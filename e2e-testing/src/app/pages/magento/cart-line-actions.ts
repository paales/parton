"use server"

/**
 * Cart line mutations — exercise partition-scoped invalidation through
 * the fragment-cell identity model.
 *
 * Each mutation colocates `...CartLine`, so its response hydrates the
 * per-line cells (auto-hydration, no signals). The single changed line
 * then fires its partition signal via value-keyed `cartItemCell.set(line)`
 * — `keyOf` reads `uid` off the value, emits `cell:magento.cart-item?uid=X`,
 * and only the matching `<CartLine uid="X">` placement re-renders.
 *
 * Cart-level state (item list, grand total) lives on `cartCell` and is
 * updated separately so the cart parton's fp moves only when the item
 * list or totals change — not when a single line's details do.
 */

import { hydrateFragmentsFromResult, readCookie } from "@parton/framework"
import { client } from "../../magento-data.ts"
import { graphql } from "../../magento-graphql.ts"
import { cartBadgeCell } from "./cart-badge-cell.ts"
import { cartCell, cartItemCell, cartAggregate, CartLineFragment } from "./cart-cells.ts"

const UpdateCartItemsMutation = graphql(
  `
    mutation UpdateCartItems($cartId: String!, $uid: ID!, $quantity: Float!) {
      updateCartItems(
        input: { cart_id: $cartId, cart_items: [{ cart_item_uid: $uid, quantity: $quantity }] }
      ) {
        cart {
          items {
            uid
            quantity
            ...CartLine
          }
          prices {
            grand_total {
              value
              currency
            }
          }
        }
      }
    }
  `,
  [CartLineFragment],
)

const RemoveCartItemMutation = graphql(
  `
    mutation RemoveCartItem($cartId: String!, $uid: ID!) {
      removeItemFromCart(input: { cart_id: $cartId, cart_item_uid: $uid }) {
        cart {
          id
          items {
            uid
            quantity
            ...CartLine
          }
          prices {
            grand_total {
              value
              currency
            }
          }
        }
      }
    }
  `,
  [CartLineFragment],
)

export async function updateLineQty(uid: string, quantity: number): Promise<void> {
  const cartId = readCookie("cart_id")
  if (!cartId) throw new Error("no active cart")

  const r = await client.request(UpdateCartItemsMutation, { cartId, uid, quantity })
  const updated = r.updateCartItems?.cart
  if (!updated) throw new Error("updateCartItems returned null")

  // Auto-hydrate every line cell from the response (storage only, no
  // signals) — so the action's own response render reads warm line
  // storage for all lines, not just the changed one.
  hydrateFragmentsFromResult(UpdateCartItemsMutation, r)

  const items = (updated.items ?? []).filter((i): i is NonNullable<typeof i> => i != null)
  const updatedLine = items.find((i) => i.uid === uid)
  // Total quantity could change either way (qty change OR line removed).
  // Push the new total to the badge cell so any header showing the badge
  // updates without refetching.
  const totalQuantity = items.reduce((sum, i) => sum + i.quantity, 0)
  await cartBadgeCell.with({ cartId }).set({ total_quantity: totalQuantity })

  if (!updatedLine) {
    // Magento removed the line (qty went to 0). Bump cart so parent
    // refetches with the shorter item list; free the line's slot.
    const next = cartAggregate(updated)
    if (next) await cartCell.with({ cartId }).set(next)
    cartItemCell.with({ uid }).hydrate(null)
    return
  }

  // Value-keyed write: `set` reads uid off the line itself, so only the
  // matching `<CartLine uid={uid}>` placement refetches. The cart
  // parton's item list didn't change, so its fp stays put.
  await cartItemCell.set(updatedLine)

  // Grand total lives on the cart cell. Update it functionally without
  // touching the item list — the cart parton's fp shifts (totals UI
  // refetches) but per-line placements that didn't change stay still.
  await cartCell.with({ cartId }).update((current) => {
    if (!current) return current
    return {
      ...current,
      grandTotal: updated.prices?.grand_total?.value ?? current.grandTotal,
      currency: updated.prices?.grand_total?.currency ?? current.currency,
    }
  })
}

export async function removeFromCart(uid: string): Promise<void> {
  const cartId = readCookie("cart_id")
  if (!cartId) throw new Error("no active cart")

  const r = await client.request(RemoveCartItemMutation, { cartId, uid })
  const updated = r.removeItemFromCart?.cart
  if (!updated) throw new Error("removeItemFromCart returned null")

  // Hydrate all remaining line cells from the response (no signals).
  hydrateFragmentsFromResult(RemoveCartItemMutation, r)

  const items = (updated.items ?? []).filter((i): i is NonNullable<typeof i> => i != null)
  const remainingTotalQty = items.reduce((sum, i) => sum + i.quantity, 0)
  await cartBadgeCell.with({ cartId }).set({ total_quantity: remainingTotalQty })

  // Push the new aggregate (shorter item list + new grand total).
  const next = cartAggregate(updated)
  if (next) await cartCell.with({ cartId }).set(next)

  // Free the removed line's storage slot (no signal — its placement is
  // gone from the parent's render now that the uid left the item list).
  cartItemCell.with({ uid }).hydrate(null)
}
