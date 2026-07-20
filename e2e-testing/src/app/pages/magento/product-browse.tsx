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
 * the FilterBar (facets + active filters) and the Pagination (total)
 * are plain partons that JOIN the same `browseProductsCell` — same
 * partitions, shared single-flight resolves, projections of one
 * result. Facets are LINKS: a click states the filter in the URL,
 * every loader's tracked `f_<code>` read re-renders the collection.
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
type BrowseArgs = NonNullable<Parameters<typeof browseProductsCell.resolve>[0]>
type BrowseFilter = NonNullable<BrowseArgs["filter"]>

/** Items per leaf parton — also the slice fetch size and the derived
 *  page size of the `?page=` projection. The one geometry number that
 *  is NOT CSS (counts, not pixels). */
const LEAF = 12

/** The facet attributes the filter bar drives. Each active facet is
 *  one URL param (`f_<code>=<value>`) — the URL is the filter state,
 *  so filters survive reload/share and every read of them is a
 *  tracked dep. Single-select per facet; clicking the active option
 *  clears it. */
const FACETS = ["price", "category_uid"] as const
type FacetCode = (typeof FACETS)[number]

/** The active facets, read from the URL — tracked reads, so every
 *  parton deriving its query args from them re-renders when a facet
 *  toggles. */
function readFacets(): Partial<Record<FacetCode, string>> {
  const active: Partial<Record<FacetCode, string>> = {}
  for (const code of FACETS) {
    const v = searchParam(`f_${code}`)
    if (v) active[code] = v
  }
  return active
}

/** Active facets → the Magento filter input. Price options are range
 *  buckets (`"0_113"` → from/to); everything else filters by eq. */
function toFilter(active: Partial<Record<FacetCode, string>>): BrowseFilter {
  const filter: BrowseFilter = {}
  if (active.price) {
    const [from = "0", to = ""] = active.price.split("_")
    filter.price = { from, to }
  }
  if (active.category_uid) filter.category_uid = { eq: active.category_uid }
  return filter
}

/** One window of the ACTIVE query — the slice the scroller loads and
 *  the partition every page projection joins. Deriving args through
 *  this one helper is what keeps the partitions ALIGNED: leaf 0, the
 *  root's shape read, the filter counts, and the pagination total all
 *  hash to the same partition and share one single-flight fetch. */
function sliceArgs(offset: number, limit: number): BrowseArgs {
  return { pageSize: limit, currentPage: offset / limit + 1, filter: toFilter(readFacets()) }
}

/** An href stating a facet selection (and dropping `?page=` — a
 *  filter change reshapes the collection, so the anchor resets). */
function facetHref(
  active: Partial<Record<FacetCode, string>>,
  patch: Partial<Record<FacetCode, string | null>>,
) {
  const sp = new URLSearchParams()
  for (const code of FACETS) {
    const v = code in patch ? patch[code] : active[code]
    if (v) sp.set(`f_${code}`, v)
  }
  const s = sp.toString()
  return `/magento/browse${s ? `?${s}` : ""}`
}

