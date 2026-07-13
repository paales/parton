/**
 * Cell write pipeline — the shared implementation behind every cell
 * mutation. Lives outside `cell-actions.ts` because that module is
 * `"use server"` (its exports must all be async server references) and
 * the pipeline has SYNCHRONOUS entry points that are load-bearing:
 *
 *   - `writeOneCell` — validate → canonicalise → storage → deferred
 *     tally → partition-scoped invalidation. The tail of every `set`.
 *   - `updateOneCell` — reducer-form write: read the current stored
 *     value, apply `updater(current) => next`, then run the SAME
 *     `writeOneCell` tail on the result.
 *
 * ── The serialization invariant ──────────────────────────────────────
 * Cell writes serialize on the event loop: storage reads/writes are
 * sync (`CellStorage.read/write`), and this module keeps every
 * read→updater→write section synchronous — no `await` between the read
 * of `current` and the write of `next`, so no concurrent write can
 * interleave into the gap. That is the whole in-process concurrency
 * story: two overlapping `update` calls on the same (cell, partition)
 * compose (both increments land) because each one's critical section
 * runs to completion within one tick. There is no separate lock to
 * acquire — adding an `await` inside `updateOneCell` (or inside
 * `writeOneCell` before the storage write) is what would break it.
 *
 * Cross-process writers sit OUTSIDE the event loop's protection. On a
 * versioned storage adapter (`readVersioned`/`writeIfVersion` — the
 * SQLite tier) `updateOneCell` runs the same synchronous section as a
 * store-level compare-and-swap (`cell-cas.ts`): a conflict — possible
 * only when another PROCESS committed between the read and the write —
 * re-reads and recomputes, so updates compose across processes too.
 * Adapters without the versioned methods (memory, JSON file, the
 * `atomic()` overlay view) keep the plain zero-overhead path.
 *
 * ── Publish-after-commit ─────────────────────────────────────────────
 * Every mutation commits its value to storage BEFORE its invalidation
 * bump publishes: `writeOneCell` runs `storage.write` and only then
 * `reload({selector})`, and under `atomic()` the overlay flushes every
 * buffered value to real storage before the transaction's `commitOne`
 * fan-out fires (see `atomic` in lib/cell.ts). With a synchronous-
 * commit shared store (the SQLite adapter) that ordering is the
 * federation arc's consistency contract: a bump is a doorbell, never a
 * payload — any subscriber it wakes re-reads the store and finds the
 * committed row, in this process or another. Reordering these two
 * steps (or making the storage write async-lagging, as a debounced
 * whole-file flush is across processes) is what would break it.
 */

import {
  cellStorageForArgs,
  CellWriteDenied,
  getCellById,
  type CellArgs,
  type CellInterface,
  type CellPartitionScope,
} from "../lib/cell.ts"
import { casUpdateRow, type VersionedCellStore } from "./cell-cas.ts"
import { hash } from "../lib/hash.ts"
import { stableStringify } from "../lib/stable-stringify.ts"
import { getRegisteredMatchPatterns } from "../lib/partial.tsx"
import { buildTimeScope } from "../lib/time.ts"
import { createSessionReadSurface } from "./session.ts"
import { getCellStorage, type CellStorage } from "./cell-storage.ts"
import { _recordCellWrite, getRequest, getScope, parseCookies } from "./context.ts"
import { _setInvalidationTsBridge, buildCellSelector } from "./invalidation-registry.ts"
import { getServerNavigation } from "./server-navigation.ts"

// ─── The registry ↔ cell-storage ts bridge ────────────────────────────
//
// The invalidation registry persists `cell:` entry timestamps with the
// stored rows (stamp at bump commit) and restores evicted / restarted
// entries from them (re-seed on query miss) — see the eviction/restore
// contract in invalidation-registry.ts. This module supplies the
// address translation: selector name → cell id, canonical constraints
// key → storage partition key. The two encodings agree by
// construction: a write's selector is `buildCellSelector(id, args)`,
// whose parsed constraints round-trip the partition args losslessly
// under `stableStringify`, so `hash(constraintsKey)` IS the row's
// partition key (`hash(stableStringify(args))`). Args outside the
// selector-codable value space (undefined members, Dates, …) produce
// diverging keys — those rows simply stay ts-unknown (unbacked:
// never evicted, cold re-record after restart).
//
// Only the DEFAULT persistent tier participates (`cell.storage ===
// getCellStorage`): ephemeral rows die with their connection, and a
// custom per-cell adapter's lifetime is the app's business. Adapters
// without the optional ts methods degrade the same way — unbacked.

const CELL_NAME_PREFIX_LEN = "cell:".length
const cellIdByName = new Map<string, string>()

function bridgeStorageFor(name: string): CellStorage | null {
  let cellId = cellIdByName.get(name)
  if (cellId === undefined) {
    cellId = name.slice(CELL_NAME_PREFIX_LEN)
    cellIdByName.set(name, cellId)
  }
  const cell = getCellById(cellId)
  if (!cell || cell.storage !== getCellStorage) return null
  return getCellStorage()
}

/** `hash(constraintsKey)` memo — probe keys recur every fold; the
 *  bounded cap just guards pathological key churn. */
