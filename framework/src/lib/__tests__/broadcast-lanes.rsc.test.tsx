/**
 * Broadcast lanes (delivery-plane D2) — render once, fan out to N
 * viewers — end to end through the production pieces: two REAL live
 * drives (`driveSegmentedResponse`) parked on the SAME page in the
 * SAME scope bucket, `refreshSelector` / deadline-wheel wakes, and the
 * client splitter consuming both wires.
 *
 * The claims under test:
 *   1. COALESCING — a bump relevant to both connections renders the
 *      touched parton ONCE (the first drainer publishes into the
 *      broadcast slot; the second consumes the bytes), and both wires
 *      carry the identical fresh body.
 *   2. GENERATION — a newer bump never serves an older slot: the next
 *      round's bodies reflect the new generation, one fresh render per
 *      round.
 *   3. ELIGIBILITY — a per-viewer axis in the dep record (a `cookie()`
 *      read, a `session()` read, an ephemeral-storage cell, a
 *      request-derived cell partition) keeps the lane per-connection:
 *      each viewer renders its own.
 *   4. FP-SKIP PRESERVED — an expiry wake on a stable-fp parton: the
 *      publisher's body renders once; a connection whose mirror holds
 *      the generation (and whose snapshot was already refreshed) ships
 *      its own skip PLACEHOLDER, never the broadcast body.
 *   5. SLOT LIFECYCLE — the route's slots exist while subscribers do
 *      and drop with the last subscriber's exit.
 */

import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  _clearInvalidationRegistry,
  buildCellSelector,
  refreshSelector,
} from "../../runtime/invalidation-registry.ts"
import { getEphemeralCellStorage } from "../../runtime/cell-storage.ts"
import {
  decodeLane,
  drainPayloadSegment,
  type DriveHandle,
  freshLiveScope,
  withLiveDrive,
} from "../../test/live-drive.tsx"
import { _broadcastStats, _clearBroadcastSlots } from "../broadcast.ts"
import { localCell } from "../cell.ts"
import type { DemuxedLane } from "../fp-trailer-split.ts"
import { clearRegistry } from "../partial-registry.ts"
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx"
import { tag } from "../current-parton.ts"
import { cookie, expires, session, time } from "../server-hooks.ts"

// ── Fixtures ──────────────────────────────────────────────────────────

const renders = {
  shared: 0,
  cookie: 0,
  session: 0,
  ephemeral: 0,
  partitioned: 0,
  clock: 0,
}

/** Eligible: one inline localCell (persistent global storage, constant
 *  partition) — the dep record is `cell:bcast-shared/value`, nothing
 *  per-viewer. */
const SharedLeaf = parton(
  Object.assign(
    async function SharedLeafRender(_: RenderArgs) {
      renders.shared++
      const v = await localCell("value", { shape: "number", initial: 0 })
      return <span data-shared>{`shared-${renders.shared}-${String(v.value)}`}</span>
    },
    { displayName: "bcast-shared" },
  ),
)
const SHARED_CELL_SELECTOR = buildCellSelector("bcast-shared/value", {})

/** Ineligible: a `cookie()` read is a per-viewer axis. */
const CookieLeaf = parton(
  Object.assign(
    function CookieLeafRender(_: RenderArgs) {
      tag("bcast-cookie") // the wake subscription the round's bump targets
      renders.cookie++
      const c = cookie("bcast_c") ?? ""
      return <span>{`cookie-${renders.cookie}-${c}`}</span>
    },
    { displayName: "bcast-cookie" },
  ),
)

/** Ineligible: a `session()` read is a per-viewer axis. */
const SessionLeaf = parton(
  Object.assign(
    function SessionLeafRender(_: RenderArgs) {
      tag("bcast-session") // the wake subscription the round's bump targets
      renders.session++
      return <span>{`session-${renders.session}-${session().id}`}</span>
    },
    { displayName: "bcast-session" },
  ),
)

