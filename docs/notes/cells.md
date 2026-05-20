# Cells

> Live design doc. Captured 2026-05-19 from a design conversation
> arriving at a typed, identity-keyed, multi-realm replacement for
> the `session.string('name')` + `setSessionValue(name, v)` pair.
> First in-tree caller: `streaming-demo` (was `streaming-demo-state.ts`
> + `streaming-demo-actions.ts`).
>
> Status note 2026-05-20: a second caller landed on the same page — a
> three-cell controlled-form card (`cardName` / `cardNumber` /
> `cardCvc`) bound to a `commitCardForm` action that batches all three
> writes inside one `runInvalidationTransaction`. Two findings from
> that exercise are now in scope below: the **controlled-input
> discipline** for cells driven by a continuous input, and the
> **nested-transaction batching** behaviour that makes app-level
> multi-cell writes ship as one segment. See the new sections at the
> end of this doc.
>
> Status note 2026-05-21: the controlled-input discipline is now a
> framework primitive. `useCell(serverCell)` returns a `ClientCell`
> with **optimistic-aware `value`** and a **batched `set`**; the
> per-input glue (refs, layout effects, caret restore, transform
> pipeline) is exposed as `cell.input(opts)` for spread onto a
> controlled `<input>`. The `commitCardForm` wrapper action is gone;
> per-keystroke writes go through a microtask-coalesced batcher
> (single-inflight, accumulate-pending) that posts one
> `__cellWriteBatch` per drain. Cells gained a `write?: (T) => T`
> option (renamed from `normalize`) that runs server-side after
> `validate` and before storage — the server's final-say
> canonicalisation. The card-form demo now has five cells (three
> form values + two global demo toggles `serverDelay` and
> `applyLocalTransform`); see `/streaming-demo` card 4.

## Premise

A cell is a **typed, identity-keyed slot** of server-authoritative
state that:

1. Has a **default value** and a **shape** (string / number / boolean
   / enum), declared once at module scope.
2. Partitions its storage by an **own `vary` callback** — sync,
   request-scoped, same shape as a parton's `vary`. Realms ("user",
   "global", "tab", per-product, per-(user × product)) fall out
   naturally from the partition you pick.
3. Is **read** by parton specs through a new `schema` option — the
   parton declares which cells it depends on; the framework
   resolves them and folds the resolved values into the parton's
   fingerprint.
4. Is **mutated** through `cell.set(v)`, available identically on
   server (sync, direct write) and client (Flight-serialized
   server-action ref). Mutation fans out via the existing
   invalidation registry — `refreshSelector("cell:<id>")` shifts
   every parton's fp that reads the cell.

Cells are **not** a state manager. They are a typed access surface
over the same storage classification the framework already
acknowledges (per-user session, per-cookie scope, durable per-key),
absorbing the boilerplate that today shows up as scoped Maps + ad
hoc selectors + per-feature server-action files.

## Surface

### Module-scope construction

```ts
import { cell } from "@parton/framework"

// "global" — single value cluster-wide
export const featured = cell.string({
  id: "featured",
  vary: () => ({}),
  initial: "none",
})

// "user" — per-session
export const palette = cell.enum(["light", "dark"], {
  id: "palette",
  vary: ({ session }) => ({ sid: session.id }),
  initial: "dark",
})

// per-product
export const productNotes = cell.string({
  id: "product-notes",
  vary: ({ params }) => ({ productId: params.id }),
  initial: "",
})

// per-(user × product)
export const productFavorite = cell.boolean({
  id: "product-favorite",
  vary: ({ session, params }) => ({
    sid: session.id,
    productId: params.id,
  }),
  initial: false,
})
```

Shape catalog for v1: `cell.string` / `cell.number` / `cell.boolean`
/ `cell.enum(values, opts)`. The shape determines runtime validation
on client writes (`__cellWrite(id, value)` rejects mismatched
shapes before storage).

The `id` is **required** in v1 — explicit ids are stable across
renames + survive HMR + identify the cell on the wire. A Vite
plugin to auto-derive ids from `(module-path, export-name)` is a
follow-up; not in this PR.

### Reading in a parton's `schema`

