# Cells

A cell is a **typed, identity-keyed slot** of server-authoritative
state that crosses Flight to client components as a `ResolvedCell<T>`
prop. Clients read its `.value` and call `.set(v)`; the framework
fans the write back out to every parton that read it via the
parton's `schema` callback or via JSX prop binding.

Two constructors today:

- **`localCell({...})`** — storage-backed by the active `CellStorage`
  adapter (default: JSON file at `cms/data/cells.json`). Initial
  value is static.
- **`gqlCell({client, doc, ...})`** — storage-backed too, but cold-
  start populates the slot by running a gql.tada-typed GraphQL query
  with the bound args.

Both implement the same `Cell<T>` interface — Render code doesn't
know or care which backend produced the value.

Use a cell when:

- The state isn't shareable (so it doesn't belong in a URL) but is
  authoritative on the server.
- The state should fan out across all viewers in its partition (a
  cell with `vary: ({session}) => ({sid: session.id})` reaches every
  tab the user has open).
- Multiple partons need to react to changes (cells auto-stamp
  `cell:<id>` on every reading parton's labels, so a `cell.set`
  refetches matching placements on the next render).

For internals (storage adapters, wire shape, batcher mechanics) see
[`../internals/cell-internals.md`](../internals/cell-internals.md).

## Partition axes

A cell's storage is keyed by `(id, partitionKey)` where partitionKey
hashes the cell's **args** for this render. Args come from two
sources:

- **`vary` callback** on the cell — derives args from the request
  scope (`session`, `cookies`, `headers`, `params`, etc.). Sync,
  runs per-render. For request-derived partitioning (palette by
  session, notes by URL param).
- **`.with(args)` at the call site** — author binds explicit args
  when placing a cell handle into a parton's schema or as a JSX
  prop. For placement-derived partitioning (cart line by item id).

Both can compose: a cell with `vary` *and* `.with()` ends up with
merged args. Vary's output forms the base; `.with()` overlays.

## Three placement patterns

### 1. Module-scope cell, declared in schema

For cells where the partition is fully derived from request scope:

```ts
import { localCell, parton, type RenderArgs, type ResolvedCell } from "@parton/framework"

export const palette = localCell({
  id: "palette",
  shape: { enum: ["light", "dark"] as const },
  vary: ({ session }) => ({ sid: session.id }),
  initial: "dark",
})

const ProductHeader = parton(
  function Render({ palette }: { palette: ResolvedCell<"light" | "dark"> } & RenderArgs) {
    return <header data-palette={palette.value}>...</header>
  },
  { schema: () => ({ palette }) },
)
```

The framework resolves `palette` against the request, passes
`ResolvedCell<...>` to Render via `palette` prop.

### 2. Parton-scoped cell, declared inline in schema

For cells owned by a specific parton, partitioned by the parton's
vary output:

```tsx
const ProductPage = parton(
  function Render({ notes, parent }) {
    return <NotesEditor notes={notes} />
  },
  {
    match: "/product/:id",
    vary: ({ params }) => ({ productId: params.id }),
    schema: ({ localCell }) => ({
      notes: localCell({ shape: "string", initial: "" }),
    }),
  },
)
```

Wire id auto-derives as `<partonId>/<schemaKey>` (e.g.
`product-page/notes`). Partition is the parton's vary output by
default; narrow via `vary: (partonVary) => subset` on the descriptor.

### 3. Placement-bound cell, passed as a JSX prop

For per-instance addressability — the new shape that enables
fine-grained refetch:

```tsx
const cartItemCell = localCell({
  id: "cart-item",
  shape: "opaque",
  initial: null as CartItem | null,
})

// Parent renders many lines, each bound to a specific itemId:
function CartRender({ cart, parent }) {
  return cart.value.itemIds.map((uid) => (
    <CartLine key={uid} parent={parent} item={cartItemCell.with({ uid })} />
  ))
}

// Child reads the bound cell from its prop bag:
const CartLine = parton(
  function Render({ item }: { item: ResolvedCell<CartItem | null> } & RenderArgs) {
    return <Line {...item.value} />
  },
  { selector: "cart-line" },
)
```

