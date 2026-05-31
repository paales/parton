import { test, expect } from "../fixtures"

/**
 * Preview-tier variant of `../search-open-then-keystroke.spec.ts`.
 *
 * The dev-tier spec runs the same flow against the Vite dev server,
 * where the double-load does NOT reproduce. This one runs against the
 * production bundle (`vite build` + `vite preview`, port 5181) —
 * which is where the "results load twice" symptom was observed.
 * Prod-only differences (minified client refs, different chunk
 * boundaries, RSC payloads without dev annotations) can change the
 * hydration timing that leaves a duplicate fingerprint behind.
 *
 * Flow:
 *   1. Land on `/` (search closed).
 *   2. Click "Search (URL)" to open the overlay interactively.
 *   3. Type one character ('p').
 *
 * Assert: exactly one `partials=search-results` dispatch AND the
 * stage-1 results grid mounts exactly once (no second repaint).
 *
 * Keep in sync with the dev-tier spec when the flow changes.
 *
 * No `/__test/clear-caches` beforeEach here: that endpoint is gated
 * behind `import.meta.env.DEV` in `entry.rsc.tsx` and is dead code in
 * the production bundle. The flow opens the overlay fresh each run, so
 * a warm cache only makes the path faster, not wrong.
 */
test("opening the overlay then typing loads the results exactly once", async ({ page }) => {
  const rscCalls: Array<{ url: string; partials: string | null; time: number }> = []
  const t0 = Date.now()
  page.on("request", (req) => {
    const url = req.url()
    if (!url.includes("_.rsc")) return
    const u = new URL(url)
    if (u.searchParams.get("streaming") === "1") return
    rscCalls.push({ url, partials: u.searchParams.get("partials"), time: Date.now() - t0 })
  })

  await page.goto("/")
  // The production server JITs its RSC handler on the first request of
  // a fresh boot, so wait for the app shell before reaching for the
  // header button.
  await page.waitForSelector('[data-testid="page-shell"]', { timeout: 30000 })
  const openButton = page.getByRole("button", { name: "Search (URL)" })
  await openButton.waitFor({ state: "visible", timeout: 15000 })
  await page.waitForTimeout(300)

  await openButton.click()
  const input = page.locator("dialog input[type=text]")
  await input.waitFor({ state: "visible", timeout: 15000 })

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

  rscCalls.length = 0
  await page.evaluate(() => {
    ;(window as unknown as { __load: { armed: boolean } }).__load.armed = true
  })
  await input.focus()
  await input.press("p")
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
