/**
 * Verifies the server-context patch threads a value parent→child through
 * NESTED ASYNC components in a SINGLE Flight document — the capability the
 * `parent` prop replaces. Exercises the patched vendor via the public shim.
 *
 * The patch rides React's own task graph (`createTask` inherits, `retryTask`
 * save/restores the rendering task), so it survives `await` and isolates
 * siblings — neither of which an `AsyncLocalStorage` can do (see
 * [[partial-context]]).
 */

import { describe, expect, it } from "vitest"
import type { ReactNode } from "react"
import { renderServerToFlight, flightToString } from "../../test/rsc-server.ts"
import {
  _childContext,
  captureCurrentTask,
  getAmbientParent,
  setTaskChildContext,
} from "../partial-context.ts"

const seen: Array<{ tag: string; parentPath: string }> = []

async function Node({ tag, children }: { tag: string; children?: ReactNode }) {
  // --- synchronous top: capture task, read parent, scope children ---
  const task = captureCurrentTask()
  const parent = getAmbientParent()
  seen.push({ tag, parentPath: parent.path.join("/") })
  setTaskChildContext(task, _childContext(parent, tag))
  // --- async work, like a parton awaiting vary/schema/cells ---
  await new Promise((r) => setTimeout(r, 1))
  return <div data-tag={tag}>{children}</div>
}

describe("server-context patch: threads through nested async (single document)", () => {
  it("accumulates parent.path O → O/M → O/M/I", async () => {
    seen.length = 0
    await flightToString(
      renderServerToFlight(
        <Node tag="O">
          <Node tag="M">
            <Node tag="I" />
          </Node>
        </Node>,
      ),
    )
    const byTag = Object.fromEntries(seen.map((s) => [s.tag, s.parentPath]))
    expect(byTag.O).toBe("") // root sees ROOT
    expect(byTag.M).toBe("O") // M's parent is O — threaded across O's await
    expect(byTag.I).toBe("O/M") // I's parent is O→M
  })

  it("isolates siblings — B sees P, not A (the enterWith failure)", async () => {
    seen.length = 0
    await flightToString(
      renderServerToFlight(
        <Node tag="P">
          <Node tag="A" />
          <Node tag="B" />
        </Node>,
      ),
    )
    const byTag = Object.fromEntries(seen.map((s) => [s.tag, s.parentPath]))
    expect(byTag.A).toBe("P")
    expect(byTag.B).toBe("P") // NOT "P/A" — retryTask save/restore isolates siblings
  })
})

// ── carrier survives await even when children are scoped AFTER the load ──
//
// The real parton wrapper captures its task + reads `parent` at the sync
// top, then `await`s schema/cell resolution, and only THEN scopes its
// children (the captured task object is stable, so the write is valid
// post-await). This is the "load data, then render the child" shape — the
// one most likely to be suspected of dropping context. It doesn't: the
// inherited value rides the task graph, and a child's task created while
// the (resumed) parent's model renders still inherits the scoped context.
const loaded: Array<{ tag: string; parent: string }> = []

async function LoadThenScope({ tag, children }: { tag: string; children?: ReactNode }) {
  const task = captureCurrentTask()
  const parent = getAmbientParent()
  loaded.push({ tag, parent: parent.path.join("/") })
  await new Promise((r) => setTimeout(r, 5)) // load data before the child exists
  setTaskChildContext(task, _childContext(parent, tag)) // scope AFTER the await
  return <div data-tag={tag}>{children}</div>
}

describe("server-context: inherited value survives await when scoped post-load", () => {
  it("threads O → O/M → O/M/I though each scopes its children after its own await", async () => {
    loaded.length = 0
    await flightToString(
      renderServerToFlight(
        <LoadThenScope tag="O">
          <LoadThenScope tag="M">
            <LoadThenScope tag="I" />
          </LoadThenScope>
        </LoadThenScope>,
      ),
    )
    const byTag = Object.fromEntries(loaded.map((s) => [s.tag, s.parent]))
    expect(byTag.O).toBe("")
    expect(byTag.M).toBe("O")
    expect(byTag.I).toBe("O/M")
  })
})

