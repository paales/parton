# Cell internals

Implementation details behind the [cell primitive](../reference/cells.md):
the write pipeline, the client-side batcher, the optimistic-value
plumbing inside `useCell`, the storage backends, and the
nested-transaction batching that lets app-level multi-cell writes
ship as one segment.

## Write pipeline

A cell write — whether from server-side `cellHandle.set(v)`, the
client's per-call `resolvedCell.set(v)` server-action ref, or a
batched `useCell(cell).set(v)` — flows through one shared
implementation: `writeOneCell(cellId, value, partitionOverride?)`
in `framework/src/runtime/cell-actions.ts`.

```
validate(value)          ← throws on shape mismatch (defends against
                            malicious client writes)
↓
write(validated)          ← optional cell-declared canonicalisation
                            (server's final say on stored shape)
↓
storage.write(scope, id,  ← writes to the active scope's bucket
              partKey, v)
↓
refreshSelector("cell:" + id)   ← bumps the invalidation registry
```

The whole pipeline runs inside a `runInvalidationTransaction`. A
throw in `validate` or `write` discards the pending refreshSelector
bumps — observers can't see a partial commit.

Two server actions wrap the pipeline:

- **`__cellWrite(cellId, value, partitionOverride?)`** — single-cell
  write. The shape `cellHandle.set` binds to via
  `Function.prototype.bind`. Each invocation = one POST.
- **`__cellWriteBatch(updates[])`** — multi-cell write. The shape
  the client-side coalescer (`_cellSetBatched` →
  `useCell(cell).set`) targets. Inside one transaction so all
  resulting `cell:<id>` bumps flush at outer commit and the
  segment driver wakes once.

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
`Promise<void>`; refetch is driven by
`getServerNavigation().reload({selector: "cell:<id>"})` inside
the action, which bumps the invalidation registry and shifts the
fp of every parton reading the cell on the next render.

The cell module handle (the module-singleton thing constructed via
`cell.string(...)`) is **distinct** from `ResolvedCell<T>`. The
module handle carries `vary`, `defaultValue`, `validate`, `write`;
the resolved cell carries `value` (and `set`, the bound action ref
the module handle also exposes). Only the resolved form is passed
to Render and across Flight.

### Why `set` on the resolved cell isn't a bound *client* function

The natural shape would be: `resolvedCell.set` is a bound *client*
function ref that calls the batcher (`_cellSetBatched.bind(null,
id)`). Flight rejects this:

```
Error: Functions cannot be passed directly to Client Components
unless you explicitly expose it by marking it with "use server".
```

Bound server-action refs are a Flight-supported special case;
bound client function refs aren't. The Render function is server-
side, so we can't re-shape `set` there either. The conversion to
a client-side cell with a batched setter has to happen inside a
client component — which is why `useCell(serverCell): ClientCell`
exists. Documented in `framework/src/lib/cell-client.tsx`.

## Client-side batcher

`framework/src/lib/cell-client.tsx`. A `"use client"` module
exposing `useCell` plus the queue + flush internals.

### State

```ts
let queue: QueuedWrite[] = []          // pending writes since last flush
let flushScheduled = false              // microtask is pending
let inflight = false                    // a __cellWriteBatch POST is in flight

const latestSentByCell = new Map<string, unknown>()  // optimistic value per cell-id
const pendingByCell    = new Map<string, number>()    // queued + in-flight count
const cellVersion      = new Map<string, number>()    // per-cell-id monotonic counter
const subscribers      = new Set<() => void>()        // useCell subscriptions
```

### `enqueue(cellId, value, opts)` — the entry point

```ts
function enqueue(id, value, opts): Promise<void> {
  incrementPending(id, value)           // bumps pendingByCell[id] AND
                                        // sets latestSentByCell[id] = value,
                                        // then bumps cellVersion[id] and
                                        // notifies subscribers
  return new Promise((resolve, reject) => {
    queue.push({id, value, partition: opts, resolve, reject})
    if (inflight || flushScheduled) return  // a batch will pick this up
    flushScheduled = true
    queueMicrotask(flushQueue)
  })
}
```

