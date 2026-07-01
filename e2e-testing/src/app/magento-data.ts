/**
 * GraphCommerce Magento 2 API data source.
 */

import { GraphQLClient } from "graphql-request"
import { withGqlDiskCache } from "./gql-disk-cache.ts"

export const MAGENTO_ENDPOINT = "https://graphcommerce.vercel.app/api/graphql"

/** Live client — carts are stateful, so cart queries and every
 *  mutation must always reach the backend. */
export const client = new GraphQLClient(MAGENTO_ENDPOINT)

/** Catalog client — the demo catalog is immutable reference data,
 *  safe to record/replay under the e2e harness (see
 *  gql-disk-cache.ts). A slow or throttled backend otherwise holds
 *  the SSR stream open (hydration can't commit until the root
 *  payload completes) and reads as a test flake. */
export const catalogClient = withGqlDiskCache(client, MAGENTO_ENDPOINT)
