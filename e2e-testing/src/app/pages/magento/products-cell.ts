/**
 * Magento products-grid cell.
 *
 * Storage caches per pageSize args; refresh is explicit via
 * `magentoProductsCell.with({pageSize}).invalidate()` (e.g. from a
 * "Refresh products" button) rather than a TTL on the parton.
 *
 * Built via the `magentoCatalog` cell builder (record/replay client) —
 * the raw `graphql()` call is hidden. Consumers type off the cell via
 * `CellValue<typeof magentoProductsCell>`.
 */

import { magentoCatalog } from "../../magento.ts"

// id auto-derives to "magento.products" (operation name + prefix).
// `currentPage` partitions the cache per page, so an infinite-scroll
// page-parton can bind `.with({pageSize, currentPage})` and fetch only
// its own slice. `total_count` lets a scroller cap its page pool.
export const magentoProductsCell = magentoCatalog.query(`
  query Products($pageSize: Int!, $currentPage: Int!) {
    products(filter: {}, pageSize: $pageSize, currentPage: $currentPage) {
      total_count
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
