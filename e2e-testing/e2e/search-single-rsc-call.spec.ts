import { test, expect, waitForPageInteractive } from "./fixtures"

/**
 * Regression guard: typing a single character in the search input must
 * dispatch exactly one refetch — its own. LoadMore's
 * IntersectionObserver is geometrically still "intersecting" the
 * viewport while the search <dialog> is open on top of it — dialog
 * `inert` / occlusion doesn't affect IntersectionObserver. Without the
 * guard in load-more.tsx, LoadMore races with the keystroke and bumps
 * `?pages=`, producing a second dispatch for page-N + load-more.
 *
 * A keystroke is a plain `navigate()`: one whole-tree statement whose
 * segment fp-skips everything except the `?q` readers (the search
 * stages). The STATED URL is what names a dispatch — the keystroke
 * moves `?q`, a LoadMore firing moves `?pages` — so the guard reads
 * the statement's params.
 *
 * The stated URL is also the only stable identity a dispatch has here,
 * because one logical statement legitimately reaches the wire more
 * than once and on more than one carrier:
 *  - carriers vary with connection timing — a statement fired
 *    pre-establishment latches and rides the attach it triggers
 *    (stated as the attach URL), an established connection takes it as
 *    a `url` frame on a `/__parton/channel` envelope, the auto-upgrade
 *    moves that envelope onto the `/__parton/ws` socket, and a
 *    discrete `_.rsc` GET is the remaining carrier;
 *  - envelopes are the RELIABLE class, so an unacked one is
 *    retransmitted with its original seq;
 *  - the heartbeat reopens its connection at the now-current URL,
 *    restating it as transport.
 * All of those state the SAME url, so counting DISTINCT stated URLs
 * counts logical dispatches. A LoadMore race states a different one
 * (`?pages=`), so it stays visible as a second distinct URL.
 */

type Statement = {
  /** The stated URL — its params name the dispatch, and it is the
   *  dispatch's identity across carriers and retransmits. */
  url: string
  transport: "rsc" | "attach" | "channel" | "ws"
}

test("single keystroke in search dispatches exactly one RSC call", async ({ page }) => {
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

  // The upgraded socket — envelopes ride it as text frames.
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

  // 1. Load with search open (empty query) — only stage-1 renders initially.
  //    Match the user's observed scenario: first-keystroke types 'p' before
  //    LoadMore's IntersectionObserver has finished its self-propagating
  //    firings on the underlying product list.
  await page.goto("/?search=url")
  const input = page.locator("input[type=text][data-hydrated]")
  await input.waitFor({ state: "visible", timeout: 15000 })
  // Wait for the interactive marker so the input's onChange pipeline
  // is wired — a keystroke fired earlier is silently lost (text input
  // is not covered by React's discrete-event replay).
  await waitForPageInteractive(page)

  // 2. Focus first, then arm — the recorder observes the keystroke and
  //    nothing before it.
  await input.focus()
  await input.press("End")
  armed = true

  // 3. Type exactly one character.
  await input.press("p")

  // 4. Wait long enough for the stages refetch (stage-3 has 2s delay) and
  //    for any spurious LoadMore firings to round-trip.
  await page.waitForTimeout(3000)

  // One logical dispatch per distinct stated URL.
  const dispatches = [...new Set(statements.map((s) => s.url))]

  // Report what we saw (helps diagnose failures).
  console.log(
    `\n=== keystroke: ${dispatches.length} dispatch(es) from ${statements.length} wire statement(s) ===`,
  )
  for (const s of statements) console.log(`  ${s.transport} ${s.url}`)

  const params = (url: string) => new URL(url, "http://localhost").searchParams
  // The keystroke's own dispatch: it moved `?q` to the typed character.
  const queryDispatches = dispatches.filter((url) => params(url).get("q") === "p")
  // Anything else the keystroke shook loose — a LoadMore firing shows
  // up here as a `?pages=` bump.
  const otherDispatches = dispatches.filter((url) => params(url).get("q") !== "p")

  expect(queryDispatches.length, "expected exactly one dispatch for the search query").toBe(1)
  expect(
    otherDispatches,
    `expected no unrelated dispatches; got: ${JSON.stringify(otherDispatches)}`,
  ).toHaveLength(0)
})
