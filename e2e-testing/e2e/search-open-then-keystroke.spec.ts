import { test, expect, waitForPageInteractive } from "./fixtures"

/**
 * Regression guard for the manual flow that double-loaded in
 * production:
 *
 *   1. Land on `/` (search closed).
 *   2. Click "Search (URL)" — the overlay opens on a `?search=1`
 *      navigate (history: push).
 *   3. Type a single character ('p').
 *
 * The sibling `search-single-rsc-call` spec shortcuts the open by
 * loading `/?search=url` directly and asserts the keystroke fires one
 * dispatch. This spec keeps the *interactive* open (button click →
 * navigate) in front of the keystroke, because that open is what
 * leaves the client holding a duplicate fingerprint for the overview
 * partial — and a duplicate subscription makes a single stage response
 * paint the results grid twice.
 *
 * We assert on two surfaces:
 *  - network: exactly one dispatch, and it is the keystroke's own —
 *    the statement that moved `?q`. A keystroke is a plain
 *    `navigate()`, so the STATED URL names the dispatch; a racing
 *    LoadMore firing would show up as a `?pages=` bump. The stated URL
 *    is also a dispatch's only stable identity here, because one
 *    logical statement legitimately reaches the wire more than once
 *    and on more than one carrier — it may ride the attach it triggers
 *    pre-establishment, a `url` frame on a `/__parton/channel`
 *    envelope once established, a text frame on the upgraded
 *    `/__parton/ws` socket, or a discrete `_.rsc` GET; envelopes are
 *    the RELIABLE class and retransmit; and the heartbeat reopens at
 *    the now-current URL. All of those state the SAME url, so counting
 *    DISTINCT stated URLs counts logical dispatches, while a LoadMore
 *    race stays visible as a second distinct URL.
 *  - DOM: the stage-1 results grid mounts exactly once after the
 *    keystroke (no second "load" repaint).
 */

type Statement = {
  /** The stated URL — its params name the dispatch, and it is the
   *  dispatch's identity across carriers and retransmits. */
  url: string
  transport: "rsc" | "attach" | "channel" | "ws"
}

test("opening the overlay then typing loads the results exactly once", async ({ page }) => {
  const statements: Statement[] = []
  let armed = false
  const record = (transport: Statement["transport"], url: string) => {
    if (armed) statements.push({ url, transport })
  }

  page.on("request", (req) => {
    const url = req.url()
    if (url.includes("_.rsc")) {
      // The heartbeat's live attach POST is transport, not a dispatch.
      if (new URL(url).searchParams.get("live") === "1") return
      record("rsc", url)
      return
    }
    if (url.includes("/__parton/live")) {
      // A statement fired pre-establishment latches and rides the
      // attach it triggers, which states it as the attach URL.
      try {
        const statement = JSON.parse(req.postData() ?? "") as { url?: string }
        if (statement.url) record("attach", statement.url)
      } catch {}
      return
    }
    if (!url.includes("/__parton/channel")) return
    try {
      const envelope = JSON.parse(req.postData() ?? "") as {
        frames?: Array<{ kind: string; url?: string; frame?: string[] }>
      }
      for (const f of envelope.frames ?? []) {
        // A `frame`-keyed url frame is a frame nav, not a page statement.
        if (f.kind !== "url" || !f.url || f.frame) continue
        record("channel", f.url)
      }
    } catch {}
  })

  page.on("websocket", (ws) => {
    if (!ws.url().includes("/__parton/ws")) return
    ws.on("framesent", (frame) => {
      if (typeof frame.payload !== "string") return
      try {
        const message = JSON.parse(frame.payload) as {
          connection?: string
          frames?: Array<{ kind: string; url?: string; frame?: string[] }>
        }
        if (typeof message.connection !== "string") return
        for (const f of message.frames ?? []) {
          if (f.kind !== "url" || !f.url || f.frame) continue
          record("ws", f.url)
        }
      } catch {}
    })
  })

  // 1. Land on the overview with search closed.
  await page.goto("/")
  const openButton = page
    .getByRole("button", { name: "Search (URL)" })
    .and(page.locator("[data-hydrated]"))
  await openButton.waitFor({ state: "visible", timeout: 15000 })
  // Wait for the interactive marker so the click handler is wired.
  await waitForPageInteractive(page)

  // 2. Open the overlay the way a user does — by clicking the button.
  await openButton.click()
  const input = page.locator("dialog input[type=text][data-hydrated]")
  await input.waitFor({ state: "visible", timeout: 15000 })

  // 3. Install a DOM tracker that counts every time a fresh stage-1
  //    results grid is inserted. One keystroke → one mount. A second
  //    insertion is the "results loaded twice" symptom.
  await page.evaluate(() => {
    const w = window as unknown as {
      __load: { mounts: number; armed: boolean }
    }
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

  // 4. Focus, then arm both trackers — they observe the keystroke and
  //    nothing before it.
  await input.focus()
  await page.evaluate(() => {
    ;(window as unknown as { __load: { armed: boolean } }).__load.armed = true
  })
  armed = true

  // 5. Type one character.
  await input.press("p")

  // 6. Let the stages refetch (stage-3 has a 2s delay) and any
  //    spurious second load round-trip + repaint.
  await page.waitForTimeout(3000)

  const mounts = await page.evaluate(
    () => (window as unknown as { __load: { mounts: number } }).__load.mounts,
  )

  // One logical dispatch per distinct stated URL.
  const dispatches = [...new Set(statements.map((s) => s.url))]

  const params = (url: string) => new URL(url, "http://localhost").searchParams
  // The keystroke's own dispatch: it moved `?q` to the typed character.
  const queryCalls = dispatches.filter((url) => params(url).get("q") === "p")
  // Anything else the keystroke shook loose — a LoadMore firing shows
  // up here as a `?pages=` bump.
  const otherCalls = dispatches.filter((url) => params(url).get("q") !== "p")

  console.log(
    `\n=== after keystroke: ${dispatches.length} dispatch(es), ${mounts} grid mount(s) ===`,
  )
  for (const s of statements) console.log(`  ${s.transport} ${s.url}`)

  expect(
    queryCalls.length,
    `expected exactly one search-query dispatch; got ${queryCalls.length}`,
  ).toBe(1)
  expect(
    otherCalls,
    `expected no unrelated dispatches; got: ${JSON.stringify(otherCalls)}`,
  ).toHaveLength(0)
  expect(
    mounts,
    `expected the results grid to load once; it mounted ${mounts} times (results loaded twice)`,
  ).toBe(1)
})
