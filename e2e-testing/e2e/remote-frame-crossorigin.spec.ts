import { clearCaches, expect, recordPartialDispatches, request, test } from "./fixtures"

/**
 * /remote-frame-crossorigin-demo — true cross-origin `<RemoteFrame>`.
 *
 * The remote app (`e2e-magento`) runs alongside the host: both are
 * Playwright-managed webServers (see `playwright.config.ts`), so no
 * manual `yarn dev:magento` terminal is needed. The config exports
 * the remote's origin as `MAGENTO_REMOTE_ORIGIN` — the same env var
 * the host's generated bindings (`src/remote/magento/`) read — so a
 * port remap stays a single-constant change in the config.
 */

const REMOTE_ORIGIN = process.env.MAGENTO_REMOTE_ORIGIN ?? "http://localhost:5181"

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test("host renders cross-origin magento-greeting", async ({ page }) => {
  // Longer goto timeout — the first hit to a /remote/* page on the
  // magento dev server forces vite to compile the parton (cold
  // optimizeDeps); subsequent hits are fast.
  await page.goto("/remote-frame-crossorigin-demo", { timeout: 30000 })
  await expect(page.getByTestId("rfxd-header")).toBeVisible({ timeout: 10000 })

  // Both cross-origin frames arrive after their respective delays.
  await expect(page.getByTestId("magento-greeting")).toBeVisible({
    timeout: 15000,
  })
  await expect(page.getByTestId("magento-stocks")).toBeVisible({
    timeout: 15000,
  })

  // The greeting card carries text identifying its origin.
  await expect(page.getByTestId("magento-greeting")).toContainText("e2e-magento")
})

test("an embed-flagged page GET returns Flight + the snapshots trailer", async ({ request }) => {
  // The remote's embeddable unit is an ORDINARY page. Fetched with
  // the embed headers it answers Flight (no HTML shell) and appends
  // the snapshots trailer entry the host registers from.
  const response = await request.get(`${REMOTE_ORIGIN}/remote/magento-greeting`, {
    headers: { "x-parton-render": "1", "x-parton-embed-depth": "1" },
  })
  expect(response.status()).toBe(200)
  expect(response.headers()["content-type"]).toMatch(/^text\/x-component/)

  // Wire shape per `fp-trailer-marker.ts`: one UTF-8-invalid lead
  // byte (`\xFF`) followed by an ASCII bracketed header
  // (`[parton:snapshots:<length>]\n`) and a length-prefixed JSON
  // body. Finding the readable header prefix confirms the page
  // response carries the snapshot trailer.
  const text = new TextDecoder("utf-8", { fatal: false }).decode(await response.body())
  expect(text, "snapshot trailer marker must be present").toMatch(/\[parton:snapshots:\d+\]/)
  // The embed render replies with the slice marker instead of the
  // page shell (PartialRoot's embed branch).
  expect(text).toContain("parton-embed-body")
})

test("the manifest advertises embeddable page paths", async ({ request }) => {
  const response = await request.get(`${REMOTE_ORIGIN}/__remote/manifest.json`)
  expect(response.status()).toBe(200)
  // CORS stays on the static metadata endpoints (the CLI may fetch
  // from anywhere).
  expect(response.headers()["access-control-allow-origin"]).toBe("*")
  const manifest = (await response.json()) as {
    specs: Array<{ selector: string; path: string | null; capabilityType: string | null }>
  }
  const bySelector = new Map(manifest.specs.map((s) => [s.selector, s]))
  expect(bySelector.get("magento-greeting")?.path).toBe("/remote/magento-greeting")
  expect(bySelector.get("magento-payment-summary")?.path).toBe("/remote/magento-payment-summary")
  expect(bySelector.get("magento-payment-summary")?.capabilityType).toBe("PaymentCap")
  // The nested cart-summary has no page of its own — reached only via
  // its parent page's trailer — so it advertises no path.
  expect(bySelector.get("cart-summary")?.path).toBeNull()
})

test("capability-scoped remote reads host-declared values", async ({ page }) => {
  await page.goto("/remote-frame-crossorigin-demo", { timeout: 30000 })

  // The host passes { cart_id, currency, total } via the
  // `capability` prop on RemoteFrame. The remote spec reads them
  // via `getCapability()` and renders them into its body.
  const summary = page.getByTestId("magento-payment-summary")
  await expect(summary).toBeVisible({ timeout: 15000 })
  await expect(summary).toContainText("demo-cart-7f3a9")
  await expect(summary).toContainText("EUR")
  await expect(page.getByTestId("magento-payment-total")).toContainText("127.45")
})

