# Cache

`<Partial cache={…}>` doesn't exist anymore — caching is a per-spec
option in the `parton` constructor.

```tsx
const ProductHero = parton(ProductHeroRender, {
  match: "/p/:slug",
  cache: { maxAge: 60, staleWhileRevalidate: 30 },
  vary: ({ params, request }) => ({
    slug: params.slug,
    variant: new URL(request.url).searchParams.get("variant") ?? "default",
  }),
})
```

## Options

```ts
interface CacheOptions {
  maxAge?: number                  // fresh window in seconds
  staleWhileRevalidate?: number    // additional stale-but-servable window
  vary?: Record<string, VaryScalar>  // extra scalars folded into the key
  bypass?: boolean                 // skip caching for this render only
}
```

## Cache key

```ts
key = hash([
  spec.id,
  structuralFingerprint,    // function-ref-derived shape salt
  innerPartialIds.sorted,   // Partials nested inside the cached subtree
  spec.varyResult,          // the dependency surface declared by `vary`
  options.vary ?? null,     // optional extra scalars
])
```

The cache key surface is `vary`'s return value. There's no implicit
manifest, no tracked accessor cell, no separate "vary scalars on
top of an opaque manifest." Whatever `vary` returns IS what the
cache keys on.

## Composition with inner partials

A cached spec may contain other specs in its rendered output. Those
inner partials must stay live across cache hits — refetching them
shouldn't have to wait for the outer spec's TTL.

`<Cache>` (an internal wrapper applied when a spec sets `cache`):

1. Walks the rendered tree, replaces every `PartialBoundary` with a
   `<i hidden data-partial>` placeholder.
2. Stores the placeholder-bearing tree as Flight bytes.
3. On hit: decodes the cached bytes, re-injects current live
   `PartialBoundary` elements at each placeholder. Inner partials
   render through their normal pipeline (vary, fingerprint, skip).

## Stale-while-revalidate

```ts
{ maxAge: 60, staleWhileRevalidate: 30 }
```

Within `maxAge`: serve cached, no refresh. Past `maxAge` but within
`maxAge + staleWhileRevalidate`: serve cached AND fire a background
re-render that overwrites the entry. Past both: miss.

The background refresh is in-flight-deduped per base key — a
thundering herd of cache hits past TTL kicks off exactly one
refresh.

## Bypass

```tsx
cache: { bypass: process.env.NODE_ENV === "development" }
```

Renders fresh every request. Useful in dev when iterating on a
component whose `vary` doesn't yet capture every dependency.

## Invalidation

Three axes:

1. **Server-action directives.** An action returns `{invalidate:
   {selector: "cart price"}}` and the framework refetches every spec
   whose id or label list contains "cart" or "price" on the next
   render — bypassing their cache by marking them as explicit
   refetch targets.
2. **Vary-result change.** A page nav whose URL changes a value in
   the spec's vary result produces a different cache key. The old
   entry stays in the store but isn't queried.
3. **Tag-based purge.** `invalidateByTags(["cart"])` from
   `partial-cache.ts` (the GraphQL response cache) flushes data
   entries; rendered-output cache entries are still keyed by the
   spec's vary result.

## Related

- [`docs/partial.md`](./partial.md) for the constructor surface
- [`docs/frames-navigation.md`](./frames-navigation.md) for frames
- [`docs/cms.md`](./cms.md) for CMS-driven cache key contributions
