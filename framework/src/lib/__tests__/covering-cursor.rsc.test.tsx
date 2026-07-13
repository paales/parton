/**
 * The covering-segment coverage cursor — the fix for the fuzzer's F1
 * finding (docs/notes/convergence-fuzzing.md): `handleNavigation` (and
 * the reconcile/frame-nav siblings) anchor the wake cursor and the
 * pending-set coverage BEFORE the covering render begins, because the
 * vendored Flight server renders lazily — a write committing while the
 * segment streams, after its reader's row already rendered, is in
 * neither the segment nor any lane.
 *
 * Two deterministic halves:
 *
 *   1. THE WINDOW DELIVERS. A write lands mid-navigation-render after
 *      the reader's row rendered (a controllable sibling stall holds
 *      the segment open). The navigation segment ships the STALE row
 *      — the window is real — and the very next wake on the reopened
 *      lanes region lanes the reader FRESH, with no further bump: the
 *      mid-render delivery stayed pending instead of being cleared as
 *      covered.
 *
 *   2. DOUBLE DELIVERY FP-SKIPS. A write lands mid-render BEFORE the
 *      reader's wrapper ran (the reader sits inside a stalled wrapper
 *      parton), so the segment's row DOES carry the write — fp folded
 *      and all. The kept pending delivery re-lanes the reader once,
 *      and that lane fp-skips against the segment's promoted fp: a
 *      placeholder, the body never re-runs. Over-delivery is one
 *      zero-cost confirm, never a duplicate render.
 */