const partitionKeyByConstraintsKey = new Map<string, string>()
const PARTITION_KEY_MEMO_MAX = 8192

function partitionKeyOf(constraintsKey: string): string {
  let pk = partitionKeyByConstraintsKey.get(constraintsKey)
  if (pk === undefined) {
    if (partitionKeyByConstraintsKey.size >= PARTITION_KEY_MEMO_MAX) {
      partitionKeyByConstraintsKey.clear()
    }
    pk = hash(constraintsKey)
    partitionKeyByConstraintsKey.set(constraintsKey, pk)
  }
  return pk
}

_setInvalidationTsBridge({
  hasAny(name) {
    const storage = bridgeStorageFor(name)
    if (!storage) return false
    return storage.hasTs?.(getScope(), cellIdByName.get(name)!) ?? false
  },
  readTs(name, constraintsKey) {
    const storage = bridgeStorageFor(name)
    if (!storage) return undefined
    return storage.readTs?.(getScope(), cellIdByName.get(name)!, partitionKeyOf(constraintsKey))
  },
  stamp(name, constraintsKey, ts) {
    const storage = bridgeStorageFor(name)
    if (!storage) return
    storage.stampTs?.(getScope(), cellIdByName.get(name)!, partitionKeyOf(constraintsKey), ts)
  },
})

function searchParamsToRecord(sp: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of sp) out[k] = v
  return out
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of h) out[k.toLowerCase()] = v
  return out
}

/**
 * Walk every registered URLPattern, exec against `url`, merge each
 * matching pattern's named param groups. Last-wins on key collision.
 * Same idea as `extractNamedParams` in partial.tsx — but here we
 * don't know which spec's pattern to use (action context, no
 * parton render bound), so we union across all matches.
 */
function deriveParamsForActionRequest(url: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pattern of getRegisteredMatchPatterns()) {
    const result = pattern.exec(url)
    if (!result) continue
    const groups = { ...result.pathname.groups, ...result.search.groups }
    for (const [k, v] of Object.entries(groups)) {
      if (typeof v !== "string") continue
      if (/^\d+$/.test(k)) continue
      out[k] = v
    }
  }
  return out
}

/** Build a `CellPartitionScope` from the current request context. Used
 *  by the write/update paths when no explicit partition override was
 *  supplied — a cell's `partition` callback re-runs against the
 *  CALLER's request, so a per-session cell resolves at the caller's
 *  partition in an action too. */
export function buildCellPartitionScope(): CellPartitionScope {
  const request = getRequest()
  const url = new URL(request.url)
  return {
    url,
    pathname: url.pathname,
    search: searchParamsToRecord(url.searchParams),
    cookies: parseCookies(request),
    headers: headersToRecord(request.headers),
    params: deriveParamsForActionRequest(request.url),
    session: createSessionReadSurface(),
    time: buildTimeScope(),
  }
}

/**
 * Write authorization — the guard gate every mutation passes through
 * before its value can commit. A cell's `writeGuard` (declared on the
 * cell definition) runs against the CALLER's request scope — the same
 * `CellPartitionScope` its `partition` callback sees, so session /
 * cookies / headers are in and the rendering read-set is untouched —
 * plus the write's resolved partition args, so a guard can pin a
 * partitioned cell to its owner (`({session}, args) => args.sid ===
 * session.id`). Deny throws `CellWriteDenied` BEFORE the storage
 * write: nothing commits, no bump fires, and inside `atomic()` the
 * throw rolls the whole batch back. The guard is sync by design — it
 * sits inside the synchronous pre-commit section the serialization
 * invariant protects (module header). No guard ⇒ writable by any
 * caller that can name the cell id.
 */
function assertCellWritable(cell: CellInterface<unknown>, args: CellArgs): void {
  if (!cell.writeGuard) return
  if (!cell.writeGuard(buildCellPartitionScope(), args)) throw new CellWriteDenied(cell.id)
}

/** Shared write implementation. Caller is responsible for wrapping in
 *  a `runInvalidationTransaction` so the resulting `refreshSelector`
 *  bumps participate in atomic commit/rollback.
 *
 *  Pipeline per write: validate (throws on shape mismatch) → write
 *  (server's final-say canonicalisation; opt-in via the cell's
 *  `write` option) → storage → `refreshSelector` (partition-scoped).
 *  Both validate and write run inside the transaction, so a throw
 *  rolls back the whole batch.
 *
 *  Selector emission is partition-scoped: if args are available (via
 *  `partitionOverride.partition` or `cell.partition(scope)`), the emitted
 *  selector carries them as constraints (`cell:<id>?key=value`).
 *  Only partons whose effective constraint surface includes the same
 *  args match — other placements of the same cell at different
 *  partitions don't refetch. */
