# `block(Render, …)`

Slot-placeable, type-catalog-registered partial. A block is what slots
look up by `type` to render their entries; its `schema` callback
declares both CMS content reads and child slot composition. `schema`
is the CMS resolution surface — the one declared schema in the
framework, and it exists because the editor needs a declarative
manifest of a block's content fields (the catalog prerender invokes
it with a tracking surface). Everything request-shaped stays in the
Render body, exactly as on `parton`.

```tsx
const HeroBlock = block(
  function HeroRender({ headline, subhead, tone }) {
    return (
      <article data-tone={tone}>
        <h1>{headline}</h1>
        <p>{subhead}</p>
      </article>
    )
  },
  {
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
  type (see [Identity](#identity--the-render-functions-name) below;
  `HeroRender` → `"hero"`); slots look it up by that type via
  `cms.blocks("body")` calls in their host's `schema`.
- **Singleton CMS binding falls out of the spec's type.** A singleton
  block placed directly via JSX reads the CMS storage row matching
  its type.
- **Content changes move the fingerprint via a tracked dep.** The
  block wrapper records a `cms:<contentKey>` dependency for the
  instance's content row; every fingerprint fold re-reads the row's
  content hash (committed store plus the requester's draft overlay),
  so a CMS edit re-renders exactly the blocks that read the edited
  row.

## Identity — the Render function's name

A block's type — the `type` slot entries name in the content store,
the catalog key slot lookups resolve, and for singleton placements the
CMS storage key — is its `Render` function's name, kebab-cased, with
ONE trailing `Render` / `Page` / `Block` / `Partial` / `Component`
suffix stripped:

```tsx
block(function HeroRender() {…})         // type "hero"
block(function ProductCardRender() {…})  // type "product-card"
block(function AppNavRender() {…})       // type "app-nav", CMS row "app-nav"
```

The derivation is `parton`'s, and so are its rules — the `displayName`
override, the anonymous-Render throw, and the collision gate that
rejects two distinct specs claiming one id. See
[partial.md § Identity](./partial.md#identity--the-render-functions-name).

The **content row** a block instance reads is its own axis, separate
from the effective render id (which is placement-scoped — props hash,
placement fold):

- **Slot-placed** — the slot entry's id. The framework threads it in
  internally; the instance renders under it and reads that row.
- **Singleton** — the spec's type.

## Options

```ts
interface BlockOptions<V, S> {
  /** CMS reads + child slot composition. Result is merged into
   *  Render's prop bag alongside the match params. */
  schema?: (scope: { cms: CmsReadSurface }) => S
  match?: MatchPattern
  cache?: CacheOptions
  defer?: DeferSpec
  fallback?: ReactNode
  keepalive?: boolean
}
```

| Option                                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                                           | Sync. Receives `{ cms }` — the CMS read surface, nothing else. Returns content reads (`cms.text(...)`, `cms.enum(...)`) and child slot compositions (`cms.blocks(...)`, `cms.block(...)`); both flow into Render as props. Request-dimension deps come from the tracked server-hooks (`searchParam()`, `cookie()`, …) read in the Render body, same as on `parton` — rare on blocks, whose content side lives on the `cms` surface. |
| `match`, `cache`, `defer`, `fallback`, `keepalive` | Same as [`parton`](./partial.md#options).                                                                                                                                                                                                                                                                                                                                                                                           |

## `cms` surface on schema

The `cms` argument is the read surface bound to the block's effective
CMS content row. Field getters (`text`, `richText`, `number`,
`boolean`, `enum`, `image`, `reference`) return values resolved from
the row's config cascade; `block(slot)` / `blocks(slot)` return
ReactNode for the block's slot children. All sync; the full getter
table with return types and empty-row defaults is in
[`cms.md`](./cms.md#read-surface).

`cms.blocks(slot)` resolves the slot's entries, looks each one up by
its `type` in the catalog, and renders the matching block in stored
order. The returned ReactNode is dropped into the Render's JSX
position. `cms.block(slot)` is the singular variant — renders at most
one entry, returns `null` when the slot is empty.

The framework binds the surface to the block's content row internally
— the schema never threads any of it.

## How blocks get placed

### 1. By a slot (from a host's schema)

A parent block hosts slots via its `schema`. The framework's slot
wiring passes the entry's id through to the rendered block instance —
internally, via a private channel — so the block's schema reads
content from the right CMS row. Author code never touches the id.

```tsx
const PageRoot = block(
  function PageRootRender({ body }) {
    return <main>{body}</main>
  },
  {
    schema: ({ cms }) => ({
      body: cms.blocks("body"),
    }),
  },
)
```

Each slot entry's id becomes its rendered effective id, the CMS row it
reads, and the `cms:<entry-id>` tag an editor write fires to wake it.

### 2. By direct JSX (singleton)

A singleton block is constructed once and placed once. Its CMS content
row matches its type, derived from the Render name:

```tsx
const AppNavBlock = block(
  function AppNavRender({ links }) {
    return <nav>{links}</nav>
  },
  {
    schema: ({ cms }) => ({ links: cms.blocks("links") }),
  },
)

