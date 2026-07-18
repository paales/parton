import { localCell, type LocalCell } from "@parton/framework"
import type { WorldGeometry } from "./constants.ts"

/**
 * The world's pulse — DERIVED, never ticked. One anchor cell PER
 * GEOMETRY (`geo.pulseCellId`, so a 128px chunk's {cx,cy} partition
 * never collides with the 512 default's), partitioned per chunk
 * coordinate. The row stores the epoch ms at which the partition was
 * first rendered — written ONCE, by the loader on the cold read; no
 * other write ever lands on this cell. The value a chunk shows is
 * computed in its body at render time (`time().now - anchor`), so it
 * is correct whenever the body runs — a re-culled-in chunk shows the
 * caught-up value by construction, with no producer keeping it warm.
 *
 * Cadence is DECLARED, not driven: each chunk render calls
 * `expires(nextBeat(cx, cy, now))` and the segment driver's expiry arm
 * re-lanes the visible chunks on their boundaries, skipping parked
 * ones. Zero clients ⇒ zero timers ⇒ zero server work — the
 * lease-by-derivation shape (docs/archive/leases.md, L1).
 *
 * The beat grid: each chunk draws a BASE period from its coordinates
 * (deterministic spatial variety — some neighborhoods are hot, some
 * sleepy); beat k sits at `k·base` plus a jitter hashed PURELY from
 * (coords, k) — lively but reproducible within a render (the tracking
 * invariant: no `Math.random` in a body), consecutive gaps spanning
 * 0.5–1.5× base, clamped to the 0.1–5s band. The network lights'
 * frequency colors keep meaning something.
 */
export interface ChunkPulse {
  /** The anchor cell — `resolve({cx, cy})` reads (and on first render
   *  writes) the partition's first-render epoch. */
  cell: LocalCell<number>
  /** The next beat boundary strictly after `now` for chunk (cx, cy) —
   *  what the body passes to `expires()`. Pure. */
  nextBeat(cx: number, cy: number, now: number): number
}

/** Deterministic unit-interval hash of (cx, cy, k) — the pure stand-in
 *  for per-beat random jitter. */
function beatJitter(cx: number, cy: number, k: number): number {
  let h = (Math.imul(cx, 374761393) + Math.imul(cy, 668265263) + Math.imul(k, 1274126177)) | 0
  h = Math.imul(h ^ (h >>> 13), 1103515245)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Coordinate-derived base period, 400–4400ms. */
function beatBase(cx: number, cy: number): number {
  return 400 + ((((cx * 7 + cy * 13) % 9) + 9) % 9) * 500
}

function nextBeat(cx: number, cy: number, now: number): number {
  const base = beatBase(cx, cy)
  // Beat k sits at k·base + jitter·base/2. Jitter < base/2 keeps the
  // sequence strictly increasing, so the boundary after `now` is the
  // current grid slot's beat if still ahead, else the next slot's.
  const beatAt = (k: number): number => (k + beatJitter(cx, cy, k) * 0.5) * base
  const k = Math.floor(now / base)
  const beat = beatAt(k) > now ? beatAt(k) : beatAt(k + 1)
  return Math.min(Math.max(beat, now + 100), now + 5_000)
}

export function definePulse(geo: WorldGeometry): ChunkPulse {
  const cell = localCell({
    id: geo.pulseCellId,
    shape: "number",
    initial: 0,
    // The write-once anchor: a cold read at a partition stores its
    // first-render epoch. The loader's storage write fires no
    // invalidation — nothing depends on the row before it exists.
    load: async () => Date.now(),
  })
  return { cell, nextBeat }
}