`cellHandle.with(args)` returns a `BoundCell<T>` descriptor. When the
framework sees a `BoundCell` in a parton's top-level JSX props, it:

1. Resolves the cell's value at the bound partition (running the
   loader if present and storage is cold).
2. Replaces the `BoundCell` with a `ResolvedCell<T>` in the prop bag.
3. Stamps `cell:<id>` onto the parton's invalidation labels.
4. Merges the bound args into the parton's effective constraint
   surface — so partition-scoped writes (`cell:<id>?<args>`) only
   refetch placements whose bound args match.

The result: 200 `<CartLine>` placements, one quantity update via
`cartItemCell.with({uid: "X"}).set(...)` → only that one placement
refetches. The others stay put.

## Surface — `localCell`

```ts
const palette = localCell({
  id: "palette",
  shape: { enum: ["light", "dark"] as const },
  vary: ({ session }) => ({ sid: session.id }),
  initial: "dark",
})

const cartItemCell = localCell({
  id: "cart-item",
  shape: "opaque",
  initial: null as CartItem | null,
  // no `vary` — partition entirely from `.with()` at placement sites
})

const cardName = localCell({
  id: "card-name",
  shape: "string",
  vary: () => ({}),
  initial: "",
  // server-side canonicalisation: every write runs through this
  write: (raw) => raw.toUpperCase().replace(/[^A-Z ]/g, "").slice(0, 26),
})
```

### Options

| Option | Notes |
|---|---|
| `id` | Wire identifier. Required. |
| `shape` | Runtime shape. `"string"` / `"number"` / `"boolean"` / `"opaque"` / `{enum: [...] as const}`. `"opaque"` accepts any value without validation — author owns the TS type. |
| `initial` | Default value when storage is empty and no loader is configured. |
| `vary` | Optional. `(scope) => CellArgs`. Output hashes into the partition key. Omit for a cell whose partition comes entirely from `.with()`. |
| `load` | Optional async `(args) => T`. Runs on cold-start (storage miss) — result is validated, written to storage, then returned. Storage stays the source of truth thereafter. |
| `write` | Optional `(T) => T`. Server-side canonicalisation. Runs after `validate` and before storage on every write. |

## Surface — `gqlCell`

Convenience wrapper over `localCell` for cells loaded from a
GraphQL endpoint:

```ts
import { gqlCell } from "@parton/framework"
import { client } from "../magento-data.ts"
import { graphql } from "../magento-graphql.ts"

export const cartItemCell = gqlCell({
  id: "cart-item",
  client,
  doc: graphql(`
    query GetCartItem($itemId: ID!) {
      cartItem(uid: $itemId) {
        uid
        quantity
        product { name sku }
      }
    }
  `),
})
```

The args shape is inferred from the query's variable definitions
(via gql.tada). Cold-start runs the query; subsequent reads return
from storage. Mutations write the cell explicitly:

```ts
"use server"
async function updateLineQty(itemId: string, qty: number) {
  const r = await client.request(UpdateCartItemMutation, { itemId, qty })
  await cartItemCell.with({ itemId }).set(r.updatedItem)
}
```

## Bound cells — mutation surface

`cellHandle.with(args)` returns a `BoundCell<T>` carrying:

| Method | Behaviour |
|---|---|
| `set(value)` | Write storage at this partition, fire `cell:<id>?<args>`. |
| `update(updater)` | Read current value (running loader on miss), apply `updater(current) => next`, write back. |
| `clear()` | Reset storage to `defaultValue`, fire partition-scoped invalidation. |
| `invalidate()` | Fire `cell:<id>?<args>` WITHOUT touching storage. Forces matching placements to re-resolve. |
| `hydrate(value)` | Sync write to storage with NO signal. Used by parent loaders to populate child cells on cold load. |

