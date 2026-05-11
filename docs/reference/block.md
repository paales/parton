# `ReactCms.block(Render, …)`

Slot-placeable, type-catalog-registered partial. A block is what slots
look up by `type` to render their entries; its `schema` callback
declares both CMS content reads and child slot composition.

```tsx
const HeroBlock = ReactCms.block(
  function HeroRender({ headline, subhead, tone, parent }) {
    return (
      <article data-tone={tone}>
        <h1>{headline}</h1>
        <p>{subhead}</p>
      </article>
    )
  },
  {
    selector: ".page-block .composed-hero",
    schema: ({ cms }) => ({
      headline: cms.text("headline"),
      subhead: cms.text("subhead"),
      tone: cms.enum("tone", ["calm", "loud"] as const),
    }),
  },
)
```

A block is internally a partial — same fingerprint pipeline, same
refetch path. Differences:

- **Slot-placeable, type-catalog-registered.** Registered under its
  auto-derived name (`HeroRender` → `"hero"`); slots look it up via
  `cms.blocks("body", ".page-block")` calls in their host's `schema`.
- **`selector` declares class identity.** Same CSS-style grammar as
  `partial`'s selector, but blocks typically have only `.tokens` —
  the `#` token is materialised per instance from the slot entry's
  id (or from a `cmsId` JSX prop on direct placement).
- **Singletons embed `#` in selector.** A spec like
  `selector: "#app-nav .nav-root"` is a singleton bound to cmsId
  `"app-nav"` — placed once via JSX without any prop override.

## Options

```ts
interface BlockOptions<V, S> {
  /** CSS-style selector. `.class` tokens are class identity for
   *  slot-allow targeting + shared refetch. `#token` makes the block
   *  a singleton bound to that cmsId. */
  selector?: SelectorTokens
  /** CMS reads + child slot composition. Result is merged into
   *  Render's prop bag alongside `vary`'s. */
  schema?: (scope: { cms: CmsReadSurface }) => S
  /** Request-dimensions vary (URL / cookies / headers / session).
   *  Same shape as on `ReactCms.partial`. Rare on blocks — content
   *  side lives on `schema`. */
  vary?: (scope: VaryScope) => V | null
  cache?: CacheOptions
  defer?: DeferSpec
  fallback?: ReactNode
}
```

| Option | Notes |
|---|---|
| `selector` | `.page-block` (class identity, multi-instance) or `#app-nav .nav-root` (singleton). Class tokens are picked up by slot-allow filters (`cms.blocks("body", ".page-block")`) and by `nav.reload({selector: ".page-block"})` shared refetch. |
| `schema` | Sync. Returns content reads (`cms.text(...)`, `cms.enum(...)`) and child slot compositions (`cms.blocks(...)`, `cms.block(...)`). Both flow into Render as props. |
| `vary` | Request-dim deps. Most blocks don't have request deps; their content comes from `schema`. |
| `cache`, `defer`, `fallback` | Same as `ReactCms.partial`. |

## `cms` surface on schema

```ts
interface CmsReadSurface {
  text(name: string): string
  richText(name: string): string
  number(name: string): number
  boolean(name: string): boolean
  enum<T extends string>(name: string, values: readonly T[]): T
  image(name: string): { src: string; alt: string }
  reference(name: string, type: string): string | null
  block(slot: string, selector?: string): ReactNode
  blocks(slot: string, selector?: string): ReactNode
}
```

Field reads (`text`/`enum`/etc.) return values; `block` / `blocks`
return ReactNode for the host's slot children. The framework wires
host context (parent + cmsId) into the surface, so the schema doesn't
thread any of it.

`cms.blocks(slot, selector?)` resolves the slot's entries against the
selector (class-only filter, e.g. `".page-block"`), looks each entry
up by its `type` in the catalog, and renders the matching block. The
returned ReactNode is dropped into the Render's JSX position.

`cms.block(slot, selector?)` is the singular variant — renders at
most one entry, returns `null` when the slot is empty.

