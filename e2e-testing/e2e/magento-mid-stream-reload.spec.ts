import { expect, request, test } from "./fixtures"

/**
 * Bug reproduction: reloading /magento before LivePrice partials
 * resolve should leave the page in a good state. User-reported:
 * the page "breaks" if you hit reload during the price-loading
 * window.
 *
 * Hypothesis: client-side fetches in-flight on navigation get
 * cancelled mid-stream; some unhandled abort surfaces as a
 * PartialErrorBoundary error or a stale fallback that never
 * resolves.
 */
test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5179"}/__test/clear-caches?all=1`)
  await ctx.dispose()
})

test("reload mid-stream lands cleanly on the magento page", async ({ page }) => {
  // Cold load: prices take ~1s each (artificial delay). Reload
  // before they all settle.
  await page.goto("/magento", { waitUntil: "commit" })
  await page.waitForSelector('[data-testid^="live-price-fallback-"]', { timeout: 5000 })

  // Reload while still loading.
  await page.reload({ waitUntil: "commit" })

  // After reload, the page must settle into a healthy state:
  //  - No "Partial failed to render" error cards.
  //  - Prices eventually resolve.
  await expect(page.getByText("failed to render")).toHaveCount(0, { timeout: 1000 }).catch(() => {
    // The error might still be there transiently; we'll re-check after
    // the prices resolve.
  })
  await page.waitForSelector('[data-testid^="live-price-"][data-price-tick]', {
    timeout: 15000,
  })

  // Final state: no error cards in the DOM.
  await expect(page.getByText("failed to render")).toHaveCount(0)
})

test("reload mid-stream three times in a row stays healthy", async ({ page }) => {
  await page.goto("/magento", { waitUntil: "commit" })
  await page.waitForSelector('[data-testid^="live-price-fallback-"]', { timeout: 5000 })
  await page.reload({ waitUntil: "commit" })
  await page.waitForSelector('[data-testid^="live-price-fallback-"]', { timeout: 5000 })
  await page.reload({ waitUntil: "commit" })
  await page.waitForSelector('[data-testid^="live-price-fallback-"]', { timeout: 5000 })
  await page.reload({ waitUntil: "commit" })

  await page.waitForSelector('[data-testid^="live-price-"][data-price-tick]', {
    timeout: 15000,
  })
  await expect(page.getByText("failed to render")).toHaveCount(0)
})