`set` / `update` / `clear` / `invalidate` are server-action refs —
Flight-serializable, callable from client components.

The cell-write path emits **partition-scoped selectors**:
`cell:<id>?<key>=<value>&<key>=<value>`. Only partons whose effective
constraint surface (vary output ∪ bound args) contains a matching
subset get invalidated.

## Reading patterns

### In schema

Schema callbacks return a record of cell handles / scoped
descriptors. The framework resolves each entry into a
`ResolvedCell<T>` and passes it to Render via the prop bag.

```ts
const Cart = parton(
  function Render({ cart, parent }) {
    return cart.value.itemUids.map((uid) => (
      <CartLine key={uid} parent={parent} item={cartItemCell.with({ uid })} />
    ))
  },
  { schema: () => ({ cart: cartCell }) },
)
```

### As a JSX prop

Top-level JSX props that are `Cell<T>` or `BoundCell<T>` are auto-
resolved before Render runs. Pass a `BoundCell` from a parent to a
child parton:

```tsx
<CartLine parent={parent} item={cartItemCell.with({ uid })} />
```

The child's Render receives `item` as a `ResolvedCell<T>`. The
child's labels include `cell:<id>` automatically.

**Scope:** only top-level JSX props are walked. Nested cells inside
object props are NOT auto-resolved — if you want a cell to be
framework-tracked, pass it as its own top-level prop.

### Server-side via `cell.peek()`

`peek()` is a sync server-side read at the partition derived from
the cell's own `vary` against the active request. Returns
`defaultValue` on miss. Does NOT trigger the loader. Useful inside
actions or vary callbacks.

```ts
const showAdvanced = palette.peek() === "dark"
```

## Resolution order per partial render

1. **match phase** — URLPattern gates rendering.
2. **vary phase** — sync callback against request scope; output participates in fp.
3. **schema phase** — for each cell handle:
   - Module cell: run `cell.vary(scope)` → args; resolve via storage (or loader on miss); build `ResolvedCell`.
   - Scoped descriptor: finalize → run descriptor's vary against partonVary → args; resolve.
   - Bound cell: use baked args; resolve.
   - Stamp `cell:<id>` onto labels; merge args into constraint surface.
4. **props phase** — walk top-level JSX props for Cell / BoundCell:
   - Resolve each; replace prop with `ResolvedCell`.
   - Stamp label; merge args.
5. **fp** = `id|matchKey|vary|schema=<cellHashes>|props|inv`. `inv` folds the latest `queryMatchingTs(labels, vary ∪ args)` — partition-scoped invalidations move fp only for matching placements.
6. **Render** runs with the merged prop bag.

## Mutation patterns

### Direct write — `cell.set(value, opts?)`

For module-scope cells where partition is fully derived from request scope:

```ts
"use server"
import { palette } from "./state.ts"

export async function reset() {
  await palette.set("dark") // partition from palette.vary(currentRequest)
}
```

Optional `opts.vary` overrides the cell's own vary for cross-context
mutations:

```ts
await productNotes.set("New notes", { vary: { productId: "abc" } })
```

### Bound write — `cell.with(args).set(value)`

For placement-derived partitions:

```ts
"use server"
async function updateLineQty(uid: string, qty: number) {
  const r = await magento.updateCartItem({ uid, qty })
  await cartItemCell.with({ uid }).set(r.updatedItem)
}
```

The selector `cell:cart-item?uid=<uid>` fires; only the matching
`<CartLine item={cartItemCell.with({uid})}>` placement refetches.

### Hydration in parent loaders — `cell.with(args).hydrate(value)`

When a parent cell's loader returns nested data, hydrate child cells
without firing signals (the children haven't rendered yet — a signal
would just be noise):

