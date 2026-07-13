/**
 * Cell storage backend.
 *
 * Mirrors the CMS storage pattern (`cms-storage.ts`) — pluggable
 * interface, JSON-file default, atomic writes (temp + rename). The
 * runtime calls `read()` synchronously from inside `parton`'s render
 * path, so the canonical read is sync against an in-memory map; the
 * file is the persistence layer that survives HMR + dev restarts.
 *
 * ── Scope bucketing ─────────────────────────────────────────────────
 * Per-scope storage isolates parallel Playwright workers (each scoped
 * via `x-test-scope`) so test state doesn't leak across workers and
 * so production state doesn't leak into test runs. Layout:
 *
 *   scopes: Map<scope, Map<cellId, Map<partitionKey, value>>>
 *
 * Only the **default** scope persists to disk. Test scopes stay in
 * memory and disappear when the process exits (or the test suite
 * fires `/__test/clear-caches`). Production never sees a non-default
 * scope.
 *
 * ── Debounced flush ─────────────────────────────────────────────────
 * Writes go to memory immediately and schedule a flush for ~100ms
 * later. Rapid-fire writes (the streaming-demo's per-second tick,
 * an autosave-on-keystroke form) coalesce into one disk write per
 * window. On process exit a sync flush attempt drains the pending
 * write — best-effort; if the process is killed harder, the most
 * recent few writes can be lost, but cells are not the right
 * primitive for durability-critical state.
 */

import {
  existsSync,
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
} from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { _raiseInvalidationTsFloor } from "./invalidation-registry.ts"
import { _getRequestEphemeralStorage } from "./context.ts"

export type CellPartitionKey = string

/**
 * Pluggable storage interface. Reads are sync — `parton.schema`
 * resolution happens synchronously inside the render path. Writes
 * are sync at the API boundary; durability is a property of the
 * adapter (in-memory adapters are instant; JsonFileCellStorage debounces).
 *
 * Per-scope methods take the active request scope (`getScope()`).
 * Adapters that span scopes (e.g. a Redis driver with a `parton:`
 * key prefix) compose the key as `<scope>:<cellId>:<partitionKey>`.
 */
export interface CellStorage {
  /** Read a single cell value. Returns `undefined` on miss; the cell
   *  runtime substitutes `cell.defaultValue` in that case. */
  read(scope: string, cellId: string, partitionKey: CellPartitionKey): unknown
  /** Write a single cell value. Synchronous from the caller's POV;
   *  persistence may be deferred (JsonFileCellStorage debounces). */
  write(scope: string, cellId: string, partitionKey: CellPartitionKey, value: unknown): void
  /** Wipe stored values. No-arg / "all" → every scope. Otherwise the
   *  named scope only. */
  clear(scope?: string | "all"): void
  /** Force any pending in-memory writes to durable storage. No-op
   *  for in-memory adapters. */
  flush?(): Promise<void>

  // ── Invalidation-timestamp persistence (optional) ──────────────────
  // The invalidation registry's entries (one bump `ts` per
  // (name, constraints) pair) are process memory; persisting the ts
  // WITH the row is what makes a hot registry entry a cache over
  // storage — evictable and restorable without a returning watcher's
  // fp fold ever matching stale cache. Adapters that omit these
  // methods still work: their rows are ts-unknown, so the registry
  // treats them as unbacked (never evicted, cold re-record after a
  // restart — over-fetch, never stale).

  /** The persisted invalidation ts for a row, `undefined` when the row
   *  is absent or was last stamped by a pre-ts version / a loader seed. */
  readTs?(scope: string, cellId: string, partitionKey: CellPartitionKey): number | undefined
  /** Stamp the committed invalidation ts onto an EXISTING row. Called
   *  by the registry at bump commit time (after the value write landed),
   *  so the row's ts always equals the registry entry that covers it.
   *  MUST no-op when neither a value slot nor a prior ts exists at the
   *  partition — a stamp never mints a phantom row. */
  stampTs?(scope: string, cellId: string, partitionKey: CellPartitionKey, ts: number): void
  /** Whether ANY row of `cellId` carries a persisted ts in `scope` —
   *  the restore path's cheap negative guard (a cell that was never
   *  stamped skips per-partition probing entirely). */
  hasTs?(scope: string, cellId: string): boolean
  /** The maximum persisted ts across all rows — consumed once when the
   *  adapter becomes the persistent singleton, to seat the registry's
   *  monotonic counter ABOVE the persisted history (restored
   *  timestamps must never surface inside a live connection's
   *  catch-up window). */
  maxTs?(): number

