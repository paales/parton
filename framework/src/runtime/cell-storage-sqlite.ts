/**
 * SQLite cell storage — the per-key persistent adapter.
 *
 * `JsonFileCellStorage` is a whole-snapshot debounced flush: the last
 * process to flush wins the entire file, and a SIGKILL inside the
 * debounce window drops the tail. This adapter is the multi-process /
 * durability answer behind the SAME `CellStorage` seam
 * (`setCellStorage(new SqliteCellStorage(path))` — opt-in, JSON stays
 * the dev default):
 *
 *   - **One row per (scope, cellId, partitionKey).** Writes touch only
 *     their row — two processes writing different keys never clobber
 *     each other, and same-key writes are ordered by SQLite's write
 *     lock (per-key write ordering comes from the store itself).
 *   - **Synchronous commits.** `write()` returns only after the row is
 *     committed to the WAL, so the write pipeline's
 *     publish-after-commit ordering (`cell-write.ts`: storage commit,
 *     THEN the invalidation bump) becomes a cross-process guarantee —
 *     any subscriber woken by the bump reads the committed row through
 *     its own handle.
 *   - **WAL mode, `synchronous=NORMAL`.** A committed write lives in
 *     the WAL file the moment `write()` returns: it survives SIGKILL
 *     (the OS keeps the written pages; the next open replays the WAL).
 *     `NORMAL` fsyncs only at checkpoints, so an OS-level crash /
 *     power loss can drop the un-checkpointed tail — the documented
 *     tradeoff; cells are not a financial ledger.
 *   - **Versioned rows (`readVersioned` / `writeIfVersion`).** Every
 *     row carries a write counter the store owns. The update pipeline
 *     uses it as a store-level compare-and-swap: `cell.update(fn)`
 *     re-reads and retries when ANOTHER PROCESS committed between its
 *     read and its write (in-process the event loop already serializes
 *     the sync section, so the retry branch is unreachable there).
 *   - **The invalidation ts rides the row** (`ts` column) — the full
 *     optional-ts contract: a value write preserves the prior ts,
 *     `stampTs` never mints a phantom row, `maxTs()` seats the
 *     registry counter on adoption.
 *
 * Scope bucketing mirrors `JsonFileCellStorage`: only the `default`
 * scope touches the database; non-default scopes (parallel Playwright
 * workers via `x-test-scope`) live in a process-local memory bucket
 * and die with the process, so test runs never pollute the store.
 * Harnesses that WANT scoped traffic on the database (the convergence
 * fuzzer runs every sequence in a fresh scope) opt in via
 * `{ persistScopes: "all" }` — isolation is unchanged (every lookup is
 * scope-keyed); only which tier holds the rows moves.
 *
 * The module is deliberately self-contained (node builtins +
 * better-sqlite3 + type-only imports) so plain `node` can load it —
 * the multi-process contention/durability tests spawn real child
 * processes against it. It is NOT exported from the framework barrel:
 * better-sqlite3 is a native module, and only apps that opt in should
 * carry it. Import via
 * `@parton/framework/runtime/cell-storage-sqlite.ts`.
 */

import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import Database from "better-sqlite3"
import type { CellStorage } from "./cell-storage.ts"

export type SqliteDatabase = import("better-sqlite3").Database

/** Mirrors the request context's default scope (`context.ts`). Kept
 *  local so the module stays loadable by plain `node` (no transitive
 *  JSX imports). */
const DEFAULT_SCOPE = "default"

/**
 * Open (or create) a parton SQLite database with the pragmas both
 * adapters rely on. Shared by `SqliteCellStorage` and
 * `SqliteSessionStore` — pass the same handle to both to keep one
 * file/WAL, or separate paths for separate lifecycles.
 */
