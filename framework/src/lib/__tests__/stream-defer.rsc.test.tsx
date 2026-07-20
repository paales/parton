/**
 * `defer: "stream"` — the stream-defer stub under driver-owned
 * renders, end to end through the real drive (`driveSegmentedResponse`
 * with a `?live=1` attach, the lane demux, the channel endpoint).
 *
 * The claims under test:
 *   1. an enclosing parton's LANE render ships a pending-marked
 *      placeholder for a stream-deferred child instead of awaiting its
 *      body — the lane muxends with the child's gate still held — and
 *      the driver spawns a FORCED follow-up lane that delivers the
 *      child's full body (with its own delivery seq) once the gate
 *      releases;
 *   2. a render with NO driver (the plain document render) has no
 *      ambient stub capture, so the stream-deferred parton renders
 *      DEEP — no pending placeholder ever reaches that wire;
 *   3. the stub's boundary still REGISTERS a snapshot — the eager
 *      publish the forced follow-up lane resolves through
 *      `lookupPartial`;
 *   4. a WINDOW url statement's covering navigation segment stubs the
 *      child the same way, and the promised body lanes forced on the
 *      reopened lanes region.
 */

import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runWithRequestAsync } from "../../runtime/context.ts"
import { _clearInvalidationRegistry, refreshSelector } from "../../runtime/invalidation-registry.ts"
import {
  decodeLane,
  drainPayloadSegment,
  freshLiveScope,
  withLiveDrive,
} from "../../test/live-drive.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { CHANNEL_ENDPOINT, type ChannelEnvelope } from "../channel-protocol.ts"
import { handleChannelPost } from "../connection-session.ts"
import { tag } from "../current-parton.ts"
import type { DemuxedLane } from "../fp-trailer-split.ts"
import {
  computeRouteKey,
  PartialRoot,
  parton,
  stripPlacementFold,
  type RenderArgs,
} from "../partial.tsx"
import { clearRegistry, enterRequestRegistry, lookupPartial } from "../partial-registry.ts"
import { searchParam } from "../server-hooks.ts"

// Module-scope render counters — bumped every time a Render body runs,
// so assertions can distinguish "re-rendered" from "served placeholder".
const renders = { parent: 0, child: 0 }

// The child's stall gate. RESOLVED by default so renders that must go
// deep (segment 0, the no-driver document render) flow through; a test
// re-arms it right before the render whose stall it observes.
let releaseGate: () => void = () => {}
let gate: Promise<void> = Promise.resolve()
function armGate(): void {
  gate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
}

// The stream-deferred child: awaits the gate before returning
// distinctive text. `stamp` is the parent's render count — a changed
// call-site prop moves the child's fp, so an enclosing re-render
// reaches the stub branch instead of fp-skipping the child.
const StreamChild = parton(
  Object.assign(
    async function StreamChildRender({ stamp }: { stamp: number } & RenderArgs) {
      renders.child++
      await gate
      return <div data-stream-child>{`gated-content-${stamp}`}</div>
    },
    { displayName: "stream-child" },
  ),
  { defer: "stream" },
)

// The enclosing parton: subscribes to its bump signal by READING the
// tag, and reads `?x` so a window navigation with a changed `x` moves
// its fp (store-and-reread — recorded on render 1, folded from then on).
const StreamParent = parton(
  Object.assign(
    function StreamParentRender(_: RenderArgs) {
      tag("stream-parent")
      searchParam("x")
      renders.parent++
      return (
        <section data-parent-render={renders.parent}>
          <StreamChild stamp={renders.parent} />
        </section>
      )
    },
    { displayName: "stream-parent" },
  ),
)

function Page(): ReactNode {
  return (
    <PartialRoot>
      <StreamParent />
    </PartialRoot>
  )
}

// The stub-shape pair: same gated body, one WITHOUT a declared
// fallback and one WITH. The fallback-less stub must emit the
// PendingSlot gate DIRECTLY under the PartialErrorBoundary — an
// interposed `<Suspense fallback={null}>` would swallow the gate's
// suspension into an inner null boundary and commit the region empty
// instead of holding the ambient app fallback.
const StreamChildFallback = parton(
  Object.assign(
    async function StreamChildFallbackRender({ stamp }: { stamp: number } & RenderArgs) {
      await gate
      return <div data-stream-child-fb>{`gated-fb-content-${stamp}`}</div>
    },
    { displayName: "stream-child-fb" },
  ),
  { defer: "stream", fallback: <em data-child-fallback>child-loading</em> },
)

