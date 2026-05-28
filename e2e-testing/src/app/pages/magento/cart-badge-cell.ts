/**
 * Cart badge cell — per-cartId total quantity, loaded from Magento.
 *
 * Lives separately from `cartCell` (which loads the full cart shape
 * for the /cart page). The badge only needs `total_quantity` and is
 * placed in the header on every magento page — keeping it as its own
 * tiny cell avoids over-fetching the full cart on pages where only
 * the badge is visible.
 *
 * The loader UNWRAPS the GraphQL envelope to the `cart` sub-object, so
 * the stored shape matches what mutations write (`set({total_quantity})`)
 * and what the header reads (`badge.value?.total_quantity`). A loader
 * that returned the raw `{cart: {...}}` envelope would render 0 on every
 * loader-resolved read (cross-connection / heartbeat / cold revisit)
 * while writes rendered correctly — a silent mismatch that only the
 * write path masks.
 *
 * Request-scoped ephemeral storage: cart data is upstream-authoritative.
 * Mutations write the new total into their own response render; other
 * connections re-load it.
 */

import { localCell, getEphemeralCellStorage } from "@parton/framework"
import { client } from "../../magento-data.ts"
import { graphql, type ResultOf } from "../../magento-graphql.ts"

const CartBadgeQuery = graphql(`
  query CartBadge($cartId: String!) {
    cart(cart_id: $cartId) {
      total_quantity
    }
  }
`)

export type CartBadgeData = NonNullable<ResultOf<typeof CartBadgeQuery>["cart"]>

export const cartBadgeCell = localCell<"opaque", CartBadgeData | null>({
  id: "magento.cart-badge",
  shape: "opaque",
  initial: null,
  storage: getEphemeralCellStorage,
  load: async ({ cartId }) => {
    if (!cartId || typeof cartId !== "string") return null
    const data = await client.request(CartBadgeQuery, { cartId: String(cartId) })
    return data.cart ?? null
  },
})