## How blocks get placed

### 1. By a slot (from a host's schema)

A parent block (or partial with a `cmsId` binding) hosts slots via
its `schema`. The framework's slot wiring writes the entry's id into
the rendered block instance via the framework-internal `__cmsId`
prop. Author code never threads that.

```tsx
const PageRoot = ReactCms.block(
  function PageRootRender({ body }) {
    return <main>{body}</main>
  },
  {
    schema: ({ cms }) => ({
      body: cms.blocks("body", ".page-block"),
    }),
  },
)
```

Each slot entry's `cmsId` becomes its effective id; refetch by
`reload({selector: "#<entry-id>"})` works.

### 2. By direct JSX (singleton or per-instance)

A block can be rendered directly via JSX. Two patterns:

**Singleton** — embed `#` in the spec selector. Spec.cmsId is the
`#token`. No JSX `cmsId` prop needed.

```tsx
const AppNav = ReactCms.block(NavRender, {
  selector: "#app-nav .nav-root",
  schema: ({ cms }) => ({ links: cms.blocks("links", ".nav-item") }),
})

<AppNav parent={ROOT}/>
```

**Per-instance** — pass `cmsId="..."` as a JSX prop to override the
spec's default cmsId. Each placement has its own effective id.

```tsx
const LivePrice = ReactCms.block(LivePriceRender, {
  selector: ".price",
})

<LivePrice parent={p} cmsId={`price-${sku}`} sku={sku} basePrice={...} />
```

## Self-refresh from inside an instance

Client components inside a block's render can refetch their enclosing
instance via the `useEnclosingPartialId()` hook. Useful when external
addressing is by class only and you want a per-instance refresh
button.

```tsx
"use client"
import { useEnclosingPartialId, useNavigation } from "@react-cms/framework/lib/partial-client.tsx"

export function RefreshSelfButton() {
  const myId = useEnclosingPartialId()
  const nav = useNavigation()
  return (
    <button onClick={() => nav.reload({ selector: `#${myId}` })}>
      Refresh
    </button>
  )
}
```

The hook reads a React Context populated by the framework's
`PartialErrorBoundary` — every block instance has it set to its
runtime effective id, regardless of whether that id came from spec
selector, slot wiring, or a JSX `cmsId` prop.

## Editor catalog manifest

`schema` is the SOLE declarative surface the editor reads. At first
catalog request, `cms-prerender.ts` walks every registered block
type and invokes its `schema` with a tracking CMS surface. Each
`cms.text(name)` / `cms.enum(name, values)` / `cms.image(name)` /
`cms.reference(name, type)` records the field's name + kind. Each
`cms.block(slot, selector)` / `cms.blocks(slot, selector)` records
the slot's allow filter + arity.

The resulting `BlockManifest` drives:

- Which field inputs the editor's field panel shows.
- Slot-allow filtering when offering "Add block" options for each
  slot.

Pure runtime — no static analysis, no JSX walking.

## Sharp edges

- **Singletons embed `#` in selector.** Don't pass `cmsId` JSX prop
  for a one-off singleton — declare it as a singleton spec. The
  `cmsId` prop is for genuinely per-instance placements (LivePrice's
  per-SKU pattern).
- **Slot wiring uses an internal `__cmsId` channel.** Don't read or
  pass `__cmsId` from user code. The framework injects it from
  `cms.blocks` / `cms.block`.
- **External addressing is by selector tokens.** The instance's id
  appears as `#<id>` for refetch only when the spec or placement
  exposed it. For multi-instance JSX placements with `cmsId="..."`,
  external code can target by that id; for slot entries, by the
  entry's id. Class tokens (`.foo`) always work as a shared union.

## Related

- [`partial.md`](./partial.md) — the base addressable-render-unit
  constructor.
- [`cms.md`](./cms.md) — content store, draft/published model, match
  clauses on configs.
- [`frames-navigation.md`](./frames-navigation.md) — `<Frame>` scope
  opener (separate from partials/blocks).
