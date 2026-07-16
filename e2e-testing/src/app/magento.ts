/**
 * GraphCommerce Magento 2 backend — one `graphqlBackend` call binds the
 * client, the gql.tada tag (scalars mapped), and the cell constructors.
 *
 * Two clients, one schema:
 *   - `magento`        — the live client. Carts are stateful, so cart
 *                        queries and every mutation must reach the backend.
 *   - `magentoCatalog` — the same backend over a record/replay-wrapped
 *                        client. The demo catalog is immutable reference
 *                        data; a slow backend otherwise holds the SSR
 *                        stream open and reads as a test flake.
 */

import { graphqlBackend, createGraphqlClient } from "@parton/framework/graphql"
import { withGqlDiskCache } from "./gql-disk-cache.ts"
import type { introspection } from "./magento-env.d.ts"

export const MAGENTO_ENDPOINT = "https://graphcommerce.vercel.app/api/graphql"

/** The live client, exported directly (not via the backend) so
 *  `client.request(doc)` keeps graphql-request's typed overloads. */
export const client = createGraphqlClient(MAGENTO_ENDPOINT)

export const magento = graphqlBackend<{
  introspection: introspection
  scalars: { DateTime: string; Date: string }
}>({ client, prefix: "magento" })

export const { graphql } = magento

/** Catalog cell builder — same tag + `magento.` id prefix, over the
 *  record/replay client. */
export const magentoCatalog = magento.withClient(withGqlDiskCache(client, MAGENTO_ENDPOINT))

export { readFragment } from "@parton/framework/graphql"
export type { ResultOf, FragmentOf, VariablesOf } from "@parton/framework/graphql"
