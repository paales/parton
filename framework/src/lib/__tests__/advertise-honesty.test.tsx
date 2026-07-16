/**
 * The advertise-honesty gate — never advertise an fp for bytes you
 * cannot restore.
 *
 * Every holdings surface (the `x-parton-cached` manifest, the attach
 * body manifest, a
 * culling flip's `cachedTokensFor`) reads `_currentPageFingerprints`;
 * an fp stated there without content behind it turns the server's
 * honest fp-skip verdict into a GHOST CONFIRM — a zero-byte
 * placeholder the substitution cannot fill, with no delta left
 * anywhere to heal it. The scroll-stress deadlock rode exactly that:
 * a parked quad's content was destroyed by the cull-park LRU
 * (`evictCulledContent` purges cache + fps together), but the parton's
 * still-mounted fiber — parked inline inside an ancestor's cached
 * wrapper — re-rendered its `PartialErrorBoundary`, whose render-time
 * fallback registration RESURRECTED the advertised fp with nothing
 * restorable behind it. The re-entry flip then stated the token, the
 * server confirmed, the confirm restored nothing, and the skeleton
 * stood until the 30s reconcile.
 *
 * The gate closes the class at the one writer of the advertised set:
 * `registerClientPartial` registers only while the (id, matchKey)
 * content slot holds the subtree the fp describes. Fresh content
 * (`cacheStore`) re-opens registration.
 */

import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { _channelEstablished, _resetChannelClient } from "../channel-client.ts"
import type { ChannelEnvelope, VisibleFrame } from "../channel-protocol.ts"
import { _resetCullPark } from "../cull-park.ts"
import {
  cachedTokensFor,
  cacheStore,
  evictCulledContent,
  getCurrentPagePartials,
  pruneToLive,
  registerClientPartial,
} from "../partial-client-state.ts"
import { PartialErrorBoundary } from "../partial-error-boundary.tsx"
import { _resetVisibilityController, reportVisible } from "../visibility.tsx"

let rafQueue: FrameRequestCallback[] = []
function raf(): void {
  const queue = rafQueue
  rafQueue = []
  for (const cb of queue) cb(0)
}

let fetchCalls: Array<{ init: RequestInit }> = []
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function sentVisibles(): VisibleFrame[] {
  return fetchCalls
    .flatMap((c) => (JSON.parse(String(c.init.body)) as ChannelEnvelope).frames)
    .filter((f): f is VisibleFrame => f.kind === "visible")
}

beforeEach(() => {
  pruneToLive(new Map())
  _resetChannelClient()
  _resetVisibilityController()
  _resetCullPark()
  rafQueue = []
  fetchCalls = []
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb)
    return rafQueue.length
  })
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    fetchCalls.push({ init })
    return Promise.resolve({ status: 204 })
  })
})

afterEach(() => {
  pruneToLive(new Map())
  _resetChannelClient()
  _resetVisibilityController()
  _resetCullPark()
  vi.unstubAllGlobals()
})

describe("registerClientPartial — the advertise-honesty gate", () => {
  it("registers only while the content slot holds the subtree", () => {
    // Bare registration (no content) states nothing.
    registerClientPartial("quad", "mk", "fp-cold")
    expect(cachedTokensFor(["quad"])).toEqual([])
    // Content first (the commit walk's order) — registration passes.
    cacheStore(getCurrentPagePartials(), "quad", "mk", "QUAD-SUBTREE")
    registerClientPartial("quad", "mk", "fp-cold")
    expect(cachedTokensFor(["quad"])).toEqual(["quad:mk:fp-cold"])
  })

  it("a parked eviction purges the tokens AND a later registration cannot resurrect them", () => {
    const cache = getCurrentPagePartials()
    cacheStore(cache, "quad", "mk", "QUAD-SUBTREE")
    registerClientPartial("quad", "mk", "fp-cold")
    registerClientPartial("quad", "mk", "fp-warm")
    expect(cachedTokensFor(["quad"])).toHaveLength(2)

    // The cull-park LRU destroys the parked content.
    evictCulledContent("quad")
    expect(cachedTokensFor(["quad"])).toEqual([])

    // The resurrect attempt — a still-mounted fiber's render-time
    // fallback registration after the eviction. Must stay inert:
    // there is nothing restorable behind the fp.
    registerClientPartial("quad", "mk", "fp-warm")
    expect(cachedTokensFor(["quad"])).toEqual([])

    // Fresh content re-opens registration — the pre-eviction behavior.
    cacheStore(cache, "quad", "mk", "QUAD-FRESH")
    registerClientPartial("quad", "mk", "fp-next")
    expect(cachedTokensFor(["quad"])).toEqual(["quad:mk:fp-next"])
  })

  it("gates per (id, matchKey) — a surviving variant keeps advertising", () => {
    const cache = getCurrentPagePartials()
    cacheStore(cache, "tile", "mkA", "A")
    registerClientPartial("tile", "mkA", "fp-a")
    // mkB never stored — its registration is inert; mkA's stands.
    registerClientPartial("tile", "mkB", "fp-b")
    expect(cachedTokensFor(["tile"])).toEqual(["tile:mkA:fp-a"])
  })
})

describe("the PEB render-time fallback registration (the resurrect writer)", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it("a mounted boundary's re-render cannot resurrect an evicted id's tokens", () => {
    const id = "quad-tile-512"
    const wrapper = (
      <PartialErrorBoundary
        key={id}
        partialId={id}
        partialFingerprint="fp-quad"
        partialMatchKey="mk"
      >
        <div data-testid={id} />
      </PartialErrorBoundary>
    )
    // The commit walk's order: content stored, then the boundary
    // mounts and its render registers — honest, passes the gate.
    cacheStore(getCurrentPagePartials(), id, "mk", wrapper)
    let rerender: () => void = () => {}
    function Host(): React.ReactNode {
      const [, bump] = React.useReducer((c: number) => c + 1, 0)
      rerender = bump
      return wrapper
    }
    act(() => root.render(<Host />))
    expect(cachedTokensFor([id])).toEqual([`${id}:mk:fp-quad`])

    // The parked content is destroyed while the fiber stays mounted
    // (inline inside an ancestor's cached wrapper).
    evictCulledContent(id)
    expect(cachedTokensFor([id])).toEqual([])

    // The fiber re-renders (an ancestor's restore, an offscreen
    // prerender) — the boundary's fallback registration re-fires and
    // must NOT resurrect the advertised fp.
    act(() => rerender())
    expect(cachedTokensFor([id])).toEqual([])
  })
})

describe("the flip statement after a parked eviction", () => {
  it("states cached#=0 — the server renders fresh instead of confirming a ghost", async () => {
    _channelEstablished("c1")
    const cache = getCurrentPagePartials()
    cacheStore(cache, "quad", "mk", "QUAD-SUBTREE")
    registerClientPartial("quad", "mk", "fp-quad")

    // Parked, then evicted by the LRU; a later registration attempt
    // (the still-mounted fiber) stays inert.
    evictCulledContent("quad")
    registerClientPartial("quad", "mk", "fp-quad")

    // Re-entry: the flip-in statement's holdings must be honest.
    reportVisible("quad", true)
    raf()
    await settle()
    const visibles = sentVisibles()
    expect(visibles).toHaveLength(1)
    expect(visibles[0].changed).toEqual(["quad"])
    expect(visibles[0].cached).toEqual([])
  })
})
