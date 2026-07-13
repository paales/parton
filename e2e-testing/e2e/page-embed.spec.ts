import { clearCaches, expect, test, waitForPageInteractive } from "./fixtures"

/**
 * `<RemoteFrame>` page-embed integration coverage (the iframe model,
 * same-origin):
 *
 *  - A full ordinary page (`/pokemon/1`) embeds inside the host page:
 *    the embedded page's body content renders inside the host frame.
 *  - The embedded page's document chrome does not reach the host:
 *    exactly one <title> (the host's), no slice-marker residue.
 *  - Nested embeds of different pages hydrate with zero hydration
 *    errors.
 *  - A page embedding ITSELF terminates at the framework's max embed
 *    depth AND survives hydration — every nesting level carries its
 *    own placement-namespaced parton ids (the increment-2 identity
 *    fix; identical ids across levels used to collapse the chain).
 *  - Duplicate embeds of one page coexist (distinct placement ids)
 *    and a label refetch fans out to both.
 *  - A targeted refetch of an embedded parton routes back through the
 *    embedded page (`?partials=` at the embedded URL) and lands fresh
 *    content without disturbing the host.
 */

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

function collectHydrationErrors(page: import("./fixtures").Page): string[] {
  const errors: string[] = []
  page.on("console", (m) => {
    if (m.type() === "error" && /hydrat/i.test(m.text())) errors.push(m.text())
  })
  return errors
}

test("embeds an ordinary page's body content inside the host page", async ({ page }) => {
  await page.goto("/embed-demo", { waitUntil: "commit" })

  await expect(page.getByTestId("embed-demo-header")).toBeVisible({ timeout: 5000 })

  // The embedded page's body content — its own page shell — renders
  // INSIDE the host frame section: two page-shells total, one nested.
  const embeddedShell = page.getByTestId("embed-demo-frame").locator('[data-testid="page-shell"]')
  await expect(embeddedShell).toBeVisible({ timeout: 15000 })
  await expect(page.locator('[data-testid="page-shell"]')).toHaveCount(2)
})

test("embedded page's document metadata does not hijack the host head", async ({ page }) => {
  await page.goto("/embed-demo", { waitUntil: "commit" })
  await expect(
    page.getByTestId("embed-demo-frame").locator('[data-testid="page-shell"]'),
  ).toBeVisible({ timeout: 15000 })

  // One <title> only — the host's.
  await expect(page).toHaveTitle("React Partials")
  expect(await page.locator("title").count()).toBe(1)

  // The slice marker never reaches the DOM.
  expect(await page.locator("parton-embed-body").count()).toBe(0)
})

test("nested embeds of different pages hydrate cleanly (host → /embed-demo → /pokemon/1)", async ({
  page,
}) => {
  const hydrationErrors = collectHydrationErrors(page)
  await page.goto("/embed-nested-demo", { waitUntil: "commit" })

  await expect(page.getByTestId("embed-nested-header")).toBeVisible({ timeout: 5000 })
  // The chain resolves: host shell + /embed-demo's shell + /pokemon/1's
  // shell nested inside it.
  await expect(page.locator('[data-testid="page-shell"]').nth(2)).toBeAttached({
    timeout: 15000,
  })
  expect(hydrationErrors).toEqual([])
})

test("a self-embedding page terminates at the max depth and survives hydration", async ({
  page,
  request,
  baseURL,
}) => {
  // Server contract, asserted on the raw SSR document: host level +
  // MAX_EMBED_DEPTH embedded copies, and exactly one inert depth-limit
  // marker where the chain stops — iframe-style silent termination.
  const res = await request.get(`${baseURL}/embed-self-demo`)
  const doc = await res.text()
  const html = doc.replace(/<script>[\s\S]*?<\/script>/g, "")
  expect(html.match(/data-testid="embed-self-header"/g)?.length).toBe(4)
  expect(html.match(/data-parton-embed-limit/g)?.length).toBe(1)

  // Browser contract: with placement-scoped ids, every level's partial
  // ids are distinct, so hydration keeps the FULL nested chain (the
  // spike's id collision used to collapse it to one level).
  const hydrationErrors = collectHydrationErrors(page)
  await page.goto("/embed-self-demo", { waitUntil: "commit" })
  await expect(page.getByTestId("embed-self-header").first()).toBeVisible({ timeout: 5000 })
  await waitForPageInteractive(page)
  await page.waitForTimeout(1500)
  expect(await page.getByTestId("embed-self-header").count()).toBe(4)
  expect(await page.locator("[data-parton-embed-limit]").count()).toBe(1)
  expect(hydrationErrors).toEqual([])
})

test("duplicate embeds of one page coexist and a label refetch fans out to both", async ({
  page,
}) => {
  const hydrationErrors = collectHydrationErrors(page)
  await page.goto("/embed-duplicate-demo")
  await waitForPageInteractive(page)

  const cardA = page.getByTestId("embed-duplicate-a").getByTestId("remote-fast")
  const cardB = page.getByTestId("embed-duplicate-b").getByTestId("remote-fast")
  await expect(cardA).toBeVisible({ timeout: 15000 })
  await expect(cardB).toBeVisible({ timeout: 15000 })
  expect(hydrationErrors).toEqual([])

  const textA = await cardA.textContent()
  const textB = await cardB.textContent()

  // One label refetch — `remote-fast` is a class label carried by both
  // placements' snapshots — updates BOTH embedded copies.
  await page.locator('[data-testid="rfd-refresh-remote-fast"][data-hydrated]').click()
  await expect
    .poll(async () => (await cardA.textContent()) !== textA, { timeout: 10000 })
    .toBe(true)
  await expect
    .poll(async () => (await cardB.textContent()) !== textB, { timeout: 10000 })
    .toBe(true)
})

test("targeted refetch of an embedded parton routes through the embedded page", async ({
  page,
}) => {
  await page.goto("/embed-refetch-demo")
  await waitForPageInteractive(page)

  const card = page.getByTestId("embed-refetch-frame").getByTestId("remote-fast")
  await expect(card).toBeVisible({ timeout: 15000 })
  const initialText = await card.textContent()
  const headerText = await page.getByTestId("embed-refetch-header").textContent()

  await page.locator('[data-testid="rfd-refresh-remote-fast"][data-hydrated]').click()

  // Fresh content arrives — the snapshot's `source: {kind: "page"}`
  // stamp re-embedded `/remote/remote-fast?partials=<id>` server-side.
  await expect
    .poll(async () => (await card.textContent()) !== initialText, { timeout: 10000 })
    .toBe(true)
  // …without disturbing the host chrome (a silent targeted refetch,
  // not a page reload).
  expect(await page.getByTestId("embed-refetch-header").textContent()).toBe(headerText)
})
