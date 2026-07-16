/**
 * The error-recovery contract riding the byte cache
 * (`docs/reference/errors.md`):
 *
 *   - a failed fresh render serves the axis's last-known-good bytes,
 *     wrapped in the explicit staleness marker (`PartonStaleProvider`);
 *   - framework sentinels (notFound / redirect) pass through untouched
 *     — no stale serve, no failure record, no store;
 *   - attempts follow the capped exponential backoff: inside the
 *     window a miss serves last-known-good WITHOUT re-attempting, past
 *     it a re-attempt runs and escalates;
 *   - a success stores, clears the streak, and serves fresh unmarked;
 *   - with NO last-known-good the error streams to the boundary (the
 *     bounded first-visit state) and nothing is ever stored;
 *   - `staleIfError: false` opts out of stale serving entirely.
 *
 * Prod-tier for the same reason as cache-write-key: the assertions
 * grep the wire for rendered stamps and marker elements, and the DEV
 * Flight build leaks discarded elements into debug-info rows — false
 * sightings the production build cannot produce.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { computeRouteKey, parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { runWithRequestAsync } from "../../runtime/context.ts"
import {
  clearRegistry,
  effectiveExpiresAt,
  enterRequestRegistry,
  lookupPartial,
} from "../partial-registry.ts"
import {
  _cacheStats,
  _clearCache,
  _setErrorRetrySchedule,
  onPartonError,
  type PartonErrorEvent,
} from "../cache.tsx"
import { notFound } from "../../runtime/errors.ts"

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function committedSnap(url: string, id: string) {
  const { result } = await runWithRequestAsync(new Request(url), async () => {
    enterRequestRegistry(computeRouteKey(url), "cache")
    return lookupPartial(id)
  })
  return result
}

// ─── Fixture specs ─────────────────────────────────────────────────────
//
// Stamps are `<name>:render#<seq>` — the wire currency the assertions
// grep. Every spec byte-caches with a 50ms fresh window so a short
// sleep forces the miss path.

let flakyMode: "ok" | "fail" = "ok"
let flakySeq = 0
const Flaky = parton(
  async function ErFlakyRender(_: RenderArgs) {
    flakySeq++
    if (flakyMode === "fail") throw new Error("er-flaky loader down")
    return <span>{`er-flaky:render#${flakySeq}`}</span>
  },
  { cache: { maxAge: 0.05 } },
)
const flakyTree = (
  <PartialRoot>
    <Flaky />
  </PartialRoot>
)

let sentinelMode: "ok" | "not-found" = "ok"
let sentinelSeq = 0
const Sentinel = parton(
  async function ErSentinelRender(_: RenderArgs) {
    sentinelSeq++
    if (sentinelMode === "not-found") notFound()
    return <span>{`er-sentinel:render#${sentinelSeq}`}</span>
  },
  { cache: { maxAge: 0.05 } },
)
const sentinelTree = (
  <PartialRoot>
    <Sentinel />
  </PartialRoot>
)

let coldMode: "ok" | "fail" = "fail"
const Cold = parton(
  async function ErColdRender(_: RenderArgs) {
    if (coldMode === "fail") throw new Error("er-cold loader down")
    return <span>{`er-cold:ok`}</span>
  },
  { cache: { maxAge: 0.05 } },
)
const coldTree = (
  <PartialRoot>
    <Cold />
  </PartialRoot>
)

let optOutMode: "ok" | "fail" = "ok"
let optOutSeq = 0
const OptOut = parton(
  Object.assign(
    async function ErOptOutRender(_: RenderArgs) {
      optOutSeq++
      if (optOutMode === "fail") throw new Error("er-optout loader down")
      return <span>{`er-optout:render#${optOutSeq}`}</span>
    },
    { displayName: "er-optout" },
  ),
  { cache: { maxAge: 0.05, staleIfError: false } },
)
const optOutTree = (
  <PartialRoot>
    <OptOut />
  </PartialRoot>
)

// ─── Harness state ─────────────────────────────────────────────────────

let events: PartonErrorEvent[] = []
let unregister: (() => void) | undefined
let errorSpy: ReturnType<typeof vi.spyOn> | undefined

beforeAll(() => {
  unregister = onPartonError((e) => events.push(e))
  // The Flight render's onError reporter logs each expected throw with
  // a digest — deliberate failures would otherwise flood the output.
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterAll(() => {
  unregister?.()
  errorSpy?.mockRestore()
})

beforeEach(async () => {
  clearRegistry("all")
  await _clearCache()
  _setErrorRetrySchedule({ baseMs: 100, capMs: 400 })
  events = []
  flakyMode = "ok"
  flakySeq = 0
  sentinelMode = "ok"
  sentinelSeq = 0
  coldMode = "fail"
  optOutMode = "ok"
  optOutSeq = 0
})

afterEach(() => {
  _setErrorRetrySchedule()
})

async function storedKeyCount(): Promise<number> {
  return (await _cacheStats()).size
}

describe.skipIf(process.env.NODE_ENV !== "production")(
  "byte cache — error recovery (serve-last-known-good + retry/backoff)",
  () => {
    const url = "http://t/er-flaky"

    it("serves last-known-good with the staleness marker when a fresh render throws", async () => {
      const r1 = await flightAt(url, flakyTree)
      expect(r1).toContain("er-flaky:render#1")
      await sleep(80) // background store settles; entry expires (50ms)

      flakyMode = "fail"
      const r2 = await flightAt(url, flakyTree)
      // Last-known-good bytes, not the error card:
      expect(r2).toContain("er-flaky:render#1")
      expect(r2).not.toContain("er-flaky loader down")
      // …wrapped in the explicit marker with the streak's shape:
      expect(r2).toContain("PartonStaleProvider")
      expect(r2).toContain('"attempts":1')

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ partonId: "er-flaky", servedStale: true, attempts: 1 })
      expect(events[0].error).toBeInstanceOf(Error)
      expect((events[0].error as Error).message).toBe("er-flaky loader down")

      // The errored snapshot declares its own retry boundary — the
      // failure wrote `nextRetryAt` into the live wake-hint box, so the
      // deadline wheel (live connections) and the fp-skip TTL gate both
      // see the schedule as an ordinary `expires()` boundary.
      const snap = await committedSnap(url, "er-flaky")
      expect(snap).toBeDefined()
      expect(effectiveExpiresAt(snap!)).toBe(events[0].retryAt)
    })

    it("backoff gates attempts: inside the window last-known-good serves without re-running the loader; past it the attempt escalates", async () => {
      const r1 = await flightAt(url, flakyTree)
      expect(r1).toContain("er-flaky:render#1")
      await sleep(80)

      flakyMode = "fail"
      await flightAt(url, flakyTree) // attempt #1 → failure streak opens (retry +100ms)
      expect(events).toHaveLength(1)

      // Immediately again — inside the retry window. The body still
      // runs (partial.tsx invokes Render every pass; the rejection is
      // observed and discarded) but NO attempt is made: no new event,
      // marker still attempts:1.
      const inWindow = await flightAt(url, flakyTree)
      expect(inWindow).toContain("er-flaky:render#1")
      expect(inWindow).toContain('"attempts":1')
      expect(events).toHaveLength(1)

      // Past the boundary: a real re-attempt, escalated streak.
      await sleep(150)
      const past = await flightAt(url, flakyTree)
      expect(past).toContain("er-flaky:render#1")
      expect(past).toContain('"attempts":2')
      expect(events).toHaveLength(2)
      expect(events[1]).toMatchObject({ servedStale: true, attempts: 2 })
      expect(events[1].retryAt).toBeGreaterThan(events[0].retryAt)
    })

    it("a success clears the streak and serves fresh unmarked; the next failure serves the NEWEST good render", async () => {
      const r1 = await flightAt(url, flakyTree)
      expect(r1).toContain("er-flaky:render#1")
      await sleep(80)

      flakyMode = "fail"
      await flightAt(url, flakyTree) // streak opens
      await sleep(150) // past the retry boundary

      flakyMode = "ok"
      const recovered = await flightAt(url, flakyTree)
      expect(recovered).toMatch(/er-flaky:render#\d+/)
      expect(recovered).not.toContain("er-flaky:render#1")
      expect(recovered).not.toContain("PartonStaleProvider")
      const recoveredStamp = /er-flaky:render#(\d+)/.exec(recovered)![1]

      // A later failure serves the RECOVERED render, streak restarts at 1.
      await sleep(80)
      flakyMode = "fail"
      const again = await flightAt(url, flakyTree)
      expect(again).toContain(`er-flaky:render#${recoveredStamp}`)
      expect(again).toContain('"attempts":1')
    })

    it("framework sentinels pass through: no stale serve, no failure record, nothing stored", async () => {
      const surl = "http://t/er-sentinel"
      const r1 = await flightAt(surl, sentinelTree)
      expect(r1).toContain("er-sentinel:render#1")
      await sleep(80)
      const before = await storedKeyCount()

      sentinelMode = "not-found"
      const r2 = await flightAt(surl, sentinelTree)
      // The sentinel rides the wire as control flow — never replaced
      // by last-known-good, never marked stale:
      expect(r2).not.toContain("er-sentinel:render#1")
      expect(r2).not.toContain("PartonStaleProvider")
      expect(events).toHaveLength(0)
      // …and the errored bytes were not stored over the good entry.
      expect(await storedKeyCount()).toBe(before)
    })

    it("no last-known-good: the error streams to the boundary and nothing is stored", async () => {
      const curl = "http://t/er-cold"
      const before = await storedKeyCount()
      const r1 = await flightAt(curl, coldTree)
      expect(r1).not.toContain("er-cold:ok")
      expect(r1).not.toContain("PartonStaleProvider")
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ partonId: "er-cold", servedStale: false, attempts: 1 })
      expect(await storedKeyCount()).toBe(before)
    })

    it("staleIfError: false opts out — the error surfaces even with last-known-good bytes", async () => {
      const ourl = "http://t/er-optout"
      const r1 = await flightAt(ourl, optOutTree)
      expect(r1).toContain("er-optout:render#1")
      await sleep(80)

      optOutMode = "fail"
      const r2 = await flightAt(ourl, optOutTree)
      expect(r2).not.toContain("er-optout:render#1")
      expect(r2).not.toContain("PartonStaleProvider")
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ partonId: "er-optout", servedStale: false })
    })
  },
)
