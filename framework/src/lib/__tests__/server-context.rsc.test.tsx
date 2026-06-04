/**
 * Verifies the framework's parton parent — the reserved `ParentContext` entry
 * on the server-context channel — threads parent→child through NESTED ASYNC
 * components in a SINGLE Flight document. Each scope reads its parent with
 * `getServerContext(ParentContext)` and scopes its descendants by rendering
 * them inside `<ParentContext value>`, exactly as the real parton wrapper /
 * `<Frame>` do.
 *
 * The value rides React's own task graph (`createTask` inherits, `retryTask`
 * save/restores the rendering task), so it survives `await` and isolates
 * siblings (see [[partial-context]] / [[server-context]]).
 */

import { describe, expect, it } from "vitest"
import type { ReactNode } from "react"
import { renderServerToFlight, flightToString } from "../../test/rsc-server.ts"
import { _childContext, ParentContext } from "../partial-context.ts"
import { getServerContext } from "../server-context.ts"

const seen: Array<{ tag: string; parentPath: string }> = []

async function Node({ tag, children }: { tag: string; children?: ReactNode }) {
  const parent = getServerContext(ParentContext)
  seen.push({ tag, parentPath: parent.path.join("/") })
  // async work, like a parton awaiting vary/schema/cells
  await new Promise((r) => setTimeout(r, 1))
  // scope descendants: they inherit this node's child context as parent
  return (
    <ParentContext value={_childContext(parent, tag)}>
      <div data-tag={tag}>{children}</div>
    </ParentContext>
  )
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

// ── carrier survives await: scope is set up only after a load ──
//
// The real parton wrapper reads `parent`, `await`s schema/cell resolution,
// and only THEN returns its body wrapped in `<ParentContext value>` — the
// "load data, then render the child" shape, the one most likely to be
// suspected of dropping context. It doesn't: the value rides the task graph,
// and a child's task created while the (resumed) parent's model renders still
// inherits the scoped context.
const loaded: Array<{ tag: string; parent: string }> = []

async function LoadThenScope({ tag, children }: { tag: string; children?: ReactNode }) {
  const parent = getServerContext(ParentContext)
  loaded.push({ tag, parent: parent.path.join("/") })
  await new Promise((r) => setTimeout(r, 5)) // load data before scoping the child
  return (
    <ParentContext value={_childContext(parent, tag)}>
      <div data-tag={tag}>{children}</div>
    </ParentContext>
  )
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
    // Each scope wraps only its OWN children in `<ParentContext value>`, so
    // two scopes at the same level scope disjoint subtrees and can't leak
    // into each other — X (under P) sees P, Y (under Q) sees Q.
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
// `getServerContext` reads the parton `AsyncLocalStorage`, which the patched
// render site enters per component (`partonStorage.run(task, …)`). Because an
// ALS store follows the JS engine's post-`await` continuation, a component
// reads context both before and after its awaits, and sibling renders that
// touch the store in between don't bleed in. These tests pin that guarantee —
// the reason a parton can read its parent anywhere in its render.
const reads: Array<{ tag: string; topParent: string; afterParent: string }> = []

async function Reader({ tag, ms }: { tag: string; ms: number }) {
  const topParent = getServerContext(ParentContext).path.join("/")
  await new Promise((r) => setTimeout(r, ms))
  const afterParent = getServerContext(ParentContext).path.join("/")
  reads.push({ tag, topParent, afterParent })
  return <div data-tag={tag} />
}

describe("server-context: reads survive await (ALS-backed)", () => {
  it("staggered sibling awaits — each reader reads the same value before AND after", async () => {
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
  })

  it("a reader reads its own scope after await, not a concurrently-rendering sibling scope's", async () => {
    // X (under P, long await) resumes after Y/Z (under Q) have rendered; the
    // ALS keeps X's read on "P" regardless of what rendered in between.
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