```ts
import { parton, type RenderArgs } from "@parton/framework"
import { palette, productNotes } from "./state.ts"

const ProductHeader = parton(
  function ProductHeaderRender({ palette, notes, parent }) {
    return (
      <header data-palette={palette.value}>
        <NotesEditor notes={notes} />          {/* handle passes to client */}
      </header>
    )
  },
  {
    match: "/product/:id",
    schema: () => ({ palette, notes: productNotes }),
  },
)
```

`schema` is a sync callback returning a record. Each entry can be:

- A **cell handle** — framework runs `cell.vary(scope)`, looks up
  storage by `(cell.id, hash(cellVaryOutput))`, resolves to a
  per-render `ResolvedCell<T>` that Render receives.
- (Later, when block.schema unifies) a `cms.text()` / `cms.enum()`
  marker — framework resolves via the CMS surface.

`schema` runs **alongside** `vary`. `vary` is request-dimensions
only (URL bits, cookies, headers); `schema` is declared deps that
need framework-mediated resolution.

### Resolution order per partial render

1. **match phase** — URLPattern gates rendering.
2. **vary phase** — sync callback against request scope; output
   participates in fp.
3. **schema phase** — sync callback returns a record; framework
   walks it, for each cell:
   - Run `cell.vary(scope)` against the same request scope →
     `partitionKey = hash(cellVaryOutput)`.
   - Storage read `(scope, cell.id, partitionKey)` → value (or
     `cell.defaultValue` on miss).
   - Build `ResolvedCell<T> = { id, value, set }` for Render.
   - Stamp `cell:<id>` onto the partial's labels (so
     `refreshSelector` fires on `.set`).
4. **fp** = `id|matchKey|vary=<hash>|schema=<cellHashes>|props=<hash>|inv=<ts>`.
   The `schema=...` slot includes each cell's `(id,
   partitionKeyHash, valueHash)`, so changing the cell value OR
   navigating across partitions both shift fp.
5. **Render** runs with merged props: vary entries + schema entries.

The parton author does NOT need to redeclare cell-vary dimensions
in their own vary. A cell partitioned by `productId` makes the
parton's fp move on productId transitively, because resolving the
cell at fp time produces a different value per productId.

### Mutation surface

Server-side:

```ts
import { palette } from "./state.ts"
import { runInvalidationTransaction } from "@parton/framework"

"use server"
export async function reset() {
  await runInvalidationTransaction(async () => {
    await palette.set("dark")
  })
}
```

`cell.set(v)` resolves the partition key from the **current
request scope** automatically. The action invocation request has
URL + cookies + headers; `cell.vary` runs against that scope to
produce the partition key.

Optional override for cross-context mutations:

```ts
await productNotes.set("New notes", { vary: { productId: "abc" } })
```

When the explicit `vary` override is supplied, `cell.vary` is
skipped and the override is used directly. Useful when an action
fired from `/cart` needs to update notes for a product not in the
current URL.

Client-side:

```tsx
"use client"
import { palette } from "../state.ts"

export function PaletteToggle({ palette: handle }) {
  return (
    <button onClick={() => handle.set(handle.value === "dark" ? "light" : "dark")}>
      {handle.value}
    </button>
  )
}
```

Two ways to obtain the handle on the client:

1. **Via Flight prop** — server render passes `<PaletteToggle
   palette={palette} />` where `palette` came from the parton's
   schema. The `ResolvedCell` carries `{id, value, set}` across
   Flight. `.set` is a server-action ref (bound `__cellWrite`
   with `cellId` baked in via `Function.prototype.bind`).
2. **Direct module import** — the client component imports the
   bare module handle; `.set` is the same bound action ref.
   `.value` on the bare handle is `undefined` (no
   request to resolve against). Use the prop-passed handle when
   you need `.value`, the bare handle when you only need `.set`.

Default exposure: `{value, set}` — both cross Flight. Permission
flags (`exposeValueToClient: false` for sensitive cells) are
deferred; can be added later without breaking the wire shape.

## Storage

v1 ships with **JSON file storage** at `cms/data/cells.json`,
mirroring the CMS storage pattern (`content.json` / `draft.json`).

- **Process-local in-memory cache** is the canonical read path
  (sync, fast).
- **Disk flushes are debounced** (~100ms) — the streaming-demo's
  per-tick writes coalesce into one file write per debounce window.
- **Test scopes** (the `x-test-scope` header used by Playwright
  workers) stay in-memory only — parallel test workers don't
  trample shared disk state, and test cleanup is a per-scope wipe
  rather than file truncation.
- **Atomic writes** use temp-file + rename, same as
  `cms-storage.ts::JsonFileStorage`.

### Storage shape on disk

```json
{
  "demo.bumps": {
    "<hash-of-empty-vary>": 5
  },
  "palette": {
    "<hash-of-{sid:abc123}>": "dark",
    "<hash-of-{sid:def456}>": "light"
  },
  "product-notes": {
    "<hash-of-{productId:42}>": "Notes for 42",
    "<hash-of-{productId:99}>": "Notes for 99"
  }
}
```

Top-level keys = cell ids. Inner keys = `hash(stableStringify(cell.vary(scope)))`
— so `vary: () => ({})` collapses to one constant partition slot.

### Pluggable driver

```ts
import { setCellStorage, type CellStorage } from "@parton/framework"