/** Ineligible: ephemeral storage is request/connection-scoped state. */
const ephemeralCell = localCell({
  id: "bcast.ephemeral",
  shape: "number",
  initial: 0,
  storage: getEphemeralCellStorage,
})
const EphemeralLeaf = parton(
  Object.assign(
    async function EphemeralLeafRender(_: RenderArgs) {
      renders.ephemeral++
      const v = await ephemeralCell.resolve({})
      return <span>{`ephemeral-${renders.ephemeral}-${String(v.value)}`}</span>
    },
    { displayName: "bcast-ephemeral" },
  ),
)

/** Ineligible: a request-derived partition callback can bake a
 *  per-viewer identity into the partition without a tracked read. */
const partitionedCell = localCell({
  id: "bcast.partitioned",
  shape: "number",
  initial: 0,
  partition: ({ session: s }) => ({ sid: s.id || "anon" }),
})
const PartitionedLeaf = parton(
  Object.assign(
    async function PartitionedLeafRender(_: RenderArgs) {
      renders.partitioned++
      const v = await partitionedCell.resolve()
      return <span>{`partitioned-${renders.partitioned}-${String(v.value)}`}</span>
    },
    { displayName: "bcast-partitioned" },
  ),
)

/** Expiry ticker with a STABLE fp (no tracked reads, no bumps): the
 *  fp-skip-preservation fixture. */
const TickLeaf = parton(
  Object.assign(
    function TickLeafRender(_: RenderArgs) {
      renders.clock++
      expires(time().in(80))
      return <time data-clock>{`tick-${renders.clock}`}</time>
    },
    { displayName: "bcast-clock" },
  ),
)

function pageOf(children: ReactNode): () => ReactNode {
  return () => <PartialRoot>{children}</PartialRoot>
}

// ── Two-viewer harness ────────────────────────────────────────────────

/** Open two live drives on the SAME url + scope (one shared route
 *  bucket, one broadcast slot space), drain both initial segments, and
 *  hand both handles to `run`. Shutdown wakes both parked drivers. */
async function withTwoViewers(
  url: string,
  page: () => ReactNode,
  scope: string,
  wakeSelector: string,
  run: (a: DriveHandle, b: DriveHandle) => Promise<void>,
): Promise<void> {
  await withLiveDrive(url, page, scope, async (a) => {
    const firstA = await a.segments.next()
    if (firstA.done || firstA.value.kind !== "payload") throw new Error("expected payload A0")
    await drainPayloadSegment(firstA.value)
    await withLiveDrive(url, page, scope, async (b) => {
      const firstB = await b.segments.next()
      if (firstB.done || firstB.value.kind !== "payload") throw new Error("expected payload B0")
      await drainPayloadSegment(firstB.value)
      await run(a, b)
      await b.shutdown(wakeSelector)
    })
    await a.shutdown(wakeSelector)
  })
}

/** The connection's lanes-region iterator (the segment after payload 0). */
async function lanesOf(h: DriveHandle): Promise<AsyncIterator<DemuxedLane>> {
  const seg = await h.segments.next()
  if (seg.done || seg.value.kind !== "lanes") throw new Error("expected lanes segment")
  return seg.value.lanes[Symbol.asyncIterator]()
}

beforeEach(() => {
  _clearInvalidationRegistry()
  _clearBroadcastSlots()
  renders.shared = 0
  renders.cookie = 0
  renders.session = 0
  renders.ephemeral = 0
  renders.partitioned = 0
  renders.clock = 0
})

afterEach(() => {
  clearRegistry("all")
  _clearInvalidationRegistry()
  _clearBroadcastSlots()
})

