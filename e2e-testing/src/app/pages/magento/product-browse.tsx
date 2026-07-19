/**
 * /magento/browse — the catalog as a `scroller()` collection.
 *
 * One CSS grid (`.browse-grid` — the wrapper carries `name` as its
 * class, so the app stylesheet owns `--scroller-cols` /
 * `--scroller-row` under it with no extra wiring): a placed span of
 * cull-gated leaf partons around the `?page=` anchor, reservation
 * shells covering the rest of the catalog with CSS arithmetic. Leaves
 * fetch their slice only in view; a scrollbar jump self-materializes
 * skeleton cells client-side and moves the span with one replace
 * navigation.
 *
 * Order and content are split: `browseProductsCell` (the slice) owns
 * which products in what order; each card is its OWN parton bound to
 * `browseCardCell` (the entity, keyed by uid) — a product's content
 * invalidates per entity, wherever it appears. Prices STREAM per
 * card (`LivePricePartial` behind Suspense, the same spec /magento
 * uses — `refreshSelector("price")` fans out here too).
 *
 * The page also demonstrates that the scroller never owns the query:
 * the FilterBar (aggregations) and the Pagination (total) are plain
 * partons that JOIN the same `browseProductsCell` — same partition,
 * same backend fetch, three projections of one result.
 */

import { Card, CardContent } from "@parton/copies/components/ui/card"
import {
  parton,
  scroller,
  searchParam,
  type BoundCell,
  type CellValue,
  type RenderArgs,
  type ResolvedCell,
} from "@parton/framework"
import { Suspense } from "react"
import { LivePriceFallback, LivePricePartial } from "./live-price.tsx"
import { browseCardCell, browseProductsCell } from "./products-cell.ts"

type CardItem = CellValue<typeof browseCardCell>

/** Items per leaf parton — also the slice fetch size and the derived
 *  page size of the `?page=` projection. The one geometry number that
 *  is NOT CSS (counts, not pixels). */
const LEAF = 12

