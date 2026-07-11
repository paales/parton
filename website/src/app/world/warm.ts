import { registerWarmProjector } from "@parton/framework"
import { GEOMETRIES, type WorldGeometry } from "./constants.ts"

/**
 * The world's warm projector — the geometry half of predictive chunk
 * warming. The scroller states telemetry (viewport box, scroll
 * position, velocity in plane px/s); the framework hands the latest
 * statement plus the route's parked partons to this projector at the
 * segment driver's park point; the ids returned here get their bodies
 * rendered into the server byte-cache so the real flip-in lanes replay
 * warm bytes. Only chunks are worth projecting — quad tiles' bodies
 * are trivial structural JSX. A candidate's spec type names its
 * geometry (`world-chunk`, `world-chunk-128`, …), which fixes the
 * chunk size its coordinates are measured in.
 */

/**
 * How far ahead of the statement the projection extends, in time. The
 * swept viewport box runs from the statement's extrapolated NOW to
 * receivedAt + horizon; a statement older than its own horizon
 * projects nothing (it has been overtaken by its own extrapolation).
 * 1200ms reaches ~1.7 chunk rows at WASD speed over the default
 * geometry (720px/s × 1.2s ≈ 864px ≈ 512px chunks) — the chunks whose
 * flips fire next — without sweeping half the world on a fast fling
 * (the framework's per-park cap truncates the rest, nearest first).
 */
const WARM_HORIZON_MS = 1200

/**
 * Minimum speed (plane px/s) worth projecting. Below ~half a default
 * chunk per second the cull runway (the chunk's 100px rootMargin)
 * plus one flip-lane round-trip already fills chunks before the
 * viewport reaches them — warming pays only when the viewport outruns
 * that pipeline.
 */
const WARM_MIN_SPEED_PX_S = 240

const geometryByChunkType = new Map<string, WorldGeometry>(
  GEOMETRIES.map((geo) => [geo.chunkSpecId, geo]),
)

registerWarmProjector((telemetry, candidates) => {
  const { viewport, scroll, receivedAt } = telemetry
  const speed = Math.hypot(scroll.vx, scroll.vy)
  if (speed < WARM_MIN_SPEED_PX_S) return []
  const horizonS = WARM_HORIZON_MS / 1000
  const elapsedS = (Date.now() - receivedAt) / 1000
  if (elapsedS >= horizonS) return []

  // Swept viewport box: the union of the viewport at the statement's
  // extrapolated current position and at the horizon.
  const x0 = scroll.x + scroll.vx * elapsedS
  const y0 = scroll.y + scroll.vy * elapsedS
  const x1 = scroll.x + scroll.vx * horizonS
  const y1 = scroll.y + scroll.vy * horizonS
  const left = Math.min(x0, x1)
  const right = Math.max(x0, x1) + viewport.w
  const top = Math.min(y0, y1)
  const bottom = Math.max(y0, y1) + viewport.h
  const centerX = x0 + viewport.w / 2
  const centerY = y0 + viewport.h / 2

  const hits: Array<{ id: string; d: number }> = []
  for (const c of candidates) {
    const geo = geometryByChunkType.get(c.type ?? "")
    if (!geo) continue
    const cx = c.props?.cx
    const cy = c.props?.cy
    if (typeof cx !== "number" || typeof cy !== "number") continue
    const bx = geo.chunkOrigin(cx)
    const by = geo.chunkOrigin(cy)
    if (bx >= right || bx + geo.chunkPx <= left) continue
    if (by >= bottom || by + geo.chunkPx <= top) continue
    // Nearest-to-viewport first: for a straight sweep, distance from
    // the current viewport center orders chunks by time-to-reach.
    hits.push({
      id: c.id,
      d: Math.hypot(bx + geo.chunkPx / 2 - centerX, by + geo.chunkPx / 2 - centerY),
    })
  }
  hits.sort((a, b) => a.d - b.d)
  if (hits.length > 0) {
    // The demo's warm evidence — one line per projection (one
    // projection per telemetry statement), read by validate-world.mjs.
    console.log(`[world] warm ${hits.length} chunk(s) ahead at ${Math.round(speed)}px/s`)
  }
  return hits.map((h) => h.id)
})
