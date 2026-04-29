# Cache internals

`<Cache>` is an internal wrapper applied when a spec sets `cache`
in its options. It sits between the spec's body and the rendered
output; authors don't render it directly.

## Strip + reinject

Cached Flight bytes capture the rendered subtree as-is. To keep
inner partials live across cache hits:

1. **Strip on store.** Walk the rendered tree; replace every
   `PartialBoundary` (and any element whose `key` resolves to a
   registered partial id) with a `<i hidden data-partial>`
   placeholder. Store the placeholder-bearing tree as Flight bytes.
2. **Reinject on hit.** Decode the cached bytes back to a tree;
   walk it and replace placeholders with the current live
   `PartialBoundary` elements. Inner partials render through their
   normal pipeline.

Two side-tables back this:

- **`store: CacheStore`** — bytes per cache key (default in-memory
  LRU, swappable for Redis / KV).
- **`snapshotIndex: Map<key, Map<id, snapshot>>`** — for each cache
  entry, the dynamic-partial snapshots registered during that
  render. On hit, those snapshots are re-registered into the
  current request's registry so `PartialRoot`'s cache-mode reads
  find them.

## Cache key derivation

```ts
key = baseKey + ":" + hash(stableStringify([varyResult, options.vary]))
baseKey = `${spec.id}:${structuralFp}:${hash(innerPartialIds.sorted)}`
```

`hash()` is SHA-256 truncated to 64 bits (`src/lib/hash.ts`).
`stableStringify` (`src/lib/stable-stringify.ts`) canonicalizes the
hash input — distinct sentinels for `undefined` / `NaN` / `±Infinity`
/ `BigInt`, ms-encoded `Date`, sorted-content `Set` / `Map`, and
`<circular>` for self-referential structures so a malformed
`vary` result fails loudly instead of recursing forever.

`innerPartialIds` lives in `baseKey` so adding/removing an inner
partial inside the cached subtree invalidates the cache
automatically (the placeholder set the cached bytes hold no longer
matches the tree being rendered).

## Stale-while-revalidate

```ts
{ maxAge: 60, staleWhileRevalidate: 30 }
```

`Entry` carries `expiresAt` (now + maxAge*1000) and `staleUntil`
(expiresAt + swr*1000). On hit:

- `expiresAt > now` — fresh hit. Serve.
- `staleUntil > now` — stale-but-servable. Serve, kick off async
  refresh. The refresh runs in `refreshing: Set<string>` to dedupe
  thundering herds.
- Past both — miss.

## Miss path

`renderMissAndStore` tees the Flight stream of the stripped subtree:

1. **User branch** — decoded immediately, returned to the outer
   render. Inner Suspense boundaries stay lazy so the client paints
   fallbacks while async work resolves.
2. **Storage branch** — buffered, fully resolved (lazy refs forced
   to materialized values), re-stripped of dynamic-partial
   wrappers, re-encoded, stored. Runs in the background; doesn't
   block the user-facing latency.

Cold-miss dedupe lives in `inFlightMiss: Map<baseKey, Promise>` —
multiple concurrent requests for the same cold key share one
in-flight render.

## Per-scope state

The cache, snapshot index, refresh set, and in-flight-miss map all
live under `ScopeState` keyed by `getScope()`. Production: every
request → `"default"` → one bucket. Dev: Playwright workers stamp
per-worker `x-test-scope` headers so parallel runs don't contend.

## HMR + clear

`vite:beforeUpdate` and `vite:beforeFullReload` fire `_clearCache()`
to drop every scope. Test-only `/__test/clear-caches` endpoint
forwards a per-request scope token (or `?all=1` for everything).
