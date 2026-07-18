/**
 * Scope confinement end to end through the REAL driver: a held live
 * connection in one `x-test-scope` never wakes on another scope's
 * bump, while its own scope's bumps and scope-less bumps both lane.
 *
 * The proof is signal-based, not timing-based. The parton renders its
 * own fold of the tag's invalidation ts, so every received lane names
 * the bump that produced it; and the driver renders its wakes
 * sequentially, so by the time an identified lane is received, every
 * earlier wake's render has completed — the render counter at that
 * moment is exact. A cross-scope leak would surface as either an
 * extra render (delivery leak) or a stale-ts first lane (fold leak).
 */

import { afterEach, describe, expect, it } from "vitest"
import { runWithRequestAsync } from "../context.ts"
import {
  _clearInvalidationRegistry,
  queryMatchingTs,
  refreshSelector,
} from "../invalidation-registry.ts"
import { tag } from "../../lib/current-parton.ts"
import { clearRegistry } from "../../lib/partial-registry.ts"
import { PartialRoot, parton } from "../../lib/partial.tsx"
import {
  decodeLane,
  drainPayloadSegment,
  freshLiveScope,
  withLiveDrive,
} from "../../test/live-drive.tsx"
import type { DemuxedLane } from "../../lib/fp-trailer-split.ts"

const renders = { count: 0 }

const ScopedLive = parton(function ScopedLiveRender() {
  tag("scoped-live")
  renders.count++
  return <div>{`ts:${queryMatchingTs(["scoped-live"], {})}`}</div>
})

function Page() {
  return (
    <PartialRoot>
      <ScopedLive />
    </PartialRoot>
  )
}

async function bumpInScope(scope: string, selector: string): Promise<number> {
  const request = new Request("http://localhost/bump", {
    headers: { "x-test-scope": scope },
  })
  const { result } = await runWithRequestAsync(request, async () => {
    refreshSelector(selector)
    return queryMatchingTs([selector], {})
  })
  return result
}

afterEach(() => {
  clearRegistry("all")
  _clearInvalidationRegistry()
  renders.count = 0
})

describe("scope confinement through the live driver", () => {
  it("another scope's bump neither wakes nor moves the connection; own-scope and scope-less bumps lane", async () => {
    const scope = freshLiveScope("scoped-live")
    await withLiveDrive("http://localhost/scoped-live?live=1", Page, scope, async (h) => {
      const first = await h.segments.next()
      if (first.done || first.value.kind !== "payload")
        throw new Error("expected payload segment 0")
      await drainPayloadSegment(first.value)
      expect(renders.count).toBe(1)

      // A bump under a DIFFERENT scope, then one under the drive's own
      // scope. The next lane must be the own-scope bump's render: its
      // body carries the own-scope fold ts (a leaked cross-scope wake
      // would have rendered ts:0 first), and — because the driver
      // renders wakes sequentially — the render count at reception
      // proves no earlier wake ran.
      await bumpInScope("scoped-live-other", "scoped-live")
      const ownTs = await bumpInScope(scope, "scoped-live")
      const second = await h.segments.next()
      if (second.done || second.value.kind !== "lanes") throw new Error("expected lanes segment")
      const laneIter = second.value.lanes[Symbol.asyncIterator]()
      const laneOwn = (await laneIter.next()).value as DemuxedLane
      expect(laneOwn.partonId).toBe("scoped-live")
      expect((await decodeLane(laneOwn)).bodyText).toContain(`ts:${ownTs}`)
      expect(renders.count).toBe(2)

      // A scope-less bump (production's shape — and the soak bench's)
      // reaches the scoped connection.
      refreshSelector("scoped-live")
      const globalTs = queryMatchingTs(["scoped-live"], {})
      const laneGlobal = (await laneIter.next()).value as DemuxedLane
      expect(laneGlobal.partonId).toBe("scoped-live")
      expect((await decodeLane(laneGlobal)).bodyText).toContain(`ts:${globalTs}`)
      expect(renders.count).toBe(3)

      await h.shutdown("scoped-live")
    })
  })
})
