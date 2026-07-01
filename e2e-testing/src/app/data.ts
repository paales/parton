/**
 * PokeAPI data source.
 */

import { GraphQLClient } from "graphql-request"
import { withGqlDiskCache } from "./gql-disk-cache.ts"

export const POKEAPI_ENDPOINT = "https://beta.pokeapi.co/graphql/v1beta"

// PokeAPI serves an immutable, versioned dataset — safe to
// record/replay under the e2e harness (see gql-disk-cache.ts). The
// GraphCommerce client stays live: carts are stateful.
export const client = withGqlDiskCache(new GraphQLClient(POKEAPI_ENDPOINT), POKEAPI_ENDPOINT)