import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runWithRequestAsync } from "../../runtime/context.ts"
import { _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts"
import {
  decodeLane,
  drainPayloadSegment,
  freshLiveScope,
  withLiveDrive,
} from "../../test/live-drive.tsx"
import { localCell } from "../cell.ts"
import { CHANNEL_ENDPOINT, type ChannelEnvelope } from "../channel-protocol.ts"
import { handleChannelPost } from "../connection-session.ts"
import type { DemuxedLane } from "../fp-trailer-split.ts"
import { PartialRoot, parton, type RenderArgs } from "../partial.tsx"
import { clearRegistry } from "../partial-registry.ts"
import { searchParam } from "../server-hooks.ts"

const renders = { aReader: 0, bReader: 0 }

// The mid-render stall — an unresolved promise the test releases once
// the write has landed. Starts RESOLVED so segment 0 drains freely.
let releaseGate: () => void = () => {}
let gate: Promise<void> = Promise.resolve()
function armGate(): void {
  gate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
}

// Body-progress signals — the real "the row's read happened" /
// "the wrapper's body started" markers the sequencing keys on.
let onAReaderRender: (value: number) => void = () => {}
let onBWrapStart: () => void = () => {}

const curACell = localCell({ id: "cur-a-cell", shape: "number", initial: 0 })
const curBCell = localCell({ id: "cur-b-cell", shape: "number", initial: 0 })

// ── Half 1 fixture: reader + stalling sibling, both step-dependent so
// the navigation render re-runs their bodies (no fp-skip).
const CurAReader = parton(
  async function CurAReaderRender(_: RenderArgs) {
    const step = searchParam("step") ?? ""
    const v = await curACell.resolve()
    renders.aReader++
    onAReaderRender(v.value)
    return <div>{`cur-a-reader:${step}:${v.value}`}</div>
  },
  { selector: "cur-a-reader" },
)
const CurASlow = parton(
  async function CurASlowRender(_: RenderArgs) {
    const step = searchParam("step") ?? ""
    await gate
    return <div>{`cur-a-slow:${step}`}</div>
  },
  { selector: "cur-a-slow" },
)
const PageA = (): ReactNode => (
  <PartialRoot>
    <CurAReader />
    <CurASlow />
  </PartialRoot>
)

// ── Half 2 fixture: the reader nested in a stalling WRAPPER, so the
// write can land before the reader's wrapper (and its fp fold) runs.
const CurBReader = parton(
  async function CurBReaderRender(_: RenderArgs) {
    const step = searchParam("step") ?? ""
    const v = await curBCell.resolve()
    renders.bReader++
    return <div>{`cur-b-reader:${step}:${v.value}`}</div>
  },
  { selector: "cur-b-reader" },
)
const CurBWrap = parton(
  async function CurBWrapRender(_: RenderArgs) {
    const step = searchParam("step") ?? ""
    onBWrapStart()
    await gate
    return (
      <div>
        {`cur-b-wrap:${step}`}
        <CurBReader />
      </div>
    )
  },
  { selector: "cur-b-wrap" },
)
const PageB = (): ReactNode => (
  <PartialRoot>
    <CurBWrap />
  </PartialRoot>
)

beforeEach(() => {
  _clearInvalidationRegistry()
  renders.aReader = 0
  renders.bReader = 0
  releaseGate()
  gate = Promise.resolve()
  onAReaderRender = () => {}
  onBWrapStart = () => {}
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

async function writeCell(
  cell: { set: (v: number) => Promise<void> },
  scope: string,
  url: string,
  value: number,
): Promise<void> {
  const request = new Request(`http://localhost${url}`, { headers: { "x-test-scope": scope } })
  await runWithRequestAsync(request, async () => {
    await cell.set(value)
  })
}

async function nextLane(iter: AsyncIterator<DemuxedLane>): Promise<DemuxedLane> {
  const step = await iter.next()
  if (step.done) throw new Error("expected another lane")
  return step.value
}

describe("covering-segment coverage cursor", () => {
  it("a write landing mid-render after the reader's row stays pending and lanes after the segment", async () => {
    const scope = freshLiveScope("cursor-window")
    await withLiveDrive("http://localhost/cur?step=1&live=1", PageA, scope, async (h) => {
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload")
        throw new Error("expected payload segment 0")
      const seg0 = await drainPayloadSegment(first.value)
      expect(seg0).toContain("cur-a-reader:1:0")
      const conn = h.connectionId() ?? ""
      expect(conn).not.toBe("")
      const lanes0 = await h.segments.next()
      if (lanes0.done || lanes0.value.kind !== "lanes") throw new Error("expected lanes segment")
      expect(
        await post(scope, { connection: conn, seq: 2, frames: [{ kind: "ack", delivered: 1 }] }),
      ).toBe(204)

      // Stall the NEXT whole-tree render and watch for the reader's
      // body pass in it.
      armGate()
      const readerRendered = new Promise<number>((resolve) => {
        onAReaderRender = resolve
      })

      // The navigation statement — a different effective URL, so this
      // is a genuine window navigation.
      expect(
        await post(scope, {
          connection: conn,
          seq: 3,
          frames: [{ kind: "url", url: "/cur?step=2", intent: "push" }],
        }),
      ).toBe(204)

      // The reader's row has rendered (it read the cell: 0); the
      // segment is still open on the stalled sibling. THE WRITE LANDS
      // NOW — mid-stream, after its reader's row.
      expect(await readerRendered).toBe(0)
      await writeCell(curACell, scope, "/cur?step=2", 1)
      releaseGate()

      // The navigation segment ships the STALE row — the window is
      // real; the covering render cannot carry the write.
      const navSeg = await h.segments.next()
      if (navSeg.done || navSeg.value.kind !== "payload")
        throw new Error("expected the navigation payload segment")
      const navBody = await drainPayloadSegment(navSeg.value)
      expect(navBody).toContain("cur-a-reader:2:0")

      // The reopened region's first wake delivers the write — NO
      // further bump: the mid-render delivery stayed pending (the
      // cursor anchored before the render began) instead of being
      // cleared as covered.
      const reopened = await h.segments.next()
      if (reopened.done || reopened.value.kind !== "lanes")
        throw new Error("expected the reopened lanes region")
      const laneIter = reopened.value.lanes[Symbol.asyncIterator]()
      const lane = await nextLane(laneIter)
      expect(lane.partonId).toBe("cur-a-reader")
      expect((await decodeLane(lane)).bodyText).toContain("cur-a-reader:2:1")

      await h.shutdown("cur-a-reader")
    })
  })

  it("a write the segment DID carry re-lanes once as an fp-skip no-op", async () => {
    const scope = freshLiveScope("cursor-dedup")
    await withLiveDrive("http://localhost/cur?step=1&live=1", PageB, scope, async (h) => {
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload")
        throw new Error("expected payload segment 0")
      const seg0 = await drainPayloadSegment(first.value)
      expect(seg0).toContain("cur-b-reader:1:0")
      expect(renders.bReader).toBe(1)
      const conn = h.connectionId() ?? ""
      const lanes0 = await h.segments.next()
      if (lanes0.done || lanes0.value.kind !== "lanes") throw new Error("expected lanes segment")
      expect(
        await post(scope, { connection: conn, seq: 2, frames: [{ kind: "ack", delivered: 1 }] }),
      ).toBe(204)

      // Stall the wrapper BEFORE it returns the reader — the write
      // lands before the reader's wrapper (and fp fold) has run.
      armGate()
      const wrapStarted = new Promise<void>((resolve) => {
        onBWrapStart = resolve
      })
      expect(
        await post(scope, {
          connection: conn,
          seq: 3,
          frames: [{ kind: "url", url: "/cur?step=2", intent: "push" }],
        }),
      ).toBe(204)
      await wrapStarted
      await writeCell(curBCell, scope, "/cur?step=2", 1)
      releaseGate()

      // The segment carries the write — the reader's row rendered
      // after the commit, fp folded.
      const navSeg = await h.segments.next()
      if (navSeg.done || navSeg.value.kind !== "payload")
        throw new Error("expected the navigation payload segment")
      const navBody = await drainPayloadSegment(navSeg.value)
      expect(navBody).toContain("cur-b-reader:2:1")
      expect(renders.bReader).toBe(2)

      // The delivery landed mid-render, so it stayed pending — the
      // reader re-lanes ONCE. That lane must be the fp-skip no-op:
      // the segment's promote already holds the row's fp, so the lane
      // ships the zero-cost placeholder and the body never re-runs.
      const reopened = await h.segments.next()
      if (reopened.done || reopened.value.kind !== "lanes")
        throw new Error("expected the reopened lanes region")
      const laneIter = reopened.value.lanes[Symbol.asyncIterator]()
      const lane = await nextLane(laneIter)
      expect(lane.partonId).toBe("cur-b-reader")
      const decoded = await decodeLane(lane)
      expect(decoded.bodyText).toContain('"data-partial-id":"cur-b-reader"')
      expect(decoded.bodyText).not.toContain("cur-b-reader:2:1")
      expect(renders.bReader).toBe(2)

      await h.shutdown("cur-b-reader")
    })
  })
})
