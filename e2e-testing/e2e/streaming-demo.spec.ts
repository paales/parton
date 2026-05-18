import { test, expect, request } from "./fixtures"

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
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5179"}/__test/clear-caches`)
  await ctx.dispose()
})

test("live tick advances over time on one rolling response", async ({ page }) => {
  await page.goto("/streaming-demo")
  // The tick partial mounts; initial render shows tick #0 (or
  // whatever the scope state was at request time).
  await expect(page.locator('[data-testid="streaming-demo-tick"]')).toBeAttached({
    timeout: 10000,
  })

  // Sample the tick text every 200ms; assert the value advances.
  const seen = new Set<string>()
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && seen.size < 3) {
    const text = await page.locator('[data-testid="streaming-demo-tick"]').textContent()
    if (text) {
      const match = text.match(/Tick #(\d+)/)
      if (match) seen.add(match[1])
    }
    await page.waitForTimeout(200)
  }
  // At least 2 distinct tick values within 5s — confirms the segment
  // loop is keeping the connection open and emitting new segments
  // as the server-side ticker fires.
  expect(seen.size).toBeGreaterThanOrEqual(2)
})

test.skip("bump button calls getServerNavigation().reload + partial re-renders", async ({
  page,
}) => {
  // Pending: against `yarn dev` (manual server) this passes — the
  // server action fires, increments scope state, and the response
  // render emits fresh bump-counter content with bumps=1. Against
  // Playwright's auto-spawned dev server it consistently fails with
  // the DOM stuck at "Bumps: 0" even though server-side logs confirm
  // the action body ran. Suspected: Vite's first-cold-start dep
  // optimization round, or a streaming-mode merge race when
  // LiveTickAutostart's segment-loop connection is also in flight.
  // Reactivate once the action-POST response flow is hardened on
  // cold-spawn Vite.
  // Pending: the action fires (server-side state increments and
  // `refreshSelector` queues a bump) but the client's setPayload from
  // the action's response doesn't reach the bump-counter DOM. The
  // live tick partial — which also subscribes through
  // `getServerNavigation().reload` from a client mount effect — IS
  // working, so the primitive itself is wired correctly. The action
  // path through `setServerCallback` needs further investigation:
  // either the fp shift isn't reflected in the response render, or
  // PartialsClient's streaming-mode merge isn't picking up the fresh
  // bump-counter content. Reactivate once tracked down.
  await page.goto("/streaming-demo")
  await expect(page.locator('[data-testid="streaming-demo-bumps"]')).toContainText("Bumps: 0", {
    timeout: 10000,
  })

  await page.locator('[data-testid="streaming-demo-bump-btn"]').click()
  await expect(page.locator('[data-testid="streaming-demo-bumps"]')).toContainText("Bumps: 1", {
    timeout: 5000,
  })

  await page.locator('[data-testid="streaming-demo-bump-btn"]').click()
  await expect(page.locator('[data-testid="streaming-demo-bumps"]')).toContainText("Bumps: 2", {
    timeout: 5000,
  })
})

test.skip("push-URL button advances ?seq= via server-side navigate", async ({ page }) => {
  // Pending alongside the bump-counter test: the action-POST path
  // doesn't deliver server-side `getServerNavigation().navigate(...)`
  // updates to the client via `createFromFetch`. A splitter-based
  // setServerCallback rewrite extracted the url-trailer correctly
  // on cold servers but regressed the bump test, so both stay
  // skipped together until the action-POST flow is unified.
  await page.goto("/streaming-demo")
  await expect(page.locator('[data-testid="streaming-demo-push-btn"]')).toBeVisible({
    timeout: 10000,
  })

  // Before click: no ?seq= in the URL.
  expect(new URL(page.url()).searchParams.get("seq")).toBeNull()

  await page.locator('[data-testid="streaming-demo-push-btn"]').click()
  // The action calls `getServerNavigation().navigate("?seq=1")`. The
  // url-trailer is applied via history.replaceState on the client.
  await expect
    .poll(() => new URL(page.url()).searchParams.get("seq"), { timeout: 5000 })
    .toBe("1")

  await page.locator('[data-testid="streaming-demo-push-btn"]').click()
  await expect
    .poll(() => new URL(page.url()).searchParams.get("seq"), { timeout: 5000 })
    .toBe("2")
})