const redisStorage: CellStorage = {
  async read(scope, cellId, partitionKey) { … },
  async write(scope, cellId, partitionKey, value) { … },
  clear(scope) { … },
}

setCellStorage(redisStorage)
```

Reads are sync today (the runtime calls cells inside parton render
paths that are sync after vary). Drivers that need async reads
(Redis, KV) ship a sync-ish wrapper or a warm-cache step the
runtime awaits at request entry — same shape `cms-storage.ts`
already uses.

## Wire shape

`ResolvedCell<T>` over Flight:

```ts
{
  __cell: true,
  id: "demo.bumps",
  value: 5,                           // current resolved value
  set: <serverRef-of-__cellWrite-bound-to-id>,
}
```

`set` is `__cellWrite.bind(null, cellId)` — Flight handles bound
server-action refs natively (React 19+). The client invokes
`.set(v)` and the framework re-resolves `partitionKey` from the
action invocation's request scope. The action returns
`Promise<void>`; refetch is driven by `getServerNavigation().reload({
selector: "cell:<id>" })` inside the action, which bumps the
invalidation registry and shifts the fp of every parton reading
the cell on the next render.

The cell module handle (the module-singleton thing constructed via
`cell.string(...)`) is **distinct** from `ResolvedCell<T>`. The
module handle carries `vary`, `defaultValue`, `validate`; the
resolved cell carries `value` (and `set`, the bound action ref the
module handle also exposes). Only the resolved form is passed to
Render and across Flight.

## Composition with existing primitives

- **vary** — unchanged. Pure request-dimensions. Cell reads do NOT
  happen inside vary; that's what `schema` is for.
- **selector** — cells auto-stamp `cell:<id>` on the spec's labels.
  Authors can declare additional labels via `selector:` as before.
- **invalidation registry** — `cell.set(v)` calls
  `refreshSelector("cell:" + id)` inside a transaction. fp folding
  reuses today's `queryMatchingTs(labels, varyInputs)` against the
  expanded label set.
- **session reads** — `session.text/number/enum` on the vary scope
  remain available; the new `session.id` field is added for cells
  that partition per-user. Editor shell stays on `session.enum` for
  now; broader migration is filed separately.
- **CMS reads** — `block.schema({cms})` already exists. Pulling
  it up to `parton.schema({cms})` is a separate refactor; this PR
  adds parton.schema to host cell reads only.

## Non-goals (v1)

- **Async loader callbacks.** Render does its own async fetching;
  cells are sync typed slots with defaults. If you need lazy
  population, do it in render.
- **Auto-id from module path.** Explicit `id` is required for now.
  Vite plugin to encode `(module-path, export-name)` is a follow-up.
- **Permission-gated value exposure.** All resolved cells expose
  `value` to client. Add `exposeValueToClient: false` later for
  sensitive cells.
- **Migration of `session.string`/`setSessionValue` callers.**
  Existing callers (editor shell, session-toggle component) stay on
  the legacy surface. Cells live alongside; migration is a
  follow-up PR.
- **Redis/KV adapters.** Interface is stable; in-tree adapter is
  JSON file only.

## Examples table

| What | Cell vary |
|---|---|
| Featured product banner (admin-set) | `() => ({})` |
| Maintenance mode flag | `() => ({})` |
| Site-wide announcement text | `() => ({})` |
| User palette / locale | `({session}) => ({sid: session.id})` |
| Wishlist | `({session}) => ({sid: session.id})` |
| Cart contents (logged-in user) | `({session}) => ({sid: session.id})` |
| Multi-step checkout draft | `({session}) => ({sid: session.id})` |
| Recent searches | `({session}) => ({sid: session.id})` |
| A/B test bucket | `({session}) => ({sid: session.id})` |
| Like state for blog post | `({session, params}) => ({sid: session.id, postId: params.id})` |
| Add-to-cart form draft per product | `({session, params}) => ({sid: session.id, productId: params.id})` |
| Comment count for post | `({params}) => ({postId: params.id})` |
| Admin price override for SKU | `({params}) => ({sku: params.sku})` |
| Cart for anonymous user | `({cookies}) => ({cartId: cookies.cart_id})` |

What's NOT a cell:

- Drawer / modal open/closed → frame URL or URL search.
- PDP variant selection → URL search (`?variant=red`), shareable.
- PLP filters → URL search.
- Currently-typing-into-textarea state → `useState` in the client
  component until commit (then debounced cell write if persistence
  matters).
- Anything sharable that fits a URL → URL, not a cell.

## Controlled-input discipline (added 2026-05-20, extracted 2026-05-21)

A cell mutated from a **discrete event** (toggle, button click, "add
to cart") is fine with plain `cell.set(v)` — each call is atomic, no
caret to preserve, no in-progress input to clobber. The bump counter
on `/streaming-demo` is this regime.

A cell bound to a **controlled input** (text field, slider, drag
handle) needs four rules together, otherwise rapid-fire typing
produces visible jank or out-of-order writes. The first card-form
caller implemented them inline; on 2026-05-21 they were extracted
into the **`useCell` hook + `ClientCell.input()` binding** so future
controlled-input cells get the discipline for free.

1. **Display is local-first.** `useCell(cell).value` is
   optimistic-aware: latest local-set value while writes are queued
   or in flight; falls back to the server-authoritative value when
   everything has settled. An optional `transform` fn passed to
   `cell.input({transform})` runs per keystroke before `set`. The
   display never waits on a server round-trip to advance to the
   next character.
2. **Single in-flight + accumulate-pending.** Every `cell.set`
   enqueues into the framework's microtask-coalesced batcher. At
   most one `__cellWriteBatch` POST in flight per tab; new
   enqueues during in-flight accumulate and flush as the next
   batch when the current resolves. Writes hit the server in
   strict send-order regardless of per-batch latency variance —
   there's no write-write race.
3. **Caret restoration via `useLayoutEffect`.** Owned by the hook.
   The transform returns `{value, caret}`; the hook stashes the
   caret in a ref and restores via `setSelectionRange` after React
   commits. Per-char transforms (uppercase, strip) keep caret in
   place; non-monotonic transforms (the card-number space
   insertion) walk the raw string counting digits-before-caret to
   find the new logical position.
4. **Safe-moment adoption.** Implicit. The optimistic value clears
   when the last pending write for the cell drains, so the next
   render flips `value` to the server-authoritative shape (the
   reconcile moment). During a typing burst the optimistic value
   stays pinned to the user's input — no mid-burst clobber by
   construction.

**Surface:**

```tsx
"use client"
import { useCell } from "@parton/framework/lib/cell-client.tsx"

