import { test, expect } from "./fixtures"

/**
 * Regression guard for the manual flow that double-loaded in
 * production:
 *
 *   1. Land on `/` (search closed).
 *   2. Click "Search (URL)" — the overlay opens via a `#search-page`
 *      partial refetch (history: push, `?search=1`).
 *   3. Type a single character ('p').
 *
 * The sibling `search-single-rsc-call` spec shortcuts the open by
 * loading `/?search=url` directly and asserts the keystroke fires one
 * RSC call. This spec keeps the *interactive* open (button click →
 * partial refetch) in front of the keystroke, because that open is
 * what leaves the client holding a duplicate fingerprint for the
 * overview partial — and a duplicate subscription makes a single
 * stage response paint the results grid twice.
 *
 * We assert on two surfaces:
 *  - network: exactly one `partials=search-results` dispatch.
 *  - DOM: the stage-1 results grid mounts exactly once after the
 *    keystroke (no second "load" repaint).
 */
test("opening the overlay then typing loads the results exactly once", async ({ page }) => {
  const rscCalls: Array<{ url: string; partials: string | null; time: number }> = []
  const t0 = Date.now()
  page.on("request", (req) => {
    const url = req.url()
    if (!url.includes("_.rsc")) return
    const u = new URL(url)
    // Ignore the live-update heartbeat — it holds a long-lived
    // `?streaming=1` connection that is not a "load".
    if (u.searchParams.get("streaming") === "1") return
    rscCalls.push({ url, partials: u.searchParams.get("partials"), time: Date.now() - t0 })
  })

  // 1. Land on the overview with search closed.
  await page.goto("/")
  const openButton = page.getByRole("button", { name: "Search (URL)" })
  await openButton.waitFor({ state: "visible", timeout: 15000 })
  // Give hydration a beat so the click handler is wired.
  await page.waitForTimeout(300)

  // 2. Open the overlay the way a user does — by clicking the button.
  await openButton.click()
  const input = page.locator("dialog input[type=text]")
  await input.waitFor({ state: "visible", timeout: 15000 })

  // 3. Install a DOM tracker that counts every time a fresh stage-1
  //    results grid is inserted. One keystroke → one mount. A second
  //    insertion is the "results loaded twice" symptom.
  await page.evaluate(() => {
    const w = window as unknown as { __load: { mounts: number; armed: boolean } }
    w.__load = { mounts: 0, armed: false }
    const isGrid = (node: Node): boolean =>
      node instanceof HTMLElement &&
      (node.matches?.('[data-testid="stage-1-content"]') ||
        !!node.querySelector?.('[data-testid="stage-1-content"]'))
    const obs = new MutationObserver((records) => {
      if (!w.__load.armed) return
      for (const r of records) {
        for (const n of r.addedNodes) if (isGrid(n)) w.__load.mounts++
      }
    })
    obs.observe(document.body, { childList: true, subtree: true })
  })

  // 4. Reset both counters, then arm the DOM tracker and type one char.
  rscCalls.length = 0
  await page.evaluate(() => {
    ;(window as unknown as { __load: { armed: boolean } }).__load.armed = true
  })
  await input.focus()
  await input.press("p")

  // 5. Let the stages refetch (stage-3 has a 2s delay) and any
  //    spurious second load round-trip + repaint.
  await page.waitForTimeout(3000)

  const mounts = await page.evaluate(
    () => (window as unknown as { __load: { mounts: number } }).__load.mounts,
  )
  const stageCalls = rscCalls.filter((c) => c.partials === "search-results")
  const otherCalls = rscCalls.filter((c) => c.partials !== "search-results")

  console.log(`\n=== after keystroke: ${rscCalls.length} RSC call(s), ${mounts} grid mount(s) ===`)
  for (const c of rscCalls) console.log(`  [${c.time}ms] partials=${c.partials}`)

  expect(
    stageCalls.length,
    `expected exactly one search-stages dispatch; got ${stageCalls.length}`,
  ).toBe(1)
  expect(
    otherCalls,
    `expected no unrelated RSC calls; got: ${JSON.stringify(otherCalls)}`,
  ).toHaveLength(0)
  expect(
    mounts,
    `expected the results grid to load once; it mounted ${mounts} times (results loaded twice)`,
  ).toBe(1)
})
