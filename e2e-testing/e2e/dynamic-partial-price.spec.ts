import {
  clearCaches,
  expect,
  recordPartialDispatches,
  test,
  waitForLiveConnection,
  waitForPageInteractive,
  type Page,
} from "./fixtures"

/**
 * Live-price refresh end-to-end — the tag idiom on a dynamically
 * minted parton.
 *
 * The /magento page renders each product's live price as a
 * `<LivePricePartial sku=… />` produced inside `ProductGrid.map(...)` —
 * invisible to the bootstrap JSX walk in `PartialRoot`. Each placement
 * self-registers in the route-scoped registry on its first render and
 * reads the sku-constrained `price` tag, so a card's ↻ button
 * (`bumpPrice(sku)` → `refreshSelector("price?sku=<sku>")`) wakes that
 * one card, while "refresh all prices" (`bumpAllPrices()` →
 * `refreshSelector("price")`) fans out across every instance. Both
 * ride the held connection's lanes: the write is a plain server
 * action, and the client states no refetch of its own.
 */

// The bare `price` bump the fanout test fires is confined to the
// request's `x-test-scope` (the invalidation registry buckets per
// scope), so it never reaches a concurrently running worker's page —
// no serial mode.

// Clear server-side caches between tests so each one starts from a
// deterministic state. Tests that preceded this one may have populated
// the `<Cache>` store (ProductGrid output) and the partial registry;
// without clearing, dynamic refetches can return cached bytes that
// don't match the current page state.
test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

/** Every visible card's tick, in DOM order. */
function readTicks(page: Page): Promise<string[]> {
  return page.$$eval('[data-testid^="live-price-"][data-price-tick]', (els) =>
    els.map((el) => `${el.getAttribute("data-testid")}=${el.getAttribute("data-price-tick")}`),
  )
}

/**
 * Open /magento and wait until the grid stops re-committing on its
 * own. The heartbeat's first live fire re-renders any card whose cold
 * fp drifted — a body's `tag()` read lands after the render that
 * shipped its fp, and the trailer heals it — which is initial-load
 * reconciliation, not anything a bump did. Past it, a card's tick
 * moves only when something wakes it.
 */
async function openSettledGrid(page: Page): Promise<void> {
  await page.goto("/magento")
  await expect(page.locator('[data-testid^="live-price-"][data-price-tick]').first()).toBeVisible({
    timeout: 15000,
  })
  await waitForPageInteractive(page)
  await waitForLiveConnection(page)
  await expect
    .poll(
      async () => {
        const first = await readTicks(page)
        await page.waitForTimeout(400)
        const second = await readTicks(page)
        return first.length > 0 && first.join("|") === second.join("|")
      },
      { timeout: 20000 },
    )
    .toBe(true)
}

test("a dynamically minted live-price card registers and wakes on its sku tag", async ({
  page,
}) => {
  // Transport-agnostic dispatch log: it records every client-stated
  // targeted refetch, on either transport.
  const refetches = recordPartialDispatches(page)

  await openSettledGrid(page)

  // The price grid materialized. If the per-card placements weren't
  // running / registering, these wouldn't be here.
  const firstPrice = page.locator('[data-testid^="live-price-"][data-price-tick]').first()
  const priceCount = await page.locator('[data-testid^="live-price-"][data-price-tick]').count()
  expect(priceCount).toBeGreaterThan(1)

  const testId = await firstPrice.getAttribute("data-testid")
  const sku = testId!.replace(/^live-price-/, "")
  expect(sku.length).toBeGreaterThan(0)

  const refreshButton = page.locator(`[data-testid="refresh-price-${sku}"][data-hydrated]`).first()
  await refreshButton.waitFor({ timeout: 15000 })

  const tickBefore = await firstPrice.getAttribute("data-price-tick")
  expect(tickBefore).toBeTruthy()

  refetches.length = 0
  await refreshButton.click()

  // The card's body re-ran: a placement minted inside the grid's
  // `map` — never walked by the bootstrap — is in the registry, and
  // its `tag("price?sku=…")` read is what the bump woke.
  await expect
    .poll(() => firstPrice.getAttribute("data-price-tick"), { timeout: 10000 })
    .not.toBe(tickBefore)

  // The refresh is a server-side bump delivered on the connection's
  // lanes — the client aims nothing at the card.
  expect(refetches).toHaveLength(0)
})

/**
 * DOM-patch assertion: the sku-constrained bump refreshes the targeted
 * price's rendered `data-price-tick` in the DOM while leaving sibling
 * products untouched. This is the payoff of the constrained tag —
 * otherwise the wake fans out across cards nobody asked about, or the
 * server response arrives but the client's cache/template merge doesn't
 * swap in the fresh content.
 */
test("clicking refresh updates the targeted price's tick in the DOM", async ({ page }) => {
  await openSettledGrid(page)

  const firstPrice = page.locator('[data-testid^="live-price-"][data-price-tick]').first()
  const testId = await firstPrice.getAttribute("data-testid")
  const sku = testId!.replace(/^live-price-/, "")

  const refreshButton = page.locator(`[data-testid="refresh-price-${sku}"][data-hydrated]`).first()
  await refreshButton.waitFor({ timeout: 15000 })

  const tickBefore = await firstPrice.getAttribute("data-price-tick")
  expect(tickBefore).toBeTruthy()

  // Read a sibling product's tick — should stay put across this refresh.
  const otherPrice = page.locator('[data-testid^="live-price-"][data-price-tick]').nth(1)
  const otherTickBefore = await otherPrice.getAttribute("data-price-tick")

  await refreshButton.click()

  // The targeted price's tick should update within a few seconds.
  await expect
    .poll(() => firstPrice.getAttribute("data-price-tick"), { timeout: 10000 })
    .not.toBe(tickBefore)

  // The sibling reads `price?sku=<its own sku>` — the constraint
  // doesn't match this bump, so it never woke.
  const otherTickAfter = await otherPrice.getAttribute("data-price-tick")
  expect(otherTickAfter).toBe(otherTickBefore)
})

/**
 * Bare-name fanout. "Refresh all prices" bumps `price` with no
 * constraint, which matches every `tag("price?sku=…")` reader on the
 * page: one server-side event wakes every card, and their fresh
 * content rides the connection's lanes. The client issues no refetch
 * of its own — the fanout costs exactly the action POST that bumped.
 */
test("clicking 'refresh all prices' updates every visible price from one bump", async ({
  page,
}) => {
  const refetches = recordPartialDispatches(page)

  await openSettledGrid(page)

  // Snapshot all visible ticks before the click.
  const before = await readTicks(page)
  expect(before.length).toBeGreaterThan(2)

  refetches.length = 0
  await page.locator('[data-testid="refresh-all-prices"][data-hydrated]').click()

  // Every card is still there and every one of them carries a fresh
  // tick — no `testId=tick` pair from before survives the bump.
  await expect
    .poll(
      async () => {
        const after = await readTicks(page)
        return after.length === before.length && before.every((b) => !after.includes(b))
      },
      { timeout: 10000 },
    )
    .toBe(true)

  // One bump, no client-stated refetches: the whole grid refreshed off
  // the single `refreshSelector("price")` the action fired.
  expect(refetches).toHaveLength(0)
})