const renders2 = { shape: 0 }
const StubShapeParent = parton(
  Object.assign(
    function StubShapeParentRender(_: RenderArgs) {
      tag("stub-shape")
      renders2.shape++
      return (
        <section data-shape-render={renders2.shape}>
          <StreamChild stamp={renders2.shape} />
          <StreamChildFallback stamp={renders2.shape} />
        </section>
      )
    },
    { displayName: "stub-shape-parent" },
  ),
)

function ShapePage(): ReactNode {
  return (
    <PartialRoot>
      <StubShapeParent />
    </PartialRoot>
  )
}

beforeEach(() => {
  _clearInvalidationRegistry()
  renders.parent = 0
  renders.child = 0
  renders2.shape = 0
  releaseGate = () => {}
  gate = Promise.resolve()
})

afterEach(() => {
  releaseGate()
  clearRegistry("all")
  _clearInvalidationRegistry()
})

async function post(scope: string, envelope: ChannelEnvelope): Promise<number> {
  const request = new Request(`http://localhost${CHANNEL_ENDPOINT}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-scope": scope },
    body: JSON.stringify(envelope),
  })
  const { result } = await runWithRequestAsync(request, () => handleChannelPost(request))
  return result.status
}

async function nextLane(iter: AsyncIterator<DemuxedLane>): Promise<DemuxedLane> {
  const step = await iter.next()
  if (step.done) throw new Error("expected another lane")
  return step.value
}

async function waitForEntry(
  entries: Array<{ tag: string; body: string }>,
  predicate: (e: { tag: string; body: string }) => boolean,
  what: string,
): Promise<{ tag: string; body: string }> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const hit = entries.find(predicate)
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for wire entry: ${what}`)
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** The folded child id, read off the pending placeholder row an
 *  enclosing driver-owned body shipped for it. */
function pendingChildIdIn(wireText: string): string {
  const m = /"data-partial-id":"(stream-child[^"]*)"/.exec(wireText)
  if (!m) throw new Error("expected the child's pending placeholder row")
  return m[1]
}

