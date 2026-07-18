/**
 * scroller() — the interval tree over item space.
 *
 * Pins the server half: tree geometry from `total`, the cold-seed
 * spine (only the anchor neighborhood's slices resolve — the fetch is
 * gated by culling), interval markers on the wire, the anchor's
 * deep-link script, and interval-identity stability as the collection
 * grows (middle placements' props never move; only the clamped tail
 * re-shapes).
 */

import { beforeEach, describe, expect, it } from "vitest"
import { clearRegistry } from "../partial-registry.ts"
import { PartialRoot, type RenderArgs } from "../partial.tsx"
import { scroller, scrollerDepthFor, type ScrollerSlice } from "../scroller.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { SkelBox } from "./cull-skeleton-fixture.tsx"

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

/** Marker intervals `[o, n]` present on the wire, in emission order. */
function markersOf(flight: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const re = /"data-so":(\d+),"data-sn":(\d+)[,}]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(flight)) !== null) out.push([Number(m[1]), Number(m[2])])
  return out
}

/** A deterministic in-memory source: `total` items, item i = `i`.
 *  Records every requested offset so tests can assert the fetch is
 *  gated by the tree's existence gates. */
function makeSource(state: { total: number; calls: number[] }) {
  return async ({ offset, limit }: { offset: number; limit: number }) => {
    state.calls.push(offset)
    const items: number[] = []
    for (let i = offset; i < Math.min(offset + limit, state.total); i++) items.push(i)
    return { items, total: state.total }
  }
}

describe("scrollerDepthFor", () => {
  it("covers total with the shallowest sufficient tree", () => {
    expect(scrollerDepthFor(0, 24, 4)).toBe(0)
    expect(scrollerDepthFor(24, 24, 4)).toBe(0)
    expect(scrollerDepthFor(25, 24, 4)).toBe(1)
    expect(scrollerDepthFor(96, 24, 4)).toBe(1)
    expect(scrollerDepthFor(97, 24, 4)).toBe(2)
    expect(scrollerDepthFor(1302, 24, 4)).toBe(3)
  })
})

describe("scroller: cold render", () => {
  beforeEach(() => clearRegistry("all"))

  const state = { total: 1302, calls: [] as number[] }
  const List = scroller(
    function ScrollerProbeRender({ items, offset }: ScrollerSlice<number> & RenderArgs) {
      return <div data-slice={offset} data-items={items.join(",")} />
    },
    {
      range: makeSource(state),
      shell: SkelBox,
      estimate: (n) => n * 10,
      leaf: 24,
      fanout: 4,
      anchor: { param: "page", pageSize: 24 },
    },
  )
  const tree = (
    <PartialRoot>
      <List />
    </PartialRoot>
  )

  it("renders the root-to-anchor spine and fetches ONLY the seeded slices", async () => {
    state.calls = []
    const flight = await flightAt("http://t/", tree)

    // The root marker spans the whole collection.
    const ms = markersOf(flight)
    expect(ms[0]).toEqual([0, 1302])

    // Head seed (no ?page=): leaves [0,24) and [24,48) render full
    // (anchor window padded one leaf); their slices — and only theirs —
    // were fetched. The root's own shape read shares leaf 0's slice.
    expect(flight).toMatch(/"data-slice":0[,}]/)
    expect(flight).toMatch(/"data-slice":24[,}]/)
    expect(flight).not.toMatch(/"data-slice":48[,}]/)
    expect(new Set(state.calls)).toEqual(new Set([0, 24]))

    // Culled structure is present as intervals (shells), not bodies:
    // the first level under the root is fanout children spanning 384.
    expect(ms).toContainEqual([0, 384])
    expect(ms).toContainEqual([384, 384])
    expect(ms).toContainEqual([1152, 150])

    // The anchor's deep-link script rides the root emission.
    expect(flight).toContain("scrollIntoView")
  })

  it("?page=N seeds the anchored neighborhood instead of the head", async () => {
    state.calls = []
    const flight = await flightAt("http://t/?page=3", tree)

    // Anchor window [48,72) padded one leaf: slices 24/48/72 resolve,
    // the head does not.
    expect(new Set(state.calls)).toEqual(new Set([0, 24, 48, 72]))
    expect(flight).toMatch(/"data-slice":48[,}]/)
    expect(flight).not.toMatch(/"data-slice":0[,}]/)
  })
})

describe("scroller: growth re-shapes only the clamped tail", () => {
  beforeEach(() => clearRegistry("all"))

  const state = { total: 100, calls: [] as number[] }
  const List = scroller(
    function ScrollerGrowRender({ offset }: ScrollerSlice<number> & RenderArgs) {
      return <div data-slice={offset} />
    },
    {
      range: makeSource(state),
      shell: SkelBox,
      estimate: (n) => n * 10,
      leaf: 24,
      fanout: 4,
    },
  )
  const tree = (
    <PartialRoot>
      <List />
    </PartialRoot>
  )

  it("middle intervals keep their props as total grows within capacity", async () => {
    state.total = 100
    const before = markersOf(await flightAt("http://t/", tree))
    // Depth 2 (capacity 384): first child spans a full 96, the tail
    // child is clamped to 4.
    expect(before).toContainEqual([0, 96])
    expect(before).toContainEqual([96, 4])

    clearRegistry("all")
    state.total = 120
    const after = markersOf(await flightAt("http://t/", tree))
    // The full middle interval is byte-identical in placement — same
    // [o, n] — while only the tail clamp moved.
    expect(after).toContainEqual([0, 96])
    expect(after).toContainEqual([96, 24])
    expect(after).not.toContainEqual([96, 4])
  })
})
