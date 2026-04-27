> **Superseded 2026-04-27** by [`docs/cache.md`](../docs/cache.md)
> § Storage tiers. Historical design proposal preserved for context.

---

# Cache scoping — where state lives

**Added:** 2026-04-20
**Files:** `src/lib/cache.tsx`, `src/lib/partial-registry.ts`, `src/lib/partial-client.tsx`, `src/framework/context.ts`
**Related:** `AUTO_TRACKED_CACHE_KEYS.md` (how each `<Partial cache>` entry's key is derived), `DYNAMIC_PARTIAL_REGISTRY.md` (the middle tier in more depth).

Answers the questions: *"is the cache global or route-specific"*, *"what's a route"*, and *"does the same Partial on multiple URLs share anything"*. Short reference — not a design doc.

## The three tiers

| Tier | Storage | Keyed by | Cross-request? |
| --- | --- | --- | --- |
| **`<Partial cache>` bytes** | `src/lib/cache.tsx` — `store` + `snapshotIndex` + `manifestStore` | `${id}:${fingerprint}:${idsHash}:${hashParts(manifestValues, vary)}` | **Yes, global.** No pathname in the key. |
| **Route-scoped registry** (refetch snapshots) | `src/lib/partial-registry.ts` — `Map<pathname, Map<id, PartialSnapshot>>` | `(pathname, partialId)` | Yes, but partitioned by pathname. |
| **Client `_template` + `_cache` + `_fingerprints` + `_partialTags`** | `src/lib/partial-client.tsx` (all `"use client"`) | — | No, per-browser-tab. `_template` is one slot, overwritten on full navs; the maps are pruned on every streaming render to live ids only. |

## Same Partial on `/shop` and `/checkout` — works

- **Render-output cache**: can share bytes. If `<Partial selector="#cart" cache>` hashes to the same fingerprint + manifest on both pages, one entry serves both. Nothing route-specific in the key.
- **Registry**: separate snapshots per pathname. `/shop`'s cart snapshot holds whatever JSX `/shop`'s ancestor captured; `/checkout`'s holds its own. Refetches for the cart on `/checkout` replay `/checkout`'s snapshot (which has the right ancestor closure context).
- **Duplicate-`#`-token check**: per-page (`seenUniqueTokens` per-request), so `<Partial selector="#cart">` can appear on both pages without collision.

No conflicts. The separation is right: registry isolation keeps refetch semantics correct per page, cache-store sharing keeps bytes cheap.

## What counts as a "route"

- **Server registry**: `new URL(request.url).pathname`. Search params are **not** part of the key. `/` and `/?q=x` share a registry bucket.
- **Server `<Cache>`**: no route at all. Cache key is `id:fp:idsHash:manifestHash`; values come from the tracked-accessor manifest (cookies, headers, search params, `getPathname(pattern)` matches).
- **Client `_templateRoute`**: `pathname + search`. Different for `?q=a` vs `?q=b`.
- **No formal router abstraction**. `framework/router.ts` exposes `matchPath(pattern)` / `pickRoute(routes)` — thin helpers around `URLPattern`, used at the top of `Root` to pick a page component. URL pathname is the de facto route identifier everywhere else.

**Inconsistency worth knowing:** server treats `/` and `/?q=x` as one route; client treats them as two. Benign today — the server uses pathname only for registry partitioning, and same-pathname full renders overwrite the bucket — but if anyone ever builds a feature assuming "route == full URL" on the server, this will bite. Right fix is probably to align both on pathname.

## Scaling — high-cardinality routes (`/p/slug1`, `/p/slug2`, … ×50k)

The registry is `Map<pathname, Map<id, snapshot>>`. **Uncapped.** Every distinct pathname a long-running process renders leaves a bucket behind. For a product catalog with 50k SKUs × ~5 Partials/page × a few KB/snapshot that's on the order of a gigabyte of heap in the worst case — the **dominant memory cost** in this architecture.

Three defenses, in order of cost:

1. **Use `getPathname(pattern)` in Partial bodies that vary by a path segment.** Instead of closure-capturing the slug from the parent (`<ProductHero slug={slug}/>`), read it ambiently inside the component:
   ```tsx
   async function ProductHero() {
     const { slug } = getPathname("/p/:slug") ?? {};
     // ... use slug
   }
   ```
   The tracked-accessor manifest then records `pathname:/p/:slug` (the pattern, not the matched value), which makes the **cache key** pattern-scoped: one entry per `(slug, manifest values)` tuple, but the *manifest key set* is invariant across products. Pairs with a future move to key the registry by pattern instead of pathname; today it already wins on the cache side.

2. **LRU cap on the registry.** Not shipped yet — flagged in this doc as the cheap bounded-memory fix. `snapshotIndex` in `cache.tsx` already uses `SNAPSHOT_INDEX_MAX = 10_000` with FIFO eviction; the registry should get the same treatment. Hot routes stay warm; cold ones fall out. Correctness is preserved because registry entries are best-effort — a miss falls back to a full streaming render (`registryMiss` branch in `partial.tsx`), which repopulates.

3. **Split template structure from per-request data.** Architectural, not mechanical. The snapshot currently captures a React element with closure-bound props (`<ProductHero slug="slug1"/>`), so every pathname produces a unique element. A future refactor could store a pure template keyed by pattern + a per-request data map resolved via `getPathname`/`getCookie`/etc. Then 50k products share one snapshot. Defer until a profiler screams — (1) and (2) together buy a lot of headroom.

## What happens on a registry miss

`partial.tsx` checks if any requested id is in the registry for the current pathname. If not, it flips `registryMiss = true` and promotes the refetch to a full streaming render:

1. `clearRoute(pathname)` (mostly no-op if bucket was empty).
2. Re-execute the whole `<Root/>` tree. Every Partial runs, self-registers.
3. Client receives full payload.

Wall-time cost: whatever the cold page costs, minus the `?cached=id:fp,…` fingerprint-skip savings (unchanged Partials emit `<i data-partial hidden>` placeholders without re-executing) and any `<Partial cache>` hits on ancestors. Not catastrophic, but not free.

Nothing is "lost" — the `<Partial cache>` layer is independent of the registry, so cached subtrees still serve. The registry is an optimization that lets refetches skip ancestor execution; when it misses, the refetch degrades to a navigation-shaped render.

## Eviction summary

| What | When | How |
| --- | --- | --- |
| `<Cache>` bytes | Never (process-local), or TTL / SWR expiry | `store.clear()` on HMR / test hook |
| `snapshotIndex` (dynamic-partial snapshots per cache key) | FIFO at 10,000 entries | `SNAPSHOT_INDEX_MAX` in `cache.tsx` |
| Route registry | Never automatically (gap — see §Scaling #2) | `clearRoute(pathname)` on each full streaming render for that pathname; HMR clears all; `/__test/clear-caches` in dev |
| Client `_cache` / `_fingerprints` / `_partialTags` | Every full streaming render | Pruned to template-placeholder ids (`partial-client.tsx`) |
| Client `_template` | Every full streaming render | Overwritten (single slot) |
