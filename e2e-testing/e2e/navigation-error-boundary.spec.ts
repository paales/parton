import { clearCaches, test, expect, request, waitForPageInteractive } from "./fixtures"

/**
 * Targeted-refetch failures surface as typed `NavigationError`s
 * thrown from the navigation hook's next render (see `useReloadHook`
 * in `partial-client.tsx` — `if (state.error) throw state.error`).
 * The throw bubbles past per-partial `<PartialErrorBoundary>` (which
 * re-throws framework-branded errors) to the host's enclosing
 * `<GlobalErrorBoundary>`, which renders the "Something went wrong"
 * fallback `<html>`.
 *
 * We assert on two signals:
 *   - The console.error React emits for the boundary-caught error
 *     (carries the classified message).
 *   - The GlobalErrorBoundary's fallback DOM.
 *
 * The classifications are stable:
 *   - HTTP error          → `Navigation failed: HTTP 500 (…)`
 *   - Network unreachable → `Navigation failed: network unreachable …`
 */

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

/** Matches the targeted-refetch URL shape: <path>_.rsc?...&partials=… */
const matchesTargetedRefetch = (url: URL) =>
  url.pathname.endsWith("_.rsc") && url.searchParams.has("partials")

function captureConsoleErrors(page: import("@playwright/test").Page): string[] {
  const lines: string[] = []
  page.on("console", (msg) => {
    if (msg.type() === "error") lines.push(msg.text())
  })
  return lines
}

async function expectClassifiedNavigationError(
  page: import("@playwright/test").Page,
  consoleLines: string[],
  needle: string,
) {
  // PartialErrorBoundary catches the thrown NavigationError and
  // renders its inline "Partial X failed to render" card (with the
  // error message in a <pre>). React also logs to console.error in
  // dev — wait for both signals.
  await expect
    .poll(() => consoleLines.some((line) => line.includes(needle)), {
      timeout: 5000,
      message: `console.error never carried "${needle}". Got: ${JSON.stringify(consoleLines)}`,
    })
    .toBe(true)
  await expect(page.locator("text=/Partial .* failed to render/")).toBeVisible({
    timeout: 5000,
  })
}

test("HTTP 500 on a targeted refetch produces a typed NavigationError", async ({ page }) => {
  const consoleErrors = captureConsoleErrors(page)
  await page.goto("/selector-demo")
  await waitForPageInteractive(page)

  await page.route(
    (url) => matchesTargetedRefetch(url),
    (route) => route.fulfill({ status: 500, body: "boom" }),
  )

  await page.locator('[data-testid="refresh-product"][data-hydrated]').click()
  await expectClassifiedNavigationError(page, consoleErrors, "Navigation failed: HTTP 500")
})

test("network failure on a targeted refetch produces a typed NavigationError", async ({ page }) => {
  const consoleErrors = captureConsoleErrors(page)
  await page.goto("/selector-demo")
  await waitForPageInteractive(page)

  // Abort the request at the network layer — the browser's fetch()
  // rejects with a TypeError, which `toNavigationError` classifies
  // as `kind: "network"`.
  await page.route(
    (url) => matchesTargetedRefetch(url),
    (route) => route.abort("failed"),
  )

  await page.locator('[data-testid="refresh-product"][data-hydrated]').click()
  // The TypeError's browser message varies across engines; the framework
  // prefixes with "Navigation failed:" and the kind label, which is stable.
  await expectClassifiedNavigationError(page, consoleErrors, "Navigation failed:")
})
