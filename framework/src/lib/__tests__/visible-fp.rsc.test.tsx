/**
 * Probe: `visible()` is a read-tracked culling signal. A parton that
 * reads it records `visible:<id>` and its fingerprint folds the
 * per-request `?visible=` membership via store-and-reread — so entering
 * or leaving the `?visible=` set moves the fp (the parton self-refetches),
 * while a spec that never calls `visible()` is invariant to it (the read
 * IS the dependency, exactly like `searchParam()` / a cell).
 *
 * The `undefined` (cold / no `?visible=`) state is a distinct fold token
 * from in/out, so the FIRST client report also moves the fp — the cold
 * paint commits to its measured state.
 */

import { describe, expect, it, beforeEach } from "vitest"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { clearRegistry } from "../partial-registry.ts"
import { visible } from "../server-hooks.ts"

function fpById(flight: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /"partialId":"([^"]+)","partialFingerprint":"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(flight)) !== null) out.set(m[1], m[2])
  return out
}
async function fpAt(url: string, node: React.ReactNode, id: string): Promise<string | undefined> {
  const { stream } = await renderWithRequest(url, node)
  const text = await new Response(stream).text()
  return fpById(text).get(id)
}

// Reads visible() and branches — the cullable spec.
const Culled = parton(
  function CulledRender(_: RenderArgs) {
    const v = visible()
    return <div data-testid="culled">{v === undefined ? "cold" : v ? "full" : "skeleton"}</div>
  },
  { selector: "#culled-probe" },
)

// Never reads visible() — the control. ?visible= must not move its fp.
const Plain = parton(
  function PlainRender(_: RenderArgs) {
    return <div data-testid="plain" />
  },
  { selector: "#plain-probe" },
)

describe("visible(): read-tracked culling folds into the fingerprint", () => {
  beforeEach(() => clearRegistry("all"))

  it("entering / leaving the ?visible= set moves the fp; the cold state is distinct", async () => {
    const tree = (
      <PartialRoot>
        <Culled />
      </PartialRoot>
    )
    // r1 is cold (records visible:culled-probe); the warm renders fold its
    // value via store-and-reread. Warm up at each state, then compare.
    await fpAt("http://t/x", tree, "culled-probe") // cold — records the dep
    const fpCold = await fpAt("http://t/x", tree, "culled-probe") // u
    const fpIn = await fpAt("http://t/x?visible=culled-probe", tree, "culled-probe") // 1
    const fpOut = await fpAt("http://t/x?visible=other", tree, "culled-probe") // 0
    const fpIn2 = await fpAt("http://t/x?visible=culled-probe", tree, "culled-probe") // 1 again

    expect(fpCold).toBeDefined()
    expect(fpIn).not.toBe(fpCold) // first client report (u→1) moved the fp
    expect(fpOut).not.toBe(fpIn) // leaving view (1→0) moved the fp
    expect(fpOut).not.toBe(fpCold) // measured-out (0) ≠ unmeasured (u)
    expect(fpIn2).toBe(fpIn) // same state → same fp (no churn)
  })

  it("a spec that never reads visible() is invariant to ?visible=", async () => {
    const tree = (
      <PartialRoot>
        <Plain />
      </PartialRoot>
    )
    await fpAt("http://t/x", tree, "plain-probe")
    const fpA = await fpAt("http://t/x", tree, "plain-probe")
    const fpB = await fpAt("http://t/x?visible=plain-probe", tree, "plain-probe")
    expect(fpA).toBeDefined()
    expect(fpB).toBe(fpA) // no visible() read → ?visible= is invisible to the fp
  })
})
