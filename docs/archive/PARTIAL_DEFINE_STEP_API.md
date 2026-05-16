# `parton(Render, …)` — define-step constructor

> **Superseded 2026-05-12 by [`docs/adr/0001-partial-block-frame-split.md`](../adr/0001-partial-block-frame-split.md)
> + [`docs/reference/partial.md`](../reference/partial.md) + [`docs/reference/block.md`](../reference/block.md).**
>
> This was the design proposal for the 2026-04-28 constructor rewrite.
> The proposal landed, then the 2026-05-11 split refactor reshaped the
> surface again: `cmsId`, `errorWith`, `frame`, `frameUrl` are no
> longer `PartialOptions`; `cms` is no longer on `VaryScope` (CMS reads
> now live on `block`'s `schema` callback); `<Frame>` is a
> plain component, not a partial option. Keep this note for the
> pre-split design rationale; consult the reference docs for current
> API shape.

Replaces the call-site `<Partial>` JSX wrapper, the implicit
tracked-accessor manifest, the per-Partial frame/CMS/manifest ALS
cells, and the separate `registerBlock` catalog API. One spec call
at module scope produces a placeable component; every dependency a
spec has on the request, route, or CMS lives in a single sync `vary`
function whose result is also the cache-key surface.

```tsx
const PokemonPage = parton(PokemonRender, '/pokemon/:id')

function PokemonRender({ id, parent }: { id: string; parent: PartialCtx }) {
  return <article>...{id}...</article>
}

// Anywhere in JSX:
<PokemonPage parent={ROOT} />
```

Three lines for a route-driven page. No tracked accessors. No
`<Partial>` wrapper. No ALS.

## Constructor signature

```ts
function parton<V, P extends V & { parent: PartialCtx }>(
  render: (props: P) => ReactNode,
  matchOrOptions: string | PartialOptions<V>,
): React.FC<{ parent: PartialCtx }>

interface PartialOptions<V> {
  match?: string                                       // pathname pattern
  vary?: (scope: VaryScope) => V | null                // null = skip render
  selector?: SelectorTokens                            // optional, auto-derived
  cmsId?: string                                       // optional, defaults to selector
  cache?: CacheOptions
  frame?: string
  frameUrl?: string
  defer?: true | ReactElement<ActivatorProps>
  fallback?: ReactNode
  errorWith?: ReactNode
}

interface VaryScope {
  request: PartialRequest        // url, pathname, searchParams, cookies, headers
  params: Record<string, string> // populated when match is set + matched
  cms: CmsReadSurface            // sync getters scoped to this spec's cmsId
}

interface CmsReadSurface {
  text(name: string): string
  richText(name: string): string
  number(name: string): number
  boolean(name: string): boolean
  enum<T extends string>(name: string, values: readonly T[]): T
  image(name: string): { src: string; alt: string }
  reference(name: string, type: string): string | null
}
```

## Two tiers

**Tier 1 — string shorthand.** Pure pattern-matched route:

```tsx
const HomePage = parton(Home, '/')
const PokemonPage = parton(PokemonRender, '/pokemon/:id')
```

Pattern fails to match → spec doesn't render. Match params (`id`)
flow straight into the render function as props.

**Tier 2 — options object.** Combine pattern with vary, or skip the
pattern entirely and use vary alone:

```tsx
const ProductHero = parton(ProductHeroRender, {
  match: '/p/:slug',
  cmsId: 'product-hero',
  cache: { maxAge: 60 },
  vary: ({ params, request, cms }) => ({
    slug: params.slug,
    variant: request.searchParams.get('variant') ?? 'default',
    headline: cms.text('headline'),
    productRef: cms.reference('featured', 'product'),
  }),
})

async function ProductHeroRender({
  slug, variant, headline, productRef, parent,
}) {
  const product = productRef ? await getProduct(productRef) : null
  return <Hero parent={parent} product={product} headline={headline} />
}
```

`match` runs first; on miss, `vary` doesn't run, the spec doesn't
render. On match, `match`'s extracted params land in `vary`'s `params`
arg. When `vary` returns `null`, the spec also doesn't render.

## What `render` receives

A single flat object: `vary`'s return value spread, plus framework
keys.

| Key | Source |
|---|---|
| `<every key from vary's return>` | author |
| `parent` | framework — fresh `PartialCtx` for descendants |

Framework reserves `parent`. No name collision check needed; vary
authors who return `parent` overwrite the framework's value (probably
a bug, lint rule can flag).

When the spec uses only `match` (no `vary`), `render` receives
`{...matchParams, parent}`.

When the spec has neither (pure static partial), `render` receives
`{ parent }`.

## CMS surface in `vary`

All sync. Every getter resolves against the already-loaded
config cascade for the spec's `cmsId`.

