# Cells as resolvers

> Live design doc. Captured 2026-05-26 from a conversation about
> growing the cell primitive into a normalised-entity layer for
> upstream-loaded data (GraphQL, REST, anything else). The shipped
> `localCell` is the first implementor; this note sketches the
> future variants (`gqlCell`, etc.) and the open questions before
> any are built. Decision open; not currently shipping.
>
> Predecessor context: `replicated-state.md` (state-mode taxonomy),
> `cell-dimensionality.md` (the orthogonal axis — inheritance walks
> inside a single cell's storage).

## Premise

Today's `localCell({id, shape, vary, initial, write})` is the
shipped shape. Storage IS the source of truth: writes hit the
configured `CellStorage` adapter, reads come straight back out. The
adapter is the cell's "loader" in the most degenerate sense — read
returns whatever the storage layer has.

The next implementor is upstream-loaded cells: a cell whose value
comes from a GraphQL query (or any other server-side data source).
The shape we converged on: same primitive contract (typed,
partition-keyed, signal-emitting), different option bag —
`gqlCell({args, shape, load, ...})` with a callable loader instead
of an in-process storage write.

The cart line-item case is the load-bearing motivator: a 200-item
cart can't reload everything on every mutation. With normalised
entity cells, a mutation that returns updated item + new totals
flushes only those two cells, only the matching `<CartItem>`
placement and the `<Cart>` totals view refetch, no upstream
round-trip on the connected viewers (the warm cell value is the
new value).

## Resolver architecture

Cells become server-side resolvers, structurally equivalent to a
GraphQL field resolver. The mapping:

| GraphQL resolver | Cell |
|---|---|
| `(parent, args, context) => result` | `(args) => T` (loader); request context is ambient |
| Type schema | Cell `shape` declaration |
| Argument shape | Cell `args` schema |
| Cache hint (per-type policy) | Cell `freshFor` / `merge` / `read` options |
| Mutation returns updated entity | Action calls `cell.set(args, value)` |
| Normalised cache | Cell storage indexed by `(cellId, hashedArgs)` |

Each implementor wraps the resolver pattern with a specific data
source:

- `localCell` — local file-backed storage; "loader" is the storage
  layer.
- `gqlCell` — GraphQL query as the loader; result populates the
  cell's storage slot.
- (Future) REST / Redis / IPC / whatever — any source that takes
  args and returns a typed value.

All implementors share the same `Cell<T>` handle shape and
`ResolvedCell<T>` wire shape. The framework's invalidation
registry, fp folding, scoped descriptors, and `useCell` machinery
don't care which loader produced the value.

## Sketch — `gqlCell`

Strawman, not committed:

```ts
const cartItem = gqlCell({
  id: "cart-item",
  args: { itemId: "string" },          // call-site args — partition source
  shape: { /* graph type contract */ },
  load: async ({ itemId }) => gql.fetchCartItem(itemId),
  freshFor: 5_000,                      // ms; mutation-result window
})
```

Or via a typed-document tag (gql.tada gives the inference for
free):

```ts
const cartItem = cellGql(graphql(`
  query GetCartItem($itemId: ID!) {
    cartItem(id: $itemId) { id qty sku product { id name } }
  }
`), { freshFor: 5_000 })
```

`cellGql` extracts variable definitions from the query AST →
`args` validator, infers the shape from gql.tada's return type,
synthesises the loader as `(args) => client.request(doc, args)`.
Thin wrapper around the more general `gqlCell`.

### Reading at a parton

Schema stays static. The cell handle is declared in the schema
record; Render calls `.load(args)` with placement-derived
arguments:

```tsx
const CartItem = parton(
  async function CartItemRender({ item, props: { itemId } }) {
    const value = await item.load({ itemId })
    return <Line {...value} />
  },
  { schema: () => ({ item: cartItem }) },
)
```

The framework records the `(cellId, args-hash)` dependency for this
placement. fp folds the resolved value's hash; partition-scoped
invalidation (cell-write with bound args) only re-renders the
matching placement.

### Mutations push to the warm cache

```ts
"use server"
async function updateLineQty(itemId, qty) {
  const r = await gql.updateCartItem({ itemId, qty })
  await cartItem.set({ itemId }, r.item)
  await cart.set({ cartId }, c => ({ ...c, totals: r.cart.totals }))
}
```

Two cell writes, both inside the implicit action transaction. Each
fires its partition-scoped signal (`cell:cart-item?itemId=abc` and
`cell:cart?cartId=xyz`). Connected clients re-render the matching
`<CartItem>` placement and the `<Cart>` parton; both find the cell
value warm (inside `freshFor`) and skip the upstream call. **Zero
Magento round-trips on the re-render after the mutation.** Other
199 cart-item placements stay put — their partition wasn't bumped.

### Cold-load hydration at the cart boundary

To avoid N+1 on cold load, the cart parton's Render fetches the
full cart in one GraphQL query and hydrates child cells before
placing them:

```tsx
const Cart = parton(
  async function CartRender({ cart, parent }) {
    const data = await cart.load({ cartId })
    await Promise.all(
      data.items.map(i => cartItem.hydrate({ itemId: i.id }, i)),
    )
    return data.itemIds.map(id => <CartItem itemId={id} parent={parent} />)
  },
  { schema: () => ({ cart }) },
)
```

`hydrate(args, value)` primes the cache WITHOUT firing the
partition signal — the child placements would re-render
unnecessarily otherwise. Verbose but explicit; duplication across
multiple cart-like callers will eventually pressure-test what
declarative shape it wants.

## What stays the same

- `Cell<T>` and `ResolvedCell<T>` interfaces — the consumer side is
  identical regardless of loader.
- `useCell` + `cell.input()` — the client surface is shape-agnostic.
- Invalidation registry, partition signals, fp folding — all reused.
- Scoped cells inside `schema({localCell})` — `gqlCell` can sit
  alongside in the same scope record.

## Inspirations

- **Apollo typePolicies** — per-type config (key fields, merge
  functions, field policies, freshness). Direct precedent for what
  per-cell options end up wanting once real callers arrive.
- **Relay** — fragment colocation + normalised cache + per-entity
  refetch. The eventual destination if fragment composition at
  parton boundaries proves load-bearing.
- **Pothos** — type-safe schema builder. Less relevant for the
  consumer side; matters if/when we go fragment-composition.

## Open questions

1. **Args typing.** `args` is `Record<string, unknown>` today (same
   as `vary`'s output). Loader-cells want typed args
   (`{itemId: string}`) for the `load` callback to be sound. Whether
   to add a runtime validator (zod or built-in) and how it composes
   with `vary` is unresolved. Defer until first loader-cell
   caller forces it.
2. **Mutation shape.** `cell.set(args, value)` is the natural shape
   for partition-arg-explicit writes. Today's `cell.set(value,
   {vary?})` already supports an explicit partition override —
   `set(args, value)` is just a different signature ordering. Pick
   one when the first caller lands.
3. **Hydrate vs set.** `hydrate` writes without firing the signal
   (cold-load priming); `set` writes and fires (mutation result).
   Single API with a flag, or two methods? Two methods feels right
   — the intent is different and the call sites read differently.
4. **TTL / `freshFor` defaults.** localCell has no TTL (storage IS
   source). gqlCell needs one (loader is source; storage is cache).
   Reasonable default: maybe 5s, configurable per-cell. Eviction
   beyond TTL — LRU? maxBytes? Pluggable adapter property.
5. **Fragment composition.** The Relay-deep version: cells declare
   fragments, framework composes them at parton boundaries into one
   query, auto-hydrates from the response. Big new surface; likely
   not worth doing until the imperative `await Promise.all(items.map
   (i => cartItem.hydrate(...)))` shape repeats often enough to
   show the sugar.
6. **Mutation auto-write from action returns.** Today actions
   imperatively call `cell.set(...)`. A future shape: action declares
   a return type (e.g. `{updatedItem: CartItem, updatedCart: Cart}`)
   and the framework infers which cells to write from the field
   names. Cleaner and composes with optimistic; needs a type
   contract sharp enough to drive the inference.

## Related

- [`../reference/cells.md`](../reference/cells.md) — the today
  `localCell` surface.
- [`../internals/cell-internals.md`](../internals/cell-internals.md)
  — wire shape, batcher mechanics, storage layer.
- [`./replicated-state.md`](./replicated-state.md) — the broader
  state-model lens; cells are the typed-value lane.
- [`./cell-dimensionality.md`](./cell-dimensionality.md) — the
  orthogonal axis (inheritance walks inside one cell's storage).
- [`./IDEAS.md`](./IDEAS.md) — broader backlog; some adjacent items
  (cross-tab sync, persist optimistic, pattern-based invalidation).
