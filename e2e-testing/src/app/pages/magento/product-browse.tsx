/**
 * /magento/browse — view-culled product scroller over a data-driven,
 * unbounded page count.
 *
 * `BrowseList` renders only a WINDOW of fixed-height sections around the
 * anchor; everything above and below collapses into two spacers sized
 * from `total_count` (data-driven, not a hardcoded pool), so the document
 * height stays `totalPages × PAGE_H` — stable scroll, no jumps — while the
 * payload is just the window, not the whole catalog. Only the RING of
 * pages nearest the anchor fetch products; the rest of the window is a
 * skeleton runway so the observer sees the edge coming. The anchor rides
 * the `browse_vis` cookie (off the sharable url, written by
 * `<BrowseScroller>`); on scroll the list reloads against it and the
 * window follows the viewport.
 *
 * Two deliberate shapes here, both load-bearing:
 *  - `total_count` is fetched by the ROUTE (rendered once) and passed to
 *    BrowseList as a `totalPages` PROP. It must NOT be BrowseList's
 *    `schema` cell: a cached schema cell makes the framework treat the
 *    partial as unchanged, so its reloads stop committing.
 *  - the ring's products are a parton keyed by page, so pages that stay
 *    in-ring across a scroll fp-skip while new ones stream in.
 */

import { parton, type CellValue, type RenderArgs, type ResolvedCell } from "@parton/framework"
import { Card, CardContent } from "@parton/copies/components/ui/card"
import { BrowseScroller } from "../../components/browse-scroller.tsx"
import { magentoProductsCell } from "./products-cell.ts"

type ProductsValue = NonNullable<CellValue<typeof magentoProductsCell>>
type ProductItem = NonNullable<NonNullable<NonNullable<ProductsValue["products"]>["items"]>[number]>

const PAGE_SIZE = 12
/** Pages within ±RING_OVER of the anchor fetch + render products. */
const RING_OVER = 2
/** The window actually rendered is ±WINDOW_OVER of the anchor: the ring,
 *  plus a skeleton runway so the observer can see the edge coming. Pages
 *  outside the window are not rendered at all — they're collapsed into the
 *  two spacers above and below, sized from the page count. */
const WINDOW_OVER = 6
/** Fixed pixel height of every page — keeps the document stable. */
const PAGE_H = 760

const GRID = "grid flex-1 grid-cols-4 grid-rows-3 gap-3 min-h-0"

function GridSkeleton() {
  return (
    <div className={GRID} aria-hidden>
      {Array.from({ length: PAGE_SIZE }, (_, i) => (
        <div key={i} className="h-full animate-pulse rounded-xl bg-muted/40" />
      ))}
    </div>
  )
}

function BrowseProductCard({ product }: { product: ProductItem }) {
  const { name, sku, id } = product

  return (
    <Card className="h-full overflow-hidden p-4" data-testid={`browse-card-${sku ?? id}`}>
      <CardContent className="flex h-full flex-col gap-1 px-0">
        {product.small_image?.url && (
          <img
            src={product.small_image.url}
            alt={product.small_image?.label || name || ""}
            loading="lazy"
            className="h-24 w-24 object-contain"
          />
        )}
        <h3 className="mt-1 line-clamp-2 text-sm">{name}</h3>
        <span className="mt-auto font-semibold tabular-nums">
          {product.price_range.minimum_price.regular_price.currency}{" "}
          {(product.price_range.minimum_price.regular_price.value || 0).toFixed(2)}
        </span>
      </CardContent>
    </Card>
  )
}

// One ring page's products — a parton keyed by page (distinct props ⇒
// distinct id), so in-ring pages fp-skip across a scroll. `data-page`
// lives on the SECTION shell (BrowseList), not here.
const BrowsePageProducts = parton(
  function BrowsePageProductsRender({
    products,
  }: { page: number; products: ResolvedCell<CellValue<typeof magentoProductsCell>> } & RenderArgs) {
    const items = (products.value?.products?.items ?? []).filter(
      (it): it is ProductItem => it != null,
    )
    return (
      <div className={GRID}>
        {items.map((p) => (
          <BrowseProductCard key={p.sku ?? p.id} product={p} />
        ))}
      </div>
    )
  },
  { fallback: <GridSkeleton /> },
)

const BrowseList = parton(
  function BrowseListRender({
    totalPages,
    anchor,
  }: { totalPages: number; anchor: number } & RenderArgs) {
    // Render only the window around the anchor; collapse everything above
    // and below into two spacers, sized from the page count, so the
    // document height stays `totalPages × PAGE_H` (stable scroll) while the
    // payload is just the window — not the whole catalog.
    const lo = Math.max(1, anchor - WINDOW_OVER)
    const hi = Math.min(totalPages, anchor + WINDOW_OVER)
    const pages: number[] = []
    for (let p = lo; p <= hi; p++) pages.push(p)
    return (
      <div data-testid="browse-list" data-anchor={anchor} data-total-pages={totalPages}>
        <div aria-hidden data-testid="browse-spacer-top" style={{ height: (lo - 1) * PAGE_H }} />
        {pages.map((p) => (
          <section
            key={p}
            data-testid={`browse-page-${p}`}
            data-page={p}
            style={{ height: PAGE_H }}
            className="flex flex-col overflow-hidden"
          >
            <h2 className="h-6 text-xs font-medium text-muted-foreground">Page {p}</h2>
            {Math.abs(p - anchor) <= RING_OVER ? (
              <BrowsePageProducts
                page={p}
                products={magentoProductsCell.with({ pageSize: PAGE_SIZE, currentPage: p })}
              />
            ) : (
              <GridSkeleton />
            )}
          </section>
        ))}
        <div
          aria-hidden
          data-testid="browse-spacer-bottom"
          style={{ height: Math.max(0, totalPages - hi) * PAGE_H }}
        />
      </div>
    )
  },
  {
    selector: "#browse-list",
    // Anchor rides the `browse_vis` cookie (off the sharable url);
    // cold-start falls back to the `?page=` anchor on the page url.
    vary: ({ cookies, search }) => {
      const c = Number(cookies.browse_vis)
      const anchor = Number.isFinite(c) && c >= 1 ? c : Math.max(1, Number(search.page) || 1)
      return { anchor }
    },
  },
)

export const ProductBrowsePage = parton(
  function ProductBrowseRender({
    meta,
  }: { meta: ResolvedCell<CellValue<typeof magentoProductsCell>> } & RenderArgs) {
    const total = meta.value?.products?.total_count ?? 0
    const totalPages = total > 0 ? Math.ceil(total / PAGE_SIZE) : 1
    return (
      <>
        <title>Browse Products</title>
        <header className="mb-4">
          <h1 className="text-2xl font-semibold">Browse Products</h1>
          <p className="text-muted-foreground">
            View-culled scroll over the whole catalog ({totalPages} pages) — only the pages near the
            viewport fetch; the rest are reserved space. <code>?page=</code> tracks where you are.
          </p>
        </header>
        {/* The scope is a stable element the route owns; BrowseList is a
            direct refetchable child of it, and the scroller observes it
            from beside (not around) the list. */}
        <div data-testid="browse-scope">
          <BrowseList totalPages={totalPages} />
        </div>
        <BrowseScroller />
      </>
    )
  },
  {
    match: "/magento/browse",
    // `total_count` is fetched HERE (the route renders once) and passed to
    // BrowseList as a prop — never BrowseList's schema (see header note).
    schema: () => ({ meta: magentoProductsCell.with({ pageSize: PAGE_SIZE, currentPage: 1 }) }),
  },
)