  // ── Versioned writes (optional — the store-level CAS) ───────────────
  // A store shared by MULTIPLE processes (the SQLite adapter) exposes a
  // per-row write counter it owns, and the update pipeline
  // (`updateOneCell` in cell-write.ts) turns `cell.update(fn)` into a
  // compare-and-retry against it: read the row + version, apply the
  // updater, commit only if the version is unchanged, re-read and
  // retry on conflict. In-process the event loop already serializes
  // the synchronous read→updater→write section, so a conflict can only
  // come from another process — adapters without these methods (the
  // in-memory tiers, the JSON file) keep the plain zero-overhead path.

  /** Atomically read a row's value and its store-owned write counter.
   *  `undefined` when the row is absent (callers treat that as
   *  version 0 for `writeIfVersion`). */
  readVersioned?(
    scope: string,
    cellId: string,
    partitionKey: CellPartitionKey,
  ): { value: unknown; version: number } | undefined
  /** Commit `value` only if the row's version still equals
   *  `expectedVersion` (0 = "row must not exist yet"); returns whether
   *  the write landed. On success the store bumps the version; any
   *  prior ts is preserved (a CAS is a value write). */
  writeIfVersion?(
    scope: string,
    cellId: string,
    partitionKey: CellPartitionKey,
    value: unknown,
    expectedVersion: number,
  ): boolean
}

// ─── In-memory adapter ────────────────────────────────────────────────

/**
 * Memory-only adapter. No persistence. Used directly in tests and as
 * the per-scope bucket for `JsonFileCellStorage`'s non-default scopes.
 */
export class MemoryCellStorage implements CellStorage {
  #scopes = new Map<string, Map<string, Map<string, unknown>>>()
  /** Invalidation ts per row, parallel to `#scopes` so the value read
   *  path stays a bare map chain (no envelope unwrap on the render
   *  hot path). A row missing here is ts-unknown (unbacked). */
  #ts = new Map<string, Map<string, Map<string, number>>>()

  read(scope: string, cellId: string, partitionKey: string): unknown {
    return this.#scopes.get(scope)?.get(cellId)?.get(partitionKey)
  }

  write(scope: string, cellId: string, partitionKey: string, value: unknown): void {
    let cellMap = this.#scopes.get(scope)
    if (!cellMap) {
      cellMap = new Map()
      this.#scopes.set(scope, cellMap)
    }
    let partMap = cellMap.get(cellId)
    if (!partMap) {
      partMap = new Map()
      cellMap.set(cellId, partMap)
    }
    // A prior ts (if any) is preserved: a value write without a stamp
    // (loader seed over a cold slot, `hydrate`, the atomic overlay
    // flush ahead of its commit) leaves the invalidation history
    // where it was; only `stampTs` — driven by a committed bump —
    // moves it.
    partMap.set(partitionKey, value)
  }

  clear(scope?: string | "all"): void {
    if (scope === undefined || scope === "all") {
      this.#scopes.clear()
      this.#ts.clear()
      return
    }
    this.#scopes.delete(scope)
    this.#ts.delete(scope)
  }

  readTs(scope: string, cellId: string, partitionKey: string): number | undefined {
    return this.#ts.get(scope)?.get(cellId)?.get(partitionKey)
  }

  stampTs(scope: string, cellId: string, partitionKey: string, ts: number): void {
    let tsCellMap = this.#ts.get(scope)?.get(cellId)
    // Never mint a phantom row: stamp only where a value slot exists
    // (including an `invalidate()`d slot holding `undefined`) or a
    // prior ts survives (an invalidate-only row reloaded from disk,
    // whose undefined value slot JSON dropped).
    if (!tsCellMap?.has(partitionKey)) {
      const hasValueSlot = this.#scopes.get(scope)?.get(cellId)?.has(partitionKey) ?? false
      if (!hasValueSlot) return
    }
    if (!tsCellMap) {
      let perScope = this.#ts.get(scope)
      if (!perScope) {
        perScope = new Map()
        this.#ts.set(scope, perScope)
      }
      tsCellMap = new Map()
      perScope.set(cellId, tsCellMap)
    }
    tsCellMap.set(partitionKey, ts)
  }

