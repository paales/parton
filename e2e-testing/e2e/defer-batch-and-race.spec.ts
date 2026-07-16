import {
  clearCaches,
  test,
  expect,
  recordPartialDispatches,
  type PartialDispatch,
} from "./fixtures"

/**
 * /defer-demo § 2,5 — dispatch behavior under concurrent activations.
 *
 *   § 2 Batched activation: two <WhenMounted> partons activate in the
 *       same commit pass. The microtask-batched dispatch should
 *       coalesce them into ONE statement forcing both ids in its
 *       `?__force=` overlay.
 *
 *   § 5 Streaming + defer race: a slow async parton suspends on
 *       initial render; a neighboring deferred parton activates
 *       immediately on mount. The defer refetch must land (and its
 *       content render) before the slow parton resolves.
 *
 * Every parton on this page is placed under the /defer-demo page
 * parton, so its effective id carries the placement fold —
 * `batch-a~<16 hex>`. `?__force=` states effective ids, so the
 * assertions match a spec id against its folded instance.
 */

/** The dispatch's stated targets — the `?__force=` overlay's effective ids. */
function targets(dispatch: PartialDispatch): string[] {
  return dispatch.partials?.split(",").filter(Boolean) ?? []
}

/** True when `id` is an instance of the spec named `specId`: a
 *  root-level unframed placement keeps the bare id, any other folds
 *  its ambient placement in as a trailing `~<16 hex>`. */
function isInstanceOf(id: string, specId: string): boolean {
  return id === specId || id.startsWith(`${specId}~`)
}

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test.describe("defer batching + race", () => {
  test("two <WhenMounted> partials coalesce into one dispatch", async ({ page }) => {
    // Both batch partials activate on mount, so each activator's
    // useEffect calls `fire()` in the same commit pass.
    const rscCalls = recordPartialDispatches(page)

    await page.goto("/defer-demo")
    // Wait for both partials to render their activated content — that
    // proves both refetches landed.
    await expect(page.locator('[data-testid="batch-a-fallback"]')).toHaveCount(0, {
      timeout: 10000,
    })
    await expect(page.locator('[data-testid="batch-b-fallback"]')).toHaveCount(0, {
      timeout: 10000,
    })

    // One dispatch should force BOTH `batch-a` and `batch-b`. Separate
    // dispatches (one per partial) would be the batching bug.
    const matches = rscCalls.filter((c) => {
      const ids = targets(c)
      return (
        ids.some((id) => isInstanceOf(id, "batch-a")) &&
        ids.some((id) => isInstanceOf(id, "batch-b"))
      )
    })
    expect(
      matches.length,
      `expected one dispatch covering both batch-a + batch-b, got: ${JSON.stringify(
        rscCalls.map((c) => c.partials),
      )}`,
    ).toBeGreaterThanOrEqual(1)

    // And no one-off dispatches for either partial alone — those would
    // indicate un-batched fires.
    const solo = (specId: string) =>
      rscCalls.filter((c) => {
        const ids = targets(c)
        return ids.length === 1 && isInstanceOf(ids[0], specId)
      })
    expect(solo("batch-a").length, "batch-a should not be refetched alone").toBe(0)
    expect(solo("batch-b").length, "batch-b should not be refetched alone").toBe(0)
  })

  test("deferred activation doesn't wait for a slow suspending sibling", async ({ page }) => {
    // One settling load first, so the route's records carry the read
    // sets their bodies make. An activation statement's forced targets
    // lane AFTER its covering whole-tree segment, and against a cold
    // registry that segment re-renders every parton on the route — the
    // cold-record gate (over-fetch, never stale). On /defer-demo that
    // is the 1200ms `concurrent-c`, which would gate the lane on a
    // parton this test says nothing about. Warm, the covering segment
    // fp-skips to placeholders and the lane is the first thing the
    // statement renders — leaving the slow sibling as the only thing
    // the activation could serialize behind, which is the claim.
    await page.goto("/defer-demo")
    await page.waitForSelector('[data-testid="slow-content"]', { timeout: 10000 })

    // `waitUntil: "commit"` lets us observe the streaming fallback
    // before the 1.5s slow partial resolves. Default `load` waits for
    // stream close, which hides the interleaving this test is about.
    // The document render is a cold render either way — no manifest
    // rides a fresh document — so the slow parton streams its full
    // 1.5s here regardless of the settling load above.
    await page.goto("/defer-demo", { waitUntil: "commit" })

    // The slow partial streams its Suspense fallback first. race-defer
    // activates on mount and completes its refetch in parallel with
    // the slow stream.
    await page.waitForSelector('[data-testid="slow-fallback"]', {
      timeout: 10000,
    })

    await page.waitForSelector('[data-testid="race-defer-content"]', {
      timeout: 10000,
    })
    await page.waitForSelector('[data-testid="slow-content"]', {
      timeout: 10000,
    })

    // The non-waiting claim, from the SERVER's own render stamps:
    // race-defer's activation render STARTED before the slow stream
    // FINISHED its 1.5s of work — the two ran concurrently. A
    // pipeline that serialized the activation behind the slow stream
    // could never produce that interval overlap. Server-clock stamps
    // are immune to client-side scheduling jitter, unlike a
    // wall-clock arrival gap.
    const raceStarted = Number(
      await page.locator('[data-testid="race-defer-content"]').getAttribute("data-started-at"),
    )
    const slowFinished = Number(
      await page.locator('[data-testid="slow-content"]').getAttribute("data-finished-at"),
    )
    expect(
      raceStarted,
      `race-defer must start before the slow stream finishes (parallel); race.started=${raceStarted} slow.finished=${slowFinished}`,
    ).toBeLessThan(slowFinished)
  })
})
