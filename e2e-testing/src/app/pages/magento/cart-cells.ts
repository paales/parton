/**
 * Cart-shape cells — proves the fragment-cell identity model:
 *
 *   cartCell      — localCell. Aggregate shape (itemUids + grand total),
 *                   kept SEPARATE from line details so a per-line qty
 *                   change doesn't move the cart parton's fp. Its loader
 *                   runs the cart query through `runQuery`, which
 *                   auto-hydrates the per-line cells from the `...CartLine`
 *                   spreads in the response, then returns the aggregate.
 *
 *   cartItemCell  — fragmentCell typed by + keyed off `CartLineFragment`.
 *                   No loader; populated by auto-hydration (the cart
 *                   query / mutations spread `...CartLine`) and by
 *                   value-keyed `cartItemCell.set(line)` from mutations.
 *                   Keyed by `uid` — Magento's CartItem has no `id`.
 *
 * Neither cell touches disk: cart data is upstream-authoritative and
 * re-fetched per request (or read from the request's warm hydration).
 * The many-lines / one-update refetch shape works within a single
 * request — the mutation's response render reads from the same
 * request's warm storage.
 */

import { fragmentCell, localCell, getEphemeralCellStorage, runQuery } from "@parton/framework"
import { client } from "../../magento-data.ts"
import { graphql } from "../../magento-graphql.ts"

/** The per-line shape. `@_unmask` keeps gql.tada from masking the
 *  spread (so query/mutation result items carry the fields directly,
 *  and resolve cleanly even though `CartItem` is an abstract union).
 *  Spread into the cart query AND every cart mutation so one upstream
 *  call hydrates the line cells. */
export const CartLineFragment = graphql(`
  fragment CartLine on CartItemInterface @_unmask {
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
`)

/**
 * The line value the cell stores. Structurally matches `CartLineFragment`
 * — hand-written rather than `ResultOf<typeof CartLineFragment>` because
 * `CartItem` is an abstract union and gql.tada collapses both `ResultOf`
 * and `FragmentOf` to `never` for fragments on abstract types. `@_unmask`
 * keeps the query/mutation *spread sites* typed as full objects (so the
 * result items remain assignable to this), which is what auto-hydration
 * and value-keyed `.set` rely on.
 */
export type CartLineValue = {
  uid: string
  quantity: number
  product?: { name?: string | null; sku?: string | null } | null
  prices?: {
    row_total?: { value?: number | null; currency?: string | null } | null
  } | null
}

/** Per-line fragment cell. No loader — hydrated from the cart query's
 *  `...CartLine` spread (auto-hydration) and written per-partition by
 *  mutations via `cartItemCell.set(line)` (keyed by uid). The value type
 *  is supplied explicitly (see `CartLineValue`). */
export const cartItemCell = fragmentCell<typeof CartLineFragment, CartLineValue>(
  CartLineFragment,
  { key: (d) => ({ uid: d.uid }) },
)

export type CartValue = {
  itemUids: string[]
  grandTotal: number
  currency: string
}

const CartWithItemsQuery = graphql(
  `
    query CartWithItems($cartId: String!) {
      cart(cart_id: $cartId) {
        id
        items {
          uid
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
  `,
  [CartLineFragment],
)

/** Cart-shaped responses (query + every mutation) share this surface. */
type CartShape = {
  items?: ReadonlyArray<{ uid: string } | null> | null
  prices?: {
    grand_total?: { value?: number | null; currency?: string | null } | null
  } | null
}

/**
 * Compute the cart aggregate (uid list + grand total) from a cart-shaped
 * response. The per-line cells are hydrated separately — by
 * `runQuery` (cart load) or `hydrateFragmentsFromResult` (mutations).
 */
export function cartAggregate(cart: CartShape | null | undefined): CartValue | null {
  if (!cart) return null
  const items = (cart.items ?? []).filter((i): i is { uid: string } => i != null)
  return {
    itemUids: items.map((i) => i.uid),
    grandTotal: cart.prices?.grand_total?.value ?? 0,
    currency: cart.prices?.grand_total?.currency ?? "USD",
  }
}

/**
 * Cart aggregate cell. The loader fetches the full cart shape via
 * `runQuery` — which auto-hydrates the per-line `cartItemCell`
 * partitions from the `...CartLine` spreads — and returns just the
 * aggregate. `storage: getEphemeralCellStorage` keeps cart data off
 * disk (it's upstream-authoritative, re-fetched per request when cold).
 */
export const cartCell = localCell<"opaque", CartValue | null>({
  id: "magento.cart",
  shape: "opaque",
  vary: ({ cookies }) => ({ cartId: cookies.cart_id ?? "" }),
  initial: null,
  storage: getEphemeralCellStorage,
  load: async ({ cartId }) => {
    if (!cartId || typeof cartId !== "string") return null
    const data = await runQuery(client, CartWithItemsQuery, { cartId: String(cartId) })
    return cartAggregate(data.cart)
  },
})
