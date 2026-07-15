/**
 * Placement identity — two placements of ONE spec on one page are two
 * INSTANCES. An auto-derived id folds the ambient parent path
 * (`applyPlacementFold`, the third leg of the identity ladder:
 * `__instanceId` > props-hash > placement-path > spec.id), so the
 * placements mint distinct wire ids, registry slots, and client cache
 * slots — instead of fighting over one identity (which used to mean a
 * hydration mismatch on every document load, a one-variantKey route
 * hint flip, and a churning fp-trailer heal per navigation).
 *
 * Explicit-selector ids are the deliberate opposite: an author-declared
 * id asserts singularity, and a second same-request placement is an
 * authoring error (`registerPartial`'s gate — DEV throw naming both
 * parent paths).
 */

import { beforeEach, describe, expect, it } from "vitest"
import type { ReactNode } from "react"
import { Frame } from "../frame.tsx"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { clearRegistry, _registryStats } from "../partial-registry.ts"
import { searchParam } from "../server-hooks.ts"
import { wrapStreamWithFpTrailer } from "../fp-trailer.ts"
import { splitAtFpTrailer } from "../fp-trailer-split.ts"
import { runWithRequestAsync, _captureCommitHandle } from "../../runtime/context.ts"
import { renderServerToFlight, renderWithRequest, type FlightBytes } from "../../test/rsc-server.ts"

// ─── Fixture: the examples/minimal shape ─────────────────────────────

let tickRuns = 0
const Tick = parton(function TickRender(_: RenderArgs) {
  tickRuns++
  return <span data-testid="tick">{`tick-run-${tickRuns}`}</span>
}, "/")

const Wrapper = parton(function WrapperRender(_: RenderArgs) {
  const name = searchParam("name")
  return (
    <div data-testid="wrapper">
      {`hello-${name ?? "null"}`}
      <Tick />
    </div>
  )
}, "/")

const dupTree = (
  <PartialRoot>
    <html lang="en">
      <body>
        <Wrapper />
        <Tick />
      </body>
    </html>
  </PartialRoot>
)

// ─── Harness: production trailer path, accumulated client manifest ──

interface RoundTrip {
  bodyText: string
  trailer: Record<string, { from: string; to: string }> | null
}

async function renderWithTrailer(url: string, node: ReactNode): Promise<RoundTrip> {
  const request = new Request(url)
  const { result } = await runWithRequestAsync(request, async () => {
    const raw = renderServerToFlight(node)
    const wrapped = wrapStreamWithFpTrailer(raw, _captureCommitHandle())
    const { mainStream, trailer } = splitAtFpTrailer(wrapped)
    const bodyText = await new Response(mainStream).text()
    const trailerPayload = await trailer
    return {
      bodyText,
      trailer: trailerPayload as Record<string, { from: string; to: string }> | null,
    }
  })
  return result
}

/** Every (id, matchKey, fp) triple emitted on the wire — dup ids kept. */
function wireEmissions(flight: string): Array<{ id: string; mk: string; fp: string }> {
  const out: Array<{ id: string; mk: string; fp: string }> = []
  const re =
    /"partialId":"([^"]+)","partialFingerprint":"([0-9a-f]+)","partialMatchKey":"([0-9a-f]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(flight)) !== null) out.push({ id: m[1], fp: m[2], mk: m[3] })
  return out
}

/** Client manifest mirror: `(id, matchKey)` → fp set, healed by the
 *  trailer the way the real client applies `{from, to}` per id. */
class Manifest {
  fps = new Map<string, Set<string>>() // `${id}:${mk}` → fps
  absorb(rt: RoundTrip): void {
    for (const e of wireEmissions(rt.bodyText)) {
      let s = this.fps.get(`${e.id}:${e.mk}`)
      if (!s) this.fps.set(`${e.id}:${e.mk}`, (s = new Set()))
      s.add(e.fp)
    }
    if (rt.trailer) {
      for (const [id, { from, to }] of Object.entries(rt.trailer)) {
        for (const [key, s] of this.fps) {
          if (key.startsWith(`${id}:`) && s.has(from)) s.add(to)
        }
      }
    }
  }
  toParam(): string {
    const toks: string[] = []
    for (const [key, s] of this.fps) {
      const [id, mk] = key.split(":")
      for (const fp of s) toks.push(`${id}:${mk}:${fp}`)
    }
    return toks.join(",")
  }
}

beforeEach(() => {
  clearRegistry("all")
  tickRuns = 0
})

// ─── Two placements are two instances ────────────────────────────────