  hasTs(scope: string, cellId: string): boolean {
    const tsCellMap = this.#ts.get(scope)?.get(cellId)
    return tsCellMap !== undefined && tsCellMap.size > 0
  }

  maxTs(): number {
    let max = 0
    for (const perScope of this.#ts.values()) {
      for (const tsCellMap of perScope.values()) {
        for (const ts of tsCellMap.values()) if (ts > max) max = ts
      }
    }
    return max
  }

  /** Internal — snapshot the default scope for disk serialization. */
  _snapshot(scope: string): {
    cells: Record<string, Record<string, unknown>>
    ts: Record<string, Record<string, number>>
  } | null {
    const cellMap = this.#scopes.get(scope)
    const tsMap = this.#ts.get(scope)
    if ((!cellMap || cellMap.size === 0) && (!tsMap || tsMap.size === 0)) return null
    const cells: Record<string, Record<string, unknown>> = {}
    for (const [cellId, partMap] of cellMap ?? []) {
      const partRec: Record<string, unknown> = {}
      for (const [partKey, value] of partMap) partRec[partKey] = value
      cells[cellId] = partRec
    }
    const ts: Record<string, Record<string, number>> = {}
    for (const [cellId, partTs] of tsMap ?? []) {
      const partRec: Record<string, number> = {}
      for (const [partKey, t] of partTs) partRec[partKey] = t
      ts[cellId] = partRec
    }
    return { cells, ts }
  }

  /** Internal — seed from a disk snapshot. Omitted `ts` (legacy files)
   *  hydrates every row as ts-unknown. */
  _hydrate(
    scope: string,
    snapshot: Record<string, Record<string, unknown>>,
    tsSnapshot?: Record<string, Record<string, number>>,
  ): void {
    const cellMap = new Map<string, Map<string, unknown>>()
    for (const [cellId, partRec] of Object.entries(snapshot)) {
      const partMap = new Map<string, unknown>()
      for (const [partKey, value] of Object.entries(partRec)) partMap.set(partKey, value)
      cellMap.set(cellId, partMap)
    }
    this.#scopes.set(scope, cellMap)
    if (tsSnapshot) {
      const tsCellMap = new Map<string, Map<string, number>>()
      for (const [cellId, partRec] of Object.entries(tsSnapshot)) {
        const partMap = new Map<string, number>()
        for (const [partKey, t] of Object.entries(partRec)) {
          if (typeof t === "number") partMap.set(partKey, t)
        }
        tsCellMap.set(cellId, partMap)
      }
      this.#ts.set(scope, tsCellMap)
    }
  }
}

// ─── JSON-file adapter ────────────────────────────────────────────────

const DEFAULT_SCOPE = "default"
const FLUSH_DEBOUNCE_MS = 100

/** Disk-format version marker. Its presence as a top-level key
 *  distinguishes the enveloped shape from a legacy file whose top
 *  level is the bare cells record. Reserved — not a valid cell id. */
const DISK_FORMAT_KEY = "__parton"
const DISK_FORMAT_VERSION = 2

interface CellsDiskFileV2 {
  [DISK_FORMAT_KEY]: number
  cells: Record<string, Record<string, unknown>>
  ts: Record<string, Record<string, number>>
}

/**
 * JSON file storage. The default scope writes through to disk;
 * non-default scopes (Playwright workers) stay in memory only so
 * test runs don't pollute the on-disk store.
 *
 * Disk shape (v2 — the `__parton` key marks the envelope):
 *
 *   {
 *     "__parton": 2,
 *     "cells": { "<cellId>": { "<partitionKeyHash>": <jsonValue> } },
 *     "ts":    { "<cellId>": { "<partitionKeyHash>": <invalidationTs> } }
 *   }
 *
 * A legacy file (bare `{ "<cellId>": {…} }`, no `__parton` key) loads
 * with every row ts-unknown; the first committed bump per row stamps
 * it forward into the v2 shape.
 *
 * Loaded eagerly on first instantiation via `loadSync` so the first
 * request can read its cells without an async warm-up step.
 */
