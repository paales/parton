# CMS

CMS-driven content lives on [`ReactCms.block`](./block.md) specs via
a `schema` callback. The callback receives a sync `cms` read surface
bound to the block's effective `cmsId`; its return is merged into the
Render function's prop bag.

```tsx
const PromoBlock = ReactCms.block(
  function PromoRender({ headline, body, tone, dismissAfter }) {
    return <div data-tone={tone}>...</div>
  },
  {
    tags: [".promo"],
    schema: ({ cms }) => ({
      headline: cms.text("headline"),
      body: cms.text("body"),
      tone: cms.enum("tone", ["info", "warn"] as const),
      dismissAfter: cms.number("dismissAfter"),
    }),
  },
)
```

## Read surface

| Getter | Returns | Empty default |
|---|---|---|
| `cms.text(name)` | `string` | `""` |
| `cms.richText(name)` | `string` | `""` |
| `cms.number(name)` | `number` | `0` |
| `cms.boolean(name)` | `boolean` | `false` |
| `cms.enum(name, values)` | `T` | `values[0]` |
| `cms.image(name)` | `{src, alt}` | `{src:"", alt:""}` |
| `cms.reference(name, type)` | `string \| null` | `null` |

All sync. Every getter resolves against the already-loaded config
cascade for the block's `cmsId`. `cms.reference` returns the **id
only** — async loaders run inside `Render`, not `schema`.

## Content store schema

`cms/data/content.json` (committed) + `cms/data/draft.json` (gitignored).
Both share one shape:

```jsonc
{
  "partials": {
    "<cmsId>": {
      "id": "<cmsId>",
      "type": "<blockType>",
      "displayName": "...",
      "configs": [
        { "match": { ... }, "fields": { ... } }
      ],
      "slots": {
        "<slotName>": [ <CmsNode>, ... ]
      }
    }
  }
}
```

## Match clauses

Match keys you'll see:

| Key | Source |
|---|---|
| `url:<param>` | request search param |
| `cookie:<name>` | request cookie |
| `header:<name>` | request header |
| `pathname:<pattern>` | pathname pattern (e.g. `/p/:slug`) |

Clause values:
- scalar (string/number/boolean) → equality
- `{in: [...]}` → membership
- for `pathname:` keys → `{paramName: scalarOrIn, ...}`

Multi-key matches AND together. Empty `match: {}` always matches
(cascade default).

## Cascade resolution

The resolver picks every config whose match is satisfied, scores by
matched-dimension count, then merges fields least-specific-first so
more-specific overrides win. Specificity: longer score wins; ties
break by config-array order (earlier wins).

## Authoring a block

```tsx
// e2e-testing/src/app/blocks/promo.tsx
import { ReactCms, type RenderArgs } from "../../lib"

export const PromoBlock = ReactCms.block(
  function PromoRender({ headline, body, tone }: { ... } & RenderArgs) {
    return <div data-tone={tone}>...</div>
  },
  {
    tags: [".promo", ".demo-block"],
    schema: ({ cms }) => ({
      headline: cms.text("headline"),
      body: cms.text("body"),
      tone: cms.enum("tone", ["calm", "loud"] as const),
    }),
  },
)
```

That's it — no `registerBlock` call. The constructor self-registers
under its auto-derived name (`PromoRender` → `"promo"`); override via
`name`. Import the file once for its side effect
(`e2e-testing/src/app/blocks/catalog.ts` does this for the demo app).

## Slots

Slot composition lives on the schema. `cms.blocks(slot, selector?)`
returns a ReactNode that resolves every entry under `node.slots[slot]`
to a rendered block via the type catalog. `cms.block(slot, selector?)`
is the singular variant (at most one entry).

```tsx
import type { ReactNode } from "react"

export const PageRootBlock = ReactCms.block(
  function PageRootRender({ body, sidebar }: {
    body: ReactNode
    sidebar: ReactNode
  } & RenderArgs) {
    return (
      <main>
        {body}
        <aside>{sidebar}</aside>
      </main>
    )
  },
  {
    schema: ({ cms }) => ({
      body: cms.blocks("body", ".page-block"),
      sidebar: cms.block("sidebar", ".widget"),
    }),
  },
)
```

The framework wires host context (parent + effective cmsId) into the
`cms` surface implicitly. Author code doesn't thread `host` /
`hostCmsId`. Each slot entry's id becomes its block instance's
effective cmsId via the framework-internal slot wiring.

## References + entity loaders

```tsx
const ProductHero = ReactCms.block(
  async function ProductHeroRender({ productRef }: { productRef: string | null } & RenderArgs) {
    const product = productRef ? await getProduct(productRef) : null
    if (!product) return null
    return <Hero product={product} />
  },
  {
    tags: [".product-hero"],
    schema: ({ cms }) => ({
      productRef: cms.reference("featured", "product"),
    }),
  },
)
```

The id contributes to the cache key via the schema result; the async
loader runs in `Render`. Loaders are userspace (`e2e-testing/src/app/loaders/`).

## Draft + published

| Signal | Where |
|---|---|
| `?cms-draft=1` | Editor stamps it on the preview URL. |
| `Cookie: cms-draft=1` | Editor sets on first response. |
| `?editor=1` / `Cookie: __editor=1` | Editor mode implies draft visibility. |

`lookupCmsNode(cmsId, request)` checks draft first when any of these
hold, else falls back to published. Cache keys naturally vary across
modes because `cms.*` reads return different values inside `schema`.

## Editor mode

`/?editor=1` sets `__editor=1` cookie; subsequent requests render
inside `<EditorShell>`. Three panes:

- Tree (`#cms-edit-tree`) — registry-driven view of the cmsIds that
  rendered for the previewed page. The tree reads
  `getRouteSnapshots()` (every `<Spec cmsId>` self-registers at
  render time) and walks each snapshot's id as a tree root through
  `listAllCmsNodes(rootIds)`; slot-children-of-other-roots are
  filtered out automatically. Chrome that renders on every page
  (e.g. `<NavRootBlock cmsId="app-nav">` placed at the page root)
  appears on every page; per-page roots only appear where their
  partial mounts. Folds the previewed `pathname` into its `vary`
  so cross-page navigation invalidates the tree fp.
- Preview — the page itself, rendered inline inside the editor's
  middle pane. Page placements receive `parent={ROOT}`; their `vary`
  callbacks see the window URL with editor-internal params present
  (`?select=…`, `?config=…`). Specs whose `vary` only reads the
  pathname or page-relevant search params naturally ignore those.
- Field form (`#cms-edit-fields`) — per-config tabs + form fields
  derived from the catalog manifest. Folds `pathname` into its
  `vary` so `pickBestConfigIndex` re-evaluates as the previewed
  page changes.

Server actions (`saveCmsFields`, `publishCmsDraft`,
`addBlockToSlot`, `removeBlockFromSlot`, `moveBlockInSlot`,
`resetCmsDraft`) live in `cms/src/editor/actions.ts`.

## Catalog prerender

The editor's field form needs to know which fields each block type
declares. The catalog prerender walks every registered spec, calls
its `vary` once with a stub request and a tracking CMS surface, and
records the field reads.

`vary` is sync and pure-of-state — the prerender doesn't enter
React, doesn't render JSX, doesn't suspend. Every accessor read in
`vary` is captured, regardless of order or position relative to
hypothetical awaits.
