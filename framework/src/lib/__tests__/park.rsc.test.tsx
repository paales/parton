/**
 * `park()` — the schema-phase park hook.
 *
 * Parking is `vary → null`'s keepalive semantics as a hook: stop the
 * schema phase, emit the parked keepalive (hidden `<Activity>` per
 * cached client variant, NO snapshot registration, NO fingerprint)
 * instead of rendering. The decision re-evaluates per request from live
 * reads, so un-parking needs no dep record. Contrast `return null` from
 * Render, which registers + fingerprints an empty body.
 */

import { describe, expect, it, beforeEach } from "vitest"
import { parton, PartialRoot, computeRouteKey, type RenderArgs } from "../partial.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { runWithRequestAsync } from "../../runtime/context.ts"
import { clearRegistry, enterRequestRegistry, lookupPartial } from "../partial-registry.ts"
import { park, searchParam } from "../server-hooks.ts"
import { hash } from "../hash.ts"
import { stableStringify } from "../stable-stringify.ts"

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

function fpById(flight: string, id: string): string | undefined {
  const m = new RegExp(`"partialId":"${id}","partialFingerprint":"([^"]+)"`).exec(flight)
  return m?.[1]
}

/** matchKey for a spec with no own match and no match-bearing ancestor. */
const ROOT_MK = hash(stableStringify({}))

// Parks unless `?pages=` admits page 2 — the value-conditional gate
// `match` can't express (ListPagePartials' load-more shape).
const ParkGate = parton(
  function ParkGateRender({ page }: { page: number } & RenderArgs) {
    return <span>{`park-gate-body:${page}`}</span>
  },
  {
    selector: "#park-gate",
    schema: () => {
      const pages = Math.max(1, Number(searchParam("pages")) || 1)
      const page = 2
      if (page > pages) park()
      return { page }
    },
  },
)

const ParkInRender = parton(
  function ParkInRenderRender(_: RenderArgs) {
    park()
    return <span>park-in-render-body</span>
  },
  { selector: "#park-in-render" },
)

describe("park() — schema-phase park hook", () => {
  beforeEach(() => clearRegistry("all"))

  it("parks and un-parks per request from live reads", async () => {
    const tree = (
      <PartialRoot>
        <ParkGate />
      </PartialRoot>
    )
    const parked = await flightAt("http://t/park", tree)
    expect(parked).not.toContain("park-gate-body")
    const open = await flightAt("http://t/park?pages=3", tree)
    expect(open).toContain("park-gate-body:2")
    const parkedAgain = await flightAt("http://t/park?pages=1", tree)
    expect(parkedAgain).not.toContain("park-gate-body")
  })

  it("a parked pass registers no snapshot and emits no fp", async () => {
    const tree = (
      <PartialRoot>
        <ParkGate />
      </PartialRoot>
    )
    // Snapshot lookups resolve within a request registry for the URL's
    // route bucket — same lens the framework reads through.
    const committed = async (url: string) => {
      const { result } = await runWithRequestAsync(new Request(url), async () => {
        enterRequestRegistry(computeRouteKey(url), "cache")
        return lookupPartial("park-gate")
      })
      return result
    }
    const parked = await flightAt("http://t/park", tree)
    expect(await committed("http://t/park")).toBeUndefined()
    expect(fpById(parked, "park-gate")).toBeUndefined()
    await flightAt("http://t/park?pages=3", tree)
    expect(await committed("http://t/park?pages=3")).toBeDefined()
  })

  it("parked emission preserves the client's cached variant (keepalive placeholder)", async () => {
    const tree = (
      <PartialRoot>
        <ParkGate />
      </PartialRoot>
    )
    const open = await flightAt("http://t/park?pages=3", tree)
    const fp = fpById(open, "park-gate")
    expect(fp).toBeDefined()
    // Client has the open variant cached; this request parks. The spec
    // must emit the hidden-Activity placeholder for the cached matchKey
    // (fiber parked, state preserved) — not disappear entirely.
    const parked = await flightAt(
      `http://t/park?pages=1&cached=park-gate:${ROOT_MK}:${fp}`,
      tree,
    )
    expect(parked).not.toContain("park-gate-body")
    expect(parked).toContain('"data-partial-id":"park-gate"')
    expect(parked).toContain(`"data-partial-match":"${ROOT_MK}"`)
  })

  it("park() in the Render body is an error card, not a park", async () => {
    const tree = (
      <PartialRoot>
        <ParkInRender />
      </PartialRoot>
    )
    const out = await flightAt("http://t/park-render", tree)
    expect(out).not.toContain("park-in-render-body")
    expect(out).toContain("render body")
  })

  it("park() outside a parton throws", () => {
    expect(() => park()).toThrow(/outside a parton/)
  })
})
