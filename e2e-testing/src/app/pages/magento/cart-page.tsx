/**
 * /magento/cart — cell-backed cart with line-item granularity.
 *
 * Demonstrates the bound-cell + partition-scoped invalidation model:
 *
 *   - CartPage reads `cartCell` (loader fetches full cart, hydrates
 *     per-line cells). Renders a <CartLine> for each itemUid.
 *
 *   - Each CartLine is a separate parton. The page binds the
 *     per-line cell via `item={cartItemCell.with({uid})}` — the
 *     framework auto-resolves the bound cell into a ResolvedCell at
 *     the placement, stamps `cell:magento.cart-item?uid=X` onto the
 *     placement's invalidation surface.
 *
 *   - Mutations (updateLineQty / removeFromCart) write the affected
 *     cell partition; only matching placements refetch. The cart
 *     totals refetch when the cart cell changes, but unaffected
 *     CartLine placements keep their fp and skip the wire.
 */

import { parton, type PartialCtx, type RenderArgs, type ResolvedCell } from "@parton/framework"
import { Card } from "@parton/copies/components/ui/card"
import {
  cartCell,
  cartItemCell,
  type CartLineValue,
  type CartValue,
} from "./cart-cells.ts"
import { CartLineControls } from "./cart-line-controls.tsx"

const CartLine = parton(
  function CartLineRender({
    item,
  }: { item: ResolvedCell<CartLineValue | null> } & RenderArgs) {
    const line = item.value
    if (!line) {
      return (
        <div data-testid="cart-line-empty" className="rounded border p-3 text-sm text-muted-foreground">
          (no data)
        </div>
      )
    }
    const name = line.product?.name ?? "(unknown)"
    const sku = line.product?.sku ?? ""
    const rowTotal = line.prices?.row_total?.value ?? 0
    const currency = line.prices?.row_total?.currency ?? "USD"
    return (
      <Card className="p-4" data-testid={`cart-line-${line.uid}`}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1">
            <div className="font-medium" data-testid={`cart-line-name-${line.uid}`}>
              {name}
            </div>
            <div className="text-xs text-muted-foreground">
              <code>{sku}</code>
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono tabular-nums" data-testid={`cart-line-total-${line.uid}`}>
              {currency} {rowTotal.toFixed(2)}
            </div>
            <div className="text-xs text-muted-foreground" data-testid={`cart-line-qty-${line.uid}`}>
              qty {line.quantity}
            </div>
          </div>
          <CartLineControls uid={line.uid} quantity={line.quantity} />
        </div>
      </Card>
    )
  },
  {
    selector: "cart-line",
  },
)

const CartContents = parton(
  function CartContentsRender({
    cart,
    parent,
  }: { cart: ResolvedCell<CartValue | null> } & RenderArgs) {
    const v = cart.value
    if (!v || v.itemUids.length === 0) {
      return (
        <div data-testid="cart-empty" className="rounded border p-6 text-center text-muted-foreground">
          Your cart is empty.
        </div>
      )
    }
    return (
      <div className="space-y-4">
        <div className="space-y-3" data-testid="cart-lines">
          {v.itemUids.map((uid) => (
            <CartLine key={uid} parent={parent} item={cartItemCell.with({ uid })} />
          ))}
        </div>
        <Card className="flex items-center justify-between p-4" data-testid="cart-totals">
          <span className="font-medium">Grand total</span>
          <span className="font-mono tabular-nums" data-testid="cart-grand-total">
            {v.currency} {v.grandTotal.toFixed(2)}
          </span>
        </Card>
      </div>
    )
  },
  {
    selector: "#cart-contents",
    schema: () => ({ cart: cartCell }),
  },
)

export const MagentoCartPage = parton(
  function MagentoCartRender({ parent }: RenderArgs) {
    return (
      <main className="py-4 space-y-4">
        <title>Magento cart — cell demo</title>
        <h1 className="text-2xl font-semibold">Cart</h1>
        <p className="text-sm text-muted-foreground">
          Cart-backed cells with per-line partitioning. Update qty or
          remove a line — only the matching line refetches; other
          lines keep their fp. The cart totals refetch on every change.
        </p>
        <CartContents parent={parent as PartialCtx} />
      </main>
    )
  },
  { match: "/magento/cart" },
)
