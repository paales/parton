/**
 * 64-bit hash for cache keys, fingerprints, and registry variant keys.
 *
 * Implementation: SHA-256 truncated to the first 16 hex chars (64 bits).
 *
 * The upgrade from djb2 (32-bit) was driven by a fingerprint-collision
 * concern: a hash collision in `cache.tsx` (cache key) is a spurious
 * miss; a collision in `partial.tsx` fingerprint or
 * `partial-registry.ts` variant key is a SILENT correctness bug
 * (client paints stale subtree as fresh / wrong snapshot reconstructed).
 * 64 bits gives ~50% collision probability at 2^32 distinct values —
 * comfortable for the cache + registry size we expect.
 *
 * Why SHA-256 truncated rather than xxhash3 / murmur3:
 *  - Available everywhere `node:crypto` runs. No vendored code, no
 *    native bindings, no build configuration.
 *  - Sync API — compatible with `vary`'s sync contract.
 *  - Output distribution matches a uniform random 64-bit function
 *    (truncating a cryptographic hash preserves distribution).
 *
 * Cost: SHA-256 is slower than xxhash3 in absolute terms, but the
 * inputs we hash are small (canonicalized vary results, partial id
 * lists) and the call rate is bounded (one per partial render). Not
 * a hot-path concern.
 *
 * Portability: this uses `node:crypto`, which is available in Node
 * and Bun but NOT in Cloudflare Workers / Vercel Edge runtimes. The
 * framework is currently Node-only via `@vitejs/plugin-rsc`. If an
 * edge target lands, swap to a pure-JS implementation behind the
 * same signature.
 */

import { createHash } from "node:crypto"

export function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16)
}

/**
 * @deprecated Use `hash` instead. Kept as an alias during the
 * djb2 → SHA-256 upgrade so existing imports keep working. The
 * underlying algorithm is no longer djb2 — call sites that rely on
 * the algorithm name should switch to `hash`.
 */
export const djb2 = hash
