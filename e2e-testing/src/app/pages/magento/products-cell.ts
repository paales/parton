/**
 * Magento products-grid cell.
 *
 * Storage caches per pageSize args; refresh is explicit via
 * `magentoProductsCell.with({pageSize}).invalidate()` (e.g. from a
 * "Refresh products" button) rather than a TTL on the parton.
 *
 * Built via the per-backend `magento` constructor — the raw `graphql()`
 * call is hidden. Consumers type off the cell via
 * `CellValue<typeof magentoProductsCell>`.
 */

import { gqlCellBuilder } from "@parton/framework"
import { client } from "../../magento-data.ts"
import { graphql } from "../../magento-graphql.ts"

const magento = gqlCellBuilder({ client, graphql, prefix: "magento" })

// id auto-derives to "magento.products" (operation name + prefix).
export const magentoProductsCell = magento.query(`
  query Products($pageSize: Int!) {
    products(filter: {}, pageSize: $pageSize) {
      items {
        id
        name
        sku
        small_image {
          url
          label
        }
        price_range {
          minimum_price {
            regular_price {
              value
              currency
            }
          }
        }
      }
    }
  }
`)
