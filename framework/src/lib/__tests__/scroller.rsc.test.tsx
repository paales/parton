/**
 * scroller() — the window model over item space.
 *
 * Pins the server half: the placed span around the anchor, the
 * reservation shells covering the rest, the cold-seed neighborhood
 * (only the anchor's slices resolve — the fetch is gated by culling),
 * interval markers on the wire, the deep-link script, and placement
 * stability as the collection grows (middle leaves' props never move;
 * only the clamped tail re-shapes).
 */

import { beforeEach, describe, expect, it } from "vitest"
import { clearRegistry } from "../partial-registry.ts"
import { PartialRoot } from "../partial.tsx"
import { scroller } from "../scroller.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

/** Marker intervals `[o, n]` present on the wire, in emission order.
 *  Includes the container ([0, total]), leaf wrappers, and the
 *  reservation shells. */
function markersOf(flight: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const re = /"data-so":(\d+),"data-sn":(\d+)[,}]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(flight)) !== null) out.push([Number(m[1]), Number(m[2])])
  return out
}

/** A deterministic in-memory source: `total` items, item i = `i`.
 *  Records every requested offset so tests can assert the fetch is
 *  gated by the span's cull seeds. */
function makeSource(state: { total: number; calls: number[] }) {
  return async ({ offset, limit }: { offset: number; limit: number }) => {
    state.calls.push(offset)
    const items: number[] = []
    for (let i = offset; i < Math.min(offset + limit, state.total); i++) items.push(i)
    return { items, total: state.total }
  }
}

describe("scroller: the placed span and its reservations", () => {
  beforeEach(() => clearRegistry("all"))

  const state = { total: 1302, calls: [] as number[] }
  const List = scroller({
    name: "probe-list",
    range: makeSource(state),
    item: (i) => <i key={i} data-item={i} />,
    leaf: 24,
    ring: 6,
  })
  const tree = (
    <PartialRoot>
      <List />
    </PartialRoot>
  )

  it("head render: span at the head, after-reservation, only the seeded slices fetch", async () => {
    state.calls = []
    const flight = await flightAt("http://t/", tree)

    const ms = markersOf(flight)
    // The container spans the whole collection.
    expect(ms[0]).toEqual([0, 1302])
    // The placed span: anchor leaf 0 plus `ring` leaves after —
    // leaves [0..168), then ONE reservation covering the rest.
    expect(ms).toContainEqual([0, 24])
    expect(ms).toContainEqual([144, 24])
    expect(ms).not.toContainEqual([192, 24])
    // The reservation is a client component — its marker renders
    // client-side; the wire carries its props.
    expect(flight).toContain('"base":168,"count":1134')
    expect(flight).not.toContain('"base":0,')

    // Cold seed (no ?page=): the anchor neighborhood (leaves 0 and
    // 24) materializes; the rest of the span is culled — placed, but
    // never fetched. The root's shape read shares leaf 0's slice.
    expect(flight).toMatch(/"data-item":0[,}]/)
    expect(flight).toMatch(/"data-item":24[,}]/)
    expect(flight).not.toMatch(/"data-item":48[,}]/)
    expect(new Set(state.calls)).toEqual(new Set([0, 24]))

    // The anchor's deep-link script rides the root emission.
    expect(flight).toContain("scrollIntoView")
  })

  it("?page=30 moves the span there — before and after reservations", async () => {
    state.calls = []
    const flight = await flightAt("http://t/?page=30", tree)

    const ms = markersOf(flight)
    // Anchor item 696 → span [552, 864), reservations on both sides.
    expect(ms).toContainEqual([552, 24])
    expect(ms).toContainEqual([840, 24])
    expect(ms).not.toContainEqual([528, 24])
    expect(flight).toContain('"base":0,"count":552')
    expect(flight).toContain('"base":864,"count":438')

    // Seeded: the anchored leaf and its two neighbors; the head is
    // fetched only by the root's shape read.
    expect(new Set(state.calls)).toEqual(new Set([0, 672, 696, 720]))
    expect(flight).toMatch(/"data-item":696[,}]/)
    expect(flight).not.toMatch(/"data-item":600[,}]/)
  })
})

describe("scroller: growth re-shapes only the tail", () => {
  beforeEach(() => clearRegistry("all"))

  const state = { total: 100, calls: [] as number[] }
  const List = scroller({
    name: "grow-list",
    range: makeSource(state),
    item: (i) => <i key={i} data-item={i} />,
    leaf: 24,
    ring: 6,
  })
  const tree = (
    <PartialRoot>
      <List />
    </PartialRoot>
  )

  it("middle placements keep their props as total grows", async () => {
    state.total = 100
    const before = markersOf(await flightAt("http://t/", tree))
    // Whole collection fits in the span — no reservations, tail leaf
    // clamped to 4.
    expect(before).toContainEqual([0, 24])
    expect(before).toContainEqual([96, 4])

    clearRegistry("all")
    state.total = 120
    const after = markersOf(await flightAt("http://t/", tree))
    // Middle placements byte-identical; only the tail clamp moved.
    expect(after).toContainEqual([0, 24])
    expect(after).toContainEqual([96, 24])
    expect(after).not.toContainEqual([96, 4])
  })
})