// One product card — the ENTITY parton. Its only dependency is the
// card cell it's bound to, so it re-renders on that product's
// invalidation and fp-skips through everything else (a re-sorted
// slice moves placements, not card bytes). The card is one grid cell
// and OWNS its height — `--scroller-row` is the floor/estimate; the
// bottom margin is the visual row spacing (row-gap stays 0). The
// price STREAMS: the card's shell (name, image) commits immediately,
// the per-SKU live price resolves behind its own Suspense.
const BrowseCard = parton(function BrowseCardRender({
  item,
  anchorId,
}: { item: ResolvedCell<CardItem>; anchorId?: string } & RenderArgs) {
  const p = item.value
  if (!p) return null
  const price = p.price_range.minimum_price.regular_price
  return (
    <Card
      id={anchorId}
      className="mb-3 min-h-[240px] p-4"
      data-testid={`browse-card-${p.sku ?? p.uid}`}
    >
      <CardContent className="flex h-full flex-col gap-1 px-0">
        {p.small_image?.url && (
          <img
            src={p.small_image.url}
            alt={p.small_image?.label || p.name || ""}
            loading="lazy"
            className="h-24 w-24 object-contain"
          />
        )}
        <h3 className="mt-1 line-clamp-2 text-sm">{p.name}</h3>
        <div className="mt-auto">
          {p.sku ? (
            <Suspense
              fallback={
                <LivePriceFallback
                  sku={p.sku}
                  basePrice={price.value ?? 0}
                  currency={price.currency ?? "USD"}
                />
              }
            >
              <LivePricePartial
                sku={p.sku}
                basePrice={price.value ?? 0}
                currency={price.currency ?? "USD"}
              />
            </Suspense>
          ) : (
            <span className="font-semibold tabular-nums">
              {price.currency} {(price.value || 0).toFixed(2)}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
})

/** The slice the page-level projections join: the first page of the
 *  CURRENT filter — the same partition leaf 0 resolves, so on page 1
 *  the whole page costs one backend query. */
function projectionArgs() {
  const q = searchParam("q")
  return { pageSize: LEAF, currentPage: 1, ...(q ? { search: q } : {}) }
}

// The FACETS — a plain parton JOINING the scroller's query. It
// resolves the same `browseProductsCell` partition the slice path
// uses and reads a different projection of the result: the
// aggregations. No scroller API involved — the cell is the shared
// address of the query result.
const BrowseFilterBar = parton(async function BrowseFilterBarRender(_: RenderArgs) {
  const res = await browseProductsCell.resolve(projectionArgs())
  const aggregations = (res.value?.products?.aggregations ?? []).filter(
    (a): a is NonNullable<typeof a> => a != null,
  )
  if (aggregations.length === 0) return null
  return (
    <div data-testid="browse-facets" className="mb-4 flex flex-col gap-2">
      {aggregations.slice(0, 3).map((agg) => (
        <div key={agg.attribute_code} className="flex flex-wrap items-baseline gap-2">
          <span className="text-xs font-medium text-muted-foreground">{agg.label}</span>
          {(agg.options ?? [])
            .filter((o): o is NonNullable<typeof o> => o != null)
            .slice(0, 8)
            .map((o) => (
              <span
                key={o.value}
                data-testid="browse-facet-option"
                className="rounded-full border px-2 py-0.5 text-xs"
              >
                {o.label} <span className="tabular-nums text-muted-foreground">{o.count}</span>
              </span>
            ))}
        </div>
      ))}
    </div>
  )
})

// The PAGINATION — pages as real links. `?page=` is a projection over
// the same source the scroller scrolls, so a pagination bar is just
// anchors: a click is an ordinary client nav, the anchor sync sees an
// EXTERNAL anchor statement and moves the viewport there (id when the
// target is in-span, estimate arithmetic when it isn't). `total`
// joins the same cell as the facets — no scroller API.
const BrowsePagination = parton(async function BrowsePaginationRender(_: RenderArgs) {
  const res = await browseProductsCell.resolve(projectionArgs())
  const total = res.value?.products?.total_count ?? 0
  const pages = Math.max(1, Math.ceil(total / LEAF))
  const current = Math.max(1, Number(searchParam("page")) || 1)
  const q = searchParam("q")

  const href = (p: number) => {
    const sp = new URLSearchParams()
    if (q) sp.set("q", q)
    if (p > 1) sp.set("page", String(p))
    const s = sp.toString()
    return `/magento/browse${s ? `?${s}` : ""}`
  }
  // A window of links around the current page, plus the ends.
  const shown = [
    ...new Set([1, current - 2, current - 1, current, current + 1, current + 2, pages]),
  ]
    .filter((p) => p >= 1 && p <= pages)
    .sort((a, b) => a - b)

  return (
    <nav data-testid="browse-pagination" className="my-6 flex items-baseline gap-1 text-sm">
      {shown.map((p, i) => (
        <span key={p} className="flex items-baseline gap-1">
          {i > 0 && shown[i - 1] !== p - 1 && <span className="text-muted-foreground">…</span>}
          {p === current ? (
            <span
              aria-current="page"
              className="rounded bg-primary px-2 py-1 text-primary-foreground tabular-nums"
            >
              {p}
            </span>
          ) : (
            <a
              href={href(p)}
              data-testid={`browse-page-link-${p}`}
              className="rounded px-2 py-1 tabular-nums hover:bg-muted"
            >
              {p}
            </a>
          )}
        </span>
      ))}
    </nav>
  )
})

const BrowseGrid = scroller({
  name: "browse-grid",
  load: async ({ offset, limit }) => {
    // A FILTER is just a tracked read in the loader: `?q=` records as
    // the calling parton's dep, so a filter change re-renders the
    // collection — and the card partons fp-skip through it wherever
    // their entities didn't change (the order/content split).
    const q = searchParam("q")
    const res = await browseProductsCell.resolve({
      pageSize: limit,
      currentPage: offset / limit + 1,
      ...(q ? { search: q } : {}),
    })
    const items = (res.value?.products?.items ?? []).filter(
      (it): it is BoundCell<CardItem> => it != null,
    )
    return { items, total: res.value?.products?.total_count ?? 0 }
  },
  // The ENTITY key — the framework keys each cell, so `render`
  // returns the bare card.
  key: (item) => String(item.args.uid),
  render: ({ item, id }) => <BrowseCard item={item} anchorId={id} />,
  leaf: LEAF,
})

export const ProductBrowsePage = parton(
  function ProductBrowseRender(_: RenderArgs) {
    return (
      <>
        <title>Browse Products</title>
        <header className="mb-4">
          <h1 className="text-2xl font-semibold">Browse Products</h1>
          <p className="text-muted-foreground">
            The catalog as one windowed collection — leaf partons fetch only in view, every card is
            its own parton, <code>?page=</code> is a projection over the same source.
          </p>
        </header>
        {/* The filter projection: a plain GET form — submitting
            navigates to ?q=…, the loader's tracked read re-renders
            the collection. */}
        <form method="get" action="/magento/browse" className="mb-4">
          <input
            type="search"
            name="q"
            defaultValue={searchParam("q") ?? ""}
            placeholder="Filter products…"
            data-testid="browse-filter"
            className="w-64 rounded-md border px-3 py-1.5 text-sm"
          />
        </form>
        <BrowseFilterBar />
        <div data-testid="browse-list">
          <BrowseGrid />
        </div>
        <BrowsePagination />
      </>
    )
  },
  { match: "/magento/browse" },
)
