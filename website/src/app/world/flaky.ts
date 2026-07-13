/**
 * The flaky district's outage schedule — DETERMINISTIC pseudo-random
 * failure from (chunk coords × time bucket), the tracking-invariant
 * stand-in for "a backend that is sometimes down": no `Math.random`
 * in a body, every render of a chunk within one bucket agrees, and
 * the schedule flips as wall-clock buckets roll over. The same shape
 * as the pulse's beat jitter (./pulse.ts) — hashed variety that is
 * reproducible within a render.
 *
 * ~45% of (chunk, bucket) pairs fail, so on any visit the district
 * shows a mix: fresh chunks, last-known-good chunks wearing the STALE
 * badge, and (on first visit during an outage) bounded error cards —
 * all transitioning as buckets roll and the framework's retry backoff
 * re-attempts (`docs/reference/errors.md`).
 */

/** Outage granularity: each chunk redraws its up/down state per
 *  12s wall-clock bucket — long enough to watch a stale badge sit,
 *  short enough that recovery is observable within a visit (the
 *  framework's retry cap is 16s, so a flip back to good is picked up
 *  at most one capped backoff later). */
export const FLAKY_BUCKET_MS = 12_000

/** Fraction of (chunk, bucket) pairs that fail. */
export const FLAKY_RATE = 0.45

/** Deterministic unit-interval hash of (cx, cy, bucket). */
function outageHash(cx: number, cy: number, bucket: number): number {
  let h = (Math.imul(cx, 374761393) + Math.imul(cy, 668265263) + Math.imul(bucket, 1274126177)) | 0
  h = Math.imul(h ^ (h >>> 13), 1103515245)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

export interface FlakyOutage {
  failing: boolean
  bucket: number
}

/** The district's up/down verdict for chunk (cx, cy) at `now` (the
 *  render clock — `time().now`, never an inline `Date.now()`). */
export function flakyOutage(cx: number, cy: number, now: number): FlakyOutage {
  const bucket = Math.floor(now / FLAKY_BUCKET_MS)
  return { failing: outageHash(cx, cy, bucket) < FLAKY_RATE, bucket }
}
