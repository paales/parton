/**
 * Byte-cache freshness clamps to the body's declared `expires()`
 * boundary — the byte-cache counterpart of fp-skip's TTL gate.
 *
 * The hazard this closes: a `cache:` spec whose body DERIVES a
 * time-shaped value (the leases-note shape: persisted anchor + render
 * clock + `expires()` cadence, no producer) has a cache key that never
 * moves — no write ever bumps its invalidation ts — so under a raw
 * `maxAge` window the hit path would replay stale derived bytes for
 * the whole window while the expiry arm dutifully re-runs the body.
 * The declaration IS the freshness contract: an entry stored from a
 * render that declared `expires(T)` must be a miss past T, `maxAge`
 * only bounding how long an undeclared entry lingers.
 *
 * Prod-tier for the same reason as cache-write-key: the assertions
 * grep the wire for the rendered stamp, and the DEV Flight build leaks
 * the wrapper's discarded fresh element (Render runs every pass; on a
 * hit its output is dropped) into debug rows — a false "fresh render"
 * sighting the production build cannot produce.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { clearRegistry } from "../partial-registry.ts"
import { _clearCache } from "../cache.tsx"
import { expires, time } from "../server-hooks.ts"

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The derived-beat shape: a byte-cached body declaring a boundary far
// inside its maxAge window. No tracked read, no invalidation — only
// the declaration can end the entry's life.
let renderSeq = 0
const CachedBeat = parton(
  Object.assign(
    function CachedBeatRender(_: RenderArgs) {
      renderSeq++
      expires(time().in(150))
      return <span>{`cached-beat:render#${renderSeq}`}</span>
    },
    { displayName: "cache-expires-clamp" },
  ),
  { cache: { maxAge: 60 } },
)

const tree = (
  <PartialRoot>
    <CachedBeat />
  </PartialRoot>
)
const url = "http://t/cache-expires-clamp"

function stamp(flight: string): string | undefined {
  return /cached-beat:(render#\d+)/.exec(flight)?.[1]
}

beforeEach(async () => {
  clearRegistry("all")
  await _clearCache()
  renderSeq = 0
})

describe.skipIf(process.env.NODE_ENV !== "production")(
  "byte cache — declared expires() clamps entry freshness",
  () => {
    it("replays within the declared boundary, misses past it despite a longer maxAge", async () => {
      const r1 = await flightAt(url, tree)
      expect(stamp(r1)).toBe("render#1")
      await sleep(30) // let the background store settle

      // Inside the boundary: byte-replay (the body ran — seq advanced —
      // but the wire carries the stored render's bytes).
      const r2 = await flightAt(url, tree)
      expect(stamp(r2)).toBe("render#1")
      expect(renderSeq).toBe(2)

      // Past the declared 150ms boundary — a 60s maxAge would still be
      // fresh, the declaration must win with a hard miss (expires()
      // alone never opens a stale-while-revalidate window).
      await sleep(180)
      const r3 = await flightAt(url, tree)
      expect(stamp(r3)).toBe("render#3")
    })
  },
)
