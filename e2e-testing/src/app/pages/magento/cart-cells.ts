/**
 * Cart-shape cells — proves the bound-cell / partition-scoped model:
 *
 *   cartCell      — gqlCell. Full cart shape (itemUids + totals).
 *                   Loader fetches the full cart and hydrates child
 *                   cartItemCell partitions from the nested result.
 *                   Request-scoped storage — discarded when the
 *                   request finishes.
 *
 *   cartItemCell  — fragmentCell. Typed by the CartLine fragment but
 *                   has NO loader. Populated by cartCell.load() via
 *                   `.with({uid}).hydrate(value)`. Per-line
 *                   placement-bound; mutations write specific
 *                   partitions.
 *
 * Neither cell touches disk: cart data is upstream-authoritative and
 * re-fetched per request (or read from the request's warm hydration).
 * The 200-line / one-update refetch shape works within a single
 * request — the mutation's response render reads from the same
 * request's warm storage.
 */

import { fragmentCell, localCell, getEphemeralCellStorage } from "@parton/framework"
import { client } from "../../magento-data.ts"
import { graphql, type ResultOf } from "../../magento-graphql.ts"

const CartWithItemsQuery = graphql(`
  query CartWithItems($cartId: String!) {
    cart(cart_id: $cartId) {
      id
      items {
        uid
        quantity
        product {
          name
          sku
        }
        prices {
          row_total {
            value
            currency
          }
        }
      }
      prices {
        grand_total {
          value
          currency
        }
      }
    }
  }
`)

type FullCart = NonNullable<ResultOf<typeof CartWithItemsQuery>["cart"]>
export type FullCartItem = NonNullable<NonNullable<FullCart["items"]>[number]>

export type CartItemValue = {
  uid: string
  quantity: number
  name: string
  sku: string
  rowTotal: number
  currency: string
}

export type CartValue = {
  itemUids: string[]
  grandTotal: number
  currency: string
}

export function toCartItemValue(it: FullCartItem): CartItemValue {
  return {
    uid: it.uid,
    quantity: it.quantity,
    name: it.product?.name ?? "(unknown)",
    sku: it.product?.sku ?? "",
    rowTotal: it.prices?.row_total?.value ?? 0,
    currency: it.prices?.row_total?.currency ?? "USD",
  }
}

/** Per-line fragment cell. Has no loader — the cart's loader hydrates
 *  per-line partitions from its nested query result. Bound via
 *  `cartItemCell.with({uid})` at placement sites. Storage is
 *  request-scoped ephemeral; disk never sees cart line data. */
export const cartItemCell = fragmentCell<CartItemValue | null>({
  id: "magento.cart-item",
  initial: null,
})

/**
 * Cart aggregate cell. Custom loader that fetches the full cart
 * shape AND hydrates child cartItemCell partitions from the nested
 * result — one upstream call serves the aggregate view + all line
 * placements within the same request.
 *
 * `storage: getEphemeralCellStorage` opts into request-scoped in-
 * memory storage (no disk persistence) — cart data is upstream-
 * authoritative, re-fetched per request when cold.
 */
export const cartCell = localCell<"opaque", CartValue | null>({
  id: "magento.cart",
  shape: "opaque",
  vary: ({ cookies }) => ({ cartId: cookies.cart_id ?? "" }),
  initial: null,
  storage: getEphemeralCellStorage,
  load: async ({ cartId }) => {
    if (!cartId || typeof cartId !== "string") return null
    const data = await client.request(CartWithItemsQuery, { cartId: String(cartId) })
    return hydrateCartFromResponse(data.cart)
  },
})

/**
 * Normalise a cart-shaped response into hydration + aggregate.
 * Populates per-line fragmentCells and returns the cart aggregate
 * value. Used by `cartCell.load` AND by mutations that return the
 * same nested cart shape (AddToCart, updateCartItems, removeFromCart).
 *
 * Side-effect: writes to `cartItemCell.with({uid}).hydrate(...)` for
 * every line in the response. No partition signals — these run
 * during loader / mutation contexts where the child placements
 * haven't rendered yet.
 */
export function hydrateCartFromResponse(
  cart: FullCart | null | undefined,
): CartValue | null {
  if (!cart) return null
  const items = (cart.items ?? []).filter((i): i is FullCartItem => i != null)
  for (const it of items) {
    cartItemCell.with({ uid: it.uid }).hydrate(toCartItemValue(it))
  }
  return {
    itemUids: items.map((i) => i.uid),
    grandTotal: cart.prices?.grand_total?.value ?? 0,
    currency: cart.prices?.grand_total?.currency ?? "USD",
  }
}