describe("defer: 'stream' — the stub under driver-owned renders", () => {
  it("an enclosing lane ships the pending stub; the forced follow-up lane delivers the body", async () => {
    const scope = freshLiveScope("stream-defer")
    await withLiveDrive("http://localhost/stream?live=1", Page, scope, async (h) => {
      // Segment 0 has NO ambient stub capture — the child renders deep
      // (the gate is resolved), exactly like a document render.
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload")
        throw new Error("expected payload segment 0")
      const seg0 = await drainPayloadSegment(first.value)
      expect(seg0).toContain("gated-content-1")
      expect(seg0).not.toContain("data-partial-pending")

      const lanesSeg = await h.segments.next()
      if (lanesSeg.done || lanesSeg.value.kind !== "lanes")
        throw new Error("expected lanes segment")
      const laneIter = lanesSeg.value.lanes[Symbol.asyncIterator]()

      // From here the child's body stalls on the gate.
      armGate()

      // Bump the parent. Its lane re-renders the body; the child's fp
      // moved with the stamp prop, so the STUB branch (not fp-skip)
      // answers for it.
      refreshSelector("stream-parent")
      const parentLane = await nextLane(laneIter)
      expect(stripPlacementFold(parentLane.partonId)).toBe("stream-parent")

      // The parent's body closes at its shell — the decode settles with
      // the gate still held: a pending-marked placeholder where the
      // child would be, none of the child's content.
      const { bodyText } = await decodeLane(parentLane)
      expect(bodyText).toContain('"data-partial-pending":true')
      expect(bodyText).not.toContain("gated-content")
      // The child's effective id carries the per-instance props hash
      // (`:<hash>` — the stamp prop discriminates placements) under
      // the placement fold; the base is the spec id.
      const childId = pendingChildIdIn(bodyText)
      expect(stripPlacementFold(childId)).toMatch(/^stream-child:[0-9a-f]{16}$/)

      // The spawned follow-up lane's render has ENTERED the child body
      // (parked on the gate) but delivered nothing — no seq entry yet.
      await waitFor(() => renders.child === 2, "the follow-up lane to enter the child body")
      expect(
        h.entries.filter((e) => e.tag === "seq" && e.body.startsWith(`${childId}\n`)),
      ).toHaveLength(0)

      // Release: the follow-up lane drains the full body, announced
      // with its own delivery seq.
      releaseGate()
      const childLane = await nextLane(laneIter)
      expect(childLane.partonId).toBe(childId)
      expect((await decodeLane(childLane)).bodyText).toContain("gated-content-2")
      await waitForEntry(
        h.entries,
        (e) => e.tag === "seq" && e.body.startsWith(`${childId}\n`),
        "child follow-up lane seq entry",
      )

      await h.shutdown("stream-parent")
    })
  })

  it("a fallback-less stub carries no interposed Suspense; a declared fallback keeps its wrap", async () => {
    const scope = freshLiveScope("stream-defer-shape")
    await withLiveDrive("http://localhost/stream-shape?live=1", ShapePage, scope, async (h) => {
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload")
        throw new Error("expected payload segment 0")
      await drainPayloadSegment(first.value)
      const lanesSeg = await h.segments.next()
      if (lanesSeg.done || lanesSeg.value.kind !== "lanes")
        throw new Error("expected lanes segment")
      const laneIter = lanesSeg.value.lanes[Symbol.asyncIterator]()

      armGate()
      refreshSelector("stub-shape")
      const parentLane = await nextLane(laneIter)
      expect(stripPlacementFold(parentLane.partonId)).toBe("stub-shape-parent")
      const { bodyText } = await decodeLane(parentLane)

      // The two stubs' effective ids, off their PendingSlot props. The
      // `stream-child:` colon anchor keeps the bare child's regex from
      // matching the `-fb` sibling.
      const bareId = /"partonId":"(stream-child:[^"]+)"/.exec(bodyText)?.[1]
      const fbId = /"partonId":"(stream-child-fb:[^"]+)"/.exec(bodyText)?.[1]
      if (!bareId || !fbId) throw new Error("expected both stubs' PendingSlot rows")

      // Each stub's EMISSION row — the Activity-wrapped tree row with
      // props inline (dev debug rows carry the same ids but reference
      // their props indirectly, so they can't satisfy the structural
      // matches below).
      const rows = bodyText.split("\n")
      const bareRow = rows.find(
        (l) => l.includes('"mode":"visible"') && l.includes(`"partialId":"${bareId}"`),
      )
      const fbRow = rows.find(
        (l) => l.includes('"mode":"visible"') && l.includes(`"partialId":"${fbId}"`),
      )
      if (!bareRow || !fbRow) throw new Error("expected both stubs' emission rows")

      // Fallback-less: the PartialErrorBoundary's children IS the
      // PendingSlot element, byte-adjacent — no interposed Suspense.
      // (The regression: the `?? null`-defaulted fallback variable
      // wrapped every stub in `<Suspense fallback={null}>`, and that
      // inner null boundary swallowed the gate's suspension — the
      // region committed empty instead of the ambient app fallback.)
      expect(bareRow).toMatch(
        /"partialMatchKey":"[0-9a-f]+","children":\["\$","\$L[0-9a-f]+",null,\{"partonId":/,
      )
      expect(bareRow).toContain('"data-partial-pending":true')
      expect(bareRow).not.toContain('"fallback"')

      // Declared fallback: the wrap stays — PartialErrorBoundary >
      // Suspense (the spec's own <em>) > PendingSlot > pending marker.
      const wrap =
        /"partialMatchKey":"[0-9a-f]+","children":\["\$","\$(\w+)",null,\{"fallback":\["\$","em",null,\{"data-child-fallback":true/.exec(
          fbRow,
        )
      if (!wrap) throw new Error("expected the declared-fallback stub's Suspense wrap")
      // The wrap's element type resolves to the Suspense symbol row.
      expect(bodyText).toContain(`\n${wrap[1]}:"$Sreact.suspense"`)
      expect(fbRow).toMatch(
        /"fallback":\["\$","em"[^]*?"children":\["\$","\$L[0-9a-f]+",null,\{"partonId":/,
      )
      expect(fbRow).toContain('"data-partial-pending":true')

      releaseGate()
      await decodeLane(await nextLane(laneIter))
      await decodeLane(await nextLane(laneIter))
      await h.shutdown("stub-shape")
    })
  })

  it("a render with no driver renders the stream-deferred parton deep", async () => {
    const { stream } = await renderWithRequest("http://t/stream-deep", Page())
    const flight = await new Response(stream).text()
    expect(flight).toContain("gated-content-1")
    expect(flight).not.toContain("data-partial-pending")
    expect(renders.child).toBe(1)
  })

  it("the stub registers a snapshot — lookupPartial resolves the child id", async () => {
    const scope = freshLiveScope("stream-defer-reg")
    const url = "http://localhost/stream-reg?live=1"
    await withLiveDrive(url, Page, scope, async (h) => {
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload")
        throw new Error("expected payload segment 0")
      await drainPayloadSegment(first.value)
      const lanesSeg = await h.segments.next()
      if (lanesSeg.done || lanesSeg.value.kind !== "lanes")
        throw new Error("expected lanes segment")
      const laneIter = lanesSeg.value.lanes[Symbol.asyncIterator]()

      armGate()
      refreshSelector("stream-parent")
      const parentLane = await nextLane(laneIter)
      const childId = pendingChildIdIn((await decodeLane(parentLane)).bodyText)

      // The stub's boundary registered a snapshot at the lane's trailer
      // flush — the eager publish the forced follow-up resolves through
      // — with the gate still held (the child's Render never returned).
      const { result: snap } = await runWithRequestAsync(
        new Request(url, { headers: { "x-test-scope": scope } }),
        async () => {
          enterRequestRegistry(computeRouteKey(url), "cache")
          return lookupPartial(childId)
        },
      )
      expect(snap).toBeTruthy()

      // Drain the promised body so the drive winds down cleanly.
      releaseGate()
      await decodeLane(await nextLane(laneIter))
      await h.shutdown("stream-parent")
    })
  })

  it("a window navigation's covering segment stubs the child; the follow-up lanes on the reopened region", async () => {
    const scope = freshLiveScope("stream-defer-nav")
    await withLiveDrive("http://localhost/stream-nav?live=1", Page, scope, async (h) => {
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload")
        throw new Error("expected payload segment 0")
      await drainPayloadSegment(first.value)
      const conn = h.connectionId() ?? ""
      const lanesSeg = await h.segments.next()
      if (lanesSeg.done || lanesSeg.value.kind !== "lanes")
        throw new Error("expected lanes segment")

      armGate()

      // The window statement (no `frame` key): `?x=1` moves the
      // parent's recorded search read, so the covering segment
      // re-renders it — and stubs the child.
      expect(
        await post(scope, {
          connection: conn,
          seq: 2,
          frames: [{ kind: "url", url: "/stream-nav?x=1", intent: "push" }],
        }),
      ).toBe(204)
      const navSeg = await h.segments.next()
      if (navSeg.done || navSeg.value.kind !== "payload")
        throw new Error("expected the navigation payload segment")
      const navText = await drainPayloadSegment(navSeg.value)
      expect(navText).toContain('"data-partial-pending":true')
      expect(navText).not.toContain("gated-content-2")
      const childId = pendingChildIdIn(navText)

      // The promised body lanes FORCED on the reopened region.
      const reopened = await h.segments.next()
      if (reopened.done || reopened.value.kind !== "lanes")
        throw new Error("expected the reopened lanes region")
      const laneIter = reopened.value.lanes[Symbol.asyncIterator]()
      releaseGate()
      const childLane = await nextLane(laneIter)
      expect(childLane.partonId).toBe(childId)
      expect((await decodeLane(childLane)).bodyText).toContain("gated-content-2")

      await h.shutdown("stream-parent")
    })
  })
})
