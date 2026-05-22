# Cache

Server-side render-output caching. A parton opts in by setting the
`cache` prop; the framework stores the rendered Flight bytes for
the spec's subtree and replays them on hit. Distinct from
`expiresAt` in `vary` — that controls when the fp becomes stale
(wake hint for the segment driver, no byte storage). Caching needs
an explicit opt-in.

```tsx
const ProductHero = parton(ProductHeroRender, {
  match: "/p/:slug",
  cache: { maxAge: 60, staleWhileRevalidate: 30 },
  vary: ({ params, search: { variant = "default" } }) => ({
    slug: params.slug,
    variant,
  }),
})
```

Within `maxAge`: serve cached bytes (no re-render). Past `maxAge`
but within `maxAge + staleWhileRevalidate`: serve cached AND fire
a background refresh. Past both: miss.

## Options

```ts
interface CacheOptions {
  maxAge?: number                  // fresh window in seconds
  staleWhileRevalidate?: number    // additional stale-but-servable window
  slowSource?: {…}                 // dev-only debug
}
```

## Time-based reactivity vs. byte caching

The `vary` scope exposes a `time` object that lets a parton declare
**when its fp becomes stale** without caching anything:

```ts
vary: ({ time }) => ({
  tick: Math.floor(time.now / 1000),
  expiresAt: time.nextSecond,
})
```

`expiresAt` is a reserved key in vary's return — the framework
strips it from the value used in fp + Render, and uses it as a
wake hint for the segment driver's live-update loop. Each segment
emits a fresh render at the boundary. **No byte storage.**

To combine both — cached AND time-reactive — set `cache` and
declare `expiresAt`:

```tsx
const HotProduct = parton(HotProductRender, {
  match: "/p/:slug",
  cache: { maxAge: 60 },
  vary: ({ params, time }) => ({
    slug: params.slug,
    expiresAt: time.in(60_000),
  }),
})
```

There's no useful configuration where the two TTLs differ — the
cache short-circuits the re-execution that `expiresAt` would
trigger. Future direction: `cache: true` boolean form that pulls
TTL from `expiresAt` directly.

## `time` helpers

```ts
interface TimeScope {
  readonly now: number          // Date.now() captured at scope construction
  readonly nextSecond: number   // next whole-second boundary
  readonly nextMinute: number   // next whole-minute boundary
  readonly nextHour: number     // next whole-hour boundary
  readonly nextDay: number      // next UTC-day boundary
  in(ms: number): number        // now + ms
  readonly never: number        // +Infinity — sentinel for "never expires"
}
```

## Cache key

```ts
key = hash([
  spec.id,
  structuralFingerprint,    // function-ref-derived shape salt
  innerPartialIds.sorted,   // Partials nested inside the cached subtree
  spec.varyResult,          // the dependency surface declared by `vary`,
                            // minus stripped `expiresAt` / `staleUntil`
])
```

The cache key surface is `vary`'s return value (minus the reserved
keys). Whatever `vary` returns IS what the cache keys on.

## Composition with inner partials

A cached spec may contain other specs in its rendered output. Those
inner partials must stay live across cache hits — refetching them
shouldn't have to wait for the outer spec's TTL.

`<Cache>` (an internal wrapper applied when `cache` is set):

1. Walks the rendered tree, replaces every `PartialBoundary` with a
   `<i hidden data-partial>` placeholder.
2. Stores the placeholder-bearing tree as Flight bytes.
3. On hit: decodes the cached bytes, re-injects current live
   `PartialBoundary` elements at each placeholder. Inner partials
   render through their normal pipeline (vary, fingerprint, skip).

## Stale-while-revalidate

```ts
cache: { maxAge: 60, staleWhileRevalidate: 30 }
```

Within `maxAge`: serve cached, no refresh. Past `maxAge` but within
`maxAge + staleWhileRevalidate`: serve cached AND fire a background
re-render that overwrites the entry. Past both: miss.

The background refresh is in-flight-deduped per base key — a
thundering herd of cache hits past TTL kicks off exactly one
refresh.

## Invalidation

Three axes:

1. **Server-side `reload({selector})`.** An action body (or any
   server-side task) calls `getServerNavigation().reload({selector:
   "cart price"})` and the framework bumps the invalidation registry
   so every spec whose id or label list contains "cart" or "price"
   sees a fresh fingerprint on the next render — bypassing their
   cache. Pair with `invalidateByTags(["cart","price"])` to also
   purge the upstream GraphQL response cache (independent axis).

   > **Scope per-user state.** A bare selector like `"cart"` has no
   > constraints and matches every cart-tagged parton across every
   > viewer — one user's mutation fans out to every other user's
   > next nav. For per-request state, add a query-string fragment:
   > `reload({ selector: "cart?cart_id=" + cartId })` matches only
   > partons whose `vary` output contains `cart_id=<cartId>`. The
   > author owns this discipline; the framework can't auto-scope
   > because it doesn't know which `vary` keys are partition axes
   > vs incidental reads. See "Sharp edge: `reload({selector})`
   > is too broad by default" in
   > [`../notes/IDEAS.md`](../notes/IDEAS.md) for the ergonomic
   > follow-up being tracked.
2. **Vary-result change.** A page nav whose URL changes a value in
   the spec's vary result produces a different cache key. The old
   entry stays in the store but isn't queried.
3. **TTL elapsing.** Past `maxAge` (no swr) or `maxAge + swr`, the
   entry is treated as a miss; next render is fresh.

## Live updates

See [`docs/internals/streaming.md`](../internals/streaming.md) for
the time-based reactivity path. Short version: `expiresAt` in vary
is a wake hint for the segment driver's `?streaming=1` long-poll
loop. The `cache` prop is independent — caching is byte storage,
expiresAt is a freshness boundary.

## Related

- [`docs/partial.md`](./partial.md) for the constructor surface
- [`docs/frames-navigation.md`](./frames-navigation.md) for frames
- [`docs/cms.md`](./cms.md) for CMS-driven cache key contributions
- [`docs/internals/streaming.md`](../internals/streaming.md) for the
  live-update path
