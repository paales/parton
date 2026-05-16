/**
 * Cache-Control-shaped options carried by `<Partial cache={…}>`.
 *
 * - `maxAge` / `staleWhileRevalidate` mirror the HTTP directives of
 *   the same name. `maxAge` is the fresh window (seconds). `swr` is an
 *   additional window after `maxAge` during which the stored entry is
 *   served stale while a background refresh runs.
 * - `vary` carries already-resolved scalar values that identify *which
 *   snapshot of the content* this is — typically route params like
 *   `sku` that can't be read from cookies / headers / URL params by
 *   the tracked-accessor surface (see `docs/cache.md`).
 *   Scalar-only by TS so authors can't pass a whole object and miss
 *   the key surface silently — they have to extract the identifying
 *   field (`{sku: product.sku}`).
 * - `bypass` skips caching for this render only. Useful in dev.
 *
 * Presence of the object opts into caching. Drop the prop to render
 * fresh every request.
 */
export type VaryScalar = string | number | boolean | null | undefined

export interface CacheOptions {
  maxAge?: number
  staleWhileRevalidate?: number
  vary?: Readonly<Record<string, VaryScalar>>
  bypass?: boolean
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
  slowSource?: { perChunkMs: number; chunkBytes?: number }
}
