/**
 * Write authorization — `writeGuard` on the cell definition.
 *
 * The properties under test: a denied write throws the typed
 * `CellWriteDenied` BEFORE anything commits (storage untouched, no
 * invalidation bump), the guard sees the caller's request scope plus
 * the write's resolved partition args, enforcement covers every write
 * path through the choke point (`set`, `update`, the batch action,
 * `atomic()` — where a deny rolls the whole batch back), and guard
 * evaluation never pollutes the rendering read-set (the guard reads
 * the partition scope, not the tracked hooks, so its inputs fold into
 * no parton's fingerprint).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { atomic, CellWriteDenied, localCell } from "../cell.ts"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { hash } from "../hash.ts"
import { stableStringify } from "../stable-stringify.ts"
import {
  MemoryCellStorage,
  setCellStorage,
  _resetCellStorage,
  getCellStorage,
} from "../../runtime/cell-storage.ts"
import { _clearInvalidationRegistry, queryMatchingTs } from "../../runtime/invalidation-registry.ts"
import { __cellWriteBatch } from "../../runtime/cell-actions.ts"
import { runWithRequestAsync } from "../../runtime/context.ts"
import { renderWithRequest } from "../../test/rsc-server.ts"

function seedCell(id: string, args: object, value: unknown): void {
  getCellStorage().write("default", id, hash(stableStringify(args)), value)
}

function readCell(id: string, args: object): unknown {
  return getCellStorage().read("default", id, hash(stableStringify(args)))
}

function atRequest(cookie: string | undefined, fn: () => Promise<void>): Promise<unknown> {
  return runWithRequestAsync(
    new Request("http://t/", cookie === undefined ? undefined : { headers: { cookie } }),
    fn,
  )
}

beforeEach(() => {
  setCellStorage(new MemoryCellStorage())
  _clearInvalidationRegistry()
})

afterEach(() => {
  _resetCellStorage()
  _clearInvalidationRegistry()
})

describe("writeGuard — deny/allow", () => {
  const guarded = localCell({
    id: "test.guard.note",
    shape: "string",
    initial: "initial",
    writeGuard: ({ cookies }) => cookies.role === "admin",
  })

  it("a denied write throws the typed CellWriteDenied — storage and registry untouched", async () => {
    seedCell(guarded.id, {}, "before")
    await atRequest("role=viewer", async () => {
      await expect(guarded.set("after")).rejects.toBeInstanceOf(CellWriteDenied)
      await expect(guarded.set("after")).rejects.toMatchObject({
        name: "CellWriteDenied",
        cellId: "test.guard.note",
      })
    })
    expect(readCell(guarded.id, {})).toBe("before")
    expect(queryMatchingTs(["cell:test.guard.note"], {})).toBe(0)
  })

  it("an authorized write commits and bumps as usual", async () => {
    await atRequest("role=admin", async () => {
      await guarded.set("after")
    })
    expect(readCell(guarded.id, {})).toBe("after")
    expect(queryMatchingTs(["cell:test.guard.note"], {})).toBeGreaterThan(0)
  })
})

describe("writeGuard — resolved partition args", () => {
  const owned = localCell({
    id: "test.guard.owned",
    shape: "string",
    initial: "",
    // Only the partition's owner may write it: the target args are the
    // guard's second input, so a cross-partition write is denied even
    // though the caller is a valid session.
    writeGuard: ({ cookies }, args) => args.sid === cookies.sid,
  })

  it("allows the caller's own partition, denies another session's", async () => {
    await atRequest("sid=u1", async () => {
      await owned.with({ sid: "u1" }).set("mine")
      await expect(owned.with({ sid: "u2" }).set("theirs")).rejects.toBeInstanceOf(CellWriteDenied)
    })
    expect(readCell(owned.id, { sid: "u1" })).toBe("mine")
    expect(readCell(owned.id, { sid: "u2" })).toBeUndefined()
  })
})

describe("writeGuard — every path passes the choke point", () => {
  const guarded = localCell({
    id: "test.guard.paths",
    shape: "number",
    initial: 0,
    writeGuard: ({ cookies }) => cookies.role === "admin",
  })

  it("update() is guarded — a deny commits nothing", async () => {
    seedCell(guarded.id, { k: "a" }, 3)
    await atRequest("role=viewer", async () => {
      await expect(guarded.with({ k: "a" }).update((n) => n + 1)).rejects.toBeInstanceOf(
        CellWriteDenied,
      )
    })
    expect(readCell(guarded.id, { k: "a" })).toBe(3)
    expect(queryMatchingTs(["cell:test.guard.paths"], { k: "a" })).toBe(0)
  })

  it("the batch action is guarded — a denied entry rejects the batch", async () => {
    await atRequest("role=viewer", async () => {
      await expect(
        __cellWriteBatch([{ id: guarded.id, value: 7, partition: { partition: { k: "b" } } }]),
      ).rejects.toBeInstanceOf(CellWriteDenied)
    })
    expect(readCell(guarded.id, { k: "b" })).toBeUndefined()
  })

  it("a deny inside atomic() rolls the whole batch back", async () => {
    const open = localCell({ id: "test.guard.open", shape: "string", initial: "" })
    seedCell(open.id, {}, "before")
    await atRequest("role=viewer", async () => {
      await expect(
        atomic(async () => {
          await open.set("buffered")
          await guarded.with({ k: "c" }).set(1)
        }),
      ).rejects.toBeInstanceOf(CellWriteDenied)
    })
    // The unguarded write buffered in the overlay and was discarded
    // with the batch — storage and registry show neither write.
    expect(readCell(open.id, {})).toBe("before")
    expect(readCell(guarded.id, { k: "c" })).toBeUndefined()
    expect(queryMatchingTs(["cell:test.guard.open"], {})).toBe(0)
  })
})

describe("writeGuard — no read-set pollution", () => {
  it("the guard's scope reads fold into no fingerprint — fp is stable across guard-input changes", async () => {
    const audited = localCell({
      id: "test.guard.audit",
      shape: "string",
      initial: "",
      // The guard reads the role cookie. If that read polluted the
      // rendering read-set, the writing parton would record a
      // `cookie:role` dep and its fp would shift when the role changes.
      writeGuard: ({ cookies }) => cookies.role !== undefined,
    })
    const Page = parton(
      async function GuardAuditRender(_: RenderArgs) {
        await audited.set("visited")
        return <span>ok</span>
      },
      { match: "/guard-audit" },
    )
    const tree = (
      <PartialRoot>
        <Page />
      </PartialRoot>
    )
    const flightAt = async (cookie: string): Promise<string> => {
      const { stream } = await renderWithRequest("http://t/guard-audit", tree, {
        headers: { cookie },
      })
      return await new Response(stream).text()
    }
    // Warm once (cold record), then capture the settled fp.
    await flightAt("role=r1")
    const first = await flightAt("role=r1")
    const fp1 = first.match(/partialFingerprint":"([0-9a-f]+)/)![1]
    // A different guard input must NOT move the fp — the guard read is
    // request-scope, never a tracked dep.
    const second = await flightAt("role=r2")
    const fp2 = second.match(/partialFingerprint":"([0-9a-f]+)/)![1]
    expect(fp2).toEqual(fp1)
  })
})