describe("duplicate placement — two instances, distinct identities", () => {
  it("both placements mint distinct wire ids and register distinct snapshots", async () => {
    const r1 = await renderWithTrailer("http://t/", dupTree)

    // Two placements → two body runs.
    expect(tickRuns).toBe(2)

    // …under DISTINCT wire ids: the root placement keeps the bare
    // spec id, the nested one folds its parent path.
    const tickIds = wireEmissions(r1.bodyText)
      .map((e) => e.id)
      .filter((id) => id.startsWith("tick"))
    expect(tickIds).toHaveLength(2)
    expect(new Set(tickIds).size).toBe(2)
    expect(tickIds).toContain("tick")
    expect(tickIds.find((id) => /^tick~[0-9a-f]{16}$/.test(id))).toBeDefined()

    // Registry: one id per placement — wrapper, root tick, nested
    // tick — each with exactly one variant; the route hint addresses
    // all three (no one-slot fight).
    const stats = _registryStats()
    expect(stats.partials).toBe(3)
    expect(stats.variants).toBe(3)
    expect(Object.values(stats.byRoute)[0]).toHaveLength(3)
  })

  it("same-URL warm cycles fp-skip both placements; the trailer heals once (cold→warm), then stays quiet", async () => {
    const manifest = new Manifest()

    const r1 = await renderWithTrailer("http://t/", dupTree)
    manifest.absorb(r1)

    // R1's trailer carries only the wrapper's cold→warm fold heal —
    // its descendant fold sees the nested tick only after the tick's
    // first registration commits.
    expect(r1.trailer?.wrapper).toBeDefined()

    for (let i = 2; i <= 5; i++) {
      const before = tickRuns
      const url = `http://t/?cached=${encodeURIComponent(manifest.toParam())}`
      const r = await renderWithTrailer(url, dupTree)
      manifest.absorb(r)
      // fp-skip holds for BOTH placements…
      expect(tickRuns - before, `tick body ran in warm cycle R${i}`).toBe(0)
      // …and there is no churning heal: with one identity per
      // placement, nothing flips the route hint between renders.
      expect(r.trailer, `trailer churned in warm cycle R${i}`).toBeNull()
    }
  })

  it("alternating navs re-render the wrapper only; neither tick placement ever re-runs", async () => {
    const manifest = new Manifest()
    const urls = [
      "http://t/",
      "http://t/?name=a",
      "http://t/?name=b",
      "http://t/?name=a",
      "http://t/",
      "http://t/?name=b",
    ]
    let cold = true
    for (const base of urls) {
      const before = tickRuns
      const url = cold
        ? base
        : `${base}${base.includes("?") ? "&" : "?"}cached=${encodeURIComponent(manifest.toParam())}`
      const r = await renderWithTrailer(url, dupTree)
      manifest.absorb(r)
      if (!cold) {
        // The tick has no deps, so no navigation may re-run either
        // placement's body.
        expect(tickRuns - before, `tick body ran on nav to ${base}`).toBe(0)
      }
      cold = false
    }
  })
})

// ─── Frame divergence is placement divergence ────────────────────────

let badgeRuns = 0
const FrameBadge = parton(function FrameBadgeRender(_: RenderArgs) {
  badgeRuns++
  return <span data-testid="frame-badge">{`badge-run-${badgeRuns}`}</span>
}, "/")

// One auto-id spec inside TWO different <Frame>s under the same
// parent: the placements share parent.path ([]), diverge only in
// frameChain. Before the frame chain rode the placement fold, both
// minted ONE id — and since the frame folds into the fp but not the
// matchKey, one frame's cached content could be substituted /
// fp-confirmed into the other's position (silent wrongness).
// `initialUrl` pins each frame's resolved request (a frame with no
// session URL falls back to the page request, whose `?cached=` would
// otherwise churn the ambient-frame fp term across warm renders).
const frameTree = (
  <PartialRoot>
    <html lang="en">
      <body>
        <Frame name="fa" initialUrl="/">
          <FrameBadge />
        </Frame>
        <Frame name="fb" initialUrl="/">
          <FrameBadge />
        </Frame>
      </body>
    </html>
  </PartialRoot>
)

describe("duplicate placement — one spec in two frames", () => {
  it("frame-divergent placements mint distinct ids and never confirm each other's content", async () => {
    badgeRuns = 0
    const r1 = await renderWithTrailer("http://t/", frameTree)
    expect(badgeRuns).toBe(2)

    // Two DISTINCT placement-folded wire ids — the fold carries the
    // frame chain, so same-parent different-frame placements diverge.
    const badges = wireEmissions(r1.bodyText).filter((e) => e.id.startsWith("frame-badge"))
    expect(badges).toHaveLength(2)
    const ids = badges.map((e) => e.id)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id).toMatch(/^frame-badge~[0-9a-f]{16}$/)

    // …each with its own registry entry.
    const stats = _registryStats()
    expect(ids.every((id) => Object.values(stats.byRoute)[0].includes(id))).toBe(true)

    // The wrongness the shared id allowed: advertise ONLY frame-a's
    // placement as cached. Frame-b's placement must re-render (its id
    // is not in the manifest — no cross-placement fp confirmation),
    // and the only fp-skip placeholder on the wire is frame-a's.
    const a = badges[0]
    const before = badgeRuns
    const r2 = await renderWithTrailer(
      `http://t/?cached=${encodeURIComponent(`${a.id}:${a.mk}:${a.fp}`)}`,
      frameTree,
    )
    expect(badgeRuns - before, "the un-advertised frame placement must re-render").toBe(1)
    // Set-dedup: dev-build Flight repeats props in debug-info rows.
    const placeholders = new Set(
      [...r2.bodyText.matchAll(/"data-partial-id":"([^"]+)"/g)]
        .map((m) => m[1])
        .filter((id) => id.startsWith("frame-badge")),
    )
    expect(placeholders).toEqual(new Set([a.id]))
  })
})

// ─── Explicit ids assert singularity ─────────────────────────────────

describe("duplicate placement — explicit-selector id", () => {
  it("a second same-request placement of an explicit id throws, naming both parent paths", async () => {
    const Banner = parton(
      function ExplicitBannerRender(_: RenderArgs) {
        return <span>banner</span>
      },
      { selector: "explicit-banner", match: "/" },
    )
    const Host = parton(function ExplicitHostRender(_: RenderArgs) {
      return (
        <div>
          <Banner />
        </div>
      )
    }, "/")

    const tree = (
      <PartialRoot>
        <html lang="en">
          <body>
            <Host />
            <Banner />
          </body>
        </html>
      </PartialRoot>
    )
    const { stream } = await renderWithRequest("http://t/", tree, { onError: () => {} })
    const text = await new Response(stream as FlightBytes).text()
    expect(text).toContain("explicit-selector id rendered at two placements in one request")
    expect(text).toContain("explicit-banner")
    expect(text).toContain("explicit-host")
  })
})
