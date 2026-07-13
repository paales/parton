/**
 * `cell.update(fn)` over the SQLite backend — the store-level CAS
 * through the REAL cell pipeline (`updateOneCell` → `casUpdateRow`).
 *
 * The in-process serialization invariant still holds (concurrent
 * updates compose — same property `cell-update.rsc.test.tsx` pins over
 * memory storage), and on top of it: a write landing through an
 * INDEPENDENT handle between the CAS read and its conditional write —
 * a real second process's only observable shape — engages the retry
 * and composes instead of clobbering. Plus publish-after-commit: at
 * the moment a bump wakes a subscriber, the committed row is already
 * readable through an independent handle (the doorbell never rings
 * before the value is in the shared store).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { atomic, localCell } from "../../lib/cell.ts"
import { hash } from "../../lib/hash.ts"
import { stableStringify } from "../../lib/stable-stringify.ts"
import { setCellStorage, _resetCellStorage } from "../cell-storage.ts"
import { SqliteCellStorage } from "../cell-storage-sqlite.ts"
import {
  _clearInvalidationRegistry,
  _closeWakeSubscription,
  _compileSurfaceQuery,
  _openWakeSubscription,
  _setWakeSubscriptionEntry,
  queryMatchingTs,
  type WakeSubscription,
} from "../invalidation-registry.ts"

const pk = (args: object): string => hash(stableStringify(args))

let dir: string
let storage: SqliteCellStorage
/** The "other process": an independent connection to the same file. */
let other: SqliteCellStorage
const subs: WakeSubscription[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "parton-cells-cas-"))
  storage = new SqliteCellStorage(join(dir, "cells.db"))
  other = new SqliteCellStorage(join(dir, "cells.db"))
  setCellStorage(storage)
  _clearInvalidationRegistry()
})

afterEach(() => {
  for (const sub of subs.splice(0)) _closeWakeSubscription(sub)
  _resetCellStorage()
  _clearInvalidationRegistry()
  storage.close()
  other.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("compose under concurrency (SQLite backend)", () => {
  it("100 concurrent updates on one (cell, partition) land exactly 100", async () => {
    const counter = localCell({ id: "sqcas.race", shape: "number", initial: 0 })
    const bound = counter.with({ k: "a" })
    await Promise.all(Array.from({ length: 100 }, () => bound.update((n) => n + 1)))
    expect(other.read("default", "sqcas.race", pk({ k: "a" }))).toBe(100)
  })
})

describe("the CAS retry — cross-process conflicts compose", () => {
  it("a write through an independent handle between read and swap re-runs the updater against the fresh value", async () => {
    const counter = localCell({ id: "sqcas.conflict", shape: "number", initial: 0 })
    await counter.with({ k: "c" }).set(5)
    let updaterRuns = 0
    await counter.with({ k: "c" }).update((n) => {
      updaterRuns++
      if (updaterRuns === 1) {
        // The "other process" commits AFTER our CAS read, BEFORE our
        // conditional write — the only interleaving a second process
        // can produce against the synchronous in-process section.
        other.write("default", "sqcas.conflict", pk({ k: "c" }), 100)
      }
      return n + 1
    })
    // First attempt computed 5+1 but lost the swap; the retry read 100
    // and committed 101 — the other process's write was NOT clobbered.
    expect(updaterRuns).toBe(2)
    expect(other.read("default", "sqcas.conflict", pk({ k: "c" }))).toBe(101)
  })

  it("single-process update takes exactly one attempt (no conflict, no loop)", async () => {
    const counter = localCell({ id: "sqcas.fast", shape: "number", initial: 0 })
    let updaterRuns = 0
    await counter.with({ k: "f" }).update((n) => {
      updaterRuns++
      return n + 1
    })
    expect(updaterRuns).toBe(1)
    expect(other.read("default", "sqcas.fast", pk({ k: "f" }))).toBe(1)
  })

  it("update inside atomic() keeps the overlay path — buffered, composed, rolled back on throw", async () => {
    const c = localCell({ id: "sqcas.atomic", shape: "number", initial: 0 })
    await atomic(async () => {
      await c.with({ k: "a" }).set(5)
      await c.with({ k: "a" }).update((n) => n + 1) // reads the overlay's 5
    })
    expect(other.read("default", "sqcas.atomic", pk({ k: "a" }))).toBe(6)

    await expect(
      atomic(async () => {
        await c.with({ k: "rb" }).update((n) => n + 1)
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(other.read("default", "sqcas.atomic", pk({ k: "rb" }))).toBeUndefined()
    expect(queryMatchingTs(["cell:sqcas.atomic"], { k: "rb" })).toBe(0)
  })
})

describe("publish-after-commit — the bump never precedes store visibility", () => {
  function subscribeValueAtWake(
    label: string,
    surface: Record<string, unknown>,
    read: () => unknown,
  ): () => unknown[] {
    const sub = _openWakeSubscription({ visible: () => null, hasAssignedSeq: () => false })
    subs.push(sub)
    _setWakeSubscriptionEntry(sub, `watch:${label}`, {
      labels: [label],
      query: _compileSurfaceQuery(surface),
      carrier: `watch:${label}`,
      carrierParkGates: null,
    })
    const seen: unknown[] = []
    sub.wakes.add(() => seen.push(read()))
    return () => seen
  }

  it("a set's wake observes the committed row through an independent handle", async () => {
    const c = localCell({ id: "sqcas.pub", shape: "number", initial: 0 })
    const seen = subscribeValueAtWake("cell:sqcas.pub", { k: "p" }, () =>
      other.read("default", "sqcas.pub", pk({ k: "p" })),
    )
    await c.with({ k: "p" }).set(7)
    expect(seen()).toEqual([7])
  })

  it("an atomic batch's wakes observe EVERY row of the batch (overlay flushed before fan-out)", async () => {
    const a = localCell({ id: "sqcas.pub.a", shape: "number", initial: 0 })
    const b = localCell({ id: "sqcas.pub.b", shape: "number", initial: 0 })
    // The wake for cell A reads cell B — commit order inside the batch
    // must not matter: by the time ANY bump fires, ALL values are in
    // the store.
    const seen = subscribeValueAtWake("cell:sqcas.pub.a", { k: "x" }, () => ({
      a: other.read("default", "sqcas.pub.a", pk({ k: "x" })),
      b: other.read("default", "sqcas.pub.b", pk({ k: "y" })),
    }))
    await atomic(async () => {
      await a.with({ k: "x" }).set(1)
      await b.with({ k: "y" }).set(2)
    })
    expect(seen()).toEqual([{ a: 1, b: 2 }])
  })

  it("an update's wake observes the composed row through an independent handle", async () => {
    const c = localCell({ id: "sqcas.pub.upd", shape: "number", initial: 0 })
    await c.with({ k: "u" }).set(4)
    const seen = subscribeValueAtWake("cell:sqcas.pub.upd", { k: "u" }, () =>
      other.read("default", "sqcas.pub.upd", pk({ k: "u" })),
    )
    await c.with({ k: "u" }).update((n) => n * 10)
    expect(seen()).toEqual([40])
  })
})