<AppNavBlock/>
```

`AppNavRender` → type `"app-nav"`, so the spec reads from CMS row
`"app-nav"` (`e2e-testing/src/app/blocks/nav-root.tsx`, whose links
slot is the `"app-nav"` row in `cms/data/content.json`). Rename the
Render to move the row.

### 3. By direct JSX (non-CMS)

A spec without CMS binding doesn't need `block` at all — use
[`parton`](./partial.md). Each placement with distinct call-site props
is a distinct instance, and refreshes on the cells and tags its own
body reads:

```tsx
const LivePrice = parton(async function LivePriceRender({ sku }: { sku: string }) {
  tag(`price?sku=${encodeURIComponent(sku)}`)
  return <Price value={await fetchPrice(sku)} />
})

{
  products.map((p) => <LivePrice key={p.sku} sku={p.sku} />)
}
```

## Refresh signals

A block re-renders on the same two body-read signals as any parton —
cells and `tag()`, covered in
[partial.md § Refresh signals](./partial.md#refresh-signals--cells-and-tags).
The block wrapper adds one of its own for free: it reads
`tag("cms:<contentKey>")` for the instance's content row, so an
editor write's `refreshSelector("cms:<row>")` wakes exactly the
instances bound to the edited row. The `cms:<contentKey>` tracked dep
covers freshness (the fold re-reads the row's hash); the tag covers
delivery to a held connection.

## Editor catalog manifest

`schema` is the SOLE declarative surface the editor reads: the
catalog prerender invokes each block type's `schema` once with a
tracking CMS surface and records the field reads and slot
declarations into the `BlockManifest` that drives the editor's field
panel. Pure runtime — no static analysis, no JSX walking. Details in
[`cms.md`](./cms.md#catalog-prerender).

## Sharp edges

- **There is no `id` JSX prop.** A block's CMS row is determined
  by placement: slot wiring carries the entry's id internally;
  singletons read from the row matching their type. Don't try to
  override CMS bindings from a JSX call site.
- **A singleton's row tracks its call-site props.** Props at the call
  site mint a per-instance render id, and the block reads its content
  from that id's row — place a singleton bare (`<AppNav/>`) to keep
  it on the row matching its type.
- **Placement moves the render id, never the row.** A bare singleton
  placed under two different parents or frames mints two distinct
  render ids (the placement fold), but both read the ONE row matching
  their type — placement discriminates instances, not content. Give
  two placements distinct content by giving them distinct props (the
  bullet above) or by making them slot entries.
- **There is no public per-instance id override.** Placements with
  distinct call-site props, and placements under different parents or
  frames, already get distinct render ids (see
  [partial.md § Identity](./partial.md#identity--the-render-functions-name)).
  To get per-instance CMS rows, route through a slot.

## Related

- [`partial.md`](./partial.md) — the base render-unit constructor.
- [`cms.md`](./cms.md) — content store, draft/published model, match
  clauses on configs, the `cms` getter table.
- [`frames-navigation.md`](./frames-navigation.md) — `<Frame>` scope
  opener (separate from partials/blocks) and the `useNavigation`
  surface.
