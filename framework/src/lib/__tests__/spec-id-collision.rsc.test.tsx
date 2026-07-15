/**
 * Spec-id collision gate — two DISTINCT specs claiming one catalog id
 * (e.g. two Render functions sharing a NAME, so both auto-derive the
 * same id) throw at construct time instead of silently last-winning
 * into split-brain (whole-tree renders run each placement's own
 * closure while every catalog consumer — lane reconstruction, the
 * descendant fold's gate re-evaluation, the matchKey ancestor walk —
 * resolves the LAST registration).
 *
 * The gate is generation-keyed for HMR: a real module re-evaluation is
 * always preceded by the code-version bump (`vite:beforeUpdate` fires
 * before the runner re-evaluates — see lib/code-version.ts), so a
 * claim from a NEWER generation replaces silently, and only a
 * same-generation distinct claim throws. In prod the generation never
 * moves, so a duplicate id fails at module init (deploy time).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parton, type RenderArgs } from "../partial.tsx"
import { _clearSpecCatalog, getSpecById } from "../spec-catalog.ts"
import { renderWithRequest, type FlightBytes } from "../../test/rsc-server.ts"

// Two DIFFERENT specs, both auto-named from a Render called
// "SameNameRender" → both derive the catalog id "same-name".
function makeSpecA() {
  return parton(function SameNameRender(_: RenderArgs) {
    return <div data-testid="body-a">BODY-A</div>
  }, "/dup-name")
}
function makeSpecB() {
  return parton(function SameNameRender(_: RenderArgs) {
    return <div data-testid="body-b">BODY-B</div>
  }, "/dup-name")
}

const initialCodeVersion = globalThis.__partonCodeVersion

beforeEach(() => {
  // Each test claims "same-name" afresh — clear the module-level
  // catalog between tests (a fresh module graph in real life).
  _clearSpecCatalog()
})

afterEach(() => {
  globalThis.__partonCodeVersion = initialCodeVersion
})

describe("duplicate spec id — same generation", () => {
  it("the second distinct claim throws, naming both definition sites", () => {
    makeSpecA()
    let thrown: Error | null = null
    try {
      makeSpecB()
    } catch (err) {
      thrown = err as Error
    }
    expect(thrown).not.toBeNull()
    expect(thrown!.message).toContain('duplicate spec id "same-name"')
    // Both definition sites ride in the message — the construct-time
    // stack captures point at THIS test file.
    const sites = thrown!.message.match(/spec-id-collision\.rsc\.test\.tsx/g) ?? []
    expect(sites.length).toBeGreaterThanOrEqual(2)
    // The first claim stays live — the failed claim replaced nothing.
    expect(getSpecById("same-name")).toBeDefined()
  })
})

describe("duplicate spec id — newer generation (HMR re-evaluation)", () => {
  it("a claim from a newer code generation replaces silently", async () => {
    makeSpecA()
    // The HMR signal: the code version bumps BEFORE the edited module
    // re-evaluates and re-claims its ids.
    globalThis.__partonCodeVersion = (globalThis.__partonCodeVersion ?? 0) + 1
    const SpecB = makeSpecB()

    // The catalog now resolves to the newest definition — an isolated
    // reconstruction (a lane, a selector refetch, a cache hole)
    // renders the NEW body, in lockstep with whole-tree renders.
    const entry = getSpecById("same-name")
    expect(entry).toBeDefined()
    const { stream } = await renderWithRequest("http://t/dup-name", <SpecB />)
    const text = await new Response(stream as FlightBytes).text()
    expect(text).toContain("BODY-B")
  })
})
