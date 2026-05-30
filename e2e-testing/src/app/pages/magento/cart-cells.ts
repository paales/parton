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
 *                  the CELL (not a raw fragment doc). Stores the raw query
 *                  result; the view derives its aggregate (cart-page.tsx).
 *
 * Mutations still spread `...CartLine` via `cartItemCell.fragment` (the
 * GraphQL mutations themselves migrate later).
 */

import { gqlCellBuilder } from "@parton/framework"
import { client } from "../../magento-data.ts"
import { graphql } from "../../magento-graphql.ts"

const magento = gqlCellBuilder({ client, graphql, prefix: "magento" })

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

/** The per-line value — inferred from the cell. */
export type CartLineValue = NonNullable<typeof cartItemCell.defaultValue>

/**
 * The cart query — composes `...CartLine` by passing the cell, loaded per
 * `.with({ cartId })`. Its loader auto-hydrates the per-line cells from
 * the spread. id auto-derives to `magento.cart`.
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

/** The raw cart query result the cell stores. The view derives its
 *  aggregate (see `cartAggregate` in `cart-page.tsx`). */
export type CartData = NonNullable<typeof cartCell.defaultValue>
