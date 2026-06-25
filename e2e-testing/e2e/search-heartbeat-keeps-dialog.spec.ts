import { test, expect } from "./fixtures"

/**
 * The live-page heartbeat must not tear the page down during a SAME-PAGE
 * refetch.
 *
 * Every search keystroke navigates (it flips `?q`). Before the fix the
 * heartbeat aborted its in-flight `?streaming=1` connection on *every*
 * `navigate` event — which rejects the already-committed payload's
 * pending references ("Connection closed."), thrown while rendering the
 * deferred search stages. That tore `SearchBodyRender` through its error
 * boundary and dropped the open search dialog mid-typing: the input
 * detached and the overlay stayed gone until a full refresh ("URL search
 * breaks the underlying page / search broken after a while").
 *
 * The heartbeat now aborts only on a real PAGE change (pathname), so a
 * keystroke's `?q` flip leaves the live stream — and the dialog — intact.
 *
 * (The separate stale-`q` ordering race — a superseded fire committing
 * out of order — is covered by `search-rapid-type-backspace.spec.ts`.)
 */
test("rapid typing keeps the search dialog alive (heartbeat doesn't tear the page)", async ({
  page,
}) => {
  const connClosed: string[] = []
  page.on("console", (m) => {
    if (m.type() === "error" && m.text().includes("Connection closed")) connClosed.push(m.text())
  })

  await page.goto("/?search=url")
  const input = page.locator("dialog input[type=text]")
  await input.waitFor({ state: "visible", timeout: 15000 })
  await input.focus()

  // Type into the open dialog while the heartbeat stream is live — each
  // keystroke navigates (`?q`). Pre-fix, the first keystroke's heartbeat
  // abort tore the page and the dialog vanished by the third character.
  // A few type + backspace cycles to be thorough.
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const ch of "pokemon") {
      await input.press(ch)
      await page.waitForTimeout(50)
    }
    for (let i = 0; i < 7; i++) {
      await input.press("Backspace")
      await page.waitForTimeout(50)
    }
  }
  await page.waitForTimeout(1000)

  // The dialog + input must survive — not be torn down by a heartbeat abort.
  await expect(page.locator("dialog")).toBeVisible()
  await expect(input).toBeVisible()
  // And the input must still be live: a final keystroke registers.
  await input.press("z")
  await expect(input).toHaveValue("z")

  expect(
    connClosed,
    `a heartbeat abort tore the search stream: ${JSON.stringify(connClosed)}`,
  ).toHaveLength(0)
})
