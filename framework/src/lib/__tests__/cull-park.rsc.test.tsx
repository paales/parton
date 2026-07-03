/**
 * Cull-to-park — the server half.
 *
 * A cullable keepalive parton's culled render is a VARIANT of its
 * in-view one (`cull-key.ts`): the wire matchKey gains the `~cull`
 * suffix (own client cache slot, own advertised fingerprints) and the
 * registry keeps per-state snapshots, so each state's dep record folds
 * its own fingerprint. Emission is a stable two-slot pair (`CullSlot`
 * content + skeleton), and a `?__cullFlip=1` refetch — the visibility
 * controller's explicit stamp — lets an explicit target fp-skip: the
 * placeholder that confirms the client's parked copy.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { culledKey } from "../cull-key.ts"
import { clearRegistry } from "../partial-registry.ts"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { searchParam, visible } from "../server-hooks.ts"
import { renderWithRequest } from "../../test/rsc-server.ts"

function fpById(flight: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /"partialId":"([^"]+)","partialFingerprint":"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(flight)) !== null) out.set(m[1], m[2])
  return out
}
function matchKeyOf(flight: string, id: string): string | undefined {
  const re = new RegExp(
    `"partialId":"${id}","partialFingerprint":"[^"]+","partialMatchKey":"([^"]+)"`,
  )
  return re.exec(flight)?.[1]
}
async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

// The cull-pair probe. Branches on visible() — its in-view branch also
// reads a search param, so the two states record DIFFERENT dep sets
// (the per-state snapshot regression this file guards).
const CullProbe = parton(
  function CullProbeRender(_: RenderArgs) {
    const v = visible()
    if (!v) return <div data-skel="1" />
    return <div data-full={searchParam("q") ?? "none"} />
  },
  { selector: "#cull-probe" },
)
const ID = "cull-probe"
const tree = (
  <PartialRoot>
    <CullProbe />
  </PartialRoot>
)

describe("cull-to-park: the culled state is a parked variant", () => {
  beforeEach(() => clearRegistry("all"))

  it("a culled render carries the ~cull wire matchKey and the two-slot pair", async () => {
    // Warm: record the visible: dep so the next pass knows the spec is
    // cullable, and learn the base matchKey.
    const warm = await flightAt(`http://t/x?visible=${ID}`, tree)
    const base = matchKeyOf(warm, ID)
    expect(base).toBeDefined()
    const inView = await flightAt(`http://t/x?visible=${ID}`, tree)
    // In-view render: base wire matchKey, body in the content slot.
    expect(matchKeyOf(inView, ID)).toBe(base)
    expect(inView).toContain("data-full")

    // Culled render (id absent from ?visible=): the body is the culled
    // variant — suffixed wire matchKey — and the client's cached base
    // variant parks behind a placeholder in the content slot.
    const culled = await flightAt(
      `http://t/x?visible=other&cached=${ID}:${base}:whatever`,
      tree,
    )
    expect(matchKeyOf(culled, ID)).toBe(culledKey(base!))
    expect(culled).toContain("data-skel")
    // Pair slots: both CullSlot client references present.
    expect(culled).toContain('"slot":"content"')
    expect(culled).toContain('"slot":"skeleton"')
    // The parked content slot points at the base cache variant.
    expect(culled).toContain(`"data-partial-id":"${ID}","data-partial-match":"${base}"`)
  })

  it("per-state snapshots: a culled render does not erode the in-view dep record", async () => {
    await flightAt(`http://t/x?q=shoes&visible=${ID}`, tree) // cold — records in-view deps
    const fpIn = fpById(await flightAt(`http://t/x?q=shoes&visible=${ID}`, tree)).get(ID)
    expect(fpIn).toBeDefined()

    // Cull out (records the skeleton branch's narrower dep set into the
    // ~cull variant), then return. The in-view fp must be computed from
    // the IN-VIEW state's record — folding the skeleton record would
    // shift it and every return would re-render even when nothing
    // changed.
    await flightAt(`http://t/x?q=shoes&visible=other`, tree)
    const fpBack = fpById(await flightAt(`http://t/x?q=shoes&visible=${ID}`, tree)).get(ID)
    expect(fpBack).toBe(fpIn)

    // And the dependency still bites: a changed in-view read moves it.
    const fpOtherQ = fpById(await flightAt(`http://t/x?q=hats&visible=${ID}`, tree)).get(ID)
    expect(fpOtherQ).not.toBe(fpIn)
  })

  it("?__cullFlip=1 lets an explicit target fp-skip; a plain explicit target still forces", async () => {
    await flightAt(`http://t/x?visible=${ID}`, tree) // cold
    const warm = await flightAt(`http://t/x?visible=${ID}`, tree)
    const base = matchKeyOf(warm, ID)
    const fpIn = fpById(warm).get(ID)

    // The culling controller's revalidation: explicit target + matching
    // advertised fp + the cull-flip stamp → placeholder, zero body bytes.
    const skip = await flightAt(
      `http://t/x?partials=${ID}&__cullFlip=1&visible=${ID}&cached=${ID}:${base}:${fpIn}`,
      tree,
    )
    expect(skip).not.toContain("data-full")
    expect(skip).toContain(`"data-partial-id":"${ID}","data-partial-match":"${base}"`)

    // Without the stamp, an explicit target is a force — fresh body.
    const forced = await flightAt(
      `http://t/x?partials=${ID}&visible=${ID}&cached=${ID}:${base}:${fpIn}`,
      tree,
    )
    expect(forced).toContain("data-full")
  })

  it("the culled state fp-skips on repeat flips once its record is warm", async () => {
    await flightAt(`http://t/x?visible=${ID}`, tree) // cold in view
    // First cull-out: fresh skeleton bytes, suffixed wire matchKey. Its
    // fp is the CULL-COLD one (the fold fell back to the in-view
    // record); the render records the skeleton branch's own reads.
    const out1 = await flightAt(`http://t/x?partials=${ID}&__cullFlip=1&visible=other`, tree)
    const cullMk = matchKeyOf(out1, ID)
    expect(cullMk).toBeDefined()
    // Second culled render folds the now-warm cull-variant record — the
    // stable skeleton fp (on the wire the fp-trailer ships this healed
    // value in out1's own response; here we warm explicitly).
    const out2 = await flightAt(`http://t/x?partials=${ID}&__cullFlip=1&visible=other`, tree)
    const fpOut = fpById(out2).get(ID)
    expect(fpOut).toBeDefined()
    // Return to view, then cull out again advertising the skeleton fp:
    // the flip is confirmed with a placeholder pointing at the ~cull
    // cache variant. Zero body bytes.
    await flightAt(`http://t/x?partials=${ID}&__cullFlip=1&visible=${ID}`, tree)
    const out3 = await flightAt(
      `http://t/x?partials=${ID}&__cullFlip=1&visible=other&cached=${ID}:${cullMk}:${fpOut}`,
      tree,
    )
    expect(out3).not.toContain("data-skel")
    expect(out3).toContain(`"data-partial-id":"${ID}","data-partial-match":"${cullMk}"`)
  })
})
