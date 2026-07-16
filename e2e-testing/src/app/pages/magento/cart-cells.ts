/**
 * Cart cells — both built via the per-backend `magento` constructor, with
 * the raw `graphql()` call hidden at every site:
 *
 *   cartItemCell — `magento.fragment(...)`. Typed by + keyed off the
 *                  `CartLine` fragment; value type inferred. Hydrated by
 *                  the cart query's `...CartLine` spread (auto-hydration)
 *                  and written per-partition by `cartItemCell.set(line)`
 *                  (keyed by uid). Magento's CartItemInterface has no
 *                  `id`, so `key` reads `uid`.
 *
 *   cartCell     — `magento.query(..., [cartItemCell])`. Loaded per
 *                  `.with({ cartId })`; composes `...CartLine` by passing
 *                  the CELL (not a raw fragment doc). The result→cells
 *                  rewrite turns each `...CartLine` spread site into its
 *                  per-line BoundCell, so `cart.value.cart.items` is an
 *                  array of forwardable cells (cart-page.tsx maps them
 *                  straight to <CartLine>, no manual `.with({uid})`).
 *
 * Mutations still spread `...CartLine` via `cartItemCell.fragment` (the
 * GraphQL mutations themselves migrate later).
 */

import { magento } from "../../magento.ts"

/** Per-line fragment cell. `@_unmask` keeps the query/mutation spread
 *  sites readable (CartItemInterface is abstract). Value type inferred. */
export const cartItemCell = magento.fragment(
  `
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
  `,
  { key: (d) => ({ uid: d.uid }) },
)

/**
 * The cart query — composes `...CartLine` by passing the cell, loaded per
 * `.with({ cartId })`. Its loader hydrates the per-line cells from the
 * spread AND rewrites each spread site to its `BoundCell` (so
 * `cart.value.cart.items` is an array of forwardable line cells). id
 * auto-derives to `magento.cart`.
 */
export const cartCell = magento.query(
  `
    query Cart($cartId: String!) {
      cart(cart_id: $cartId) {
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
  [cartItemCell],
)