export class JsonFileCellStorage implements CellStorage {
  readonly path: string
  readonly #memory = new MemoryCellStorage()
  #flushTimer: ReturnType<typeof setTimeout> | null = null
  #pending = false
  #writing = false

  constructor(path: string) {
    this.path = path
    this.#loadSync()
    // Best-effort flush on process exit so the last debounced write
    // doesn't get lost on a clean shutdown. Won't run on SIGKILL.
    const flushOnExit = () => this.#flushSync()
    process.once("exit", flushOnExit)
    process.once("SIGINT", () => {
      flushOnExit()
      process.exit(130)
    })
    process.once("SIGTERM", () => {
      flushOnExit()
      process.exit(143)
    })
  }

  read(scope: string, cellId: string, partitionKey: string): unknown {
    return this.#memory.read(scope, cellId, partitionKey)
  }

  write(scope: string, cellId: string, partitionKey: string, value: unknown): void {
    this.#memory.write(scope, cellId, partitionKey, value)
    if (scope === DEFAULT_SCOPE) this.#scheduleFlush()
  }

  clear(scope?: string | "all"): void {
    this.#memory.clear(scope)
    if (scope === undefined || scope === "all" || scope === DEFAULT_SCOPE) {
      this.#scheduleFlush()
    }
  }

  readTs(scope: string, cellId: string, partitionKey: string): number | undefined {
    return this.#memory.readTs(scope, cellId, partitionKey)
  }

  stampTs(scope: string, cellId: string, partitionKey: string, ts: number): void {
    this.#memory.stampTs(scope, cellId, partitionKey, ts)
    if (scope === DEFAULT_SCOPE) this.#scheduleFlush()
  }

  hasTs(scope: string, cellId: string): boolean {
    return this.#memory.hasTs(scope, cellId)
  }

  maxTs(): number {
    return this.#memory.maxTs()
  }