export function writeOneCell(
  cellId: string,
  value: unknown,
  partitionOverride: { partition?: Record<string, unknown> } | undefined,
): void {
  const cell = getCellById(cellId)
  if (!cell) throw new Error(`cell-write: unknown cell id "${cellId}"`)
  const validated = cell.validate(value)
  const stored = cell.write ? cell.write(validated) : validated
  let args: Record<string, unknown>
  if (partitionOverride?.partition) {
    args = partitionOverride.partition
  } else if (cell.keyOf) {
    // Value-keyed cell (fragment cells): the partition lives in the
    // value itself. `cell.set(value)` routes to `keyOf(value)`'s
    // partition without the caller restating the identity in `.with()`.
    args = cell.keyOf(stored)
  } else {
    const scope = buildCellPartitionScope()
    args = cell.partition(scope)
  }
  assertCellWritable(cell, args)
  const partitionKey = hash(stableStringify(args))
  // Storage commit first, bump second — the publish-after-commit
  // ordering (module header): the doorbell must never ring before the
  // value is readable from the store.
  cellStorageForArgs(cell, args).write(getScope(), cellId, partitionKey, stored)
  publishCellWrite(cell, args)
}

/** The publish half of every mutation — runs strictly AFTER the value
 *  landed in storage: tally the write for the deferred-commit decision
 *  (a write to a `deferred` cell lets the action response skip its
 *  re-render; the open streaming connection carries the value), then
 *  fire the partition-scoped invalidation bump. */
function publishCellWrite(cell: CellInterface<unknown>, args: Record<string, unknown>): void {
  _recordCellWrite(cell.deferred === true)
  getServerNavigation().reload({ selector: buildCellSelector(cell.id, args) })
}

/** Mirror of `resolveCellValue`'s warm-read coercion: a stored value
 *  that fails shape validation (stale disk state after a shape change)
 *  degrades to `defaultValue`; an absent/invalidated slot reads as
 *  `defaultValue` too (cold loaders are the caller's concern —
 *  `updateCell` warms the slot before entering the critical section). */
function coerceStored(cell: CellInterface<unknown>, raw: unknown): unknown {
  if (raw === undefined) return cell.defaultValue
  try {
    return cell.validate(raw)
  } catch {
    return cell.defaultValue
  }
}

function assertSyncUpdaterResult(cellId: string, next: unknown): void {
  if (typeof (next as PromiseLike<unknown> | null)?.then === "function") {
    throw new TypeError(
      `cell-update: cell "${cellId}": updater returned a thenable — updaters must be ` +
        `synchronous ((current) => next). An async updater would reopen the read→write ` +
        `gap the synchronous section closes, so concurrent updates could clobber again.`,
    )
  }
}

/**
 * Reducer-form write: read the current stored value at `args`, apply
 * `updater`, and commit the result through the full `writeOneCell`
 * tail — so an update shares set's ENTIRE downstream path (shape
 * validation of the result, `write` canonicalisation, storage,
 * deferred tally, partition-scoped `cell:<id>?<args>` bump, and —
 * via the caller's transaction — `atomic()` batching/rollback).
 *
 * The whole read→updater→write section is synchronous — see the
 * serialization invariant in the module header. Concurrent `update`
 * calls on the same (cell, partition) therefore COMPOSE instead of
 * clobbering, which is the reason to reach for `update` over a
 * read-modify-write around `set`.
 *
 * The read mirrors the warm branch of `resolveCellValue`: a stored
 * value that fails shape validation (stale disk state after a shape
 * change) degrades to `defaultValue`. Cold loaders are the CALLER's
 * concern (`updateCell` in lib/cell.ts warms the slot before entering
 * this section) — a loader is async and cannot live inside the
 * synchronous critical section.
 *
 * On a VERSIONED adapter the same section runs as a store-level
 * compare-and-swap (`casUpdateRow`) so cross-process writers compose
 * too; the retry branch only executes when the store reports a version
 * conflict, which an in-process writer cannot produce (the section is
 * synchronous), so single-process cost is one versioned read + one
 * conditional write — still zero awaits. The `atomic()` overlay view
 * deliberately exposes no versioned methods: inside a transaction the
 * update composes over the buffered batch instead (in-process
 * semantics), and the batch's cross-process story is last-writer-wins
 * per key, per the consistency contract.
 */
export function updateOneCell(
  cell: CellInterface<unknown>,
  args: CellArgs,
  updater: (current: unknown) => unknown,
): void {
  const partitionKey = hash(stableStringify(args))
  const storage = cellStorageForArgs(cell, args)
  const scope = getScope()
  if (storage.readVersioned && storage.writeIfVersion) {
    // The CAS path commits inside `casUpdateRow`, bypassing
    // `writeOneCell` — authorize before it can.
    assertCellWritable(cell, args)
    casUpdateRow(storage as VersionedCellStore, scope, cell.id, partitionKey, (rawStored) => {
      const current = coerceStored(cell, rawStored)
      const next = updater(current)
      assertSyncUpdaterResult(cell.id, next)
      const validated = cell.validate(next)
      return cell.write ? cell.write(validated) : validated
    })
    // The CAS committed the canonical value — publish-after-commit's
    // publish half only.
    publishCellWrite(cell, args)
    return
  }
  const raw = storage.read(scope, cell.id, partitionKey)
  const current = coerceStored(cell, raw)
  const next = updater(current)
  assertSyncUpdaterResult(cell.id, next)
  writeOneCell(cell.id, next, { partition: args })
}
