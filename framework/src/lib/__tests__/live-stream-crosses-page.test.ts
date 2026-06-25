/**
 * The live-page heartbeat tears its streaming connection down only when
 * navigation crosses to a different PAGE (pathname). Aborting on a
 * same-page refetch (a search keystroke flipping `?q`) rejects the
 * committed payload's pending references ("Connection closed.") and drops
 * the open overlay mid-interaction — the dialog-vanish bug. This pins the
 * decision: same-page → keep the stream; cross-page → tear it.
 */

import { describe, expect, it } from "vitest"
import { _liveStreamCrossesPage } from "../live-page-heartbeat.tsx"

describe("_liveStreamCrossesPage", () => {
  it("keeps the stream for a same-page refetch (query-only change)", () => {
    // The search keystroke case: same pathname, `?q` flips. MUST NOT tear.
    expect(_liveStreamCrossesPage("/", "http://localhost/?search=url&q=pikachu")).toBe(false)
    expect(_liveStreamCrossesPage("/pokemon", "http://localhost/pokemon?q=x")).toBe(false)
    // Opening/closing the overlay flips `?search`, still same pathname.
    expect(_liveStreamCrossesPage("/", "http://localhost/?search=1")).toBe(false)
    expect(_liveStreamCrossesPage("/", "http://localhost/")).toBe(false)
  })

  it("tears the stream for a real page change (pathname)", () => {
    expect(_liveStreamCrossesPage("/", "http://localhost/cms-demo")).toBe(true)
    expect(_liveStreamCrossesPage("/pokemon", "http://localhost/pokemon/25")).toBe(true)
  })

  it("treats an unknown / unparseable destination as same-page (don't tear)", () => {
    expect(_liveStreamCrossesPage("/", undefined)).toBe(false)
    expect(_liveStreamCrossesPage("/", "")).toBe(false)
    expect(_liveStreamCrossesPage("/", "::not a url::")).toBe(false)
  })
})