  async flush(): Promise<void> {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer)
      this.#flushTimer = null
    }
    this.#pending = false
    await this.#writeAtomic()
  }

  // ─── Internals ────────────────────────────────────────────────────

  #loadSync(): void {
    if (!existsSync(this.path)) return
    try {
      const text = fsReadFileSync(this.path, "utf8")
      const parsed = JSON.parse(text) as Record<string, unknown>
      if (parsed && typeof parsed === "object" && DISK_FORMAT_KEY in parsed) {
        const file = parsed as unknown as CellsDiskFileV2
        this.#memory._hydrate(DEFAULT_SCOPE, file.cells ?? {}, file.ts ?? {})
      } else {
        // Legacy bare-cells file — every row hydrates ts-unknown
        // (unbacked: never evicted, cold re-record after restart).
        this.#memory._hydrate(DEFAULT_SCOPE, parsed as Record<string, Record<string, unknown>>)
      }
    } catch {
      // Malformed file — treat as empty. Author can delete or fix.
    }
  }

  #serialize(): string {
    const snapshot = this.#memory._snapshot(DEFAULT_SCOPE)
    const file: CellsDiskFileV2 = {
      [DISK_FORMAT_KEY]: DISK_FORMAT_VERSION,
      cells: snapshot?.cells ?? {},
      ts: snapshot?.ts ?? {},
    }
    return JSON.stringify(file, null, 2) + "\n"
  }

  #scheduleFlush(): void {
    this.#pending = true
    if (this.#flushTimer) return
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null
      if (!this.#pending) return
      void this.#writeAtomic()
    }, FLUSH_DEBOUNCE_MS)
  }

  async #writeAtomic(): Promise<void> {
    if (this.#writing) {
      // Reschedule — another write is in flight; the next tick will
      // pick up the merged state.
      this.#pending = true
      this.#scheduleFlush()
      return
    }
    this.#writing = true
    this.#pending = false
    try {
      const text = this.#serialize()
      await mkdir(dirname(this.path), { recursive: true })
      const rand = Math.random().toString(36).slice(2, 10)
      const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}-${rand}`
      await writeFile(tmp, text, "utf8")
      await rename(tmp, this.path)
    } finally {
      this.#writing = false
      // If a write came in while we were flushing, schedule another.
      if (this.#pending) this.#scheduleFlush()
    }
  }

  /** Synchronous flush for process-exit hooks. Best-effort — sync IO
   *  inside a Node exit handler. Skips if nothing pending. */
  #flushSync(): void {
    if (!this.#pending) return
    this.#pending = false
    try {
      fsWriteFileSync(this.path, this.#serialize(), "utf8")
    } catch {
      // Best-effort.
    }
  }
}

// ─── Resolver + singleton ─────────────────────────────────────────────

/**
 * Resolve the default cells data file path.
 *
 *   1. `process.env.CELLS_DATA_PATH` if set — absolute or cwd-relative.
 *   2. `<CMS_DATA_DIR or cms/data>/cells.json` (sits next to
 *      content.json / draft.json).
 */
export function defaultCellsPath(): string {
  const env = process.env.CELLS_DATA_PATH
  if (env) return resolve(env)
  const dir = process.env.CMS_DATA_DIR
    ? resolve(process.env.CMS_DATA_DIR)
    : resolve(process.cwd(), "cms/data")
  return resolve(dir, "cells.json")
}

let _instance: CellStorage | null = null

/**
 * The PERSISTENT cell storage singleton. Backs `localCell`. By
 * default a `JsonFileCellStorage` that writes to disk at
 * `cms/data/cells.json` (or `$CELLS_DATA_PATH`). Survives process
 * restart.
 *
 * The JSON file is the DEV default — whole-snapshot, debounced,
 * single-process. Deployments that need durable acknowledged writes
 * or multiple processes swap in the per-key SQLite adapter through
 * this same seam: `setCellStorage(new SqliteCellStorage(path))` from
 * `./cell-storage-sqlite.ts` (deep import — the adapter carries a
 * native module and stays out of the barrel). Choice matrix:
 * docs/internals/cell-internals.md § The adapter matrix.
 */
export function getCellStorage(): CellStorage {
  if (!_instance) {
    _instance = new JsonFileCellStorage(defaultCellsPath())
    // Seat the invalidation registry's monotonic counter ABOVE the
    // persisted history: restored row timestamps must compare as PAST
    // events (below every live connection's catch-up cursor), and new
    // bumps must supersede every restored one.
    _raiseInvalidationTsFloor(_instance.maxTs?.() ?? 0)
  }
  return _instance
}

/** Replace the persistent singleton storage. */
export function setCellStorage(backend: CellStorage): void {
  _instance = backend
  _raiseInvalidationTsFloor(backend.maxTs?.() ?? 0)
}

/** Reset to the default-resolved JsonFileCellStorage. Test cleanup helper. */
export function _resetCellStorage(): void {
  _instance = null
}

/**
 * Outside-request fallback for the ephemeral storage. Used only
 * when `_getRequestEphemeralStorage` returns `null` (test bootstrap
 * paths, framework-internal callers without a request scope). Each
 * fallback instance is a fresh `MemoryCellStorage` — there's no
 * shared global to leak between tests.
 *
 * NOT a singleton — calling this returns a brand-new instance every
 * time. Use only when there's truly no request context to attach to.
 * Production cell reads/writes ALWAYS run inside a request context,
 * so they ALWAYS get the per-request storage.
 */
function _newEphemeralFallback(): CellStorage {
  return new MemoryCellStorage()
}

/**
 * Look up the active connection's ephemeral cell storage. Backs
 * `gqlCell` and `fragmentCell` reads/writes for the lifetime of one
 * ALS request context — which in this framework is one HTTP
 * connection (a streaming heartbeat's segment loop shares one
 * context across all its segments). Discarded when the connection
 * closes.
 *
 * Cross-connection caching (when we eventually want it) is a
 * separate layer; this primitive intentionally lives only as long
 * as the connection that opened it.
 */
export function getEphemeralCellStorage(): CellStorage {
  const store = _getRequestEphemeralStorage(_newEphemeralFallback)
  // Outside-request fallback only used for tests/bootstrap; framework
  // call sites always have a request context.
  return store ?? _newEphemeralFallback()
}
