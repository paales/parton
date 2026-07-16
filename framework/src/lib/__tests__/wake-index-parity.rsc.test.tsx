/**
 * Wake-index parity — end to end through the REAL driver. With the
 * parity oracle armed (`_setWakeParityCheck`), every bump drain
 * re-derives its lane set through the retired pull filter
 * (`_routeMatchingBumpIds`) and THROWS on any divergence from the
 * index's delivered pending set — so this drive proves the two
 * semantics equal across targeted, irrelevant, fan-out, and coalesced
 * bumps on a held connection. A parity violation errors the drive
 * (the lanes iterator rejects), so plain green assertions here ARE
 * the proof.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { _clearInvalidationRegistry, refreshSelector } from "../../runtime/invalidation-registry.ts"
import {
  decodeLane,
  drainPayloadSegment,
  freshLiveScope,
  withLiveDrive,
} from "../../test/live-drive.tsx"
import type { DemuxedLane } from "../fp-trailer-split.ts"
import { clearRegistry } from "../partial-registry.ts"
import { PartialRoot, parton } from "../partial.tsx"
import { tag } from "../current-parton.ts"
import { _setWakeParityCheck } from "../segment-relevance.ts"

const renders = { a: 0, b: 0 }

// Each parton subscribes by READING tags — its own name-tag plus the
// shared fan-out tag. `refreshSelector("parity-a")` wakes ParityA
// alone; `refreshSelector("parity-shared")` fans out to both. The
// parton id is the Render name (`ParityARender` → "parity-a").
const ParityA = parton(function ParityARender() {
  tag("parity-a")
  tag("parity-shared")
  renders.a++
  return <div>{`pa-${renders.a}`}</div>
})

const ParityB = parton(function ParityBRender() {
  tag("parity-b")
  tag("parity-shared")
  renders.b++
  return <div>{`pb-${renders.b}`}</div>
})

function Page() {
  return (
    <PartialRoot>
      <ParityA />
      <ParityB />
    </PartialRoot>
  )
}

beforeEach(() => {
  _setWakeParityCheck(true)
  _clearInvalidationRegistry()
  renders.a = 0
  renders.b = 0
})

afterEach(() => {
  _setWakeParityCheck(false)
  clearRegistry("all")
  _clearInvalidationRegistry()
})

describe("wake index — driver parity oracle", () => {
  it("targeted, irrelevant, fan-out, and coalesced bumps drain filter-identical lane sets", async () => {
    await withLiveDrive(
      "http://localhost/parity?live=1",
      Page,
      freshLiveScope("parity-rsc"),
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload")
          throw new Error("expected payload segment 0")
        await drainPayloadSegment(first.value)
        expect(renders.a).toBe(1)
        expect(renders.b).toBe(1)

        // Irrelevant bump — nothing registered it: no lane, no wake
        // (and had it woken with a divergent set, the armed oracle
        // would have errored the drive). Then a targeted bump: exactly
        // ParityA's lane.
        refreshSelector("parity-unrelated")
        refreshSelector("parity-a")
        const second = await h.segments.next()
        if (second.done || second.value.kind !== "lanes") throw new Error("expected lanes segment")
        const laneIter = second.value.lanes[Symbol.asyncIterator]()
        const laneA = (await laneIter.next()).value as DemuxedLane
        expect(laneA.partonId).toBe("parity-a")
        expect((await decodeLane(laneA)).bodyText).toContain("pa-2")
        expect(renders.b).toBe(1)

        // Fan-out label + coalesced re-bump between wakes: both
        // partons lane, each ONCE (the pending set dedupes).
        refreshSelector("parity-shared")
        refreshSelector("parity-shared")
        const laneX = (await laneIter.next()).value as DemuxedLane
        const laneY = (await laneIter.next()).value as DemuxedLane
        expect(new Set([laneX.partonId, laneY.partonId])).toEqual(new Set(["parity-a", "parity-b"]))
        await decodeLane(laneX)
        await decodeLane(laneY)
        expect(renders.a).toBe(3)
        expect(renders.b).toBe(2)

        await h.shutdown("parity-a")
      },
    )
  })
})
