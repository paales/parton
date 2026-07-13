import { clearCaches, test, expect, waitForPageInteractive, type Page } from "./fixtures"

/**
 * /guarded-note — write authorization (`writeGuard` on the cell
 * definition). The note cell is writable only by callers carrying the
 * `note_owner=1` cookie; the save button calls the resolved cell's
 * `.set` directly, so a denial exercises the real `__cellWrite`
 * surface. Proves:
 *
 *  - an unauthorized write is rejected SERVER-SIDE: the set promise
 *    rejects, the author-rendered denied state shows, and the value
 *    never lands (a full reload — a fresh server render — still shows
 *    the old value);
 *  - the UI degrades sanely: after the denial the page stays live (a
 *    write to the unguarded control cell commits and re-renders);
 *  - flipping the credential flips the verdict: after claiming
 *    ownership the same write path succeeds and persists, and after
 *    releasing it the guard denies again.
 */

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

/** The controls are inside the parton's boundary and hydrate after the
 *  root commit — interact only through their own `data-hydrated`. */
async function waitForGuardedNoteReady(page: Page): Promise<void> {
  await waitForPageInteractive(page)
  for (const id of ["guarded-note-input", "guarded-note-save", "guarded-note-claim"]) {
    await page.locator(`[data-testid="${id}"][data-hydrated]`).waitFor({ timeout: 10000 })
  }
}

test("unauthorized write is rejected server-side and the page degrades sanely", async ({
  page,
}) => {
  await page.goto("/guarded-note")
  await waitForGuardedNoteReady(page)

  await expect(page.locator('[data-testid="guarded-note-owner"]')).toHaveText("not-owner")
  await expect(page.locator('[data-testid="guarded-note-value"]')).toHaveText("nothing saved yet")

  // The write: rejected server-side, surfaced as the form's own
  // denied state (the promise rejects; the author renders the text).
  await page.locator('[data-testid="guarded-note-input"]').fill("hijacked")
  await page.locator('[data-testid="guarded-note-save"]').click()
  await expect(page.locator('[data-testid="guarded-note-status"]')).toContainText("denied", {
    timeout: 10000,
  })
  await expect(page.locator('[data-testid="guarded-note-value"]')).toHaveText("nothing saved yet")

  // Degrades sanely: the page isn't wedged — a write to the UNGUARDED
  // control cell still commits and its re-render lands.
  await page.locator('[data-testid="guarded-note-bump"][data-hydrated]').click()
  await expect(page.locator('[data-testid="guarded-note-bumps"]')).toHaveText("1", {
    timeout: 10000,
  })

  // The denied value never reached storage: a full reload is a fresh
  // server render straight off the cell, and it still shows the old
  // value (while the committed bump survives).
  await page.reload()
  await waitForGuardedNoteReady(page)
  await expect(page.locator('[data-testid="guarded-note-value"]')).toHaveText("nothing saved yet")
  await expect(page.locator('[data-testid="guarded-note-bumps"]')).toHaveText("1")
})

test("the credential flips the verdict: claim → write succeeds, release → denied again", async ({
  page,
}) => {
  await page.goto("/guarded-note")
  await waitForGuardedNoteReady(page)

  // Claim the credential. `cookie("note_owner")` is a tracked read, so
  // the action's response render flips the badge.
  await page.locator('[data-testid="guarded-note-claim"]').click()
  await expect(page.locator('[data-testid="guarded-note-owner"]')).toHaveText("owner", {
    timeout: 10000,
  })

  // The same write path now passes the guard and commits.
  await page.locator('[data-testid="guarded-note-input"]').fill("legitimate edit")
  await page.locator('[data-testid="guarded-note-save"]').click()
  await expect(page.locator('[data-testid="guarded-note-status"]')).toHaveText("saved", {
    timeout: 10000,
  })
  await expect(page.locator('[data-testid="guarded-note-value"]')).toHaveText("legitimate edit")

  // Committed for real — survives a reload.
  await page.reload()
  await waitForGuardedNoteReady(page)
  await expect(page.locator('[data-testid="guarded-note-value"]')).toHaveText("legitimate edit")

  // Release the credential: the guard denies again, and the committed
  // value stays.
  await page.locator('[data-testid="guarded-note-release"][data-hydrated]').click()
  await expect(page.locator('[data-testid="guarded-note-owner"]')).toHaveText("not-owner", {
    timeout: 10000,
  })
  await page.locator('[data-testid="guarded-note-input"]').fill("late edit")
  await page.locator('[data-testid="guarded-note-save"]').click()
  await expect(page.locator('[data-testid="guarded-note-status"]')).toContainText("denied", {
    timeout: 10000,
  })
  await expect(page.locator('[data-testid="guarded-note-value"]')).toHaveText("legitimate edit")
})