describe("server-context: sibling scopes isolate their child contexts", () => {
  it("X under P sees P and Y under Q sees Q — sibling scopes don't clobber", async () => {
    // Each async scope captures its OWN task at its sync top, so two scopes
    // at the same level don't share a row and can't overwrite each other's
    // child context — even though one's post-await pointer drifts onto the
    // other's task (see the drift test below). What keeps them correct is
    // that each scopes children on its captured handle, not a re-read.
    loaded.length = 0
    await flightToString(
      renderServerToFlight(
        <>
          <LoadThenScope tag="P">
            <LoadThenScope tag="X" />
          </LoadThenScope>
          <LoadThenScope tag="Q">
            <LoadThenScope tag="Y" />
          </LoadThenScope>
        </>,
      ),
    )
    const byTag = Object.fromEntries(loaded.map((s) => [s.tag, s.parent]))
    expect(byTag.P).toBe("")
    expect(byTag.Q).toBe("")
    expect(byTag.X).toBe("P")
    expect(byTag.Y).toBe("Q")
  })
})

// ── reads survive await (ALS-backed) ─────────────────────────────────────
//
// `captureCurrentTask()` / `getAmbientParent()` read the parton
// `AsyncLocalStorage`, which the patched render site enters per component
// (`partonStorage.run(task, …)`). Because an ALS store follows the JS
// engine's post-`await` continuation, a component reads its OWN task both
// before and after its awaits, and sibling renders that touch the store in
// between don't bleed in. These tests pin that guarantee — the reason a
// parton can read its parent anywhere in its render, not just at the top.
const reads: Array<{ tag: string; sameTask: boolean; topParent: string; afterParent: string }> = []

async function Reader({ tag, ms }: { tag: string; ms: number }) {
  const topTask = captureCurrentTask()
  const topParent = getAmbientParent().path.join("/")
  await new Promise((r) => setTimeout(r, ms))
  const afterTask = captureCurrentTask()
  const afterParent = getAmbientParent().path.join("/")
  reads.push({ tag, sameTask: topTask === afterTask, topParent, afterParent })
  return <div data-tag={tag} />
}

describe("server-context: reads survive await (ALS-backed)", () => {
  it("staggered sibling awaits — each reader reads its own task before AND after", async () => {
    reads.length = 0
    await flightToString(
      renderServerToFlight(
        <LoadThenScope tag="P">
          <Reader tag="A" ms={20} />
          <Reader tag="B" ms={5} />
          <Reader tag="C" ms={12} />
        </LoadThenScope>,
      ),
    )
    expect(reads.every((o) => o.topParent === "P")).toBe(true) // correct at the top
    expect(reads.every((o) => o.afterParent === "P")).toBe(true) // STILL correct after await
    expect(reads.every((o) => o.sameTask)).toBe(true) // same task object — no drift
  })

  it("a reader reads its own scope after await, not a concurrently-rendering sibling scope's", async () => {
    // X (under P, long await) resumes after Y/Z (under Q) have rendered. With
    // the old global pointer X would read "Q"; the ALS keeps it on "P".
    reads.length = 0
    await flightToString(
      renderServerToFlight(
        <>
          <LoadThenScope tag="P">
            <Reader tag="X" ms={20} />
          </LoadThenScope>
          <LoadThenScope tag="Q">
            <Reader tag="Y" ms={5} />
            <Reader tag="Z" ms={12} />
          </LoadThenScope>
        </>,
      ),
    )
    const x = reads.find((o) => o.tag === "X")!
    expect(x.topParent).toBe("P")
    expect(x.afterParent).toBe("P") // NOT "Q"
  })
})