export function openSqliteDatabase(path: string): SqliteDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  // WAL: readers never block the writer, writes append to the -wal
  // file (the SIGKILL-durability property documented above).
  db.pragma("journal_mode = WAL")
  // Commit = written to the WAL, fsync deferred to checkpoints.
  // Survives process death; an OS crash can lose the un-checkpointed
  // tail. FULL would fsync per commit — measure before wanting it.
  db.pragma("synchronous = NORMAL")
  // A concurrent writer (another process) holds the write lock only
  // per-statement; block rather than throw SQLITE_BUSY.
  db.pragma("busy_timeout = 5000")
  return db
}

/** A non-default-scope row in the process-local memory bucket. `value`
 *  may legitimately be `undefined` (an `invalidate()`d slot). */
interface MemRow {
  value: unknown
  ts?: number
  version: number
}

interface CellRow {
  value: string | null
  ts: number | null
  version: number
}

export interface SqliteCellStorageOpts {
  /** Which scopes persist to the database. `"default-only"` (the
   *  default) mirrors `JsonFileCellStorage` — test scopes stay in a
   *  process-local memory bucket. `"all"` routes every scope to the
   *  database (harness use — the convergence fuzzer). */
  persistScopes?: "default-only" | "all"
}

export class SqliteCellStorage implements CellStorage {
  readonly db: SqliteDatabase
  /** The path this instance opened, `null` when constructed over a
   *  shared handle (`close()` always closes `db`, shared or not). */
  readonly path: string | null

  #persistAllScopes: boolean

  /** Non-database scopes (test isolation — same posture as
   *  `JsonFileCellStorage`). */
  #mem = new Map<string, Map<string, Map<string, MemRow>>>()

  /** `hasTs` sits on the fp-fold hot path (the registry's restore
   *  guard runs it once per `cell:` label query). Cache POSITIVE
   *  results only: "some row of this cell carries a ts" is monotone
   *  under writes/stamps — in-process it can only flip false via
   *  `clear()` (which drops the cache), and another process can only
   *  ADD stamps. `false` is never cached, so a stamp committed by
   *  another process is observed on the next query. */
  #hasTsTrue = new Set<string>()

  #stRead
  #stReadVersioned
  #stWrite
  #stWriteIfAbsent
  #stWriteIfVersion
  #stStampTs
  #stReadTs
  #stHasTs
  #stMaxTs
  #stClearScope
  #stClearAll

