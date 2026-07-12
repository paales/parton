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
 */

import {
  cellStorageForArgs,
  getCellById,
  type CellArgs,
  type CellInterface,
  type CellPartitionScope,
} from "../lib/cell.ts"
import { hash } from "../lib/hash.ts"
import { stableStringify } from "../lib/stable-stringify.ts"
import { getRegisteredMatchPatterns } from "../lib/partial.tsx"
import { buildTimeScope } from "../lib/time.ts"
import { createSessionReadSurface } from "./session.ts"
import { _recordCellWrite, getRequest, getScope, parseCookies } from "./context.ts"
import { buildCellSelector } from "./invalidation-registry.ts"
import { getServerNavigation } from "./server-navigation.ts"

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
  const partitionKey = hash(stableStringify(args))
  cellStorageForArgs(cell, args).write(getScope(), cellId, partitionKey, stored)
  // Count the write for the deferred-commit decision. A write to a
  // `deferred` cell lets the action response skip its re-render — the
  // open streaming connection carries the new value instead.
  _recordCellWrite(cell.deferred === true)
  getServerNavigation().reload({ selector: buildCellSelector(cellId, args) })
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
 */
export function updateOneCell(
  cell: CellInterface<unknown>,
  args: CellArgs,
  updater: (current: unknown) => unknown,
): void {
  const partitionKey = hash(stableStringify(args))
  const storage = cellStorageForArgs(cell, args)
  const raw = storage.read(getScope(), cell.id, partitionKey)
  let current: unknown
  if (raw === undefined) {
    current = cell.defaultValue
  } else {
    try {
      current = cell.validate(raw)
    } catch {
      current = cell.defaultValue
    }
  }
  const next = updater(current)
  if (typeof (next as PromiseLike<unknown> | null)?.then === "function") {
    throw new TypeError(
      `cell-update: cell "${cell.id}": updater returned a thenable — updaters must be ` +
        `synchronous ((current) => next). An async updater would reopen the read→write ` +
        `gap the synchronous section closes, so concurrent updates could clobber again.`,
    )
  }
  writeOneCell(cell.id, next, { partition: args })
}
