import { test, expect, request } from "./fixtures"

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
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches`)
  await ctx.dispose()
})

test("RefreshPriceButton instance survives a price refetch", async ({ page }) => {
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message))

  await page.goto("/magento")
  await page.waitForSelector('[data-testid^="live-price-"]', {
    timeout: 15000,
  })

  // Tag every refresh-price button so we can detect remount.
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>('[data-testid^="refresh-price-"]').forEach((btn, i) => {
      ;(btn as any).__instanceId = `inst-${i}-${Math.random().toString(36).slice(2, 8)}`
    })
  })

  const before = await page.evaluate(() => {
    const out: Record<string, string> = {}
    document.querySelectorAll<HTMLElement>('[data-testid^="refresh-price-"]').forEach((btn) => {
      out[btn.getAttribute("data-testid")!] = (btn as any).__instanceId ?? "NONE"
    })
    return out
  })

  const firstBtn = page.locator('[data-testid^="refresh-price-"]').first()
  const firstTestId = (await firstBtn.getAttribute("data-testid"))!
  const sku = firstTestId.replace(/^refresh-price-/, "")

  const priceEl = page.locator(`[data-testid="live-price-${sku}"]`)
  const tickBefore = await priceEl.getAttribute("data-price-tick")

  await firstBtn.click()

  // Refetch has landed when the price tick has changed.
  await expect
    .poll(() => priceEl.getAttribute("data-price-tick"), { timeout: 5000 })
    .not.toBe(tickBefore)

  const after = await page.evaluate(() => {
    const out: Record<string, string> = {}
    document.querySelectorAll<HTMLElement>('[data-testid^="refresh-price-"]').forEach((btn) => {
      out[btn.getAttribute("data-testid")!] = (btn as any).__instanceId ?? "LOST"
    })
    return out
  })

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