const name = useCell(props.cardName)   // { value, serverValue, set, input }

<input
  {...name.input({
    transform: (raw, caret) => ({ value: raw.toUpperCase(), caret }),
    onCommit: (v) => fireRelatedCell(v),   // optional cross-cell trigger
  })}
  data-testid="..." className="..."
/>
```

The author writes the `onChange`-free spread + the transform fn. No
`useState`, no `useEffect` adoption, no manual refs/layout effects,
no pending checks. `cell.input()` parallels react-hook-form's
`register()` (see the "Future research" section below for a closer
comparison before extending `CellInputOpts` ad-hoc).

Code: `framework/src/lib/cell-client.tsx` (hook), `streaming-demo-card-form.tsx`
+ `streaming-demo-card-shared.ts` for the transforms/caret math.

For fast-fire discrete events (game-style button mashing, slider
flick), the same four rules apply but with a different **coalesce
strategy** — sum for counters (`pending = (pending ?? 0) +
delta`), XOR for toggles, list-concat for append-to-list. The
matching server-side shape is a delta-style action (`addToBumps(n:
number)`) the client passes the accumulated count to. The current
`/streaming-demo` bump counter is the simple discrete-event regime
(plain `cell.set`); it has a known click-spam race that the
delta-action shape would fix — filed as a follow-up.

## Nested-transaction batching (added 2026-05-20)

`runInvalidationTransaction` is nestable as of 2026-05-20: when an
enclosing tx is already active, the inner call is a thin
pass-through (`if (transactionContext.getStore()) return await
fn()`). This makes app-level multi-cell writes batch correctly
without a new public primitive:

```ts
"use server"
import { runInvalidationTransaction } from "@parton/framework"

