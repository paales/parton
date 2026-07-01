import {
  clearCaches,
  test,
  expect,
  waitForLiveConnection,
  waitForPageInteractive,
  type Page,
} from "./fixtures"

/**
 * /forms-demo — scoped cells declared inline (`localCell("key", …)`),
 * committed by an action that resolves them by key without a render.
 * Exercises:
 *
 *  - The `save` action resolves the inline `saves` cell + auto-writes the
 *    `cardName` / `cardCvc` args into their matching inline cells, all
 *    inside one transaction. The committed values surface server-side.
 *  - `notes` is bound per-keystroke (`useCell.input({mode: 'onChange'})`)
 *    and persists across a reload (the cell is persistent + partitioned by
 *    session, stable across the reload).
 */

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

/**
 * These tests TYPE into cell-bound inputs — text input is not covered
 * by React's discrete-event replay, so a keystroke landing before the
 * input's boundary hydrates is silently lost. Wait for the page-
 * interactive marker AND the target inputs' own `data-hydrated`
 * (stamped by the framework's `useCell().input()` callback ref at the
 * commit that wires their handlers).
 */
async function waitForFormsReady(page: Page, testids: string[]): Promise<void> {
  await waitForPageInteractive(page)
  // The heartbeat's first live fire can re-commit (and remount) the
  // form island if its cold fp drifted; interacting inside that window
  // loses the keystrokes/click. Its own marker says when it settled.
  await waitForLiveConnection(page)
  for (const id of testids) {
    await page.locator(`[data-testid="${id}"][data-hydrated]`).waitFor({ timeout: 10000 })
  }
}

test("save action commits the card fields and records the snapshot", async ({ page }) => {
  await page.goto("/forms-demo")
  await waitForFormsReady(page, ["forms-card-name", "forms-card-cvc"])

  // failChance defaults to 0 → the handler never throws.
  await page.locator('[data-testid="forms-card-name"]').fill("Ada Lovelace")
  await page.locator('[data-testid="forms-card-cvc"]').fill("123")
  await page.locator('[data-testid="forms-save"]').click()

  // Server-authoritative values (survive any refetch/remount): the staged
  // `saves` snapshot + the auto-written `cardName` cell.
  await expect(page.locator('[data-testid="forms-saves-json"]')).toContainText("Ada Lovelace", {
    timeout: 10000,
  })
  await expect(page.locator('[data-testid="forms-saves-json"]')).toContainText("123")
  await expect(page.locator('[data-testid="forms-server-name"]')).toContainText("Ada Lovelace")
})

test("notes persist across a reload (per-keystroke cell write)", async ({ page }) => {
  await page.goto("/forms-demo")
  await waitForFormsReady(page, ["forms-notes"])

  await page.locator('[data-testid="forms-notes"]').fill("remember me")
  // Wait for the per-keystroke write to commit server-side.
  await expect(page.locator('[data-testid="forms-notes-server"]')).toContainText("remember me", {
    timeout: 10000,
  })

  await page.reload()
  await waitForFormsReady(page, ["forms-notes"])
  await expect(page.locator('[data-testid="forms-notes-server"]')).toContainText("remember me")
})
