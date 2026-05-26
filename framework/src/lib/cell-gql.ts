/**
 * GraphQL-shaped cells: `gqlCell` + `fragmentCell`.
 *
 *   gqlCell      — cell whose loader runs a typed GraphQL query.
 *                  Backed by REQUEST-SCOPED in-memory storage; each
 *                  request gets a fresh cache, discarded at request
 *                  end. Cross-request caching is a separate layer.
 *
 *   fragmentCell — cell typed by a GraphQL fragment but WITHOUT a
 *                  loader. Populated externally — typically by a
 *                  parent gqlCell's loader calling
 *                  `cellHandle.with(args).hydrate(value)`. The
 *                  fragment is purely a type-flow hook (gql.tada
 *                  inference); the runtime treats values opaquely.
 *
 * Both use the same ephemeral storage as their backing — disk never
 * sees upstream-loaded data. For state that should persist across
 * runs (preferences, drafts) use `localCell`.
 */

import type { TadaDocumentNode, FragmentOf } from "gql.tada"
import { buildEphemeralCell, type Cell, type CellArgs } from "./cell.ts"

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
  /** Wire identifier. Required. Stable across HMR + renames. */
  id: string
  /** GraphQL client (any object with a typed `.request(doc, vars)`). */
  client: GqlClient
  /** Typed gql.tada document — return type drives `T`, variable
   *  types drive the args contract. */
  doc: TadaDocumentNode<TResult, TVars>
  /** Optional initial value used before the loader populates storage.
   *  Defaults to `null`. Rarely useful — the loader is the normal
   *  cold-start path. */
  initial?: TResult | null
}

/**
 * Build a `Cell<TResult | null>` whose loader runs the GraphQL query
 * with the bound args. Args must match the query's variable shape;
 * gql.tada's inferred `TVars` enforces this at compile time when the
 * call site uses `.with(args)`.
 *
 *     export const cartCell = gqlCell({
 *       id: "magento.cart",
 *       client,
 *       doc: graphql(`query Cart($cartId: String!) { cart(cart_id: $cartId) { … } }`),
 *     })
 *
 *     // In a parent parton:
 *     <CartContents cart={cartCell.with({ cartId })} parent={parent} />
 */
export function gqlCell<TResult, TVars extends Record<string, unknown>>(
  opts: GqlCellOpts<TResult, TVars>,
): Cell<TResult | null> {
  return buildEphemeralCell<TResult | null>(
    opts.id,
    opts.initial ?? null,
    async (args: CellArgs): Promise<TResult | null> => {
      return await opts.client.request(opts.doc, args as TVars)
    },
  )
}

export interface FragmentCellOpts<T> {
  /** Wire identifier. Required. */
  id: string
  /** Optional gql.tada fragment definition. Carries the TS type that
   *  flows through `Cell<T>` to render props; the runtime ignores it
   *  (no validation). Pass as a documentation/typing aid — callers
   *  pick `T` via `FragmentOf<typeof fragment>`. */
  fragment?: TadaDocumentNode<unknown, Record<string, unknown>>
  /** Initial value before any hydration. Typically `null`. */
  initial: T
}

/**
 * Build a `Cell<T>` typed by a GraphQL fragment, with NO loader.
 * Authors populate it from elsewhere — usually a parent gqlCell's
 * loader calling `fragmentCellHandle.with(args).hydrate(value)`
 * during its own response normalisation.
 *
 *     // Type imported from gql.tada fragment definition:
 *     const CartItemFragment = graphql(`
 *       fragment CartItem on CartItem {
 *         uid quantity product { name sku }
 *       }
 *     `)
 *
 *     export const cartItemCell = fragmentCell<
 *       FragmentOf<typeof CartItemFragment> | null
 *     >({
 *       id: "magento.cart-item",
 *       fragment: CartItemFragment,
 *       initial: null,
 *     })
 *
 *     // Placement:
 *     <CartLine item={cartItemCell.with({ uid })} parent={parent} />
 *
 * Reads return `defaultValue` (typically `null`) if the cell hasn't
 * been hydrated for the partition yet. The parent cell's loader is
 * responsible for hydrating children before children render.
 */
export function fragmentCell<T>(opts: FragmentCellOpts<T>): Cell<T> {
  // The `fragment` field is type-only documentation today; the
  // framework doesn't introspect it. Future work could derive shape
  // metadata for runtime validation, but the gql.tada compile-time
  // type is already enforced at the call site.
  void opts.fragment
  return buildEphemeralCell<T>(opts.id, opts.initial, undefined)
}

export type { FragmentOf } from "gql.tada"
