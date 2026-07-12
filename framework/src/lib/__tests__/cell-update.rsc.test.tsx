/**
 * Reducer-form cell writes — `cell.update(updater)` and
 * `cell.with(args).update(updater)`.
 *
 * The property under test is the serialization invariant
 * (`runtime/cell-write.ts`): the read→updater→write section is
 * synchronous, so concurrent updates on the same (cell, partition)
 * COMPOSE — plus update sharing set's entire downstream path (shape
 * validation of the result, `write` canonicalisation, partition-scoped
 * invalidation, `atomic()` batching/rollback).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { atomic, buildEphemeralCell, localCell } from "../cell.ts"
import { hash } from "../hash.ts"
import { stableStringify } from "../stable-stringify.ts"
import {
  MemoryCellStorage,
  setCellStorage,
  _resetCellStorage,
  getCellStorage,
} from "../../runtime/cell-storage.ts"
import { _clearInvalidationRegistry, queryMatchingTs } from "../../runtime/invalidation-registry.ts"
import { runWithRequestAsync } from "../../runtime/context.ts"

function seedCell(id: string, args: object, value: unknown): void {
  getCellStorage().write("default", id, hash(stableStringify(args)), value)
}

function readCell(id: string, args: object): unknown {
  return getCellStorage().read("default", id, hash(stableStringify(args)))
}

beforeEach(() => {
  setCellStorage(new MemoryCellStorage())
  _clearInvalidationRegistry()
})

afterEach(() => {
  _resetCellStorage()
  _clearInvalidationRegistry()
})

describe("compose under concurrency", () => {
  it("100 concurrent updates on one (cell, partition) land exactly 100", async () => {
    const counter = localCell({
      id: "test.upd.race",
      shape: "number",
      initial: 0,
    })
    const bound = counter.with({ k: "a" })
    await Promise.all(Array.from({ length: 100 }, () => bound.update((n) => n + 1)))
    expect(readCell("test.upd.race", { k: "a" })).toBe(100)
  })

  it("100 concurrent updates against a cold loader compose over the loaded value — the loader never clobbers a landed increment", async () => {
    let loaderCalls = 0
    const counter = localCell({
      id: "test.upd.cold-race",
      shape: "number",
      initial: 0,
      load: async () => {
        loaderCalls++
        // Real async gap: every concurrent update enters its warm phase
        // before any loader resolves, so the still-cold re-check is the
        // only thing standing between the loader result and a clobber.
        await new Promise((r) => setTimeout(r, 5))
        return 40
      },
    })
    const bound = counter.with({ k: "x" })
    await Promise.all(Array.from({ length: 100 }, () => bound.update((n) => n + 1)))
    expect(readCell("test.upd.cold-race", { k: "x" })).toBe(140)
    expect(loaderCalls).toBeGreaterThanOrEqual(1)
  })
})

describe("atomic() composability", () => {
  it("an update inside atomic joins the batch and reads the overlay", async () => {
    const c = localCell({ id: "test.upd.atomic", shape: "number", initial: 0 })
    await atomic(async () => {
      await c.with({ k: "a" }).set(5)
      // The overlay read: without the transaction view this would see
      // cold storage (0) and commit 1 — seeing 6 proves the update
      // composed over the buffered set.
      await c.with({ k: "a" }).update((n) => n + 1)
    })
    expect(readCell("test.upd.atomic", { k: "a" })).toBe(6)
    expect(queryMatchingTs(["cell:test.upd.atomic"], { k: "a" })).toBeGreaterThan(0)
  })

  it("a throw rolls updates back with the batch — storage and registry untouched", async () => {
    const c = localCell({ id: "test.upd.rollback", shape: "number", initial: 0 })
    seedCell("test.upd.rollback", { k: "a" }, 1)
    await expect(
      atomic(async () => {
        await c.with({ k: "a" }).update((n) => n + 1)
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(readCell("test.upd.rollback", { k: "a" })).toBe(1)
    expect(queryMatchingTs(["cell:test.upd.rollback"], { k: "a" })).toBe(0)
  })
})

describe("update shares set's downstream path", () => {
  it("shape-validates the updater's RESULT — a bad result commits nothing and bumps nothing", async () => {
    const c = localCell({ id: "test.upd.shape", shape: "number", initial: 0 })
    seedCell("test.upd.shape", { k: "a" }, 3)
    await expect(
      c.with({ k: "a" }).update((() => "banana") as unknown as (n: number) => number),
    ).rejects.toThrow(TypeError)
    expect(readCell("test.upd.shape", { k: "a" })).toBe(3)
    expect(queryMatchingTs(["cell:test.upd.shape"], { k: "a" })).toBe(0)
  })

  it("runs the cell's `write` canonicalisation on the updater's result", async () => {
    const c = localCell({
      id: "test.upd.canon",
      shape: "string",
      initial: "",
      write: (s) => s.toUpperCase(),
    })
    seedCell("test.upd.canon", { k: "a" }, "AB")
    await c.with({ k: "a" }).update((s) => s + "c")
    expect(readCell("test.upd.canon", { k: "a" })).toBe("ABC")
  })

  it("rejects an async updater — the gap it would reopen is the whole point", async () => {
    const c = localCell({ id: "test.upd.async", shape: "number", initial: 0 })
    await expect(
      c.with({ k: "a" }).update((async (n: number) => n + 1) as unknown as (n: number) => number),
    ).rejects.toThrow(/thenable/)
    expect(readCell("test.upd.async", { k: "a" })).toBeUndefined()
  })
})

describe("partition scoping", () => {
  it("an update at one partition leaves siblings untouched and fires a partition-scoped bump", async () => {
    const c = localCell({ id: "test.upd.iso", shape: "number", initial: 0 })
    seedCell("test.upd.iso", { k: "a" }, 1)
    seedCell("test.upd.iso", { k: "b" }, 10)
    await c.with({ k: "a" }).update((n) => n + 1)
    expect(readCell("test.upd.iso", { k: "a" })).toBe(2)
    expect(readCell("test.upd.iso", { k: "b" })).toBe(10)
    expect(queryMatchingTs(["cell:test.upd.iso"], { k: "a" })).toBeGreaterThan(0)
    expect(queryMatchingTs(["cell:test.upd.iso"], { k: "b" })).toBe(0)
  })

  it("module-form update derives the partition from the cell's own callback against the caller's request", async () => {
    const notes = localCell({
      id: "test.upd.module",
      shape: "string",
      initial: "",
      partition: ({ cookies }) => ({ sid: cookies.sid ?? "anon" }),
    })
    await runWithRequestAsync(
      new Request("http://t/", { headers: { cookie: "sid=u1" } }),
      async () => {
        await notes.update((s) => s + "!")
      },
    )
    expect(readCell("test.upd.module", { sid: "u1" })).toBe("!")
    expect(readCell("test.upd.module", { sid: "anon" })).toBeUndefined()
  })

  it("module-form update accepts an explicit partition override, like set", async () => {
    const notes = localCell({ id: "test.upd.override", shape: "string", initial: "" })
    await notes.update((s) => s + "?", { partition: { sid: "u2" } })
    expect(readCell("test.upd.override", { sid: "u2" })).toBe("?")
  })
})

describe("value-keyed (keyOf) cells", () => {
  it("module-form update throws — the identity lives in the value; bind it via .with(key)", async () => {
    const frag = buildEphemeralCell<{ id: number; n: number } | null>(
      "test.upd.keyed",
      null,
      undefined,
      (v) => ({ id: v!.id }),
    )
    await expect(frag.update((v) => v)).rejects.toThrow(/value-keyed/)
  })

  it("bound-form update composes at the bound identity", async () => {
    const frag = buildEphemeralCell<{ id: number; n: number } | null>(
      "test.upd.keyed-bound",
      null,
      undefined,
      (v) => ({ id: v!.id }),
    )
    await runWithRequestAsync(new Request("http://t/"), async () => {
      frag.with({ id: 1 }).hydrate({ id: 1, n: 1 })
      await frag.with({ id: 1 }).update((v) => ({ id: 1, n: (v?.n ?? 0) + 1 }))
      expect(frag.peek({ id: 1 })).toEqual({ id: 1, n: 2 })
    })
  })
})
