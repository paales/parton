# Cells as resolvers — what shipped, what's still open

> Captured 2026-05-26 during the design conversation that produced
> bound cells (`.with(args)`), the prop-bag resolution path,
> partition-scoped invalidation, and `gqlCell`. The user-facing
> surface lives in [`../reference/cells.md`](../reference/cells.md);
> this note tracks the residue — design questions that were noted
> but deferred during the shipped change.

## What shipped (resolved questions)

- **Resolver-shape primitive.** Cells are normalised entity slots with
  loaders. Same `Cell<T>` contract across `localCell` (storage-only,
  static `initial`) and `gqlCell` (loader = gql.tada-typed query).
- **Args mechanism.** `cellHandle.with(args)` returns a `BoundCell<T>`
  with partition baked. Authors pass `BoundCell`s as JSX props; the
  framework resolves them in the parton's prop-bag resolution phase.
- **Storage-as-authoritative.** Loader runs on cold-start; storage is
  the source thereafter. No TTL, no `freshFor` — that was an
  anti-pattern. Mutations write the cell explicitly; reads dedupe.
- **Partition-scoped invalidation.** Cell writes emit
  `cell:<id>?<args>` selectors; only placements whose merged
  constraints (vary ∪ bound args) match refetch. 200 cart lines, one
  update, one refetch.
- **`hydrate(value)` for parent loaders.** Sync write without firing
  the signal — solves the cascade-on-cold-load problem when a parent
  cell's loader populates child cells.
- **`gqlCell` via gql.tada.** Thin wrapper; args inferred from query
  variables, return type from gql.tada inference, loader is
  `client.request(doc, args)`.

## What's still open

### 1. Typed args (deferred — works as `Record<string, unknown>`)

Today `args` is `CellArgs = Record<string, unknown>`. The cell's
shape doesn't propagate to its `.with(args)` parameter — authors
get no compile-time check that they're passing the right args.

For `gqlCell`, gql.tada's inferred `TVars` IS the args shape, so the
type information is present at construction; threading it through
`.with()` is a TS-generic exercise. For `localCell`, args would
either need a runtime validator (zod-shaped) or just a TS-only type
parameter.

Defer until a caller hits the lack of typing. The functional
behaviour is correct; the typing layer can tighten later.

### 2. Object / list cell shapes (we have `opaque`)

The shape catalog now includes `"opaque"` — accepts any value, no
runtime validation. Real object validation (`{object: {a: string,
b: number}}`, `{list: shape}`) would require building out a small
shape DSL that the framework can walk. Not urgent — `opaque` covers
the cart-line case and any other "trust the loader" pattern.

The CMS migration likely needs proper object shapes (nested
configs + slots with field-level validation). That's the trigger
for building this out.

### 3. Fragment composition + relay-style auto-hydration

Today a parent cell's loader explicitly calls
`cartItemCell.with({uid}).hydrate(value)` for each child. Manual,
explicit, verbose. The Relay-deep version:

```ts
const cartCell = gqlCell({
  doc: graphql(`...`),
  hydrates: {
    items: cartItemCell,  // declares "rows of `items` populate cartItemCell"
  },
})
```

The framework reads the relation map and auto-hydrates child cells
from the query result. Saves typing; centralises the normalisation
logic.

Cost: needs a way to express "this field is an array of CartItem
entities," a way to extract identity keys (probably `__typename + id`
or a custom keyer), and a way for the framework to walk the result
recursively. Not small.

Defer until the manual hydration shape repeats often enough to show
the abstraction's shape.

### 4. Mutation result auto-write from action returns

Today actions imperatively call `cell.with(args).set(value)` after
the upstream mutation returns. The framework doesn't know "this
action result populates this cell." A future shape:

```ts
const updateLineMutation = gqlMutation({
  doc: graphql(`mutation UpdateLine($uid, $qty) { ... cartItem { ... } }`),
  writes: {
    "data.cartItem": (cartItem) => cartItemCell.with({ uid: cartItem.uid }),
  },
})
```

The framework reads `writes`, finds the corresponding field in the
mutation response, calls the bound cell's `.set()` with the field
value. Reduces action boilerplate; ensures the cell update happens
inside the same transaction as the mutation.

Needs typed paths (`"data.cartItem"`) — gql.tada's response type can
drive this with a tagged-template path utility. Adjacent to (3); same
caller pressure.

### 5. Multi-tab / multi-viewer mutation propagation

Today, partition-scoped invalidation propagates within ONE process.
Connected clients on the SAME process re-render through the
heartbeat stream. Multiple processes / multiple users on the same
cart: a write in process A doesn't reach process B's clients.

Solutions:
- `BroadcastChannel` for same-origin tabs (filed in
  [`./IDEAS.md`](./IDEAS.md)).
- Pluggable invalidation backend (Redis pub/sub) for cross-process.

Independent of cells; affects the registry layer.

### 6. Eviction policy

`localCell` + `gqlCell` storage grows indefinitely until process
restart. For long-running production usage with N users × M
cart-items, this matters. Today's `CellStorage` adapter contract
doesn't have LRU/maxBytes/TTL eviction.

Eviction is a property of the adapter, not the cell primitive. A
Redis-backed adapter gets eviction for free. The default JSON-file
adapter could grow a TTL pass. Not urgent — even sloppy in-memory
storage handles tens of thousands of entries fine.

## Inspirations

- **Apollo typePolicies** — per-type config (key fields, merge
  functions, field policies). The direct precedent for what
  per-cell options end up looking like once real callers arrive.
- **Relay** — fragment colocation + normalised cache. The eventual
  destination if fragment composition (item 3) earns its place.

## Related

- [`../reference/cells.md`](../reference/cells.md) — the shipped
  user-facing surface (localCell, gqlCell, .with(), hydrate, etc.).
- [`../internals/cell-internals.md`](../internals/cell-internals.md)
  — wire shape, batcher, prop-bag resolution path.
- [`./cell-dimensionality.md`](./cell-dimensionality.md) — the
  orthogonal axis (inheritance walks inside one cell's storage).
- [`./IDEAS.md`](./IDEAS.md) — broader backlog; cross-tab sync,
  persist optimistic state, pattern-based invalidation.