The microtask boundary is what makes "calls in the same tick
coalesce" work — N synchronous `set` calls all push onto `queue`
before the microtask runs and turns them into one POST.

### `flushQueue` — single-inflight drain loop

```ts
async function flushQueue(): Promise<void> {
  if (inflight) return                  // someone beat us to it
  inflight = true
  flushScheduled = false
  try {
    while (queue.length > 0) {
      const batch = queue
      queue = []                        // reassign; new enqueues build the next batch
      try {
        await __cellWriteBatch(batch.map((w) => ({...})))
        for (const w of batch) {
          decrementPending(w.id)        // may clear latestSentByCell[id]
          w.resolve()
        }
      } catch (err) {
        for (const w of batch) {
          decrementPending(w.id)
          w.reject(err)
        }
      }
    }
  } finally {
    inflight = false
  }
}
```

Key invariants:

- **At most one POST in flight per tab.** New enqueues during
  in-flight just push to `queue`; the while-loop picks them up on
  the next iteration.
- **Strict send-order on the server.** The server-side
  `__cellWriteBatch` iterates `updates[]` in order inside one
  transaction. Plus single-inflight means the next batch can't
  start until the previous one commits — so the global write
  order matches the order entries left the client.
- **No write-write races.** With at most one POST in flight per
  cell, no overlapping writes can land in arbitrary order on the
  server.

### Optimistic value tracking

The hook returns `{value, serverValue, set, input}`. `value` is
**optimistic-aware** — latest local-set value if writes are
queued/in-flight for the cell, otherwise the server-authoritative
value from props.

Mechanism:

- `incrementPending(id, value)` sets `latestSentByCell[id] = value`
  AND bumps `cellVersion[id]`.
- `decrementPending(id)` checks if it's the last pending write for
  the id — if so, deletes `latestSentByCell[id]` AND bumps
  `cellVersion[id]`. Otherwise just decrements the count.
- `useCell` subscribes via `useSyncExternalStore` keyed on
  `cellVersion[id]`. The store re-renders the component only when
  THIS cell's version changes — other cells' activity doesn't
  trigger spurious renders.
- Inside the component body: `const value = latestSentByCell.has(id)
  ? latestSentByCell.get(id) : cell.value`. Computed fresh on each
  render against the current map state.

The "reconcile moment" is the render where the last pending write
drains and `latestSentByCell.delete(id)` fires: `value` flips from
the user's optimistic input to the server-authoritative shape
(which may differ if the server `write` normalised differently).

### `cell.input()` — the controlled-input binding

`useCell` allocates a `useRef<HTMLInputElement | null>(null)` and a
`useRef<number | null>(null)` for the pending caret position. A
`useLayoutEffect([value])` restores the caret after React commits:

```ts
useLayoutEffect(() => {
  if (pendingCaret.current == null || !inputRef.current) return
  const c = pendingCaret.current
  pendingCaret.current = null
  inputRef.current.setSelectionRange(c, c)
}, [value])
```

The `input(opts)` callback returns `{value, onChange, ref}`. Its
`onChange` reads `event.target.value` + `selectionStart`, runs
`opts.transform?(raw, caret)` (or identity), stashes the new caret
in `pendingCaret`, fires `set(transformed.value)`, then calls
`opts.onCommit?(transformed.value)` for cross-cell triggers.

## Nested-transaction batching

`runInvalidationTransaction` is **nestable** — when an enclosing tx
is already active, the inner call is a pass-through. App-level
multi-cell writes use this to batch correctly:

```ts
"use server"
import { runInvalidationTransaction } from "@parton/framework"

export async function commitCardForm({ name, number }) {
  await runInvalidationTransaction(async () => {
    await cardName.set(name)
    await cardNumber.set(number)
    await cardCvc.set(computeCvc(name, number))
  })
}
```