```ts
export const cartCell = localCell({
  id: "cart",
  shape: "opaque",
  vary: ({ cookies }) => ({ cartId: cookies.cart_id }),
  initial: null as CartShape | null,
  load: async ({ cartId }) => {
    const data = await client.request(CartQuery, { cartId })
    // Populate per-line cells without firing partition signals.
    for (const item of data.cart.items) {
      cartItemCell.with({ uid: item.uid }).hydrate(item)
    }
    return { itemUids: data.cart.items.map((i) => i.uid), totals: data.cart.totals }
  },
})
```

### Client-side via `useCell`

`useCell(resolvedCell)` returns a `ClientCell` with optimistic-aware
`.value`, microtask-batched `set`, and controlled-input bindings.
See [`./useCell` section below](#client-side-mutation) — unchanged from
prior versions.

## Controlled-input discipline (four rules)

See [`useCell` section](#client-side-mutation) — same as before.
Cells driven by a controlled input use `useCell(cell).input(opts)`
to get the four behaviours (display-local-first, single-inflight
batch, caret restoration, safe-moment adoption) for free.

## Client-side mutation

```tsx
"use client"
import { useCell } from "@parton/framework/lib/cell-client.tsx"

export function PaletteToggle({ palette }: { palette: ResolvedCell<"light" | "dark"> }) {
  return (
    <button onClick={() => palette.set(palette.value === "dark" ? "light" : "dark")}>
      {palette.value}
    </button>
  )
}
```

For controlled inputs and rapid-fire writes, reach for **`useCell`**:

```tsx
"use client"
import { useCell } from "@parton/framework/lib/cell-client.tsx"

export function MessageField({ message }: { message: ResolvedCell<string> }) {
  const m = useCell(message)
  return (
    <>
      <input value={m.value} onChange={(e) => m.set(e.target.value)} />
      <div>server says: {m.serverValue}</div>
    </>
  )
}
```

See [`../internals/cell-internals.md`](../internals/cell-internals.md)
for the client-side batcher, optimistic value tracking, and the
`cell.input()` controlled-input binding.

## Examples table

| What | Pattern |
|---|---|
| Featured product banner (admin-set) | `localCell({vary: () => ({}), ...})` |
| User palette / locale | `localCell({vary: ({session}) => ({sid: session.id}), ...})` |
| Cart contents (per session) | `localCell({vary: ({cookies}) => ({cartId: cookies.cart_id}), ...})` |
| Per cart-line | `cartItemCell.with({uid})` — placement-bound |
| GraphQL-loaded product | `gqlCell({doc: graphql(\`query Product($sku){...}\`), ...}).with({sku})` |
| Add-to-cart form draft per product | `localCell({vary: ({session, params}) => ({sid, productId}), ...})` |

What's NOT a cell:

- Drawer / modal open/closed → frame URL or URL search.
- PDP variant selection → URL search (shareable).
- Anything sharable that fits a URL → URL, not a cell.

## Composition with existing primitives

- **vary** — unchanged. Pure request-dimensions on parton specs.
  Cells have their own `vary` callback (same shape, different role —
  storage partition key vs parton fp).
- **selector** — cells auto-stamp `cell:<id>` on the parton's
  labels. Partition-scoped writes emit `cell:<id>?<args>`.
- **invalidation registry** — `cell.set` calls
  `refreshSelector("cell:" + id + "?" + args)` inside a transaction;
  fp folding reuses `queryMatchingTs(labels, varyInputs ∪ boundArgs)`.

## Related

- [`../internals/cell-internals.md`](../internals/cell-internals.md)
  — storage backends, wire shape, batcher mechanics, prop-bag
  resolution path, partition-scoped selector encoding.
- [`../notes/cells-as-resolvers.md`](../notes/cells-as-resolvers.md)
  — the design conversation behind this surface; resolved questions
  + open ones.
- [`../notes/cell-dimensionality.md`](../notes/cell-dimensionality.md)
  — separate axis: inheritance walks within a single cell's storage
  (translations, draft/published, time/history). Deferred.
- [`./partial.md`](./partial.md) — the `parton` constructor that
  hosts schema + props.
- [`./cms.md`](./cms.md) — block.schema, the existing template for
  the schema callback shape.
