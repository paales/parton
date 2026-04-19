/**
 * Server-side data cache for partials.
 *
 * Caches GraphQL response data keyed by query hash. Each partial
 * can opt in to caching via the `cache` prop (TTL in seconds).
 *
 * The cache key is the compiled query string — this naturally varies
 * by user when the component reads cookies/headers for query arguments
 * (e.g., cart_id). No explicit "vary" needed for the common case.
 *
 * Tag-based invalidation: server actions return { invalidate: { tags: ["cart"] } },
 * which purges all cache entries tagged with "cart". Partials tagged
 * with "cart" are then re-rendered with fresh data.
 *
 * This is the ESI model: compose pages from independently cached
 * fragments, fetch only what's stale.
 */

interface CacheEntry {
  data: Record<string, unknown>;
  query: string;
  tags: string[];
  expiresAt: number;
}

// CATEGORY C (notes/SERVER_ISOLATION.md) — shared GraphQL response cache.
// Entries keyed by query hash + variables; safe to share across users for
// anonymous queries, and authenticated queries should not end up here.
const cache = new Map<string, CacheEntry>();

import { djb2 as hashQuery } from "./hash.ts";

/**
 * Look up cached response data for a query.
 * Returns the data if found and not expired, null otherwise.
 */
export function getCachedData(
  query: string,
): Record<string, unknown> | null {
  const key = hashQuery(query);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

/**
 * Store response data in the cache.
 * @param query   The compiled GraphQL query (used as cache key)
 * @param data    The response data
 * @param ttl     Time-to-live in seconds
 * @param tags    Invalidation tags for this entry
 */
export function setCachedData(
  query: string,
  data: Record<string, unknown>,
  ttl: number,
  tags: string[] = [],
): void {
  const key = hashQuery(query);
  cache.set(key, {
    data,
    query,
    tags,
    expiresAt: Date.now() + ttl * 1000,
  });
}

/**
 * Invalidate all cache entries matching any of the given tags.
 * Called from server actions via entry.rsc.tsx.
 */
export function invalidateByTags(tags: string[]): number {
  const tagSet = new Set(tags);
  let purged = 0;
  for (const [key, entry] of cache) {
    if (entry.tags.some((t) => tagSet.has(t))) {
      cache.delete(key);
      purged++;
    }
  }
  return purged;
}

/** Clear the entire cache. Useful for testing. */
export function clearCache(): void {
  cache.clear();
}

/** Get cache stats. Useful for debugging. */
export function getCacheStats(): {
  size: number;
  entries: Array<{ query: string; tags: string[]; ttlRemaining: number }>;
} {
  const now = Date.now();
  return {
    size: cache.size,
    entries: [...cache.values()].map((e) => ({
      query: e.query.slice(0, 80) + (e.query.length > 80 ? "..." : ""),
      tags: e.tags,
      ttlRemaining: Math.max(0, Math.round((e.expiresAt - now) / 1000)),
    })),
  };
}