export async function commitCardForm({ name, number }) {
  // ...compute cleanName, formattedNumber, cvc...
  await runInvalidationTransaction(async () => {
    await cardName.set(cleanName)
    await cardNumber.set(formattedNumber)
    await cardCvc.set(cvc)
  })
}
```

Each `cell.set` internally wraps in its own
`runInvalidationTransaction`; with the nesting fix, those inner
wrappers join the outer tx. All three `refreshSelector("cell:...")`
bumps flush at the outer commit, the segment driver wakes once,
one segment ships carrying every affected cell. Without nesting
each `cell.set` would commit at its own boundary and the three
writes would arrive as three separate segments — visually
out-of-step on watching tabs.

Authors don't need a `cellBatch(...)` helper for this — wrap the
calls in `runInvalidationTransaction` directly, same as a server
action body. The cost is one extra `await` per cell write (the
inner tx's `await fn()`); for a 3-cell write that's negligible
compared to one wire round-trip.

## Future research: `cell.input()` ↔ react-hook-form `register()`

The `useCell(cell).input(opts)` binding ([`framework/src/lib/cell-client.tsx`](../../framework/src/lib/cell-client.tsx))
returns `{value, onChange, ref}` for spread onto a controlled
`<input>`. The shape is deliberately RHF-flavoured — react-hook-
form's [`register()`](https://react-hook-form.com/docs/useform/register)
returns the same spread surface (`{name, onChange, onBlur, ref}`)
and absorbs the per-input glue (refs, change handlers,
validation/transform pipeline).

Worth a closer comparison before extending `CellInputOpts` ad-hoc:

- RHF covers `onBlur`, validation rules (`required`, `min`, `max`,
  `pattern`, `validate`), `valueAsNumber` / `valueAsDate`, field
  arrays, and the submit lifecycle (`handleSubmit`). Cells today
  cover `transform` (per-keystroke with caret math) and `onCommit`
  (cross-cell trigger).
- A closer alignment would let cells drop into RHF-style form
  patterns without translation — and would tell us which RHF
  features have a natural cell analog vs. which are form-library
  concerns we should leave to RHF itself (cells own the wire +
  optimistic-aware value; RHF owns the form-state choreography).
- Open question: should cells SUBSUME RHF for forms, INTEROP with
  it (`useCell` returning a shape RHF can register), or stay in a
  narrower niche (single controlled input, no form-level
  validation)? The card-form demo is one data point; a multi-step
  CMS draft form would be a useful second one.

## Related

- [`replicated-state.md`](./replicated-state.md) — the broader
  Unreal-actor-shaped state model. Cells are the narrow
  "single typed value, mutate-and-invalidate" lane.
- [`transient-client-state.md`](./transient-client-state.md) —
  Direction A (per-session draft store) collapses to a cell with
  `vary: ({session}) => ({sid: session.id})`. The card-form caller
  on `/streaming-demo` lands the controlled-input discipline
  inline; whether to extract it as `<PartialForm>` (Direction D)
  is open.
- [`../reference/partial.md`](../reference/partial.md) — the
  `parton` constructor surface that `schema` extends.
- [`../reference/cms.md`](../reference/cms.md) — block.schema, the
  existing template for the schema callback shape.