  constructor(pathOrDb: string | SqliteDatabase, opts?: SqliteCellStorageOpts) {
    if (typeof pathOrDb === "string") {
      this.db = openSqliteDatabase(pathOrDb)
      this.path = pathOrDb
    } else {
      this.db = pathOrDb
      this.path = null
    }
    this.#persistAllScopes = opts?.persistScopes === "all"
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS parton_cells (
         scope         TEXT    NOT NULL,
         cell_id       TEXT    NOT NULL,
         partition_key TEXT    NOT NULL,
         value         TEXT,
         ts            INTEGER,
         version       INTEGER NOT NULL DEFAULT 1,
         PRIMARY KEY (scope, cell_id, partition_key)
       )`,
    )
    const db = this.db
    this.#stRead = db.prepare(
      "SELECT value FROM parton_cells WHERE scope = ? AND cell_id = ? AND partition_key = ?",
    )
    this.#stReadVersioned = db.prepare(
      "SELECT value, version FROM parton_cells WHERE scope = ? AND cell_id = ? AND partition_key = ?",
    )
    // A value write PRESERVES the prior ts (loader seeds / hydrate /
    // the atomic-overlay flush must not move the invalidation
    // history) and bumps the row's write counter.
    this.#stWrite = db.prepare(
      `INSERT INTO parton_cells (scope, cell_id, partition_key, value, ts, version)
       VALUES (?, ?, ?, ?, NULL, 1)
       ON CONFLICT(scope, cell_id, partition_key)
       DO UPDATE SET value = excluded.value, version = parton_cells.version + 1`,
    )
    this.#stWriteIfAbsent = db.prepare(
      `INSERT INTO parton_cells (scope, cell_id, partition_key, value, ts, version)
       VALUES (?, ?, ?, ?, NULL, 1)
       ON CONFLICT(scope, cell_id, partition_key) DO NOTHING`,
    )
    this.#stWriteIfVersion = db.prepare(
      `UPDATE parton_cells SET value = ?, version = version + 1
       WHERE scope = ? AND cell_id = ? AND partition_key = ? AND version = ?`,
    )
    // UPDATE only — a stamp can never mint a phantom row.
    this.#stStampTs = db.prepare(
      "UPDATE parton_cells SET ts = ? WHERE scope = ? AND cell_id = ? AND partition_key = ?",
    )
    this.#stReadTs = db.prepare(
      "SELECT ts FROM parton_cells WHERE scope = ? AND cell_id = ? AND partition_key = ?",
    )
    this.#stHasTs = db.prepare(
      "SELECT 1 FROM parton_cells WHERE scope = ? AND cell_id = ? AND ts IS NOT NULL LIMIT 1",
    )
    this.#stMaxTs = db.prepare("SELECT max(ts) AS m FROM parton_cells")
    this.#stClearScope = db.prepare("DELETE FROM parton_cells WHERE scope = ?")
    this.#stClearAll = db.prepare("DELETE FROM parton_cells")
  }

  /** Close the underlying connection (shared handles included). The
   *  WAL is checkpointed on a clean close; an unclosed handle is still
   *  safe — the next open replays the WAL. */
  close(): void {
    this.db.close()
  }

  // ── Value encoding ──────────────────────────────────────────────────
  // JSON text in the `value` column; SQL NULL encodes the `undefined`
  // slot `invalidate()` writes (a row that EXISTS but reads as a
  // miss, so the loader re-runs while `stampTs` still lands). JSON
  // `null` is the 4-byte text "null" — distinct from SQL NULL.

  #encode(value: unknown): string | null {
    if (value === undefined) return null
    return JSON.stringify(value)
  }

  #decode(text: string | null): unknown {
    if (text === null) return undefined
    return JSON.parse(text)
  }

  #memRows(scope: string, cellId: string, create: boolean): Map<string, MemRow> | undefined {
    let cells = this.#mem.get(scope)
    if (!cells) {
      if (!create) return undefined
      cells = new Map()
      this.#mem.set(scope, cells)
    }
    let rows = cells.get(cellId)
    if (!rows) {
      if (!create) return undefined
      rows = new Map()
      cells.set(cellId, rows)
    }
    return rows
  }

  /** Whether `scope` lives on the database (vs the memory bucket). */
  #onDb(scope: string): boolean {
    return scope === DEFAULT_SCOPE || this.#persistAllScopes
  }

  // ── CellStorage ─────────────────────────────────────────────────────

  read(scope: string, cellId: string, partitionKey: string): unknown {
    if (!this.#onDb(scope)) {
      return this.#memRows(scope, cellId, false)?.get(partitionKey)?.value
    }
    const row = this.#stRead.get(scope, cellId, partitionKey) as Pick<CellRow, "value"> | undefined
    if (!row) return undefined
    return this.#decode(row.value)
  }

  write(scope: string, cellId: string, partitionKey: string, value: unknown): void {
    if (!this.#onDb(scope)) {
      const rows = this.#memRows(scope, cellId, true)!
      const prior = rows.get(partitionKey)
      rows.set(partitionKey, { value, ts: prior?.ts, version: (prior?.version ?? 0) + 1 })
      return
    }
    this.#stWrite.run(scope, cellId, partitionKey, this.#encode(value))
  }

  clear(scope?: string | "all"): void {
    if (scope === undefined || scope === "all") {
      this.#mem.clear()
      this.#stClearAll.run()
      this.#hasTsTrue.clear()
      return
    }
    if (this.#onDb(scope)) {
      this.#stClearScope.run(scope)
    }
    this.#mem.delete(scope)
    for (const key of this.#hasTsTrue) {
      if (key.startsWith(`${scope}\n`)) this.#hasTsTrue.delete(key)
    }
  }

  // No `flush` — every write is already committed when it returns.

  // ── Invalidation-ts persistence ─────────────────────────────────────

  readTs(scope: string, cellId: string, partitionKey: string): number | undefined {
    if (!this.#onDb(scope)) {
      return this.#memRows(scope, cellId, false)?.get(partitionKey)?.ts
    }
    const row = this.#stReadTs.get(scope, cellId, partitionKey) as Pick<CellRow, "ts"> | undefined
    return row?.ts ?? undefined
  }

  stampTs(scope: string, cellId: string, partitionKey: string, ts: number): void {
    if (!this.#onDb(scope)) {
      const row = this.#memRows(scope, cellId, false)?.get(partitionKey)
      if (!row) return // never mint a phantom row
      row.ts = ts
      this.#hasTsTrue.add(`${scope}\n${cellId}`)
      return
    }
    const result = this.#stStampTs.run(ts, scope, cellId, partitionKey)
    if (result.changes > 0) this.#hasTsTrue.add(`${scope}\n${cellId}`)
  }

  hasTs(scope: string, cellId: string): boolean {
    const key = `${scope}\n${cellId}`
    if (this.#hasTsTrue.has(key)) return true
    let found: boolean
    if (!this.#onDb(scope)) {
      found = false
      const rows = this.#memRows(scope, cellId, false)
      if (rows) {
        for (const row of rows.values()) {
          if (row.ts !== undefined) {
            found = true
            break
          }
        }
      }
    } else {
      found = this.#stHasTs.get(scope, cellId) !== undefined
    }
    if (found) this.#hasTsTrue.add(key)
    return found
  }

  maxTs(): number {
    const row = this.#stMaxTs.get() as { m: number | null } | undefined
    let max = row?.m ?? 0
    for (const cells of this.#mem.values()) {
      for (const rows of cells.values()) {
        for (const r of rows.values()) {
          if (r.ts !== undefined && r.ts > max) max = r.ts
        }
      }
    }
    return max
  }

  // ── Versioned writes (the store-level CAS) ──────────────────────────

  readVersioned(
    scope: string,
    cellId: string,
    partitionKey: string,
  ): { value: unknown; version: number } | undefined {
    if (!this.#onDb(scope)) {
      const row = this.#memRows(scope, cellId, false)?.get(partitionKey)
      return row ? { value: row.value, version: row.version } : undefined
    }
    const row = this.#stReadVersioned.get(scope, cellId, partitionKey) as
      | Pick<CellRow, "value" | "version">
      | undefined
    if (!row) return undefined
    return { value: this.#decode(row.value), version: row.version }
  }

  writeIfVersion(
    scope: string,
    cellId: string,
    partitionKey: string,
    value: unknown,
    expectedVersion: number,
  ): boolean {
    if (!this.#onDb(scope)) {
      const rows = this.#memRows(scope, cellId, true)!
      const prior = rows.get(partitionKey)
      if ((prior?.version ?? 0) !== expectedVersion) return false
      rows.set(partitionKey, { value, ts: prior?.ts, version: expectedVersion + 1 })
      return true
    }
    const encoded = this.#encode(value)
    if (expectedVersion === 0) {
      // "Row absent" — succeed only by creating it.
      return this.#stWriteIfAbsent.run(scope, cellId, partitionKey, encoded).changes === 1
    }
    // Conditional swap: another process's commit between our read and
    // here moved `version`, the UPDATE matches nothing, the caller
    // retries against the fresh row. ts is preserved (not in SET).
    return (
      this.#stWriteIfVersion.run(encoded, scope, cellId, partitionKey, expectedVersion).changes ===
      1
    )
  }
}
