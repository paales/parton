import {
  clearCaches,
  test,
  expect,
  request,
  waitForLiveConnection,
  waitForPageInteractive,
} from "./fixtures"

/**
 * End-to-end coverage for the /streaming-demo page — three live
 * proofs of the server primitives:
 *
 *  - `markConnectionLive` + segment loop  → live tick advances on
 *    the same HTTP response without client-side polling.
 *  - `getServerNavigation().reload({selector})` → click bumps the
 *    counter and the partial re-renders.
 *  - `getServerNavigation().navigate(url)` → click pushes a new
 *    `?seq=` into the URL bar without re-fetching.
 */

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test("live tick advances over time on one rolling response", async ({ page }) => {
  await page.goto("/streaming-demo")
  const tick = page.locator('[data-testid="streaming-demo-tick"]')
  // The tick partial mounts; initial render shows tick #0 (or
  // whatever the scope state was at request time).
  await expect(tick).toBeAttached({ timeout: 10000 })

  // The tick only advances while the live subscription is open — the
  // channel transport marks `<html data-parton-live>` once the
  // stream's `conn` handshake arrives (the session is open
  // server-side). Wait for that signal, THEN observe an advance: the
  // segment loop wakes at each second boundary, so a new tick must
  // land on the same rolling response.
  await waitForLiveConnection(page)
  const initial = (await tick.textContent())?.match(/Tick #(\d+)/)?.[1]
  expect(initial).toBeDefined()
  await expect
    .poll(async () => (await tick.textContent())?.match(/Tick #(\d+)/)?.[1], {
      timeout: 10000,
    })
    .not.toBe(initial)
})

test("bump button calls getServerNavigation().reload + partial re-renders", async ({ page }) => {
  await page.goto("/streaming-demo")
  await expect(page.locator('[data-testid="streaming-demo-bumps"]')).toContainText("Bumps: 0", {
    timeout: 10000,
  })
  await waitForPageInteractive(page)

  await page.locator('[data-testid=\"streaming-demo-bump-btn\"][data-hydrated]').click()
  await expect(page.locator('[data-testid="streaming-demo-bumps"]')).toContainText("Bumps: 1", {
    timeout: 5000,
  })

  await page.locator('[data-testid=\"streaming-demo-bump-btn\"][data-hydrated]').click()
  await expect(page.locator('[data-testid="streaming-demo-bumps"]')).toContainText("Bumps: 2", {
    timeout: 5000,
  })
})

test("push-URL button advances ?seq= via server-side navigate", async ({ page }) => {
  await page.goto("/streaming-demo")
  await expect(page.locator('[data-testid="streaming-demo-push-btn"]')).toBeVisible({
    timeout: 10000,
  })
  await waitForPageInteractive(page)

  // Before click: no ?seq= in the URL.
  expect(new URL(page.url()).searchParams.get("seq")).toBeNull()

  // The action calls `getServerNavigation().navigate("?seq=N")`. The
  // url-trailer is applied via `history.replaceState` on the client.
  // `seq` is module-scope on the server (advances across calls) so we
  // read the value from the URL after each click rather than asserting
  // exact numbers — what matters is that the URL changes and that each
  // click advances it.
  await page.locator('[data-testid=\"streaming-demo-push-btn\"][data-hydrated]').click()
  await expect
    .poll(() => new URL(page.url()).searchParams.get("seq"), { timeout: 5000 })
    .not.toBeNull()
  const first = Number(new URL(page.url()).searchParams.get("seq"))
  expect(first).toBeGreaterThan(0)

  await page.locator('[data-testid=\"streaming-demo-push-btn\"][data-hydrated]').click()
  await expect
    .poll(() => Number(new URL(page.url()).searchParams.get("seq")), {
      timeout: 5000,
    })
    .toBe(first + 1)
})
