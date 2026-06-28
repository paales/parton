/**
 * /magento/browse — view-culled product scroller over a data-driven,
 * unbounded page count.
 *
 * `BrowseList` renders one fixed-height section per page of the whole
 * catalog (the count comes from `total_count`, not a hardcoded pool), so
 * the document height is stable — scrolling never jumps. Off-screen pages
 * are culled from PAINT by `content-visibility`, and only the RING of
 * pages around the anchor fetch products; the rest are skeletons. The
 * anchor rides the `browse_vis` cookie (off the sharable url, written by
 * `<BrowseScroller>`); on scroll the list reloads against it and the ring
 * follows the viewport.
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
  const imageUrl = product.small_image?.url
  const imageLabel = product.small_image?.label
  const rawPrice = product.price_range.minimum_price.regular_price.value
  const currency = product.price_range.minimum_price.regular_price.currency ?? "USD"
  const price = typeof rawPrice === "number" ? rawPrice : 0
  return (
    <Card className="h-full overflow-hidden p-4" data-testid={`browse-card-${sku ?? id}`}>
      <CardContent className="flex h-full flex-col gap-1 px-0">
        {imageUrl && (
          <img
            src={imageUrl}
            alt={imageLabel || name || ""}
            loading="lazy"
            className="h-24 w-24 object-contain"
          />
        )}
        <h3 className="mt-1 line-clamp-2 text-sm">{name}</h3>
        <span className="mt-auto font-semibold tabular-nums">
          {currency} {price.toFixed(2)}
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
    const pages: number[] = []
    for (let p = 1; p <= totalPages; p++) pages.push(p)
    return (
      <div data-testid="browse-list" data-anchor={anchor} data-total-pages={totalPages}>
        {pages.map((p) => (
          <section
            key={p}
            data-testid={`browse-page-${p}`}
            data-page={p}
            // Fixed height keeps the document stable; content-visibility
            // culls the PAINT of off-screen pages (browser-native).
            style={{
              height: PAGE_H,
              contentVisibility: "auto",
              containIntrinsicSize: `auto ${PAGE_H}px`,
            }}
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
