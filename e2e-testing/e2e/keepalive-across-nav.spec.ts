import { clearCaches, test, expect, waitForPageInteractive } from "./fixtures"

/**
 * With `keepalive: true` on every spec (the default), a partial's
 * React subtree stays mounted across cross-route navigation —
 * `<Activity mode="hidden">` parks it instead of unmounting. The
 * Activity fiber lives at the spec's natural JSX position (root.tsx
 * sibling), and the cached inner Suspense subtree is substituted at
 * the placeholder position via the existing cache merge, so `useState`
 * / `useRef` / DOM state survive the navigate-away-and-back round-trip.
 *
 * This spec uses `/cache-demo`'s `Slow` partial, which has a client
 * `<ClickCounter>` (useState) inside it. Click the counter to a known
 * value, navigate away, navigate back — the count must persist.
 * Without keepalive, the counter would mount fresh at 0 on return.
 */
test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test("ClickCounter state inside a partial survives nav away and back", async ({ page }) => {
  // Cross-route keepalive: `Slow` is nested inside `CacheDemoPage`, which
  // is a permanent `root.tsx` sibling gated by `match`. Navigating
  // /cache-demo → /defer-demo, `CacheDemoPage`'s match misses, so it emits
  // a parked `<Activity mode="hidden">` placeholder and never re-runs its
  // body — `Slow` isn't in this render's `seenIds`. What keeps `Slow`'s
  // cache entry alive is the client's BFS `seen`-expansion (`PartialsClient`
  // streaming branch): the parked parent's placeholder IS in `seen`, so the
  // walk follows the cached `CacheDemoPage` wrapper, harvests its nested
  // `Slow` id, and the prune spares it. Navigating back, `CacheDemoPage`
  // matches, its Activity flips visible, and `substituteNested` restores the
  // still-cached `Slow` subtree with its `useState` intact.
  await page.goto("/cache-demo")
  const counter = page.getByTestId("click-counter")
  await expect(counter).toBeVisible({ timeout: 10000 })
  await waitForPageInteractive(page)

  // Click the counter three times. Each click bumps the useState
  // counter inside `<ClickCounter>`, which is rendered inside the
  // `Slow` partial inside `/cache-demo`'s wrapper.
  await counter.click()
  await counter.click()
  await counter.click()
  await expect(counter).toHaveText(/clicked 3×/)

  // Client-side nav to /defer-demo via the app-nav link. The whole
  // cache-demo subtree should flip to `<Activity mode="hidden">` —
  // its DOM is rendered with `display:none` but the React fiber tree
  // (including ClickCounter's `useState` value) stays mounted.
  await page.getByRole("link", { name: /Defer Demo/ }).click()
  await expect(page.locator('[data-testid="manual-fallback"]')).toBeVisible()

  // The ClickCounter button is in the DOM but hidden (Activity hidden).
  // We can't assert "not visible" through Playwright's `toBeVisible`
  // because that races with the Activity-driven `display:none`
  // commit; instead we just confirm the new page is showing.
  await expect(page.getByTestId("activate-manual")).toBeVisible()

  // Client-side nav back. With keepalive, the spec emits
  // `<Activity mode="visible">` for the now-active route; the cached
  // inner Suspense subtree paints from the prior render and the
  // counter's `useState` value survives.
  await page.getByRole("link", { name: /Cache Demo/ }).click()
  const counterAfter = page.getByTestId("click-counter")
  await expect(counterAfter).toBeVisible({ timeout: 10000 })
  await expect(counterAfter).toHaveText(/clicked 3×/)
})
