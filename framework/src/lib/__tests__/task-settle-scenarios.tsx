/**
 * Shared scenario bodies for the per-parton subtree-settlement tests
 * (`task-settle.rsc.test.tsx` / `task-settle.rsc-prod.test.tsx`). The dev
 * and prod Flight builds schedule tasks differently — the prod build is
 * exactly where a settle hook that only works against the dev build's task
 * granularity would silently diverge — so the same behaviors are asserted
 * against both; the scenarios live here so the two tiers can't drift apart.
 *
 * Each scenario records an ordered event log — settle callbacks, loader
 * milestones — and asserts relative order, so the assertions hold no matter
 * how a build interleaves its task queue. Each also asserts exactly-once
 * firing: the settle refcount decrements on success, error, AND abort paths,
 * and a leak or double-decrement would show up as a missing or duplicated
 * event.
 */

import { expect } from "vitest"
import { parton, type RenderArgs } from "../partial.tsx"
import { _onPartonSettled } from "../server-context.ts"
import { renderWithRequest } from "../../test/rsc-server.ts"

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const silentError = () => {}

/** A fast parton settles while a slow sibling's loader is still pending —
 *  settlement is per-parton, not per-request. */
export async function siblingSettleScenario(): Promise<void> {
  const events: string[] = []
  const Fast = parton(function SettleSibFastRender({}: RenderArgs) {
    _onPartonSettled(() => events.push("fast-settled"))
    return <span>fast</span>
  })
  const Slow = parton(async function SettleSibSlowRender({}: RenderArgs) {
    _onPartonSettled(() => events.push("slow-settled"))
    await delay(50)
    events.push("slow-loaded")
    return <span>slow</span>
  })
  await renderWithRequest(
    "http://t/settle-sib",
    <div>
      <Fast />
      <Slow />
    </div>,
  )
  expect(events.filter((e) => e === "fast-settled")).toHaveLength(1)
  expect(events.filter((e) => e === "slow-settled")).toHaveLength(1)
  // The fast parton settled while the slow sibling's loader was pending.
  expect(events.indexOf("fast-settled")).toBeLessThan(events.indexOf("slow-loaded"))
  // The slow parton settled only after its loader resolved.
  expect(events.indexOf("slow-settled")).toBeGreaterThan(events.indexOf("slow-loaded"))
}

/** A parent parton's subtree includes its nested child parton: the parent
 *  settles only after the child does, even though the parent's own model
 *  serialized immediately. Own-task completion is not subtree settlement. */
export async function nestedSettleScenario(): Promise<void> {
  const events: string[] = []
  const Child = parton(async function SettleNestChildRender({}: RenderArgs) {
    _onPartonSettled(() => events.push("child-settled"))
    await delay(50)
    events.push("child-loaded")
    return <span>child</span>
  })
  const Parent = parton(function SettleNestParentRender({}: RenderArgs) {
    _onPartonSettled(() => events.push("parent-settled"))
    return (
      <div>
        <Child />
      </div>
    )
  })
  await renderWithRequest("http://t/settle-nest", <Parent />)
  expect(events.filter((e) => e === "child-settled")).toHaveLength(1)
  expect(events.filter((e) => e === "parent-settled")).toHaveLength(1)
  // The parent's own body finished immediately; it must still wait for the
  // nested parton's loader.
  expect(events.indexOf("parent-settled")).toBeGreaterThan(events.indexOf("child-loaded"))
  // The inner scope drains before the outer: child settles first.
  expect(events.indexOf("child-settled")).toBeLessThan(events.indexOf("parent-settled"))
}

/** A descendant that throws still settles the parton — the errored task's
 *  terminal transition decrements the same refcount a completion does. */
export async function errorSettleScenario(): Promise<void> {
  const events: string[] = []
  async function Boom(): Promise<React.ReactNode> {
    await delay(10)
    events.push("boom-thrown")
    throw new Error("settle-boom")
  }
  const Errory = parton(function SettleErrRender({}: RenderArgs) {
    _onPartonSettled(() => events.push("err-settled"))
    return (
      <div>
        <Boom />
      </div>
    )
  })
  await renderWithRequest("http://t/settle-err", <Errory />, { onError: silentError })
  // Give a hypothetical double-fire (a second decrement path racing the
  // first) the chance to surface before counting.
  await delay(20)
  expect(events.filter((e) => e === "err-settled")).toHaveLength(1)
  expect(events.indexOf("err-settled")).toBeGreaterThan(events.indexOf("boom-thrown"))
}

/** An aborted render settles every still-open parton exactly once — the
 *  abort sweep's `abortTask` is a terminal transition like any other, so no
 *  counter leaks and no callback fires twice. */
export async function abortSettleScenario(): Promise<void> {
  const events: string[] = []
  const Fast = parton(function SettleAbortFastRender({}: RenderArgs) {
    _onPartonSettled(() => events.push("fast-settled"))
    return <span>fast</span>
  })
  const Hang = parton(async function SettleAbortHangRender({}: RenderArgs) {
    _onPartonSettled(() => events.push("hang-settled"))
    events.push("hang-started")
    // Never resolves — only the abort can terminate this subtree's task.
    await new Promise<never>(() => {})
    return null
  })
  const ac = new AbortController()
  const timer = setTimeout(() => {
    events.push("abort-fired")
    ac.abort(new Error("settle-abort"))
  }, 50)
  await renderWithRequest(
    "http://t/settle-abort",
    <div>
      <Fast />
      <Hang />
    </div>,
    { signal: ac.signal, onError: silentError },
  )
  clearTimeout(timer)
  // Let the deferred abort finalization (`finishAbort` runs on a timer) do
  // any late work — a leaked counter or second decrement would fire here.
  await delay(20)
  expect(events.filter((e) => e === "fast-settled")).toHaveLength(1)
  expect(events.filter((e) => e === "hang-settled")).toHaveLength(1)
  // The fast parton settled on its own, before the abort.
  expect(events.indexOf("fast-settled")).toBeLessThan(events.indexOf("abort-fired"))
  // The hanging parton settled BECAUSE of the abort.
  expect(events.indexOf("hang-settled")).toBeGreaterThan(events.indexOf("abort-fired"))
}
