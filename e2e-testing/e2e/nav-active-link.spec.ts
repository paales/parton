import { test, expect, request, waitForPageInteractive } from "./fixtures"

/**
 * The app-nav highlights the link for the current route. "Active" is
 * presentational and 100% URL-derived, so it lives on the client via
 * the isomorphic `useNavigation()` (the host `.nav-item` block keeps
 * fp-skipping — no URL in its `vary`). Because the hook resolves the
 * URL during SSR too, the highlight is correct on the very first paint
 * (no hydration flash), and a client navigation flips it without a
 * full reload.
 */

const BASE = "http://localhost:5173"

test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? BASE}/__test/clear-caches`)
  await ctx.dispose()
})

test("active nav link is server-rendered and flips on client navigation", async ({
  page,
  baseURL,
}) => {
  const base = baseURL ?? BASE

  // SSR: the active link carries aria-current in the raw server HTML —
  // correct before any JS runs, which is what "isomorphic" buys us.
  const ctx = await request.newContext()
  const html = await (await ctx.get(`${base}/cache-demo`)).text()
  await ctx.dispose()
  expect(html).toMatch(/href="\/cache-demo"[^>]*aria-current="page"/)
  expect(html).not.toMatch(/href="\/cms-demo"[^>]*aria-current="page"/)

  // Live page: the same link is marked active.
  await page.goto(`${base}/cache-demo`)
  await waitForPageInteractive(page)
  await expect(page.locator('a[href="/cache-demo"]')).toHaveAttribute("aria-current", "page")

  // Client navigation flips the active link (no full reload).
  await page.locator('a[href="/cms-demo"][data-hydrated]').first().click()
  await expect(page.locator('a[href="/cms-demo"]').first()).toHaveAttribute("aria-current", "page")
  await expect(page.locator('a[href="/cache-demo"]')).not.toHaveAttribute("aria-current", "page")
})
