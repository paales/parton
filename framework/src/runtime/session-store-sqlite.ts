/**
 * SQLite `SessionStore` — the second implementation behind the session
 * seam (`setSessionStore`), for deployments where sessions must
 * survive a process restart or be readable by several processes on one
 * host. The default `MemorySessionStore` stays the dev default: a
 * session is cheap, re-creatable state, and per-process memory is the
 * sticky-session posture — reach for this store when the deploy story
 * (drain/resume) makes losing every frame URL on restart unacceptable.
 *
 * One row per (scope, session_id); the state is a JSON blob because
 * the session is read and written WHOLESALE by the policy layer in
 * `session.ts` — per-frame rows would buy nothing but joins. The
 * activity clock is a real column so `touch` (every read) is a
 * two-column UPDATE, and the idle-TTL sweep is one indexed DELETE.
 *
 * Unlike cell storage, test scopes persist too: session rows are
 * TTL-bounded ephemera, the per-worker `/__test/clear-caches` clears
 * them by scope, and an inert leftover row can never leak across
 * scopes (every lookup is scope-keyed).
 *
 * Share one database file with the cell adapter by passing its `db`:
 *
 *     const cells = new SqliteCellStorage(path)
 *     setCellStorage(cells)
 *     setSessionStore(new SqliteSessionStore(cells.db))
 *
 * …or keep separate lifecycles with a separate path. Same WAL /
 * synchronous=NORMAL posture as the cell adapter (`openSqliteDatabase`).
 */

import { openSqliteDatabase, type SqliteDatabase } from "./cell-storage-sqlite.ts"
import type { SessionEntry, SessionState, SessionStore } from "./session.ts"

interface SessionRow {
  session_id: string
  state: string
  touched_at: number
}

export class SqliteSessionStore implements SessionStore {
  readonly db: SqliteDatabase

  #stRead
  #stWrite
  #stTouch
  #stDelete
  #stSweep
  #stClearScope
  #stClearAll
  #stEntries

  constructor(pathOrDb: string | SqliteDatabase) {
    this.db = typeof pathOrDb === "string" ? openSqliteDatabase(pathOrDb) : pathOrDb
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS parton_sessions (
         scope      TEXT    NOT NULL,
         session_id TEXT    NOT NULL,
         state      TEXT    NOT NULL,
         touched_at INTEGER NOT NULL,
         PRIMARY KEY (scope, session_id)
       );
       CREATE INDEX IF NOT EXISTS parton_sessions_touched
         ON parton_sessions (touched_at)`,
    )
    const db = this.db
    this.#stRead = db.prepare(
      "SELECT state, touched_at FROM parton_sessions WHERE scope = ? AND session_id = ?",
    )
    this.#stWrite = db.prepare(
      `INSERT INTO parton_sessions (scope, session_id, state, touched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scope, session_id)
       DO UPDATE SET state = excluded.state, touched_at = excluded.touched_at`,
    )
    this.#stTouch = db.prepare(
      "UPDATE parton_sessions SET touched_at = ? WHERE scope = ? AND session_id = ?",
    )
    this.#stDelete = db.prepare("DELETE FROM parton_sessions WHERE scope = ? AND session_id = ?")
    this.#stSweep = db.prepare("DELETE FROM parton_sessions WHERE touched_at < ?")
    this.#stClearScope = db.prepare("DELETE FROM parton_sessions WHERE scope = ?")
    this.#stClearAll = db.prepare("DELETE FROM parton_sessions")
    this.#stEntries = db.prepare(
      "SELECT session_id, state, touched_at FROM parton_sessions WHERE scope = ?",
    )
  }

  close(): void {
    this.db.close()
  }

  read(scope: string, id: string): SessionEntry | undefined {
    const row = this.#stRead.get(scope, id) as Omit<SessionRow, "session_id"> | undefined
    if (!row) return undefined
    let state: SessionState
    try {
      state = JSON.parse(row.state) as SessionState
    } catch {
      // A corrupt row is an absent session — the caller mints fresh
      // state; never throw the render path over one bad blob.
      return undefined
    }
    return { state, touchedAt: row.touched_at }
  }

  write(scope: string, id: string, entry: SessionEntry): void {
    this.#stWrite.run(scope, id, JSON.stringify(entry.state), entry.touchedAt)
  }

  touch(scope: string, id: string, touchedAt: number): void {
    this.#stTouch.run(touchedAt, scope, id)
  }

  delete(scope: string, id: string): void {
    this.#stDelete.run(scope, id)
  }

  sweep(cutoff: number): void {
    if (!Number.isFinite(cutoff)) {
      // -Infinity (TTL disabled) sweeps nothing; +Infinity never
      // reaches here (session.ts skips the sweep entirely).
      if (cutoff === -Infinity) return
    }
    this.#stSweep.run(cutoff)
  }

  clear(scope?: string | "all"): void {
    if (scope === undefined || scope === "all") {
      this.#stClearAll.run()
      return
    }
    this.#stClearScope.run(scope)
  }

  entries(scope: string): Iterable<[string, SessionEntry]> {
    const rows = this.#stEntries.all(scope) as SessionRow[]
    const out: Array<[string, SessionEntry]> = []
    for (const row of rows) {
      try {
        out.push([
          row.session_id,
          { state: JSON.parse(row.state) as SessionState, touchedAt: row.touched_at },
        ])
      } catch {
        // Skip corrupt rows — same posture as `read`.
      }
    }
    return out
  }
}
