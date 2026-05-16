import { ReactCms, type RenderArgs } from "@react-cms/framework"
import { RefreshPriceButton } from "./refresh-price-button.tsx"

export function LivePriceFallback({
  sku,
  basePrice,
  currency,
}: {
  sku: string
  basePrice: number
  currency: string
}) {
  return (
    <div data-testid={`live-price-fallback-${sku}`} className="mt-2 flex items-center gap-2">
      <span className="font-semibold italic text-muted-foreground tabular-nums">
        {currency} {basePrice.toFixed(2)}
      </span>
      <span className="text-xs text-muted-foreground">loading…</span>
    </div>
  )
}

/**
 * Per-SKU live price. NOT CMS-bound — `basePrice`, `currency`, `sku`
 * flow in as JSX props at the call site, not from CMS storage. The
 * spec is placed once per product card; all instances share the
 * `.price` class label and refetch together via
 * `nav.reload({selector: ".price"})`. Per-instance addressing isn't
 * a goal here — a single price refresh is functionally the same as
 * refreshing all.
 */
export const LivePricePartial = ReactCms.partial(
  async function LivePriceRender({
    sku,
    basePrice,
    currency,
  }: { sku: string; basePrice: number; currency: string } & RenderArgs) {
    await new Promise((r) => setTimeout(r, 1000))

    const tick = Date.now()
    const swing = Math.random() - 0.5
    const live = basePrice * (1 + swing)

    return (
      <div
        data-testid={`live-price-${sku}`}
        data-price-tick={String(tick)}
        className="mt-2 flex items-center gap-2"
      >
        <span className="font-semibold text-emerald-400 tabular-nums">
          {currency} {live.toFixed(2)}
        </span>
        <RefreshPriceButton sku={sku} />
      </div>
    )
  },
  {
    selector: ".price",
  },
)
