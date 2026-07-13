/**
 * Cache-Control-shaped options carried by `parton(..., { cache })`.
 *
 * Setting the `cache` prop activates byte-level caching: the
 * framework stores the rendered Flight bytes for the spec's
 * subtree and replays them on hit. Distinct from `expiresAt` in
 * `expires()` — that controls when the fp becomes stale (wake hint for
 * the segment driver, no byte storage). Caching needs an explicit
 * opt-in via this prop.
 *
 * - `maxAge`: HTTP-directive-style fresh window in seconds. After
 *   `maxAge` elapses the stored entry is stale and the next
 *   request misses.
 * - `staleWhileRevalidate`: additional seconds past `maxAge` during
 *   which stale bytes are served while a background refresh runs.
 * - `staleIfError`: how long a last-known-good entry stays servable
 *   when a FRESH render throws (the error-recovery contract,
 *   `docs/reference/errors.md`).
 * - `__slowSource` (dev only): emit stored bytes in artificially
 *   throttled chunks so a hit-path replay exercises Suspense
 *   streaming end-to-end. Used by `cache-streaming-demo.tsx`.
 *
 * Future direction: `cache: true` (boolean) replacing the object
 * form, with TTL coming from vary's `expiresAt`. Not yet — for now
 * the prop is the byte-cache opt-in AND carries its own maxAge.
 */
export interface CacheOptions {
  maxAge?: number
  staleWhileRevalidate?: number
  /**
   * HTTP `stale-if-error`-shaped bound on serve-last-known-good.
   *
   * When a fresh render of this spec THROWS (a loader failure — never
   * the framework's control-flow sentinels) and the byte cache holds a
   * previous good render for the same (id, variant), the framework
   * serves those bytes with an explicit staleness marker
   * (`usePartonStale()`) instead of the error card, and re-attempts on
   * a capped exponential backoff.
   *
   * - omitted (default): last-known-good stays error-servable
   *   indefinitely — repeated failure keeps the newest good render up.
   * - `number`: seconds PAST the entry's ordinary stale window
   *   (`staleUntil`) during which it remains error-servable; older
   *   entries fall through to the error card.
   * - `false`: opt out — a failed render always surfaces the error
   *   card, even when last-known-good bytes exist. Retry scheduling
   *   still applies.
   */
  staleIfError?: number | false
  /**
   * DEV / DEBUG ONLY. When set on a hit-path read, the stored bytes
   * are emitted through the decoder in chunks separated by `perChunkMs`
   * (default chunk size `chunkBytes`, 64 if omitted).
   *
   * Used to validate end-to-end that the cache's stream-replay path
   * preserves Suspense streaming — the same primitive a future
   * `<RemoteFrame>` uses to stitch a slow cross-origin Flight payload
   * into the host's outer render. Not for production: every hit pays
   * the artificial latency.
   */
  __slowSource?: { perChunkMs: number; chunkBytes?: number }
}