| Getter | Returns | Empty default |
|---|---|---|
| `cms.text(name)` | `string` | `""` |
| `cms.richText(name)` | `string` | `""` |
| `cms.number(name)` | `number` | `0` |
| `cms.boolean(name)` | `boolean` | `false` |
| `cms.enum(name, values)` | `T` | `values[0]` |
| `cms.image(name)` | `{src, alt}` | `{src: "", alt: ""}` |
| `cms.reference(name, type)` | `string \| null` | `null` |

`cms.reference` returns the **id only**. The async loader call lives
in `render`. The id contributes to the cache key; entity-content
invalidation is the loader's concern.

## What contributes to the cache key

```ts
fp = hash([
  spec.id,                       // auto-derived selector (stable per spec)
  render.toString().length,      // render fn identity proxy
  stableStringify(varyResult),   // explicit dependency surface
  ambientFrameKey,               // resolved before vary runs
])
```

`vary`'s return value IS the surface. No separate `cache.vary` prop;
no implicit manifest. Cache invalidation by manifest value (an
`IDEAS.md` follow-up) becomes "any cached entry whose vary result
contains `{cookie: "user_id"}` with the matching value."

## Self-registration

`parton(...)` called at module scope registers itself in the
catalog as a side-effect — keyed by `cmsId` (or auto-derived
selector). HMR replaces the prior spec by id. Catalog prerender
becomes:

```ts
for (const spec of catalog) {
  const stub = makeStubVaryScope(spec)
  spec.vary?.(stub)              // captures cms.text(...) calls into manifest
}
```

Strictly simpler than today's "render the component once and hope
all reads happen sync-top before first await." The
catalog-prerender sharp edge in `docs/cms.md` goes away.

## Selector auto-generation

When `selector` is omitted:

1. Take `Render.displayName ?? Render.name`.
2. Strip a trailing `Page` / `Block` / `Render` / `Partial` suffix.
3. Kebab-case → `"#pokemon"`, `"#product-hero"`, `"#cart"`.
4. On collision at registration, throw with a hint to provide
   explicit `selector`.

Authors who address the spec by `reload({ selector: '#cart' })` can
still pass an explicit selector. Auto-generation is for the (common)
case where the partial is only ever placed once and never targeted
by a programmatic refetch.

`cmsId` defaults to the (auto- or explicit) selector with the
leading `#` stripped — `"#pokemon"` → `cmsId: "pokemon"`. Authors
override only when sharing CMS scope across two partial specs.

## ALS deletions

The constructor folds in everything that was implicit before. Every
ALS-backed cell goes away:

- `requestContext` — request + cookies passed to vary
- `partialManifestCell`, `setCurrentPartialManifest`, `recordAccess`,
  `resolveManifest` — manifest IS the vary result
- `frameScopeCell` — frame is per-spec; the request passed to vary
  is already frame-resolved
- `cmsScopeCell` — `cms` is a vary arg, scoped by spec's `cmsId`
- `runWithCacheManifest` — no scope to enter
- `HoistingViolationError` — no manifest to compare against
- `liveManifest` / `baselineManifest` registry split — single
  vary-result snapshot
- `computeDescendantManifestKey` walker — descendants declare their
  own vary; ancestor cache key composes from descendants' vary
  results when needed

Estimated framework deletion: ~1,200 lines across `context.ts` and
`partial-component.tsx`.

## What stays

- Selector grammar (`#unique`, `.shared`) for refetch addressing
- `<Cache>` mechanics (strip-on-store, reinject-on-return)
- Frame URL stack, `useNavigation('frame').navigate(...)`
- `defer` modes + `useActivate`
- `<Children>` / `<Child>` slot primitives
- Registry per-(route, id) content split
- Fingerprint-skip on the wire
- The CMS JSON store schema + cascade resolver

## Deferred

- **`closest` / ancestor `provides`.** Out of scope for this pass.
  Apps that need ancestor data should pass it as a render prop
  (manual threading) until a successor design lands.
- **`<PartialMatch>` 404 fallback.** When zero specs on a page
  match, the page renders empty. A future `<PartialMatch>` (or
  similar) will provide the explicit "render this when nothing
  else matched" hook.

## Migration

Zero backwards compat. The whole repo flips at once:

1. Framework rewrite: new `partial.tsx`, gut `context.ts`, simplify
   `partial-registry.ts`, adjust `cache.tsx`.
2. CMS runtime: sync `CmsReadSurface`, prerender by spec walk,
   delete `registerBlock`.
3. `e2e-testing/src/app/` rewritten end-to-end. No incremental migration; the
   demo app is small enough to flip wholesale.
4. `cms/src/editor/` adapted: tree + field form read from spec catalog
   directly, no ALS reads.
5. Tests + docs in the same pass.

The `archive/` move for the old `vary-render-api.md` proposal
records the path from "vary as call-site prop" to "vary as
constructor option."
