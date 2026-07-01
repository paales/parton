import {
  clearCaches,
  test,
  expect,
  waitForLiveConnection,
  waitForPageInteractive,
} from "./fixtures"

/**
 * Client state inside a `<Partial>` must survive a refetch.
 *
 * Refetched Suspense boundaries use a bare key + a flushSync commit,
 * so React reconciles the Suspense in place: the old children are
 * hidden behind the fallback while the new children stream in, and
 * their DOM nodes (and the React state attached to client components
 * inside) are preserved. This test tags each RefreshPriceButton's
 * DOM node with a random instance id and asserts the id is the same
 * before and after a refetch.
 */
test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test("RefreshPriceButton instance survives a price refetch", async ({ page }) => {
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message))

  await page.goto("/magento")
  await page.waitForSelector('[data-testid^="live-price-"]', {
    timeout: 15000,
  })
  await waitForPageInteractive(page)
  // Settle the heartbeat's first live fire: it re-commits (and
  // remounts) any partial whose cold fp drifted, which is initial-load
  // reconciliation — not the refetch-preservation behavior under test.
  // After the live marker, the page only re-commits when explicitly
  // refetched.
  await waitForLiveConnection(page)

  // Only a HYDRATED button's DOM node is a stable, state-carrying
  // instance — the price cards stream in via Suspense, and until a
  // card's boundary hydrates React doesn't own its SSR DOM (a commit
  // that re-renders the boundary replaces the nodes wholesale, which
  // is not the client-state-loss this spec guards against). Each
  // button stamps `data-hydrated` from its own mount effect; scope
  // the tag + assert set to those.
  await page
    .locator('[data-testid^="refresh-price-"][data-hydrated]')
    .filter({ visible: true })
    .first()
    .waitFor({ timeout: 15000 })

  // Tag every hydrated refresh-price button and read the tag map in
  // the same evaluate — one atomic snapshot, no commit window between
  // stamping and reading.
  const before = await page.evaluate(() => {
    const out: Record<string, string> = {}
    document
      .querySelectorAll<HTMLElement>('[data-testid^="refresh-price-"][data-hydrated]')
      .forEach((btn, i) => {
        const id = `inst-${i}-${Math.random().toString(36).slice(2, 8)}`
        ;(btn as any).__instanceId = id
        out[btn.getAttribute("data-testid")!] = id
      })
    return out
  })

  const firstBtn = page
    .locator('[data-testid^="refresh-price-"][data-hydrated]')
    .filter({ visible: true })
    .first()
  const firstTestId = (await firstBtn.getAttribute("data-testid"))!
  const sku = firstTestId.replace(/^refresh-price-/, "")

  const priceEl = page.locator(`[data-testid="live-price-${sku}"]`)
  const tickBefore = await priceEl.getAttribute("data-price-tick")

  await firstBtn.click()

  // Refetch has landed when the price tick has changed.
  await expect
    .poll(() => priceEl.getAttribute("data-price-tick"), { timeout: 5000 })
    .not.toBe(tickBefore)

  // Look the tagged buttons up by testid — a remount would produce a
  // fresh node without the expando (and without our tag).
  const after = await page.evaluate((ids: string[]) => {
    const out: Record<string, string> = {}
    for (const id of ids) {
      const btn = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
      out[id] = (btn as any)?.__instanceId ?? "LOST"
    }
    return out
  }, Object.keys(before))

  // The clicked button's DOM node should be the same instance
  // (reconciled in place, not remounted).
  expect(
    after[firstTestId],
    "Clicked RefreshPriceButton remounted — lost instance state across refetch",
  ).toBe(before[firstTestId])

  // Every other button must also retain its identity.
  for (const [k, v] of Object.entries(before)) {
    if (k === firstTestId) continue
    expect(after[k], `Sibling button ${k} remounted during unrelated refetch`).toBe(v)
  }
})
