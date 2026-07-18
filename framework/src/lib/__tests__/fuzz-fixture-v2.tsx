/**
 * The v2 convergence fuzzer's fixture — the v1 parton shapes
 * (match-gated variants, cell readers, cullable pairs, a nested
 * cullable wrapper) PLUS the async-body geometry the v1 fixture
 * deliberately lacks:
 *
 *   - `fz-async-leaf` — an ASYNC Render body with no nested partons.
 *     Its children cross the wire as an outlined promise row (`$@`),
 *     so every commit of it exercises the merge walks' thenable arm
 *     and the settlement re-walk (F8's territory), and its fp-set is
 *     the re-store surface e728964's identity check protects.
 *   - `fz-async-wrap` / `fz-async-inner` — an async parent carrying an
 *     addressable child: the exact auction-lot geometry (a parent lane
 *     fp-skips the child to a hole INSIDE the promise row).
 *
 * Stamps stay pure functions of tracked reads, so a cold render at the
 * same request state reproduces every stamp byte-for-byte. See
 * `fuzz-convergence-v2.rsc.test.tsx` and
 * `docs/internals/convergence-fuzzing.md`.
 */

import type { ReactNode } from "react"
import { _resetLaneCommitStateForTest } from "../partial-cache.ts"
import { _resetClientStateForTest } from "../partial-client-state.ts"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { searchParam } from "../server-hooks.ts"
import type { FuzzFixtureV2 } from "../../test/fuzz-harness-v2.ts"
import {
  Alpha,
  Beta,
  CullA,
  CullB,
  fzCellA,
  fzCellB,
  Gated,
  isolate as isolateV1,
  Shared,
  Wrap,
  writeCell,
} from "./fuzz-fixture.tsx"

// ─── The async shapes ────────────────────────────────────────────────

const AsyncLeaf = parton(async function FzAsyncLeafRender(_: RenderArgs) {
  // The await is what makes the body's return value a genuinely
  // pending Promise at wrap time — the outlined-row ($@) geometry.
  await Promise.resolve()
  const b = await fzCellB.resolve()
  return <div>{`[S|fz-async-leaf|b=${b.value}]`}</div>
})

const AsyncInner = parton(async function FzAsyncInnerRender(_: RenderArgs) {
  const q = searchParam("q") ?? ""
  const b = await fzCellB.resolve()
  return <div>{`[S|fz-async-inner|q=${q}.b=${b.value}]`}</div>
})

const AsyncWrap = parton(async function FzAsyncWrapRender(_: RenderArgs) {
  await Promise.resolve()
  const a = await fzCellA.resolve()
  return (
    <div>
      {`[S|fz-async-wrap|a=${a.value}]`}
      <AsyncInner />
    </div>
  )
})

function FuzzPageV2(): ReactNode {
  return (
    <PartialRoot>
      <Shared />
      <Alpha />
      <Beta />
      <Gated />
      <CullA />
      <CullB />
      <Wrap />
      <AsyncWrap />
      <AsyncLeaf />
    </PartialRoot>
  )
}

// ─── The fixture wiring ──────────────────────────────────────────────

export const fixtureV2: FuzzFixtureV2 = {
  page: FuzzPageV2,
  universeIds: [
    "fz-shared",
    "fz-alpha",
    "fz-beta",
    "fz-gated",
    "fz-cull-a",
    "fz-cull-b",
    "fz-wrap",
    "fz-inner",
    "fz-async-wrap",
    "fz-async-inner",
    "fz-async-leaf",
  ],
  cullableIds: ["fz-cull-a", "fz-cull-b", "fz-wrap"],
  initialVisible: ["fz-cull-a", "fz-cull-b", "fz-wrap"],
  parentOf: { "fz-inner": "fz-wrap", "fz-async-inner": "fz-async-wrap" },
  foldDriftAllowed: new Set(["fz-wrap", "fz-async-wrap"]),
  urls: ["/alpha?q=x", "/alpha", "/beta?q=y", "/beta", "/alpha?q=y"],
  refetchLabels: ["fz-shared", "fz-inner", "fz-async-inner", "fz-async-leaf"],
  writes: [
    { name: "cellA", apply: (scope, url, v) => writeCell(fzCellA, scope, url, v) },
    { name: "cellB", apply: (scope, url, v) => writeCell(fzCellB, scope, url, v) },
  ],
}

/** Trial isolation: the v1 server-side reset (registries, invalidation,
 *  cell storage) plus the CLIENT-side module state the v2 loop drives
 *  for real (partial cache, fingerprints, template, lane generations). */
export function isolateV2(): void {
  isolateV1()
  _resetClientStateForTest()
  _resetLaneCommitStateForTest()
}
