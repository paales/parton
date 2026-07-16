/**
 * `@parton/framework/graphql` — the GraphQL data layer.
 *
 * One `graphqlBackend(...)` call per backend replaces the hand-rolled
 * client + `initGraphQLTada` pair an app would otherwise write. It binds
 * the graphql-request client and the gql.tada tag once, and returns —
 * fully typed end-to-end — the tagged `graphql()` helper, the executing
 * `client`, and the cell constructors (`query` / `fragment`, the
 * `gqlCellBuilder` surface). An app depends only on `@parton/framework`;
 * gql.tada and graphql-request live under the framework.
 *
 *     import { graphqlBackend } from "@parton/framework/graphql"
 *     import type { introspection } from "./pokeapi-env.d.ts"
 *
 *     export const pokeapi = graphqlBackend<{
 *       introspection: introspection
 *       scalars: { jsonb: unknown }
 *     }>({ endpoint: "https://beta.pokeapi.co/graphql/v1beta" })
 *
 *     export const heroCell = pokeapi.query(`
 *       query PokemonHero($id: Int!) {
 *         pokemon_v2_pokemon(where: { id: { _eq: $id } }, limit: 1) { id name }
 *       }
 *     `)
 *
 * The introspection `-env.d.ts` is produced by `parton gql <url>` (see
 * ./README.md), so the app never adds gql.tada as its own dependency.
 */

import { GraphQLClient } from "graphql-request"
import { initGraphQLTada, type AbstractSetupSchema, type TadaDocumentNode } from "gql.tada"
import { gqlCellBuilder, runQuery, type GqlClient } from "../lib/cell-gql.ts"

/**
 * Construct the internal graphql-request client from an endpoint. Apps
 * that need to wrap the client (record/replay, custom fetch) build it
 * here and pass it as `graphqlBackend({ client })`; the common case
 * passes `graphqlBackend({ endpoint })` and never touches this.
 */
export function createGraphqlClient(
  endpoint: string,
  opts?: { headers?: GraphQLClient["requestConfig"]["headers"] },
): GraphQLClient {
  return new GraphQLClient(endpoint, { headers: opts?.headers })
}

export interface GraphqlBackendConfig {
  /** Endpoint URL — the client is constructed from it. Provide this OR
   *  `client`. */
  endpoint?: string
  /** Static headers threaded onto every request (auth tokens, etc.).
   *  Ignored when `client` is given — wrap the client yourself. */
  headers?: Record<string, string>
  /** A pre-built client (wrapped for record/replay, a custom fetch, a
   *  second endpoint). Any object with graphql-request's `.request`
   *  matches. Provide this OR `endpoint`. */
  client?: GqlClient
  /** Namespaces every cell's auto-derived wire id (`magento.cart`).
   *  Distinguishes ids when two backends share an operation name. */
  prefix?: string
}

/**
 * Per-backend constructor. `Setup` mirrors gql.tada's
 * `initGraphQLTada<Setup>()` generic — `{ introspection; scalars }`, the
 * introspection imported from the generated `-env.d.ts`:
 *
 *     export const magento = graphqlBackend<{
 *       introspection: introspection
 *       scalars: { DateTime: string; Date: string }
 *     }>({ endpoint: MAGENTO_ENDPOINT, prefix: "magento" })
 *
 *     export const { graphql, client } = magento
 */
export function graphqlBackend<const Setup extends AbstractSetupSchema>(
  config: GraphqlBackendConfig,
) {
  const graphql = initGraphQLTada<Setup>()
  const client =
    config.client ??
    (config.endpoint
      ? createGraphqlClient(config.endpoint, { headers: config.headers })
      : undefined)
  if (!client) {
    throw new Error("graphqlBackend: provide `endpoint` or `client`.")
  }
  const { prefix } = config
  const builder = gqlCellBuilder({ client, graphql, prefix })

  const bindRunQuery =
    (c: GqlClient) =>
    <TResult, TVars extends Record<string, unknown>>(
      doc: TadaDocumentNode<TResult, TVars, any>,
      vars: TVars,
    ) =>
      runQuery(c, doc, vars)

  return {
    graphql,
    client,
    query: builder.query,
    fragment: builder.fragment,
    runQuery: bindRunQuery(client),
    withClient(nextClient: GqlClient) {
      const b = gqlCellBuilder({ client: nextClient, graphql, prefix })
      return { query: b.query, fragment: b.fragment, runQuery: bindRunQuery(nextClient) }
    },
  }
}

// ── Cell integration (re-exported from the cell library) ────────────────
// The gqlCell family is the unit: an app pulls everything it needs to
// build GraphQL-backed cells from this one subpath.
export {
  gqlCell,
  gqlCellBuilder,
  runQuery,
  fragmentCell,
  hydrateFragmentsFromResult,
  spreadSitesOf,
  _clearFragmentCellRegistry,
  type GqlCell,
  type GqlCellOpts,
  type GqlClient,
  type FragmentCell,
  type FragmentCellOpts,
  type RewriteSpreads,
} from "../lib/cell-gql.ts"

// ── gql.tada surface (re-exported so the app never imports gql.tada) ────
// The typed helpers an app uses alongside cells for mutations and direct
// queries: unmask a masked fragment ref, and infer a document's result /
// variables / fragment types.
export { readFragment } from "gql.tada"
export type { ResultOf, VariablesOf, FragmentOf, TadaDocumentNode } from "gql.tada"
