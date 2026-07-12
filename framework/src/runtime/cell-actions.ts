"use server"

/**
 * Cell-write server actions — the Flight-callable entry points over
 * the write pipeline in `cell-write.ts` (a `"use server"` module may
 * only export async server references, so the sync pipeline lives
 * next door and these wrappers stay thin).
 *
 * One generic action: `__cellWrite(cellId, value, partition?)`. Each
 * `CellInterface<T>` exposes `.set` as a `Function.prototype.bind`-bound
 * reference (`__cellWrite.bind(null, id)`), so author code calls
 * `palette.set("dark")` and the framework routes by the bound id.
 *
 * Resolution path (see `writeOneCell` in cell-write.ts):
 *
 *   1. Look up the cell by id in the cell registry. Unknown id →
 *      throw; the registry is populated as a side-effect of
 *      `cell.<shape>(...)` module-init.
 *   2. Validate the incoming value against the cell's shape (throws
 *      on mismatch — defends against malicious client writes).
 *   3. Resolve the partition key:
 *      - Explicit `partition` argument wins (used for cross-context
 *        mutations: action fired from /cart updating notes for a
 *        product not in the URL).
 *      - Otherwise run `cell.partition` against a `CellPartitionScope`
 *        built from the current request. `params` is populated from any
 *        registered URLPattern that matches the request URL — same
 *        derivation pass `partial.tsx` does for spec match.
 *   4. Write storage at `(getScope(), cellId, partitionKey)`.
 *   5. Fire `refreshSelector("cell:<id>?<args>")` inside a transaction
 *      — partition-scoped, only partons whose constraint surface
 *      includes matching args see fp shift on the next render. Args
 *      are URL-encoded as the query-string fragment; bare
 *      `cell:<id>` is emitted only when args are empty.
 *
 * There is no `__cellUpdate` action: an updater is a function, which
 * Flight cannot serialize client→server. `cell.update(updater)` is a
 * server-side surface (plain method on the handle / bound cell) —
 * clients reach it through app-level `"use server"` functions.
 */

import { writeOneCell } from "./cell-write.ts"
import { buildCellSelector, runInvalidationTransaction } from "./invalidation-registry.ts"
import { getServerNavigation } from "./server-navigation.ts"
import { _getCellWriteDelay } from "./cell-write-delay.ts"

/**
 * Internal cell-write entry point. Client code obtains a bound
 * reference to this action via `cell.<shape>(...).set` — the bound
 * function calls in here with the cellId already baked in.
 *
 * Wrapped in `runInvalidationTransaction` so a thrown validation
 * error (bad client payload) leaves the registry untouched.
 *
 * The write itself calls `getServerNavigation().reload({selector:
 * "cell:<id>"})` (see `writeOneCell`), which bumps the invalidation
 * registry inside the active transaction. Every parton whose schema
 * reads this cell (cells auto-stamp `cell:<id>` onto those partons'
 * labels) sees a new fingerprint and re-renders on the action's
 * response render.
 */
export async function __cellWrite(
  cellId: string,
  value: unknown,
  partitionOverride?: { partition?: Record<string, unknown> },
): Promise<void> {
  await runInvalidationTransaction(async () => {
    writeOneCell(cellId, value, partitionOverride)
  })
}

/**
 * Scoped cell-write entry point. Scoped cells (declared inside a
 * parton's `schema({cell})` callback) need partition baked at parton-
 * resolution time — their partition is the parton's vary output (or a
 * subset via the descriptor's `vary`), which isn't derivable from the
 * action's request scope alone.
 *
 * The resolved scoped cell's `set` field binds to this action as
 * `__scopedCellWrite.bind(null, cellId, partitionVary)` — both id and
 * partition are baked. Client invokes `(value)`; server receives
 * `(cellId, partitionVary, value)` and writes against the explicit
 * partition.
 *
 * Same transaction + validation semantics as `__cellWrite`.
 */
export async function __scopedCellWrite(
  cellId: string,
  partitionVary: Record<string, unknown>,
  value: unknown,
): Promise<void> {
  await runInvalidationTransaction(async () => {
    writeOneCell(cellId, value, { partition: partitionVary })
  })
}

/**
 * Batched cell-write entry point. Counterpart of `__cellWrite` for the
 * client-side microtask coalescer (`_cellSetBatched` in
 * `lib/cell-client.tsx`): instead of one POST per `cell.set` call, the
 * batcher accumulates writes within a tick and flushes them as a single
 * POST into here.
 *
 * Writes are processed sequentially in send-order — the framework does
 * not parallelise commits across cells. The whole batch lives inside
 * one `runInvalidationTransaction` so every affected `cell:<id>` bump
 * flushes together at outer commit; the segment driver wakes once and
 * one segment ships carrying every changed cell.
 *
 * On validation failure for ANY entry the whole batch rolls back —
 * the transaction discards its pending bumps and re-throws the error.
 * Mirrors the safety guarantee of single-write `__cellWrite`.
 */
export async function __cellWriteBatch(
  updates: ReadonlyArray<{
    id: string
    value: unknown
    partition?: { partition?: Record<string, unknown> }
  }>,
): Promise<void> {
  if (updates.length === 0) return
  const delay = _getCellWriteDelay()
  if (typeof delay === "number" && delay > 0) {
    await new Promise((r) => setTimeout(r, delay))
  }
  await runInvalidationTransaction(async () => {
    for (const u of updates) writeOneCell(u.id, u.value, u.partition)
  })
}

/**
 * Partition-scoped invalidate — fires the `cell:<id>?<args>` signal
 * WITHOUT writing storage. Used by `BoundCell.invalidate()` to force
 * matching placements to re-resolve (re-run the loader on next render
 * if storage is empty, or just refetch the parton's bytes if not).
 */
export async function __cellInvalidate(
  cellId: string,
  args: Record<string, unknown>,
): Promise<void> {
  await runInvalidationTransaction(async () => {
    getServerNavigation().reload({ selector: buildCellSelector(cellId, args) })
  })
}
