# scroller() — windowed collections

`scroller(Render, options)` renders a collection (catalog, listing,
feed) as an **interval tree of cullable partons over item index
space** — the 1D analogue of the demo world's quadtree. It is a
constructor composed around `parton()` + the `cull` gate: everything
it emits is ordinary partons, so fingerprints, fp-skip, refetch,
keepalive, and the live channel all apply unchanged.

The division of labor:

- **The tree owns placement**: which intervals of the collection
  exist in the DOM, which resolve their data, which collapse to
  shells. Existence is CULL-driven (viewport), never URL-driven.
- **Items own content**: each item the Render places is expected to
  be (or contain) its own parton bound to a per-entity cell — so item
  content invalidates per entity, wherever it appears, and a
  re-sorted slice moves placements without re-shipping item bytes.
- **Pagination is a projection**: the `anchor` URL param seeds the
  cold render and mirrors the scroll position. A page is never a
  render unit; `?page=N` links (a pager, a sitemap) are plain links
  over the same source.

```tsx
const BrowseGrid = scroller(
  function BrowseGridRender({ items }: ScrollerSlice<BoundCell<CardItem>> & RenderArgs) {
    return (
      <div className={GRID}>
        {items.map((item) => (
          <BrowseCard key={String(item.args.uid)} item={item} />
        ))}
      </div>
    )
  },
  {
    range: async ({ offset, limit }) => {
      const res = await browseProductsCell.resolve({
        pageSize: limit,
        currentPage: offset / limit + 1,
      })
      const items = (res.value?.products?.items ?? []).filter(isPresent)
      return { items, total: res.value?.products?.total_count ?? 0 }
    },
    shell: BrowseShell, // "use client" — the culled reservation
    estimate: (n) => Math.ceil(n / COLS) * CARD_ROW_PX,
    leaf: 12,
    fanout: 4,
    anchor: { param: "page", pageSize: 12 },
  },
)
// placement: <BrowseGrid />
```

Worked demos: `e2e-testing/src/app/pages/magento/product-browse.tsx`
(grid, per-item entity cells) and the pokedex list in
`e2e-testing/src/app/pages/pokemon.tsx` (fragment-cell forwarding).

## The source: `range`

One async function from a window request to `{ items, total }`. The
scroller always asks in `leaf`-aligned slices (`offset % leaf === 0`,
`limit === leaf`), so a page-shaped backend maps directly
(`currentPage: offset / limit + 1`).

Resolve data through tracked reads (cells) inside — the read IS the
dependency: a leaf re-renders when its slice's cell invalidates. The
tracking invariant applies as everywhere. `total` is restated by
every slice; the ROOT's read of it (it resolves the head slice —
shared with leaf 0's cell partition, so no extra fetch) is what
re-shapes the tree when the collection grows.

The idiomatic source is a slice query cell **composed with a
per-item fragment cell** (`backend.query(str, [itemCell])`): the
slice result's spread sites arrive as the item cell's BoundCells,
and the Render forwards each straight into an item parton. Order
then lives on the slice cell, content on the entity cell.

## The Render and the shell

The author's Render is the **layout renderer** for one resolved
slice — `{ items, offset, total }`. It owns all markup: the list
container, item placement, empty states.

`shell` is its culled twin — a `"use client"` component receiving
`{ o, n, h }` (offset, item count, server-computed px from
`estimate(n)`). At leaf counts (`n <= leaf`) render per-item
placeholders in the same layout, so a slice streams in over the
shape it culls out to; for deeper regions render one `h`-px block.
`estimate` is the one geometric number the author declares —
everything else is CSS.

## Geometry and identity

Leaves cover `leaf` items; levels group `fanout` children; the tree
height derives from `total` (`scrollerDepthFor`). A node IS its
interval: specs are minted per level (`<id>-l<k>`, leaf id from the
Render name), placements carry `{o, n}` props, so instance identity
derives from the interval and survives collection growth — a middle
segment's props never change when `total` moves; only the clamped
tail (and the root) re-render. Crossing a capacity boundary
(`leaf · fanout^k`) re-parents the top of the tree and re-caches —
rare by construction (each crossing is a `fanout`× growth).

Every placement is wrapped in an interval marker
(`data-s=<id> data-so data-sn`, emitted by the PARENT so it exists
in every cull state). The markers are the position surface: the
anchor client navigates by them, and tests/tools can read tree
shape off the DOM.

Cull runways stagger by height (`rootMargin + k · estimate(leaf)`),
the demo world's staggered-runway rule in item units: an ancestor
mounts its children's observers before their own flip line, so a
steady scroll batches each crossing.

## The anchor

`anchor: { param, pageSize? }` wires three things:

- **Cold seed.** Every segment's cull seed reads the param (a
  tracked `searchParam()` read) and resolves in-view iff its
  interval intersects the anchored window padded by one leaf — the
  same intersection rule at every level, so the cold tree is exactly
  the root-to-anchor spine, O(viewport + log collection).
- **Deep-link landing.** A pre-hydration script (document loads) and
  a layout-effect scroll (client navs) land the viewport on the
  anchored interval — into a still-culled region, the shell's
  reservation is the landing strip.
- **The mirror.** As the user scrolls, the interval under the
  viewport's center is written back silently
  (`history: "replace", silent: true` — no refetch, no history
  pile-up). The center is resolved by **hit test**
  (`elementFromPoint`), which is occlusion-aware: while an overlay
  (dialog, drawer) covers the collection, no marker is hit and the
  mirror stands down.

Without `anchor`, the collection seeds at its head and the URL is
untouched.

## Limits (current, deliberate)

- **Estimate drift.** A culled region's reservation is `estimate`
  px; materialization replaces it with real layout. Below-viewport
  drift is invisible; above-viewport drift can shift scroll by the
  error. Measure-and-pin (the observer already produces rects) is
  the known refinement.
- **Teleport cascade.** A deep link or long jump into unexplored
  territory materializes level by level (one lane round-trip per
  level of the spine). The anchored deep link avoids this (the seed
  renders the spine server-side in one pass); an unanchored teleport
  converges progressively.
- **Append-shaped growth only.** Interval identity assumes an item's
  index is stable per (source, sort, filter) modulo appends. Sorted
  catalogs re-slice cleanly (segments re-render, item partons
  fp-skip by entity); prepend-shaped feeds want the signed extension
  of the same tree — not built yet.
- **`range` is offset/limit.** Cursor sources adapt by mapping
  cursors to offsets; an async-iterator/streaming source adapter is
  backlog.
