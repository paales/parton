/**
 * `gqlCell` — a cell whose loader is a typed GraphQL query.
 *
 * Thin wrapper over `localCell`: takes a gql.tada-typed document plus
 * a GraphQL client, infers the args shape from variable definitions,
 * synthesizes `load` as `client.request(doc, args)`.
 *
 * Shape is "opaque" — the runtime treats the loaded value as a black
 * box. The TS type comes from gql.tada's `ResultOf<typeof doc>` and
 * flows through `Cell<T>` to Render's prop bag.
 *
 * Storage is authoritative once written. The loader runs on cold-start
 * (storage miss); subsequent reads return the stored value until a
 * mutation explicitly updates it via `cell.with(args).set(newValue)`
 * or `cell.with(args).invalidate()`.
 *
 *     const cartItemCell = gqlCell({
 *       id: "cart-item",
 *       client: magentoClient,
 *       doc: graphql(`query GetCartItem($itemId: ID!) {
 *         cartItem(uid: $itemId) { uid quantity product { sku name } }
 *       }`),
 *     })
 *
 *     // In a parton placement:
 *     <CartLine
 *       parent={parent}
 *       item={cartItemCell.with({ itemId: "abc" })}
 *     />
 *
 *     // In Render:
 *     function CartLineRender({ item }) {
 *       return <Line {...item.value} />
 *     }
 *
 *     // In an action:
 *     "use server"
 *     async function updateQty(itemId: string, qty: number) {
 *       const r = await magentoClient.request(UpdateMutation, { itemId, qty })
 *       await cartItemCell.with({ itemId }).set(r.cartItem)
 *     }
 */

import type { TadaDocumentNode } from "gql.tada"
import { localCell, type Cell, type CellArgs } from "./cell.ts"

/**
 * Minimal GraphQL client contract. Both `graphql-request` and a
 * hand-rolled fetch wrapper match this. Defined locally so the
 * framework doesn't take a hard dep on a specific client library.
 */
export interface GqlClient {
  request<TResult, TVars extends Record<string, unknown>>(
    document: TadaDocumentNode<TResult, TVars>,
    variables: TVars,
  ): Promise<TResult>
}

export interface GqlCellOpts<TResult, TVars extends Record<string, unknown>> {
  /** Wire identifier — required, same role as `localCell`'s `id`. */
  id: string
  /** GraphQL client (any object with a typed `.request(doc, vars)`
   *  method matching `GqlClient`). */
  client: GqlClient
  /** Typed gql.tada document — return type drives `T`, variables type
   *  drives the args contract. */
  doc: TadaDocumentNode<TResult, TVars>
  /** Optional initial value for storage misses BEFORE the loader runs.
   *  Defaults to `null`. Rarely useful — the loader is the normal path
   *  for cold reads. */
  initial?: TResult | null
}

/**
 * Build a `Cell<TResult | null>` whose loader runs the GraphQL query
 * with the bound args. Args MUST match the query's variable shape —
 * gql.tada's inferred `TVars` enforces this at compile time when the
 * call site uses `.with(args)`.
 */
export function gqlCell<TResult, TVars extends Record<string, unknown>>(
  opts: GqlCellOpts<TResult, TVars>,
): Cell<TResult | null> {
  return localCell<"opaque", TResult | null>({
    id: opts.id,
    shape: "opaque",
    initial: opts.initial ?? null,
    load: async (args: CellArgs): Promise<TResult | null> => {
      return await opts.client.request(opts.doc, args as TVars)
    },
  })
}
