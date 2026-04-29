# `ReactCms.partial(Render, …)`

The framework's only public render primitive. A spec is constructed
once at module scope from a `Render` function and an options object;
the call returns a placeable React component. Every dependency the
spec has on the request, route, or CMS lives in a single sync `vary`
function whose result is also the cache-key surface.

```tsx
import { ReactCms, ROOT, type RenderArgs } from "./lib"

const PokemonPage = ReactCms.partial(PokemonRender, "/pokemon/:id")

function PokemonRender({ id, parent }: { id: string } & RenderArgs) {
  return <article>...{id}...</article>
}

// Anywhere in JSX:
<PokemonPage parent={ROOT} />
```

## Tier 1 — pattern-match shorthand

When a string is passed as the second argument, it's treated as the
`match` pattern. On miss, the spec doesn't render. Pattern params
flow into `Render`'s props directly.

```tsx
const HomePage = ReactCms.partial(Home, "/")
const PokemonPage = ReactCms.partial(PokemonRender, "/pokemon/:id")
```

## Tier 2 — options object

```tsx
const ProductHero = ReactCms.partial(ProductHeroRender, {
  match: "/p/:slug",
  cmsId: "product-hero",
  cache: { maxAge: 60 },
  vary: ({ params, request, cms }) => ({
    slug: params.slug,
    variant: new URL(request.url).searchParams.get("variant") ?? "default",
    headline: cms.text("headline"),
    productRef: cms.reference("featured", "product"),
  }),
})

async function ProductHeroRender({
  slug, variant, headline, productRef, parent,
}: { slug: string; variant: string; headline: string; productRef: string | null } & RenderArgs) {
  const product = productRef ? await getProduct(productRef) : null
  return <Hero parent={parent} product={product} headline={headline} />
}
```

`match` runs first; on miss, `vary` doesn't run. On match, the
pattern's params land in `vary`'s `params` arg. When `vary` returns
`null`, the spec also doesn't render.

## Options

```ts
interface PartialOptions<V> {
  match?: string                                  // pathname pattern
  vary?: (scope: VaryScope) => V | null           // null = skip render
  selector?: SelectorTokens                       // auto-derived from Render.name
  cmsId?: string                                  // defaults to selector
  type?: string                                   // catalog tag (slot lookup)
  tags?: ReadonlyArray<`.${string}`>              // class tokens for slot blocks
  cache?: CacheOptions
  frame?: string
  frameUrl?: string
  defer?: true | ReactElement<ActivatorProps>
  fallback?: ReactNode
  errorWith?: ReactNode
}
```

| Option | Notes |
|---|---|
| `match` | `/p/:slug` / `/p/:slug/reviews/:page` / `/anything/*`. Pattern miss → spec emits nothing. |
| `vary` | Sync function. Receives `{ request, params, cms }`. Returns the dependency surface or `null`. |
| `selector` | Defaults to `#<kebab-cased Render.name minus Page/Block/Render/Partial suffix>`. |
| `cmsId` | Defaults to the effective id (selector minus `#`). |
| `tags` | When set, the spec is a slot block — `[#<entry.id>, ...tags]` per instance. |
| `frame` | Opens a frame scope. `vary` receives the frame-resolved request. |
| `defer` | `true` for app-driven, an activator element to wire automatically. |

## `VaryScope`

```ts
interface VaryScope {
  request: Request                  // frame-resolved if framed
  params: Record<string, string>    // populated by `match`
  cms: CmsReadSurface               // sync getters bound to this spec's cmsId
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

`cms.reference` returns the **id only**. Async loaders run inside
`Render`. The reference id contributes to the cache key; entity-
content invalidation is the loader's concern.

## `Render` props

`Render` receives the vary result spread, plus framework-injected
keys:

| Key | Source |
|---|---|
| `<every key from vary's return>` | author |
| `parent` | framework — fresh `PartialCtx` for descendants |
| `cmsId` | framework — effective cmsId (override-aware) |

`parent` is what nested specs and slot hosts use; `cmsId` is what
slot primitives pass as `hostCmsId`.

## Slots

```tsx
import { Children, Child } from "./lib"

function PageRootRender({ parent, cmsId }: RenderArgs) {
  return (
    <main>
      <Children name="body" allow=".page-block" host={parent} hostCmsId={cmsId} />
      <aside>
        <Child name="sidebar" allow=".widget" host={parent} hostCmsId={cmsId} />
      </aside>
    </main>
  )
}
```

