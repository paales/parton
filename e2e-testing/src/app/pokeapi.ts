/**
 * PokeAPI backend — one `graphqlBackend` call binds the client, the
 * gql.tada tag, and the cell constructors. Cells build straight from
 * query strings (`pokeapi.query` / `pokeapi.fragment`); mutations and
 * direct reads use the `graphql` tag + `client`.
 *
 * The client is wrapped with the disk record/replay layer: PokeAPI
 * serves an immutable, versioned dataset, safe to replay under the e2e
 * harness (see gql-disk-cache.ts) where dozens of workers would
 * otherwise rate-limit the public endpoint.
 */

import { graphqlBackend, createGraphqlClient } from "@parton/framework/graphql"
import { withGqlDiskCache } from "./gql-disk-cache.ts"
import type { introspection } from "./pokeapi-env.d.ts"

export const POKEAPI_ENDPOINT = "https://beta.pokeapi.co/graphql/v1beta"

/** Exported directly (not via the backend) so `client.request(doc)`
 *  keeps graphql-request's typed overloads. */
export const client = withGqlDiskCache(createGraphqlClient(POKEAPI_ENDPOINT), POKEAPI_ENDPOINT)

export const pokeapi = graphqlBackend<{
  introspection: introspection
  scalars: { jsonb: unknown }
}>({ client })

export const { graphql } = pokeapi
export { readFragment } from "@parton/framework/graphql"
export type { ResultOf, FragmentOf, VariablesOf } from "@parton/framework/graphql"