// One product card — the ENTITY parton, the scroller's `render`
// component. Its only dependency is the card cell it's bound to, so
// it re-renders on that product's invalidation and fp-skips through
// everything else (a re-sorted slice moves placements, not card
// bytes). The card is one grid cell and OWNS its height —
// `--scroller-row` is the floor/estimate; the bottom margin is the
// visual row spacing (row-gap stays 0). `id` is the scroller's public
// anchor id on boundary items — on the element, so deep links target
// real content. The price STREAMS: the card's shell (name, image)
// commits immediately, the per-SKU live price resolves behind its own
// Suspense.
const BrowseCard = parton(function BrowseCardRender({
  item,
  id,
}: { item: ResolvedCell<CardItem>; id?: string } & RenderArgs) {
  const p = item.value
  if (!p) return null
  const price = p.price_range.minimum_price.regular_price
  return (
    <Card id={id} className="mb-3 min-h-[240px] p-4" data-testid={`browse-card-${p.sku ?? p.uid}`}>
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

// The FILTER BAR — a plain parton JOINING the scroller's query, both
// sides of it:
//   - the option UNIVERSE comes from the UNFILTERED query, so the bar
//     stays stable while filters toggle (options never vanish because
//     the current result no longer contains them);
//   - the COUNTS come from the ACTIVE query, so every number reflects
//     what the grid is actually showing.
// Same cell, two partitions — and with no filter active the two args
// are identical, so they collapse into ONE shared resolve. No
// scroller API involved: the cell is the shared address of the query
// result, and resolving a partition is the join.
const BrowseFilterBar = parton(async function BrowseFilterBarRender(_: RenderArgs) {
  const active = readFacets()
  const hasFilter = Object.keys(active).length > 0
  const [base, current] = await Promise.all([
    browseProductsCell.resolve({ pageSize: LEAF, currentPage: 1, filter: {} }),
    browseProductsCell.resolve(sliceArgs(0, LEAF)),
  ])
  const universe = (base.value?.products?.aggregations ?? []).filter(
    (a): a is NonNullable<typeof a> => a != null && FACETS.includes(a.attribute_code as FacetCode),
  )
  if (universe.length === 0) return null

  // Counts of the active result, keyed `code:value`; an option absent
  // here has 0 matches under the current filter.
  const countOf = new Map<string, number>()
  for (const agg of current.value?.products?.aggregations ?? []) {
    for (const o of agg?.options ?? []) {
      if (o) countOf.set(`${agg?.attribute_code}:${o.value}`, o.count ?? 0)
    }
  }
  // Labels for the active-filter chips, from the universe.
  const labelOf = new Map<string, string>()
  for (const agg of universe) {
    for (const o of agg.options ?? []) {
      if (o) labelOf.set(`${agg.attribute_code}:${o.value}`, o.label ?? o.value)
    }
  }

  return (
    <div data-testid="browse-facets" className="mb-4 flex flex-col gap-2">
      {hasFilter && (
        <div data-testid="browse-active-filters" className="flex flex-wrap items-baseline gap-2">
          <span className="text-xs font-medium text-muted-foreground">Active</span>
          {FACETS.filter((code) => active[code]).map((code) => (
            <a
              key={code}
              href={facetHref(active, { [code]: null })}
              data-testid={`browse-active-filter-${code}`}
              className="rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground"
            >
              {labelOf.get(`${code}:${active[code]}`) ?? active[code]} ✕
            </a>
          ))}
          <a
            href="/magento/browse"
            data-testid="browse-clear-filters"
            className="text-xs text-muted-foreground underline"
          >
            Clear all
          </a>
        </div>
      )}
      {universe.map((agg) => (
        <div key={agg.attribute_code} className="flex flex-wrap items-baseline gap-2">
          <span className="text-xs font-medium text-muted-foreground">{agg.label}</span>
          {(agg.options ?? [])
            .filter((o): o is NonNullable<typeof o> => o != null)
            .slice(0, 8)
            .map((o) => {
              const code = agg.attribute_code as FacetCode
              const isActive = active[code] === o.value
              const count = countOf.get(`${code}:${o.value}`) ?? 0
              return (
                <a
                  key={o.value}
                  href={facetHref(active, { [code]: isActive ? null : o.value })}
                  data-testid="browse-facet-option"
                  data-active={isActive || undefined}
                  aria-pressed={isActive}
                  className={
                    isActive
                      ? "rounded-full border border-primary bg-primary px-2 py-0.5 text-xs text-primary-foreground"
                      : count === 0
                        ? "rounded-full border px-2 py-0.5 text-xs opacity-40"
                        : "rounded-full border px-2 py-0.5 text-xs hover:bg-muted"
                  }
                >
                  {o.label}{" "}
                  <span
                    data-testid="browse-facet-count"
                    className={isActive ? "tabular-nums" : "tabular-nums text-muted-foreground"}
                  >
                    {count}
                  </span>
                </a>
              )
            })}
        </div>
      ))}
    </div>
  )
})

// The PAGINATION — pages as real links over the ACTIVE query. `?page=`
// is a projection over the same source the scroller scrolls, so a
// pagination bar is just anchors: a click is an ordinary client nav,
// the anchor sync sees an EXTERNAL anchor statement and moves the
// viewport there (id when the target is in-span, estimate arithmetic
// when it isn't). `total` joins the same partition as the grid — the
// filtered collection is what it paginates.
const BrowsePagination = parton(async function BrowsePaginationRender(_: RenderArgs) {
  const active = readFacets()
  const res = await browseProductsCell.resolve(sliceArgs(0, LEAF))
  const total = res.value?.products?.total_count ?? 0
  const pages = Math.max(1, Math.ceil(total / LEAF))
  const current = Math.max(1, Number(searchParam("page")) || 1)

  const href = (p: number) => {
    const sp = new URLSearchParams()
    for (const code of FACETS) {
      if (active[code]) sp.set(`f_${code}`, active[code])
    }
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
    // The filter is just tracked reads in the loader: each `f_<code>`
    // param records as the calling parton's dep, so a facet toggle
    // re-renders the collection — and the card partons fp-skip
    // through it wherever their entities didn't change (the
    // order/content split).
    const res = await browseProductsCell.resolve(sliceArgs(offset, limit))
    const items = (res.value?.products?.items ?? []).filter(
      (it): it is BoundCell<CardItem> => it != null,
    )
    return { items, total: res.value?.products?.total_count ?? 0 }
  },
  // `load` defines the item, `key` names it, `render` draws it — the
  // card parton IS the renderer.
  key: (item) => String(item.args.uid),
  render: BrowseCard,
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
            its own parton, <code>?page=</code> and the facets are projections over the same source.
          </p>
        </header>
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