| Component | Renders |
|---|---|
| `<Children name allow host hostCmsId>` | Every entry in `node.slots[name]` in stored order, each rendered through its registered spec with `cmsId={entry.id}` override. |
| `<Child name allow host hostCmsId>` | At most one entry. |

`host` becomes the slot block's `parent`. `hostCmsId` is the parent
node whose `slots[name]` array to read.

## Selector grammar

CSS-style. Tokens separated by whitespace.

- `#foo` — unique. A second spec with the same `#foo` is a render
  error. Drives `reload({ selector: "#foo" })` lookup.
- `.foo` — shared. Multiple specs may carry it. Refetches by `.foo`
  union across every carrier.

Auto-derived from `Render.name`: `PokemonHeroRender` → `#pokemon-hero`.

## Skip semantics

A spec doesn't render in three cases:

1. `match` is set and the URL didn't match.
2. `vary` returned `null`.
3. The client's cached fingerprint matches this render's fingerprint
   (the `?cached=` skip handshake).

Cases 1 and 2 emit nothing. Case 3 emits a placeholder so the client
paints from `_cache`.

## Page-level routing — `<PartialMatch>` / `<Match>`

Per-spec `match` works for individual sections but doesn't compose
hierarchically — every spec on `/pokemon/:id` repeats the pattern,
and there's no single place to render a 404 when nothing matches.
`PartialMatch` is the page-level router:

```tsx
import { PartialMatch, Match, ROOT } from "./lib"

<PartialMatch fallback={<NotFoundPage />}>
  <Match pattern="/pokemon/:id">
    <DetailPlacements parent={ROOT} />
  </Match>
  <Match pattern="/cms-demo/:slug">
    <CmsDemoPlacements parent={ROOT} />
  </Match>
  <Match pattern="/">
    <HomePlacements parent={ROOT} />
  </Match>
</PartialMatch>
```

Behaviour:

- **First match wins.** `PartialMatch` scans its top-level `Match`
  children in order and renders the first whose `pattern` hits the
  request pathname. Later `Match` siblings don't run.
- **Fallback on miss.** Nothing matched → `fallback` renders. No
  `fallback` → empty.
- **Non-`Match` children are ignored.** Chrome (header, footer,
  debug overlays) goes outside `PartialMatch`.
- **Ambient match-params.** When a `Match` hits, its matched params
  flow into descendant spec components via an injected
  `__ambientMatchParams` prop. A spec with no `match` of its own
  reads those params in its `vary` scope, so the per-spec
  `match: "/pokemon/:id"` repetition can be removed:

  ```tsx
  // Before — every spec repeats the pattern.
  const Hero = ReactCms.partial(HeroRender, { match: "/pokemon/:id", ... })
  const Stats = ReactCms.partial(StatsRender, { match: "/pokemon/:id", ... })

  // After — outer Match owns the URL, specs inherit params.
  <Match pattern="/pokemon/:id">
    <Hero parent={ROOT} />
    <Stats parent={ROOT} />
  </Match>
  ```

- **`Match` standalone.** `Match` works without a `PartialMatch`
  wrapper. It self-gates on a miss (returns `null`) and provides
  ambient params on a hit. Useful for local route gating.

The injection walks the JSX tree under a `Match` and stops at:

- spec components — injects ambient params and stops descending;
- nested `<Match>` — its own injection wins, so the outer doesn't
  recurse into it;
- user-defined function components — opaque to the walker. A spec
  nested inside `<Wrapper>{specs}</Wrapper>` will not receive
  ambient params; thread them as explicit props in that case.

## Sharp edges

- **Slot block specs need `tags`.** Specs without `tags` aren't
  registered as slot blocks; they always render with their fixed
  selector / cmsId. To author a reusable block, set `tags:
  [".my-block"]` and an explicit `type`.
- **`closest` / ancestor `provides`.** Punted out of this design
  pass. Specs that need ancestor data should accept it as a render
  prop (manual threading from a parent spec's `vary`).
- **`Match` ambient params don't traverse function components.** As
  noted above. The escape hatch is explicit prop threading.

## Migration notes (2026-04-28)

The previous `<Partial>` JSX wrapper, tracked accessors
(`getSearchParam`, `getCookie`, …), per-Partial frame/CMS/manifest
ALS cells, `HoistingViolationError`, and `registerBlock` are gone.
See `archive/VARY_RENDER_API.md` and
`notes/partial-define-step-api.md` for the design rationale.
