import { clearCaches, test, expect } from "./fixtures"

/**
 * Monotonic commit ordering for window-scoped selector refetches.
 *
 * Window-scoped selector refetches are not aborted on supersede — they
 * drain and commit. Their responses can arrive OUT OF ORDER, so the
 * framework must commit them in ISSUE order, not arrival order:
 * an older-issued fire whose response lands late must NOT clobber a
 * newer one.
 *
 * The existing page-URL staleness guard cannot arbitrate this: both
 * fires are for the SAME url (`/selector-demo`, `?partials=product`), so
 * the URL is identical at every commit. Only the real signal — a
 * monotonic per-selector issue sequence (`refetch-ordering.ts`) — can.
 *
 * `<ProductAnonymousPartial>` renders `<ServerTime>` (`new Date()`), so
 * each fire of the same url returns DIFFERENT content. We hold the
 * first fire's response open (its server render already stamped an
 * EARLIER time), let a second fire commit a LATER time, then release the
 * first. Without the guard the stale earlier time clobbers the newer one
 * ("last arrival wins"); with it, the stale commit is dropped.
 */

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test("a superseded same-url selector refetch can't clobber the newer one", async ({ page }) => {
  // Deterministic RSC traffic: keep the streaming heartbeat off so the
  // only `?partials=product` requests are the two this test drives.
  await page.addInitScript(() => {
    ;(window as unknown as { __partonHeartbeatDisabled?: boolean }).__partonHeartbeatDisabled = true
  })

  await page.goto("/selector-demo")
  const product = page.locator('[data-testid="time-product"]')
  await product.waitFor({ state: "visible", timeout: 15000 })
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __fireProductReload?: unknown }).__fireProductReload ===
      "function",
    null,
    { timeout: 10000 },
  )
  const initial = (await product.textContent())?.trim()

  // Hold the FIRST `.product` refetch's response. `route.fetch()` runs
  // the server render NOW (stamping the EARLIER time), then we park the
  // delivery until released; later fires pass straight through.
  let releaseFirst!: () => void
  const firstReleased = new Promise<void>((r) => (releaseFirst = r))
  let held = false
  let onHeld!: () => void
  const heldP = new Promise<void>((r) => (onHeld = r))
  await page.route(
    (url) => url.pathname.endsWith("_.rsc") && url.searchParams.get("partials") === "product",
    async (route) => {
      if (!held) {
        held = true
        const response = await route.fetch()
        onHeld()
        await firstReleased
        await route.fulfill({ response })
        return
      }
      await route.continue()
    },
  )

  // Fire #1 (issued first) — its response is parked.
  await page.evaluate(() =>
    (window as unknown as { __fireProductReload: () => void }).__fireProductReload(),
  )
  await heldP

  // A beat so #2's server render lands a strictly LATER timestamp than #1.
  await page.waitForTimeout(60)

  // Fire #2 (issued second) — passes through and commits the later time.
  await page.evaluate(() =>
    (window as unknown as { __fireProductReload: () => void }).__fireProductReload(),
  )
  await expect(product).not.toHaveText(initial ?? "", { timeout: 10000 })
  const newer = (await product.textContent())?.trim()
  expect(newer, "second refetch should have committed a fresh time").not.toBe(initial)

  // Release #1 — its STALE (earlier) response now arrives last.
  releaseFirst()
  await page.waitForTimeout(1000)

  // The committed time must remain the NEWER one. Pre-guard, the stale
  // earlier time clobbered it here ("last arrival wins").
  await expect(
    product,
    "a superseded refetch's stale response clobbered the newer commit (monotonic-order regression)",
  ).toHaveText(newer ?? "")
})
