import { test, expect, request } from "./fixtures"

/**
 * The search section must CONVERGE on the latest-typed query under a
 * rapid type→backspace burst — never settle permanently on a stale one.
 *
 * Each keystroke fires an independent `.search-results` refetch; the
 * fires are not aborted on supersede. Two things make convergence
 * eventual rather than instant here: the section runs in `streaming:
 * false` (startTransition holds the prior results visible until the
 * latest query's stages are ready), and the fixture's stages carry
 * artificial 1s/2s delays behind the un-aborted predecessor fires. So
 * the correct latest-query tree arrives a beat late — we poll for it
 * rather than asserting at a fixed instant.
 *
 * The framework guarantee underneath is monotonic commit ordering: a
 * late older fire can't clobber a newer one. Search content is a pure
 * function of `?q`, so that ordering isn't independently visible HERE
 * (two fires of the same query are identical) — the same-url ordering
 * case is demonstrated directly in `selector-refetch-monotonic.spec.ts`.
 *
 * The instrumentation in `pokemon.tsx` stamps each stage with `data-q`
 * (the query its committed tree was rendered against) and `data-count`
 * (row count), so we can assert the COMMITTED state matches the LATEST
 * input, not just that "something" rendered.
 */

test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5179"}/__test/clear-caches`)
  await ctx.dispose()
})

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

  const value = await input.inputValue()
  const stage1 = page.locator('[data-testid="stage-1"]')
  await expect(stage1).toBeVisible()

  // The committed stage-1 must CONVERGE on the query currently in the
  // box, never settling permanently on a stale superseded one. The
  // latest query's (artificially 1s/2s-delayed) stages stream in past
  // the un-aborted predecessor fires while startTransition holds the
  // prior results, so convergence is eventual — poll for it rather than
  // a fixed settle. A timeout here is the stale-query regression.
  await expect
    .poll(() => stage1.getAttribute("data-q"), {
      timeout: 12000,
      message: "stage-1 never converged on the latest query (stale-q monotonic regression)",
    })
    .toBe(value)

  // With a non-empty query there should be matching pokemon — an empty
  // stage-1 here is the "Start typing to search..." regression.
  if (value.length > 0) {
    const count = Number(await stage1.getAttribute("data-count"))
    expect(count, `stage-1 empty for non-empty query "${value}"`).toBeGreaterThan(0)
  }
  expect(errors, `page errors: ${JSON.stringify(errors)}`).toHaveLength(0)
})

// The held-stale-refetch-after-close case (deterministic network hold,
// release after close, assert the stale commit is dropped) lives in
// `search-escape-during-fetch.spec.ts`, which covers it without the
// page.route teardown race this file's earlier version flaked on.
