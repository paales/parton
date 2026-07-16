import {
  clearCaches,
  expect,
  test,
  waitForLiveConnection,
  waitForPageInteractive,
} from "./fixtures"

/**
 * The fp-skip manifest carrier on an ACTION POST splits by attachment.
 * The manifest — the `id:matchKey:fp` tokens the client holds — never
 * rides the URL: an attached POST omits it entirely (the server's
 * session mirror knows this connection's holdings), and an UNATTACHED
 * one (degraded / pre-establishment, no mirror to consult) carries it
 * as the `x-parton-cached` request HEADER. This pins both legs:
 *
 *   1. degraded — the channel is proven broken (`data-parton-degraded`),
 *      so the action fires with no live connection: the POST carries
 *      `x-parton-cached`, and the response fp-skips the unchanged shell
 *      (`app-nav`) against it — a placeholder, not the re-serialized
 *      nav — proving the header drove the skip;
 *   2. attached — the fetch channel is open (`data-parton-live`), so the
 *      same action names its connection (`x-parton-conn`) and omits the
 *      manifest header: the mirror supplies the holdings.
 *
 * The WS advertisement is suppressed in both so the auto-upgrade stands
 * down and the fetch transport (whose degrade machinery leg 1 exercises)
 * stays the only one.
 */

test.beforeEach(async ({ baseURL, page }) => {
  await clearCaches(baseURL)
  await page.addInitScript(() => {
    Object.defineProperty(window, "__partonWsAvailable", {
      get: () => undefined,
      set: () => {},
      configurable: true,
    })
  })
})

test("a degraded action POST carries the x-parton-cached header and its response fp-skips against it", async ({
  page,
}) => {
  // The degrade chain (establish → commit → ack → fail → sticky degrade)
  // plus the intercepted action round-trip is slow under a saturated
  // parallel run; give it the headroom rather than race the give-up.
  test.slow()
  // Break the duplex: envelopes never reach the server, so the first
  // ack can't be said and the page degrades stickily. The attach still
  // establishes and deliveries commit — the client holds real fps to
  // advertise.
  await page.route("**/__parton/channel", (route) => route.abort("failed"))

  let captured: { cached: string | undefined; conn: string | undefined; body: string } | null = null
  await page.route("**/*_.rsc", async (route) => {
    const headers = route.request().headers()
    const response = await route.fetch()
    const body = await response.text()
    captured = {
      cached: headers["x-parton-cached"],
      conn: headers["x-parton-conn"],
      body,
    }
    await route.fulfill({ response, body })
  })

  await page.goto("/forms-demo")
  await waitForPageInteractive(page)
  await page.getByTestId("forms-save").waitFor({ state: "visible", timeout: 15000 })
  await page.locator("html[data-parton-degraded]").waitFor({ state: "attached", timeout: 20000 })

  // Fire the plain server function (`saveCard`). No live connection →
  // the unattached leg of `setServerCallback`.
  await page.getByTestId("forms-save").click({ timeout: 20000 })
  await expect.poll(() => captured, { timeout: 20000 }).not.toBeNull()

  const cap = captured!
  // (a) the manifest rides the header, not the URL — with real
  // `id:matchKey:fp` tokens (matchKey and fp are 16-hex each).
  expect(cap.conn).toBeUndefined()
  expect(cap.cached).toBeTruthy()
  expect(cap.cached).toMatch(/app-nav:[0-9a-f]{16}:[0-9a-f]{16}/)

  // (b) the response fp-skips the unchanged shell against that manifest:
  // `app-nav` collapses to a hidden placeholder (`data-partial`), and
  // its nav chrome is NOT re-serialized.
  expect(cap.body).toMatch(/"data-partial":true,"data-partial-id":"app-nav"/)
  expect(cap.body).not.toContain("flex flex-wrap gap-1 border-b pb-3")
})

test("an attached action POST omits the manifest header — the session mirror supplies holdings", async ({
  page,
}) => {
  let captured: { cached: string | undefined; conn: string | undefined } | null = null
  await page.route("**/*_.rsc", async (route) => {
    const headers = route.request().headers()
    captured = { cached: headers["x-parton-cached"], conn: headers["x-parton-conn"] }
    await route.continue()
  })

  await page.goto("/forms-demo")
  await waitForPageInteractive(page)
  // The fetch channel is open: the action can name a live connection.
  await waitForLiveConnection(page)

  await page.getByTestId("forms-save").click()
  await expect.poll(() => captured, { timeout: 15000 }).not.toBeNull()

  const cap = captured!
  // (c) the attached POST names its connection and carries NO manifest.
  expect(cap.conn).toBeTruthy()
  expect(cap.cached).toBeUndefined()
})