describe("broadcast lanes — render once, fan out", () => {
  it("a shared bump renders ONCE and both wires carry the identical body; a newer bump renders the newer generation", async () => {
    await withTwoViewers(
      "http://localhost/bcast?live=1",
      pageOf(<SharedLeaf />),
      freshLiveScope("bcast-rsc"),
      SHARED_CELL_SELECTOR,
      async (a, b) => {
        expect(renders.shared).toBe(2) // the two cold opens
        // Both subscribers registered on the route's slot space.
        expect(_broadcastStats().subscribers).toBe(2)

        // ── Round 1: coalescing. ──
        renders.shared = 0
        refreshSelector(SHARED_CELL_SELECTOR)
        const lanesA = await lanesOf(a)
        const lanesB = await lanesOf(b)
        const laneA = (await lanesA.next()).value as DemuxedLane
        const laneB = (await lanesB.next()).value as DemuxedLane
        expect(laneA.partonId).toBe("bcast-shared")
        expect(laneB.partonId).toBe("bcast-shared")
        const bodyA = await decodeLane(laneA)
        const bodyB = await decodeLane(laneB)
        // ONE render served both wires…
        expect(renders.shared).toBe(1)
        expect(bodyA.bodyText).toContain("shared-1-")
        // …with byte-identical bodies (the broadcast slot's whole point).
        expect(bodyB.bodyText).toBe(bodyA.bodyText)

        // ── Round 2: generation. A newer bump can never be served the
        // older slot — both wires carry the NEW generation's body, from
        // exactly one fresh render. ──
        refreshSelector(SHARED_CELL_SELECTOR)
        const laneA2 = (await lanesA.next()).value as DemuxedLane
        const laneB2 = (await lanesB.next()).value as DemuxedLane
        const bodyA2 = await decodeLane(laneA2)
        const bodyB2 = await decodeLane(laneB2)
        expect(renders.shared).toBe(2)
        expect(bodyA2.bodyText).toContain("shared-2-")
        expect(bodyB2.bodyText).toBe(bodyA2.bodyText)
        expect(bodyA2.bodyText).not.toBe(bodyA.bodyText)
      },
    )
  })

  it("a cookie() dep keeps the lane per-connection (each viewer renders its own)", async () => {
    await withTwoViewers(
      "http://localhost/bcast-cookie?live=1",
      pageOf(<CookieLeaf />),
      freshLiveScope("bcast-rsc"),
      "bcast-cookie",
      async (a, b) => {
        renders.cookie = 0
        refreshSelector("bcast-cookie")
        const laneA = (await (await lanesOf(a)).next()).value as DemuxedLane
        const laneB = (await (await lanesOf(b)).next()).value as DemuxedLane
        await decodeLane(laneA)
        await decodeLane(laneB)
        expect(renders.cookie).toBe(2)
      },
    )
  })

  it("a session() dep keeps the lane per-connection", async () => {
    await withTwoViewers(
      "http://localhost/bcast-session?live=1",
      pageOf(<SessionLeaf />),
      freshLiveScope("bcast-rsc"),
      "bcast-session",
      async (a, b) => {
        renders.session = 0
        refreshSelector("bcast-session")
        const laneA = (await (await lanesOf(a)).next()).value as DemuxedLane
        const laneB = (await (await lanesOf(b)).next()).value as DemuxedLane
        await decodeLane(laneA)
        await decodeLane(laneB)
        expect(renders.session).toBe(2)
      },
    )
  })

  it("an ephemeral-storage cell keeps the lane per-connection", async () => {
    await withTwoViewers(
      "http://localhost/bcast-ephemeral?live=1",
      pageOf(<EphemeralLeaf />),
      freshLiveScope("bcast-rsc"),
      buildCellSelector("bcast.ephemeral", {}),
      async (a, b) => {
        renders.ephemeral = 0
        refreshSelector(buildCellSelector("bcast.ephemeral", {}))
        const laneA = (await (await lanesOf(a)).next()).value as DemuxedLane
        const laneB = (await (await lanesOf(b)).next()).value as DemuxedLane
        await decodeLane(laneA)
        await decodeLane(laneB)
        expect(renders.ephemeral).toBe(2)
      },
    )
  })

  it("a request-derived cell partition keeps the lane per-connection", async () => {
    await withTwoViewers(
      "http://localhost/bcast-partitioned?live=1",
      pageOf(<PartitionedLeaf />),
      freshLiveScope("bcast-rsc"),
      buildCellSelector("bcast.partitioned", { sid: "anon" }),
      async (a, b) => {
        renders.partitioned = 0
        refreshSelector(buildCellSelector("bcast.partitioned", { sid: "anon" }))
        const laneA = (await (await lanesOf(a)).next()).value as DemuxedLane
        const laneB = (await (await lanesOf(b)).next()).value as DemuxedLane
        await decodeLane(laneA)
        await decodeLane(laneB)
        expect(renders.partitioned).toBe(2)
      },
    )
  })

  it("per-connection fp-skip is preserved: an expiry wake renders once; the mirror-holding viewer ships its own skip placeholder", async () => {
    await withTwoViewers(
      "http://localhost/bcast-clock?live=1",
      pageOf(<TickLeaf />),
      freshLiveScope("bcast-rsc"),
      "bcast-clock",
      async (a, b) => {
        expect(renders.clock).toBe(2)
        renders.clock = 0
        // No bump — the 80ms `expires()` boundary alone wakes both
        // connections' deadline wheels in the same grid slot.
        const lanesA = await lanesOf(a)
        const lanesB = await lanesOf(b)
        const laneA = (await lanesA.next()).value as DemuxedLane
        const laneB = (await lanesB.next()).value as DemuxedLane
        const bodyA = await decodeLane(laneA)
        const bodyB = await decodeLane(laneB)
        // Exactly ONE body render served the round.
        expect(renders.clock).toBe(1)
        // The parton's fp is STABLE across expiry rounds (no tracked
        // reads, no bump), so a viewer whose drain runs after the fresh
        // snapshot committed holds the current generation in its mirror
        // and must ship the zero-byte skip PLACEHOLDER — its own
        // per-connection verdict, never the broadcast body. The other
        // wire carries the fresh body.
        const texts = [bodyA.bodyText, bodyB.bodyText]
        const withBody = texts.filter((t) => t.includes("tick-"))
        const withPlaceholder = texts.filter((t) => !t.includes("tick-"))
        expect(withBody.length).toBe(1)
        expect(withPlaceholder.length).toBe(1)
        expect(withPlaceholder[0]).toContain("data-partial-id")

        // ── Miss fallback: the NEXT boundary's round finds the prior
        // slot EXPIRED (its validity is bounded by the body's declared
        // `expires()`), so it must be a fresh render — an expired slot
        // is never served, over-fetch never stale. ──
        const laneA2 = (await lanesA.next()).value as DemuxedLane
        const laneB2 = (await lanesB.next()).value as DemuxedLane
        await decodeLane(laneA2)
        await decodeLane(laneB2)
        expect(renders.clock).toBe(2)
      },
    )
  })

  it("the route's slots drop with the last subscriber's exit", async () => {
    const scope = freshLiveScope("bcast-rsc")
    await withTwoViewers(
      "http://localhost/bcast-drop?live=1",
      pageOf(<SharedLeaf />),
      scope,
      SHARED_CELL_SELECTOR,
      async (a, b) => {
        refreshSelector(SHARED_CELL_SELECTOR)
        const laneA = (await (await lanesOf(a)).next()).value as DemuxedLane
        const laneB = (await (await lanesOf(b)).next()).value as DemuxedLane
        await decodeLane(laneA)
        await decodeLane(laneB)
        const stats = _broadcastStats()
        expect(stats.subscribers).toBe(2)
        expect(stats.slots).toBe(1)
      },
    )
    // Both drives closed — their subscriptions released the route, and
    // the last release dropped the slot space wholesale.
    const after = _broadcastStats()
    expect(after.subscribers).toBe(0)
    expect(after.routes).toBe(0)
    expect(after.slots).toBe(0)
  })
})
