import { test, expect, waitForPageInteractive } from "./fixtures"

/**
 * Duplicate placement — two placements of ONE parton on a page are two
 * INSTANCES (the placement fold in partial.tsx mints each an id of its
 * own).
 *
 * /dup-placement places <DupTick/> twice (nested inside
 * <DupWrapperPage/> AND directly in root.tsx); /dup-control is the
 * single-placement baseline. Both partons stamp `data-now` (time().now)
 * so a body re-run is observable as a moved stamp. The contract:
 *
 *  - the document load hydrates CLEANLY (no hydration-mismatch console
 *    error — the two placements no longer fight over one client cache
 *    slot) and each position displays its own tick;
 *  - the tick has no deps, so no navigation re-runs either placement's
 *    body (fp-skip holds per placement);
 *  - after a document reload, the attach catch-up fp-skips — stamps
 *    hold still afterwards.
 */

async function stamps(page: import("@playwright/test").Page, prefix: string) {
  return page.$$eval(`[data-testid^="${prefix}-stamp"]`, (els) =>
    els.map((e) => ({ t: e.getAttribute("data-testid"), n: e.getAttribute("data-now") })),
  )
}

/** Collect hydration-related console errors — the signal the one-slot
 *  identity collision used to trip on every document load. */
function trackHydrationErrors(page: import("@playwright/test").Page): string[] {
  const errors: string[] = []
  page.on("console", (msg) => {
    if (msg.type() === "error" && /hydrat/i.test(msg.text())) errors.push(msg.text())
  })
  page.on("pageerror", (err) => {
    if (/hydrat/i.test(err.message)) errors.push(err.message)
  })
  return errors
}

test("control: nav a↔b re-renders wrapper, tick fp-skips", async ({ page }) => {
  await page.goto("/dup-control")
  await waitForPageInteractive(page)
  const s0 = await stamps(page, "solo")

  await page.locator('[data-testid="solo-nav-a"]').click()
  await expect(page.locator('[data-testid="solo-wrapper"] h2')).toContainText("dupname=a")
  const s1 = await stamps(page, "solo")
  expect(s1.find((s) => s.t === "solo-stamp-wrapper")!.n).not.toBe(
    s0.find((s) => s.t === "solo-stamp-wrapper")!.n,
  )
  expect(s1.find((s) => s.t === "solo-stamp-tick")!.n).toBe(
    s0.find((s) => s.t === "solo-stamp-tick")!.n,
  )

  await page.locator('[data-testid="solo-nav-b"]').click()
  await expect(page.locator('[data-testid="solo-wrapper"] h2')).toContainText("dupname=b")
  const s2 = await stamps(page, "solo")
  expect(s2.find((s) => s.t === "solo-stamp-tick")!.n).toBe(
    s0.find((s) => s.t === "solo-stamp-tick")!.n,
  )
})

test("dup: document load hydrates cleanly; both positions display their own tick", async ({
  page,
}) => {
  const hydrationErrors = trackHydrationErrors(page)
  await page.goto("/dup-placement")
  await waitForPageInteractive(page)

  // Two placements, two rendered instances — one nested in the
  // wrapper, one at root.
  await expect(page.locator('[data-testid="dup-tick"]')).toHaveCount(2)
  const s0 = await stamps(page, "dup")
  expect(s0.filter((s) => s.t === "dup-stamp-tick").length).toBe(2)

  // Distinct client identities: the two positions resolve to two
  // DISTINCT effective ids (the nested one placement-folded), so
  // hydration never sees one cache slot claimed by two positions.
  expect(hydrationErrors, "hydration mismatch on document load").toEqual([])
})

test("dup: nav a↔b re-renders wrapper, BOTH tick placements fp-skip", async ({ page }) => {
  await page.goto("/dup-placement")
  await waitForPageInteractive(page)
  const s0 = await stamps(page, "dup")
  expect(s0.filter((s) => s.t === "dup-stamp-tick").length).toBe(2)

  await page.locator('[data-testid="dup-nav-a"]').click()
  await expect(page.locator('[data-testid="dup-wrapper"] h2')).toContainText("dupname=a")
  const s1 = await stamps(page, "dup")

  await page.locator('[data-testid="dup-nav-b"]').click()
  await expect(page.locator('[data-testid="dup-wrapper"] h2')).toContainText("dupname=b")
  const s2 = await stamps(page, "dup")

  await page.locator('[data-testid="dup-nav-none"]').click()
  await expect(page.locator('[data-testid="dup-wrapper"] h2')).toContainText("dupname=null")
  const s3 = await stamps(page, "dup")

  // The contract: the tick has no deps, so no navigation may ever
  // re-run its body — both placements' stamps stay at their load values.
  const loadTicks = s0.filter((s) => s.t === "dup-stamp-tick").map((s) => s.n)
  for (const [label, snap] of [
    ["nav a", s1],
    ["nav b", s2],
    ["nav none", s3],
  ] as const) {
    const ticks = snap.filter((s) => s.t === "dup-stamp-tick").map((s) => s.n)
    expect(ticks, `tick stamps moved after ${label}`).toEqual(loadTicks)
  }
})

test("dup: document reload → attach catch-up fp-skips, stamps hold still", async ({ page }) => {
  await page.goto("/dup-placement")
  await waitForPageInteractive(page)

  await page.locator('[data-testid="dup-reload"]').click()
  await page.waitForLoadState("load")
  await waitForPageInteractive(page)
  const s1 = await stamps(page, "dup")

  // Everything moves on a document reload (no manifest on a document
  // GET). What matters is what happens NEXT: the attach catch-up must
  // fp-skip both placements, so stamps hold still afterwards.
  await page.waitForTimeout(3000)
  const s2 = await stamps(page, "dup")
  expect(s2).toEqual(s1)

  // A second reload cycle for good measure.
  await page.locator('[data-testid="dup-reload"]').click()
  await page.waitForLoadState("load")
  await waitForPageInteractive(page)
  const s3 = await stamps(page, "dup")
  await page.waitForTimeout(3000)
  const s4 = await stamps(page, "dup")
  expect(s4).toEqual(s3)
})
