import { test, expect, request } from "./fixtures"

/**
 * Repro for the rapid type→backspace→close races in the search overlay.
 *
 * Symptoms reported in production (hard to pin to one specific state):
 *   - stage-1 commits an empty tree ("Start typing to search...") even
 *     though the input has a non-empty query;
 *   - a committed stage shows results for a STALE query (an older,
 *     superseded refetch's tree clobbered the newer one);
 *   - after closing the overlay it stays visible.
 *
 * The instrumentation in `pokemon.tsx` stamps each stage with `data-q`
 * (the query its committed tree was rendered against) and `data-count`
 * (row count), and the dialog body with `data-search-q`. That lets us
 * assert the COMMITTED state matches the LATEST input, not just that
 * "something" rendered.
 *
 * Run with --repeat-each to shake out the race; a single pass may get
 * lucky on timing.
 */

test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5179"}/__test/clear-caches`)
  await ctx.dispose()
})

async function settle(page: import("@playwright/test").Page) {
  // Stage 3 has a 2s server delay; give every in-flight fire time to
  // either commit or be superseded, then a beat for React to flush.
  await page.waitForTimeout(3500)
}

test("rapid type then backspace leaves stage-1 consistent with the input", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))

  await page.goto("/?search=url")
  const input = page.locator("dialog input[type=text]")
  await input.waitFor({ state: "visible", timeout: 15000 })
  await page.waitForTimeout(300)
  await input.focus()

  // Type "pokemon" one key at a time, fast — each keystroke fires a
  // `.search-results` refetch and supersedes the previous.
  for (const ch of "pokemon") {
    await input.press(ch)
    await page.waitForTimeout(40)
  }
  // Then backspace most of it, equally fast.
  for (let i = 0; i < 5; i++) {
    await input.press("Backspace")
    await page.waitForTimeout(40)
  }

  await settle(page)

  const value = await input.inputValue()
  const stage1 = page.locator('[data-testid="stage-1"]')
  await expect(stage1).toBeVisible()
  const committedQ = await stage1.getAttribute("data-q")
  const count = Number(await stage1.getAttribute("data-count"))

  console.log(`input="${value}" stage1.data-q="${committedQ}" stage1.count=${count}`)

  // The committed stage-1 must reflect the query currently in the box,
  // not a stale superseded one.
  expect(committedQ, "stage-1 committed a tree for a stale query").toBe(value)
  // With a non-empty query there should be matching pokemon — an empty
  // stage-1 here is the "Start typing to search..." regression.
  if (value.length > 0) {
    expect(count, `stage-1 empty for non-empty query "${value}"`).toBeGreaterThan(0)
  }
  expect(errors, `page errors: ${JSON.stringify(errors)}`).toHaveLength(0)
})

// The held-stale-refetch-after-close case (deterministic network hold,
// release after close, assert the stale commit is dropped) lives in
// `search-escape-during-fetch.spec.ts`, which covers it without the
// page.route teardown race this file's earlier version flaked on.
