/**
 * SqliteCellStorage — the per-key persistent adapter's own contract.
 *
 * What the cell pipeline relies on, pinned at the adapter level:
 * per-key rows readable through an INDEPENDENT handle the moment
 * `write()` returns (the storage half of publish-after-commit), the
 * optional-ts contract (write preserves ts; stamp never mints a
 * phantom row; hasTs/maxTs), scope routing (test scopes stay off the
 * database unless `persistScopes: "all"`), and the versioned CAS
 * primitives (`readVersioned` / `writeIfVersion`) that make
 * `cell.update(fn)` cross-process safe. The full cell-level suites run
 * over this adapter in `cell-ts-persistence.rsc.test.ts` and
 * `cell-update-sqlite.rsc.test.ts`; the multi-process gates live in
 * `cell-storage-sqlite-contention.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteCellStorage } from "../cell-storage-sqlite.ts"

let dir: string
let dbPath: string
let opened: SqliteCellStorage[]

function open(opts?: ConstructorParameters<typeof SqliteCellStorage>[1]): SqliteCellStorage {
  const s = new SqliteCellStorage(dbPath, opts)
  opened.push(s)
  return s
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "parton-sqlite-"))
  dbPath = join(dir, "cells.db")
  opened = []
})

afterEach(() => {
  for (const s of opened) {
    try {
      s.close()
    } catch {
      // already closed by the test
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

describe("values — per-key rows, JSON round-trip", () => {
  it("round-trips JSON values and misses as undefined", () => {
    const s = open()
    s.write("default", "c", "p1", 5)
    s.write("default", "c", "p2", { a: [1, "x", null], b: true })
    s.write("default", "c", "p3", "text")
    s.write("default", "c", "p4", null)
    expect(s.read("default", "c", "p1")).toBe(5)
    expect(s.read("default", "c", "p2")).toEqual({ a: [1, "x", null], b: true })
    expect(s.read("default", "c", "p3")).toBe("text")
    expect(s.read("default", "c", "p4")).toBeNull() // JSON null ≠ missing
    expect(s.read("default", "c", "nope")).toBeUndefined()
  })

  it("an undefined write is an invalidated slot: reads as a miss, but the row exists for stamps", () => {
    const s = open()
    s.write("default", "c", "p1", 9)
    s.write("default", "c", "p1", undefined)
    expect(s.read("default", "c", "p1")).toBeUndefined()
    s.stampTs("default", "c", "p1", 7) // row exists → stamp lands
    expect(s.readTs("default", "c", "p1")).toBe(7)
  })

  it("a committed write is visible through an INDEPENDENT handle immediately — the storage half of publish-after-commit", () => {
    const a = open()
    const b = open()
    a.write("default", "c", "p1", 42)
    expect(b.read("default", "c", "p1")).toBe(42)
  })

  it("values and ts survive close + reopen (restart)", () => {
    const a = open()
    a.write("default", "c", "p1", 5)
    a.stampTs("default", "c", "p1", 17)
    a.close()
    const b = open()
    expect(b.read("default", "c", "p1")).toBe(5)
    expect(b.readTs("default", "c", "p1")).toBe(17)
    expect(b.hasTs("default", "c")).toBe(true)
    expect(b.maxTs()).toBe(17)
  })
})

describe("the optional-ts contract", () => {
  it("a value write preserves the prior ts (loader seed / hydrate / overlay flush)", () => {
    const s = open()
    s.write("default", "c", "p1", 1)
    s.stampTs("default", "c", "p1", 11)
    s.write("default", "c", "p1", 2)
    expect(s.read("default", "c", "p1")).toBe(2)
    expect(s.readTs("default", "c", "p1")).toBe(11)
  })

  it("stampTs never mints a phantom row", () => {
    const s = open()
    s.stampTs("default", "ghost", "p1", 7)
    expect(s.readTs("default", "ghost", "p1")).toBeUndefined()
    expect(s.hasTs("default", "ghost")).toBe(false)
    expect(s.read("default", "ghost", "p1")).toBeUndefined()
  })

  it("hasTs is per (scope, cellId) and survives the positive cache across clears", () => {
    const s = open()
    s.write("default", "a", "p1", 1)
    s.write("default", "b", "p1", 1)
    s.stampTs("default", "a", "p1", 3)
    expect(s.hasTs("default", "a")).toBe(true)
    expect(s.hasTs("default", "b")).toBe(false)
    // clear() must drop the positive cache — a stale `true` would
    // resurrect evicted registry entries from rows that are gone.
    s.clear("default")
    expect(s.hasTs("default", "a")).toBe(false)
  })

  it("hasTs observes a stamp committed through ANOTHER handle (no negative caching)", () => {
    const a = open()
    const b = open()
    expect(a.hasTs("default", "c")).toBe(false)
    b.write("default", "c", "p1", 1)
    b.stampTs("default", "c", "p1", 5)
    expect(a.hasTs("default", "c")).toBe(true)
  })

  it("maxTs spans rows and scopes", () => {
    const s = open()
    s.write("default", "a", "p1", 1)
    s.stampTs("default", "a", "p1", 3)
    s.write("default", "a", "p2", 1)
    s.stampTs("default", "a", "p2", 9)
    s.write("w1", "a", "p1", 1) // memory bucket
    s.stampTs("w1", "a", "p1", 20)
    expect(s.maxTs()).toBe(20)
  })
})

describe("scope routing", () => {
  it("non-default scopes stay off the database (per-process, gone with the handle)", () => {
    const a = open()
    a.write("w1", "c", "p1", 7)
    expect(a.read("w1", "c", "p1")).toBe(7)
    // An independent handle on the same file sees nothing — the row
    // never reached the database.
    const b = open()
    expect(b.read("w1", "c", "p1")).toBeUndefined()
    expect(a.db.prepare("SELECT count(*) AS n FROM parton_cells WHERE scope = 'w1'").get()).toEqual(
      { n: 0 },
    )
  })

  it("persistScopes: 'all' routes every scope to the database, still isolated by scope", () => {
    const a = open({ persistScopes: "all" })
    a.write("w1", "c", "p1", 7)
    // Another all-scopes handle sees the row via the database…
    const b = open({ persistScopes: "all" })
    expect(b.read("w1", "c", "p1")).toBe(7)
    expect(b.read("default", "c", "p1")).toBeUndefined()
    // …and it genuinely lives in the table (scope-keyed).
    expect(a.db.prepare("SELECT count(*) AS n FROM parton_cells WHERE scope = 'w1'").get()).toEqual(
      { n: 1 },
    )
  })

  it("clear targets one scope; clear('all') wipes every tier", () => {
    const s = open()
    s.write("default", "c", "p1", 1)
    s.write("w1", "c", "p1", 2)
    s.clear("w1")
    expect(s.read("default", "c", "p1")).toBe(1)
    expect(s.read("w1", "c", "p1")).toBeUndefined()
    s.clear("all")
    expect(s.read("default", "c", "p1")).toBeUndefined()
  })
})

describe("versioned CAS primitives", () => {
  it("readVersioned: absent row → undefined; versions count writes", () => {
    const s = open()
    expect(s.readVersioned("default", "c", "p1")).toBeUndefined()
    s.write("default", "c", "p1", "a")
    expect(s.readVersioned("default", "c", "p1")).toEqual({ value: "a", version: 1 })
    s.write("default", "c", "p1", "b")
    expect(s.readVersioned("default", "c", "p1")).toEqual({ value: "b", version: 2 })
  })

  it("writeIfVersion(…, 0) creates the row only when absent", () => {
    const s = open()
    expect(s.writeIfVersion("default", "c", "p1", "first", 0)).toBe(true)
    expect(s.readVersioned("default", "c", "p1")).toEqual({ value: "first", version: 1 })
    expect(s.writeIfVersion("default", "c", "p1", "second", 0)).toBe(false)
    expect(s.read("default", "c", "p1")).toBe("first")
  })

  it("writeIfVersion swaps only at the expected version and preserves ts", () => {
    const s = open()
    s.write("default", "c", "p1", 1) // version 1
    s.stampTs("default", "c", "p1", 40)
    expect(s.writeIfVersion("default", "c", "p1", 2, 1)).toBe(true) // → version 2
    expect(s.writeIfVersion("default", "c", "p1", 99, 1)).toBe(false) // stale version
    expect(s.read("default", "c", "p1")).toBe(2)
    expect(s.readTs("default", "c", "p1")).toBe(40)
  })

  it("a write through another handle between read and CAS fails the swap (the cross-process conflict)", () => {
    const a = open()
    const b = open()
    a.write("default", "c", "p1", 10)
    const seen = a.readVersioned("default", "c", "p1")!
    b.write("default", "c", "p1", 99) // the "other process" lands first
    expect(a.writeIfVersion("default", "c", "p1", seen.value as number, seen.version)).toBe(false)
    // The retry (fresh read) succeeds and composes over 99.
    const fresh = a.readVersioned("default", "c", "p1")!
    expect(fresh.value).toBe(99)
    expect(a.writeIfVersion("default", "c", "p1", (fresh.value as number) + 1, fresh.version)).toBe(
      true,
    )
    expect(b.read("default", "c", "p1")).toBe(100)
  })

  it("versioned methods work on memory-bucket scopes too", () => {
    const s = open()
    expect(s.writeIfVersion("w1", "c", "p1", 1, 0)).toBe(true)
    expect(s.readVersioned("w1", "c", "p1")).toEqual({ value: 1, version: 1 })
    expect(s.writeIfVersion("w1", "c", "p1", 2, 5)).toBe(false)
    expect(s.writeIfVersion("w1", "c", "p1", 2, 1)).toBe(true)
    expect(s.read("w1", "c", "p1")).toBe(2)
  })
})

describe("database file", () => {
  it("runs in WAL mode and passes integrity_check", () => {
    const s = open()
    s.write("default", "c", "p1", 1)
    expect(s.db.pragma("journal_mode", { simple: true })).toBe("wal")
    expect(existsSync(`${dbPath}-wal`)).toBe(true)
    expect(s.db.pragma("integrity_check", { simple: true })).toBe("ok")
  })
})
