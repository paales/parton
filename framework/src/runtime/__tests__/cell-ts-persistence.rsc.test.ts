/**
 * The invalidation timestamp rides the stored cell row (leases.md L2).
 *
 * Contract under test: every committed cell bump stamps its `ts` onto
 * the backing storage row (`commitOne` → the ts bridge), and a query
 * that misses a `cell:` entry restores it from the row BEFORE reading
 * — so hot registry entries are a cache over storage: evictable and
 * restorable with byte-identical fp folds. The headline is restart
 * equivalence: a fresh registry over the same storage folds the SAME
 * ts a never-restarted process would.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { atomic, localCell } from "../../lib/cell.ts"
import { hash } from "../../lib/hash.ts"
import { stableStringify } from "../../lib/stable-stringify.ts"
import { evalDepKeys } from "../../lib/server-hooks.ts"
import {
  JsonFileCellStorage,
  MemoryCellStorage,
  getCellStorage,
  setCellStorage,
  _resetCellStorage,
} from "../cell-storage.ts"
import {
  _clearInvalidationRegistry,
  _currentTs,
  _evictInvalidationEntry,
  _registryStats,
  _setInvalidationEntryCap,
  buildCellSelector,
  queryMatchingTs,
  refreshSelector,
} from "../invalidation-registry.ts"

const pk = (args: object): string => hash(stableStringify(args))
const rowTs = (id: string, args: object): number | undefined =>
  getCellStorage().readTs?.("default", id, pk(args))

beforeEach(() => {
  setCellStorage(new MemoryCellStorage())
  _clearInvalidationRegistry()
})

afterEach(() => {
  _resetCellStorage()
  _clearInvalidationRegistry()
  _setInvalidationEntryCap(null)
})

describe("write path — the committed ts stamps the row", () => {
  it("set stamps the row with exactly the entry's ts", async () => {
    const cell = localCell({ id: "tsp.set", shape: "number", initial: 0 })
    await cell.with({ k: "a" }).set(5)
    const ts = queryMatchingTs(["cell:tsp.set"], { k: "a" })
    expect(ts).toBe(_currentTs())
    expect(rowTs("tsp.set", { k: "a" })).toBe(ts)
    // A second write supersedes both in lockstep.
    await cell.with({ k: "a" }).set(6)
    expect(rowTs("tsp.set", { k: "a" })).toBe(ts + 1)
    expect(queryMatchingTs(["cell:tsp.set"], { k: "a" })).toBe(ts + 1)
  })

  it("update stamps through the same pipeline", async () => {
    const cell = localCell({ id: "tsp.upd", shape: "number", initial: 0 })
    await cell.with({ k: "u" }).update((n) => n + 1)
    const ts = queryMatchingTs(["cell:tsp.upd"], { k: "u" })
    expect(ts).toBeGreaterThan(0)
    expect(rowTs("tsp.upd", { k: "u" })).toBe(ts)
  })

  it("an atomic batch stamps each row with its own committed ts, at commit", async () => {
    const a = localCell({ id: "tsp.atomic.a", shape: "number", initial: 0 })
    const b = localCell({ id: "tsp.atomic.b", shape: "number", initial: 0 })
    await atomic(async () => {
      await a.with({ k: "x" }).set(1)
      await b.with({ k: "y" }).set(2)
      // Inside the transaction nothing has committed: no entry ts, no
      // row stamp (values are still in the overlay too).
      expect(queryMatchingTs(["cell:tsp.atomic.a"], { k: "x" })).toBe(0)
      expect(rowTs("tsp.atomic.a", { k: "x" })).toBeUndefined()
    })
    const tsA = queryMatchingTs(["cell:tsp.atomic.a"], { k: "x" })
    const tsB = queryMatchingTs(["cell:tsp.atomic.b"], { k: "y" })
    expect(rowTs("tsp.atomic.a", { k: "x" })).toBe(tsA)
    expect(rowTs("tsp.atomic.b", { k: "y" })).toBe(tsB)
    expect(getCellStorage().read("default", "tsp.atomic.a", pk({ k: "x" }))).toBe(1)
    expect(getCellStorage().read("default", "tsp.atomic.b", pk({ k: "y" }))).toBe(2)
  })

  it("two writes to one row in one atomic batch leave the row at the final commit ts", async () => {
    const c = localCell({ id: "tsp.atomic.dup", shape: "number", initial: 0 })
    await atomic(async () => {
      await c.with({ k: "d" }).set(1)
      await c.with({ k: "d" }).set(2)
    })
    const ts = queryMatchingTs(["cell:tsp.atomic.dup"], { k: "d" })
    expect(rowTs("tsp.atomic.dup", { k: "d" })).toBe(ts)
    expect(getCellStorage().read("default", "tsp.atomic.dup", pk({ k: "d" }))).toBe(2)
  })

  it("a rolled-back atomic batch stamps nothing", async () => {
    const c = localCell({ id: "tsp.atomic.rb", shape: "number", initial: 0 })
    await expect(
      atomic(async () => {
        await c.with({ k: "r" }).set(9)
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(rowTs("tsp.atomic.rb", { k: "r" })).toBeUndefined()
    expect(queryMatchingTs(["cell:tsp.atomic.rb"], { k: "r" })).toBe(0)
  })
})

describe("restart equivalence — the headline", () => {
  it("a fresh registry over the same storage folds the SAME ts", async () => {
    const cell = localCell({ id: "tsp.restart", shape: "number", initial: 0 })
    await cell.with({ uid: "42" }).set(7)
    const sel = buildCellSelector("tsp.restart", { uid: "42" })
    const req = new Request("http://localhost/")
    const foldBefore = evalDepKeys([sel], req)
    const tsBefore = queryMatchingTs(["cell:tsp.restart"], { uid: "42" })
    expect(tsBefore).toBeGreaterThan(0)

    // Simulate a process restart: the registry (hot state) is wiped,
    // storage (the durable tier) survives.
    _clearInvalidationRegistry()
    expect(_registryStats().entries).toBe(0)

    // The fold restores the entry from the row before reading it —
    // byte-identical dep fold, identical ts.
    expect(evalDepKeys([sel], req)).toBe(foldBefore)
    expect(queryMatchingTs(["cell:tsp.restart"], { uid: "42" })).toBe(tsBefore)
    expect(_registryStats().entries).toBe(1)

    // The restored timeline CONTINUES: a post-restart write supersedes
    // the persisted history instead of restarting below it.
    await cell.with({ uid: "42" }).set(8)
    expect(queryMatchingTs(["cell:tsp.restart"], { uid: "42" })).toBe(tsBefore + 1)
    expect(rowTs("tsp.restart", { uid: "42" })).toBe(tsBefore + 1)
  })

  it("restores type-tagged (non-string) partitions losslessly", async () => {
    const cell = localCell({ id: "tsp.restart.num", shape: "number", initial: 0 })
    await cell.with({ cx: 3, cy: -1 }).set(1)
    const sel = buildCellSelector("tsp.restart.num", { cx: 3, cy: -1 })
    const req = new Request("http://localhost/")
    const foldBefore = evalDepKeys([sel], req)
    _clearInvalidationRegistry()
    expect(evalDepKeys([sel], req)).toBe(foldBefore)
    // The string-keyed partition {cx:"3",cy:"-1"} is a DIFFERENT slot
    // and stays cold.
    expect(queryMatchingTs(["cell:tsp.restart.num"], { cx: "3", cy: "-1" })).toBe(0)
  })

  it("swapping in a storage backend with persisted history seats the counter above it", () => {
    const prior = new MemoryCellStorage()
    prior.write("default", "tsp.floor", pk({ k: "f" }), 1)
    prior.stampTs("default", "tsp.floor", pk({ k: "f" }), 41)
    setCellStorage(prior) // raises the ts floor from maxTs()
    refreshSelector("anything")
    expect(_currentTs()).toBe(42)
  })
})

describe("eviction — backed entries only, verified at evict time", () => {
  it("evict → restore round-trips with an identical fold", async () => {
    const cell = localCell({ id: "tsp.evict", shape: "number", initial: 0 })
    await cell.with({ k: "e" }).set(3)
    const ts = queryMatchingTs(["cell:tsp.evict"], { k: "e" })
    const entriesBefore = _registryStats().entries

    expect(_evictInvalidationEntry("cell:tsp.evict", stableStringify({ k: "e" }))).toBe(true)
    expect(_registryStats().entries).toBe(entriesBefore - 1)

    // The next fold restores it from the row — same ts, entry back.
    expect(queryMatchingTs(["cell:tsp.evict"], { k: "e" })).toBe(ts)
    expect(_registryStats().entries).toBe(entriesBefore)
  })

  it("refuses an unbacked entry (bump without a row)", () => {
    refreshSelector("cell:tsp.norow?k=z")
    expect(_evictInvalidationEntry("cell:tsp.norow", stableStringify({ k: "z" }))).toBe(false)
    expect(queryMatchingTs(["cell:tsp.norow"], { k: "z" })).toBe(_currentTs())
  })

  it("refuses when the backing row is ts-unknown (adapter without stampTs)", async () => {
    // A persistent adapter that never stamps: rows exist, ts doesn't —
    // the legacy / custom-adapter posture. Its entries must be treated
    // as unbacked.
    const bare = new MemoryCellStorage()
    const noStamp: import("../cell-storage.ts").CellStorage = {
      read: (s, c, p) => bare.read(s, c, p),
      write: (s, c, p, v) => bare.write(s, c, p, v),
      clear: (s) => bare.clear(s),
    }
    setCellStorage(noStamp)
    const cell = localCell({ id: "tsp.nostamp", shape: "number", initial: 0 })
    await cell.with({ k: "n" }).set(4)
    expect(queryMatchingTs(["cell:tsp.nostamp"], { k: "n" })).toBe(_currentTs())
    expect(_evictInvalidationEntry("cell:tsp.nostamp", stableStringify({ k: "n" }))).toBe(false)
  })

  it("refuses non-cell entries", () => {
    refreshSelector("cart")
    expect(_evictInvalidationEntry("cart", stableStringify({}))).toBe(false)
  })

  it("refuses a row whose ts lags the entry (a later bump not yet re-stamped)", async () => {
    const cell = localCell({ id: "tsp.stale", shape: "number", initial: 0 })
    await cell.with({ k: "s" }).set(1)
    const entryTs = _currentTs()
    // Regress the row's ts out from under the entry.
    getCellStorage().stampTs?.("default", "tsp.stale", pk({ k: "s" }), entryTs - 1)
    expect(_evictInvalidationEntry("cell:tsp.stale", stableStringify({ k: "s" }))).toBe(false)
  })
})

describe("bounded-cardinality sweep", () => {
  it("trims backed entries past the cap, spares unbacked ones, restores on demand", async () => {
    _setInvalidationEntryCap(8)
    const cell = localCell({ id: "tsp.sweep", shape: "number", initial: 0 })
    // Three unbacked entries — exempt from the cap by the loss rule.
    refreshSelector(["tsp-u1", "tsp-u2", "tsp-u3"])
    const unbackedTs = [
      queryMatchingTs(["tsp-u1"], null),
      queryMatchingTs(["tsp-u2"], null),
      queryMatchingTs(["tsp-u3"], null),
    ]
    // Ten backed entries push past the cap; the sweep trims to the
    // low watermark as they commit.
    const writeTs: number[] = []
    for (let i = 0; i < 10; i++) {
      await cell.with({ p: String(i) }).set(i)
      writeTs.push(_currentTs())
    }
    expect(_registryStats().entries).toBeLessThanOrEqual(8)

    // Unbacked entries survived with their timestamps.
    expect(queryMatchingTs(["tsp-u1"], null)).toBe(unbackedTs[0])
    expect(queryMatchingTs(["tsp-u2"], null)).toBe(unbackedTs[1])
    expect(queryMatchingTs(["tsp-u3"], null)).toBe(unbackedTs[2])

    // Every evicted partition restores its exact committed ts on the
    // next fold — eviction is invisible to consumers.
    for (let i = 0; i < 10; i++) {
      expect(queryMatchingTs(["cell:tsp.sweep"], { p: String(i) })).toBe(writeTs[i])
      expect(rowTs("tsp.sweep", { p: String(i) })).toBe(writeTs[i])
    }
  })
})

describe("legacy / migration posture", () => {
  it("a ts-unknown row folds cold (no restore, no phantom entry)", () => {
    localCell({ id: "tsp.cold", shape: "number", initial: 0 })
    getCellStorage().write("default", "tsp.cold", pk({ k: "c" }), 9)
    expect(queryMatchingTs(["cell:tsp.cold"], { k: "c" })).toBe(0)
    expect(_registryStats().entries).toBe(0)
    expect(getCellStorage().read("default", "tsp.cold", pk({ k: "c" }))).toBe(9)
  })

  it("the first post-migration write stamps the row forward", async () => {
    const cell = localCell({ id: "tsp.migrate", shape: "number", initial: 0 })
    getCellStorage().write("default", "tsp.migrate", pk({ k: "m" }), 1)
    expect(rowTs("tsp.migrate", { k: "m" })).toBeUndefined()
    await cell.with({ k: "m" }).set(2)
    expect(rowTs("tsp.migrate", { k: "m" })).toBe(_currentTs())
  })
})

describe("JsonFileCellStorage — disk round-trip", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parton-cells-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("persists ts in the v2 envelope and restores it across instances", async () => {
    const path = join(dir, "cells.json")
    const a = new JsonFileCellStorage(path)
    a.write("default", "disk.cell", "pk1", 5)
    a.stampTs("default", "disk.cell", "pk1", 17)
    await a.flush()

    const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    expect(file.__parton).toBe(2)

    const b = new JsonFileCellStorage(path)
    expect(b.read("default", "disk.cell", "pk1")).toBe(5)
    expect(b.readTs("default", "disk.cell", "pk1")).toBe(17)
    expect(b.hasTs("default", "disk.cell")).toBe(true)
    expect(b.maxTs()).toBe(17)
  })

  it("loads a legacy bare-cells file as ts-unknown", async () => {
    const path = join(dir, "cells.json")
    writeFileSync(path, JSON.stringify({ "legacy.cell": { pkX: 5 } }), "utf8")
    const s = new JsonFileCellStorage(path)
    expect(s.read("default", "legacy.cell", "pkX")).toBe(5)
    expect(s.readTs("default", "legacy.cell", "pkX")).toBeUndefined()
    expect(s.hasTs("default", "legacy.cell")).toBe(false)
    expect(s.maxTs()).toBe(0)
    // A stamp migrates the file to the v2 envelope without losing values.
    s.stampTs("default", "legacy.cell", "pkX", 3)
    await s.flush()
    const reloaded = new JsonFileCellStorage(path)
    expect(reloaded.read("default", "legacy.cell", "pkX")).toBe(5)
    expect(reloaded.readTs("default", "legacy.cell", "pkX")).toBe(3)
  })

  it("never mints a phantom row from a stamp", () => {
    const path = join(dir, "cells.json")
    const s = new JsonFileCellStorage(path)
    s.stampTs("default", "ghost.cell", "pk1", 7)
    expect(s.readTs("default", "ghost.cell", "pk1")).toBeUndefined()
    expect(s.hasTs("default", "ghost.cell")).toBe(false)
  })

  it("an invalidated (undefined-value) row keeps its ts across reload", async () => {
    const path = join(dir, "cells.json")
    const a = new JsonFileCellStorage(path)
    a.write("default", "inv.cell", "pk1", undefined) // invalidate() shape
    a.stampTs("default", "inv.cell", "pk1", 9)
    await a.flush()
    const b = new JsonFileCellStorage(path)
    expect(b.read("default", "inv.cell", "pk1")).toBeUndefined()
    expect(b.readTs("default", "inv.cell", "pk1")).toBe(9)
    // The surviving ts slot still accepts a forward stamp.
    b.stampTs("default", "inv.cell", "pk1", 12)
    expect(b.readTs("default", "inv.cell", "pk1")).toBe(12)
  })
})