Each `cell.set` internally wraps in its own
`runInvalidationTransaction`; with nesting, those inner wrappers
join the outer tx. All three `refreshSelector("cell:...")` bumps
flush at the outer commit — the segment driver wakes once, one
segment ships carrying every affected cell. Without nesting each
`cell.set` would commit at its own boundary and the three writes
would arrive as three separate segments — visually out-of-step on
watching tabs.

The client-side batcher's `__cellWriteBatch` action body does the
same thing implicitly: every entry in the batch participates in
one outer `runInvalidationTransaction`.

## Storage

Pluggable via `setCellStorage(backend)`; default is
`JsonFileCellStorage` at `<CMS_DATA_DIR or cms/data>/cells.json`.

```ts
export interface CellStorage {
  read(scope, cellId, partitionKey): unknown
  write(scope, cellId, partitionKey, value): void
  clear(scope?: string | "all"): void
  flush?(): Promise<void>
}
```

Reads are **sync** — `parton.schema` resolution happens
synchronously inside the render path. Writes are sync at the API
boundary; durability is a property of the adapter (in-memory
adapters are instant; `JsonFileCellStorage` debounces to disk).

### Scope bucketing

```
scopes: Map<scope, Map<cellId, Map<partitionKey, value>>>
```

Per-scope storage isolates parallel Playwright workers (each scoped
via `x-test-scope` header — see
[`testing.md`](./testing.md)) so test state doesn't leak across
workers and so production state doesn't leak into test runs. Only
the **default** scope persists to disk. Test scopes stay in memory
and disappear when the process exits.

### Disk shape

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

Top-level keys = cell ids. Inner keys =
`hash(stableStringify(cell.vary(scope)))` — so `vary: () => ({})`
collapses to one constant partition slot.

### Debounced flush

Writes go to memory immediately and schedule a flush ~100 ms later.
Rapid-fire writes (the streaming-demo's per-second tick, an
autosave-on-keystroke form) coalesce into one file write per
window. On process exit a sync flush attempt drains the pending
write — best-effort; if the process is killed harder, the most
recent few writes can be lost. Cells aren't the right primitive
for durability-critical state.

### Atomic writes

Temp-file + rename, same as `cms-storage.ts::JsonFileStorage`.

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

Drivers that need async reads (Redis, KV) ship a sync-ish wrapper
or a warm-cache step the runtime awaits at request entry — same
shape `cms-storage.ts` already uses.

## Debug hooks

### `_setCellWriteDelaySimulator(fn)`

Server-side debug-only hook in
`framework/src/runtime/cell-write-delay.ts`. Lets a demo install a
per-batch latency simulator:

```ts
import { _setCellWriteDelaySimulator } from "@parton/framework"

_setCellWriteDelaySimulator(() => {
  // Trimodal: ~fast / typing-speed / slower-than-typing
  const r = Math.random()
  if (r < 1 / 3) return Math.random() * 30
  if (r < 2 / 3) return 100 + Math.random() * 100
  return 400 + Math.random() * 100
})
```

`__cellWriteBatch` reads this every batch via `_getCellWriteDelay()`
and awaits the returned milliseconds before processing the batch.
Production code leaves the simulator `null`. Lives in its own
module (not the `"use server"` cell-actions one) so the setter can
be a regular sync export.

## Cell registry (module-scope state)

`framework/src/lib/cell.ts`. Module-scope `Map<id, Cell<unknown>>`
populated by `cell.<shape>({id, ...})` at module-init time. HMR
overwrites in place; the storage layer keys by id, so values from
the prior registration are unaffected.

`__cellWrite` / `__cellWriteBatch` look up cells by id from this
registry. An unknown id throws — defends against client requests
for cells whose modules haven't loaded yet on the current process.

## Related

- [`../reference/cells.md`](../reference/cells.md) — user-facing
  surface (construction, options, schema reads, `useCell`,
  controlled-input discipline, examples).
- [`./render-pipeline.md`](./render-pipeline.md) — how fp folds
  in schema-resolved cell labels.
- [`./testing.md`](./testing.md) — `x-test-scope` header and
  per-worker storage isolation.