test("selector refetch routes back to the cross-origin remote", async ({ page }) => {
  // A selector-targeted refetch is a `url` frame with a `?__force=`
  // overlay on the held channel; the host resolves the embedded
  // snapshot, and its `source: {kind: "page"}` stamp re-embeds
  // `/remote/magento-stocks?partials=<id>` on the REMOTE — the
  // ordinary protocol at the embedded URL. Drive the page's refresh
  // button and prove both halves: the dispatch names the label, and
  // genuinely FRESH remote content lands (the per-render data-tick
  // moves).
  await page.goto("/remote-frame-crossorigin-demo", { timeout: 30000 })
  const stocks = page.getByTestId("magento-stocks")
  await expect(stocks).toBeVisible({ timeout: 15000 })
  const initialTick = await stocks.getAttribute("data-tick")

  const dispatches = recordPartialDispatches(page)
  await page
    .getByTestId("rfd-refresh-magento:magento-stocks")
    .and(page.locator("[data-hydrated]"))
    .click()

  await expect
    .poll(() => dispatches.filter((d) => d.partials?.includes("magento:magento-stocks")).length, {
      timeout: 10000,
    })
    .toBeGreaterThan(0)
  // Fresh remote render arrived — the refetch crossed the origin
  // boundary and came back.
  await expect
    .poll(async () => (await stocks.getAttribute("data-tick")) !== initialTick, {
      timeout: 15000,
    })
    .toBe(true)
})

test("nested cross-origin partial is registered via the commit-defer trailer", async ({ page }) => {
  // `MagentoStockTicker` (rendered on magento) embeds an addressable
  // child `MagentoCartSummary` (`magento:cart-summary`). The child's
  // snapshot only ever reaches the host's registry through the trailer
  // that ships with its PARENT's render — the commit-defer mechanism
  // holds the RemoteFrame's commit open until every nested snapshot is
  // registered. Its presence, freshly rendered with a numeric
  // `data-tick` from the remote, proves the nested snapshot landed
  // (without commit-defer it would race and the nested id would never
  // register).
  await page.goto("/remote-frame-crossorigin-demo", { timeout: 30000 })
  const nested = page.getByTestId("magento-cart-summary")
  await expect(nested, "nested cart-summary must reach the host registry").toBeVisible({
    timeout: 15000,
  })
  expect(await nested.getAttribute("data-tick")).toMatch(/^\d+$/)
})

test("frame navigation within a cross-origin RemoteFrame", async ({ page }) => {
  // Wraps a cross-origin RemoteFrame in a `<Frame name="checkout">`.
  // Buttons inside call `useNavigation("checkout").navigate(?step=…)`
  // which updates the frame URL. A wrapper parton reads the frame
  // URL's `?step=` via `vary` and threads it into the RemoteFrame's
  // src, causing a re-fetch with new content.
  //
  // What this proves: the existing <Frame> + parton + RemoteFrame
  // primitives COMPOSE to give per-RemoteFrame navigation without
  // any new framework code. Other frames on the page are unaffected;
  // the page URL doesn't change.
  await page.goto("/remote-frame-crossorigin-demo", { timeout: 30000 })
  const card = page.getByTestId("magento-checkout-step")
  await expect(card).toBeVisible({ timeout: 15000 })
  await expect(card).toHaveAttribute("data-step", "shipping")

  await page.getByTestId("checkout-step-payment").click()
  await expect(card).toHaveAttribute("data-step", "payment", { timeout: 5000 })

  await page.getByTestId("checkout-step-review").click()
  await expect(card).toHaveAttribute("data-step", "review", { timeout: 5000 })

  // Browser URL didn't change — the frame has its own URL space.
  expect(new URL(page.url()).pathname).toBe("/remote-frame-crossorigin-demo")
})

test("remote without capability sees no host values", async ({ request }) => {
  // Embed-flagged page GET with no x-parton-capability header —
  // getCapability returns {} on the remote side, so the body falls
  // back to defaults (cart_id=<missing>, USD, 0). Response is Flight
  // bytes (JSON-ish), not HTML — angle brackets are raw.
  const response = await request.get(`${REMOTE_ORIGIN}/remote/magento-payment-summary`, {
    headers: { "x-parton-render": "1", "x-parton-embed-depth": "1" },
  })
  expect(response.status()).toBe(200)
  const text = await response.text()
  expect(text).toContain("<missing>")
  expect(text).toContain("USD")
})
