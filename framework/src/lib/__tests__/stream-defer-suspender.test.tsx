import React, { Activity, act, Suspense, type ReactNode } from "react"
import { createRoot, hydrateRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CullPair } from "../cull-pair.tsx"
import { _resetCullPark, reportCullState } from "../cull-park.ts"
import { _commitPartonLane, _settleLaneRewalksForTest } from "../partial-cache.ts"
import { PartialsClient } from "../partial-client.tsx"
import { PartialErrorBoundary } from "../partial-error-boundary.tsx"
import { PendingSlot } from "../pending-slot.tsx"
import { _resetVisibilityController } from "../visibility.tsx"
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * `defer: "stream"` — the stub's suspend gate (`<PendingSlot>`)
 * through the REAL client pipeline (template + cache +
 * `_commitPartonLane`), in jsdom.
 *
 * The wire shape under test (the stream-stub branch in partial.tsx): a
 * lane body carries a LEAF parton wrapper containing a CARD parton
 * wrapper whose price region is an app-level `<Suspense>` around the
 * price parton's STUB — a keyed `<PartialErrorBoundary>` whose child
 * is `<PendingSlot partonId matchKey>` wrapping the inert
 * `<i data-partial data-partial-pending>` marker. The gate throws the
 * id's slot-fill promise while the slot is EMPTY (the harvest never
 * stores a stub wrapper), so every rendering path — substituted or
 * native (the raw-reveal TOCTOU) — suspends at the app Suspense until
 * the follow-up lane's real body stores.
 *
 * The contract pinned by every spec: after a lane commit settles, the
 * card shell is in the DOM AND the price region shows the Suspense
 * fallback — never a committed-empty region; the follow-up lane's
 * body then replaces the fallback with content.
 */

// ─── Server-shaped node builders (mirror partial.tsx emissions) ─────

function peb(id: string, mk: string, content: ReactNode): ReactNode {
  return (
    <PartialErrorBoundary
      key={id}
      partialId={id}
      partialFingerprint={`fp_${id}_${mk}`}
      partialMatchKey={mk}
    >
      {content}
    </PartialErrorBoundary>
  )
}

/** The stub's gated pending marker — `<PendingSlot>` around
 *  `placeholderFor(id, mk, undefined, true)`, the streamStub emission. */
function gatedPendingMarker(id: string, mk: string): ReactNode {
  return (
    <PendingSlot partonId={id} matchKey={mk}>
      <i
        key={`${id}|${mk}`}
        hidden
        data-partial
        data-partial-id={id}
        data-partial-match={mk}
        data-partial-pending
      />
    </PendingSlot>
  )
}

/** A plain fp-skip placeholder. */
function placeholder(id: string, mk: string): ReactNode {
  return <i key={`${id}|${mk}`} hidden data-partial data-partial-id={id} data-partial-match={mk} />
}

/** A Flight-chunk-shaped instrumented thenable (the decoded form of an
 *  outlined `$@` promise row — how an async Render body reaches its
 *  wrapper). Pending until `resolve()`. Mirrors `makeChunk` in
 *  partial-cache-substitute.test.tsx. */
function makeChunk() {
  const listeners: Array<(v: unknown) => void> = []
  const chunk = {
    status: "pending",
    value: null as ReactNode,
    reason: null as unknown,
    then(res?: (v: unknown) => void) {
      if (chunk.status === "fulfilled") {
        res?.(chunk.value)
        return
      }
      if (typeof res === "function") listeners.push(res)
    },
  }
  return {
    node: chunk as unknown as ReactNode,
    resolve(value: ReactNode) {
      chunk.status = "fulfilled"
      chunk.value = value
      for (const l of listeners.splice(0)) l(value)
    },
  }
}

// ─── Harness ────────────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root
let rafQueue: FrameRequestCallback[]

/** Flush coalesced lane notifies (they ride rAF — stubbed to a queue). */
function flushRaf(): void {
  act(() => {
    while (rafQueue.length > 0) {
      const queue = rafQueue
      rafQueue = []
      for (const cb of queue) cb(0)
    }
  })
}

class StubIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): never[] {
    return []
  }
}

beforeEach(() => {
  rafQueue = []
  _resetCullPark()
  _resetVisibilityController()
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb)
    return rafQueue.length
  })
  vi.stubGlobal("cancelAnimationFrame", () => {})
  vi.stubGlobal("IntersectionObserver", StubIntersectionObserver)
  vi.stubGlobal("fetch", () => Promise.resolve({ status: 204 }))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  _resetCullPark()
  _resetVisibilityController()
  vi.unstubAllGlobals()
})

/** Commit a page payload through PartialsClient (populates the
 *  module-level cache + template). */
function mountPage(body: ReactNode, opts?: { strict?: boolean }): void {
  const tree = (
    <PartialsClient>
      <main>{body}</main>
    </PartialsClient>
  )
  act(() => {
    root.render(opts?.strict ? <React.StrictMode>{tree}</React.StrictMode> : tree)
  })
}

/** The card parton's body: shell + the price region — an app-level
 *  `<Suspense>` around the price parton's stream stub. */
function cardBodyOf(price: string, opts?: { activity?: boolean }): ReactNode {
  const stub = peb(price, "mk", gatedPendingMarker(price, "mk"))
  const wrap = (n: ReactNode): ReactNode =>
    opts?.activity ? <Activity mode="visible">{n}</Activity> : n
  return (
    <div data-testid="card-shell">
      <h3>Product name</h3>
      <div className="mt-auto">
        <Suspense fallback={<div data-testid="fb">loading price…</div>}>{wrap(stub)}</Suspense>
      </div>
    </div>
  )
}

/** The decoded-lane-shaped tree for one leaf: leaf wrapper > card
 *  wrapper > card body. `cardChildren` overrides the card wrapper's
 *  children (to model a still-pending Flight row). */
function leafLaneTree(
  ids: { leaf: string; card: string; price: string },
  opts?: { activity?: boolean; cardChildren?: ReactNode },
): ReactNode {
  const wrap = (n: ReactNode): ReactNode =>
    opts?.activity ? <Activity mode="visible">{n}</Activity> : n
  const cardChildren = opts?.cardChildren ?? cardBodyOf(ids.price, opts)
  return wrap(peb(ids.leaf, "mk", wrap(peb(ids.card, "mk", cardChildren))))
}

/** The follow-up lane's body for the price parton. */
function priceLaneTree(price: string): ReactNode {
  return peb(price, "mk", <div data-testid="live-price">EUR 42.00</div>)
}

let seq = 0
/** Fresh ids per spec — the partial cache / slot-fill waiters are
 *  module-level state shared across specs. */
function freshIds() {
  seq += 1
  return { leaf: `leaf-${seq}`, card: `card-${seq}`, price: `price-${seq}` }
}

function priceRegionHtml(): string {
  return container.querySelector(".mt-auto")?.innerHTML ?? "(no .mt-auto)"
}

function expectFallbackShowing(): void {
  expect(container.querySelector('[data-testid="card-shell"]'), "card shell missing").not.toBeNull()
  expect(
    container.querySelector('[data-testid="fb"]'),
    `price fallback missing — .mt-auto committed: ${priceRegionHtml()}`,
  ).not.toBeNull()
}

async function commitPriceLaneAndSettle(ids: { price: string }): Promise<void> {
  await act(async () => {
    _commitPartonLane(priceLaneTree(ids.price), null, ids.price)
    await _settleLaneRewalksForTest(ids.price)
  })
  // The store's notify may ride the (stubbed) rAF quantum.
  flushRaf()
}

function expectPriceHealed(): void {
  expect(
    container.querySelector('[data-testid="live-price"]'),
    `price content missing after follow-up lane — .mt-auto: ${priceRegionHtml()}`,
  ).not.toBeNull()
}

// ─── Specs ──────────────────────────────────────────────────────────

describe("stream-defer stub gate through the real client pipeline", () => {
  it("static lane body: card shell AND price fallback commit; follow-up lane heals", async () => {
    const ids = freshIds()
    mountPage(placeholder(ids.leaf, "mk"))
    act(() => {
      _commitPartonLane(leafLaneTree(ids), null, ids.leaf)
    })
    flushRaf()
    expectFallbackShowing()
    await commitPriceLaneAndSettle(ids)
    expectPriceHealed()
  })

  it("keepalive Activity wrappers around every emission", async () => {
    const ids = freshIds()
    mountPage(placeholder(ids.leaf, "mk"))
    act(() => {
      _commitPartonLane(leafLaneTree(ids, { activity: true }), null, ids.leaf)
    })
    flushRaf()
    expectFallbackShowing()
    await commitPriceLaneAndSettle(ids)
    expectPriceHealed()
  })

  it("under StrictMode (the real browser entry wraps the app in it)", async () => {
    const ids = freshIds()
    mountPage(placeholder(ids.leaf, "mk"), { strict: true })
    act(() => {
      _commitPartonLane(leafLaneTree(ids, { activity: true }), null, ids.leaf)
    })
    flushRaf()
    expectFallbackShowing()
    await commitPriceLaneAndSettle(ids)
    expectPriceHealed()
  })

  it("card body arrives as a PENDING Flight row that resolves after the first commit", async () => {
    const ids = freshIds()
    mountPage(placeholder(ids.leaf, "mk"))
    const chunk = makeChunk()
    await act(async () => {
      _commitPartonLane(
        leafLaneTree(ids, { activity: true, cardChildren: chunk.node }),
        null,
        ids.leaf,
      )
    })
    flushRaf()
    await act(async () => {
      chunk.resolve(cardBodyOf(ids.price, { activity: true }))
      await _settleLaneRewalksForTest(ids.leaf)
    })
    flushRaf()
    expectFallbackShowing()
    await commitPriceLaneAndSettle(ids)
    expectPriceHealed()
  })

  it("leaf mounts through the CullPair content slot (skeleton -> content first fill)", async () => {
    // The real leaf is cullable: the page carries the PAIR (skeleton
    // showing, content slot an unbacked hole), and the flip-in lane
    // delivers the pair-shaped emission whose PEB body the walk
    // stores. The template re-render substitutes the hole inside the
    // pair; the content Activity (generation-keyed) mounts the body —
    // the price gate suspends inside it.
    const ids = freshIds()
    // In view: the skeleton's observer already reported visible.
    reportCullState(ids.leaf, true)
    const pairOf = (children: ReactNode): ReactNode => (
      <Activity mode="visible">
        <CullPair id={ids.leaf} culled={false} skel={<span data-testid="skel" />}>
          {children}
        </CullPair>
      </Activity>
    )
    mountPage(pairOf(placeholder(ids.leaf, "mk")))
    expect(container.querySelector('[data-testid="skel"]'), "skeleton should show").not.toBeNull()
    // Flip-in delivery: the full pair-shaped emission.
    act(() => {
      _commitPartonLane(
        pairOf(
          peb(
            ids.leaf,
            "mk",
            <Activity mode="visible">
              {peb(ids.card, "mk", cardBodyOf(ids.price, { activity: true }))}
            </Activity>,
          ),
        ),
        null,
        ids.leaf,
      )
    })
    flushRaf()
    expectFallbackShowing()
    await commitPriceLaneAndSettle(ids)
    expectPriceHealed()
  })

  it("sibling lane commits keep re-rendering the template while the price sits suspended", async () => {
    // Candidate (d): every sibling commit notifies -> transition ->
    // renderTemplate -> substitution. The suspended boundary must keep
    // its fallback across those re-renders.
    const ids = freshIds()
    const sib = freshIds()
    mountPage(
      <>
        {placeholder(ids.leaf, "mk")}
        {placeholder(sib.leaf, "mk")}
      </>,
    )
    act(() => {
      _commitPartonLane(leafLaneTree(ids, { activity: true }), null, ids.leaf)
    })
    flushRaf()
    expectFallbackShowing()
    // A burst of sibling commits (fresh trees each time) while the
    // price boundary is suspended.
    for (let i = 0; i < 3; i++) {
      act(() => {
        _commitPartonLane(
          <Activity mode="visible">
            {peb(sib.leaf, "mk", <div data-testid={`sib-${i}`} />)}
          </Activity>,
          null,
          sib.leaf,
        )
      })
      flushRaf()
    }
    expect(container.querySelector('[data-testid="sib-2"]')).not.toBeNull()
    expectFallbackShowing()
    await commitPriceLaneAndSettle(ids)
    expectPriceHealed()
  })

  it("on a HYDRATED root (the real browser entry hydrates over SSR HTML)", async () => {
    const ids = freshIds()
    const page = (
      <PartialsClient>
        <main>{placeholder(ids.leaf, "mk")}</main>
      </PartialsClient>
    )
    // SSR pass (PartialsClient returns raw children on the server),
    // then hydrate the same tree — the browser entry's boot shape.
    container.innerHTML = renderToString(page)
    act(() => root.unmount())
    let hydrated!: Root
    act(() => {
      hydrated = hydrateRoot(container, <React.StrictMode>{page}</React.StrictMode>)
    })
    root = hydrated
    act(() => {
      _commitPartonLane(leafLaneTree(ids, { activity: true }), null, ids.leaf)
    })
    flushRaf()
    expectFallbackShowing()
    await commitPriceLaneAndSettle(ids)
    expectPriceHealed()
  })

  it("leaf wrapper is never memoizable (perma-pending row) — every notify rebuilds the suspended subtree", async () => {
    // Candidate (d): a never-settling Flight row in an unrelated
    // corner of the card poisons the leaf's walk memo (sawPending —
    // never memoized), so every sibling notify rebuilds the whole
    // substituted subtree with FRESH element identities — the
    // suspended boundary's children are replaced each transition. The
    // fallback must survive the churn.
    const ids = freshIds()
    const sib = freshIds()
    const permaPending = makeChunk()
    const cardBody = (
      <div data-testid="card-shell">
        <h3>Product name</h3>
        <section data-testid="reviews">
          <Suspense fallback={<div data-testid="reviews-fb" />}>{permaPending.node}</Suspense>
        </section>
        <div className="mt-auto">
          <Suspense fallback={<div data-testid="fb">loading price…</div>}>
            <Activity mode="visible">
              {peb(ids.price, "mk", gatedPendingMarker(ids.price, "mk"))}
            </Activity>
          </Suspense>
        </div>
      </div>
    )
    mountPage(
      <>
        {placeholder(ids.leaf, "mk")}
        {placeholder(sib.leaf, "mk")}
      </>,
    )
    await act(async () => {
      _commitPartonLane(
        leafLaneTree(ids, { activity: true, cardChildren: cardBody }),
        null,
        ids.leaf,
      )
    })
    flushRaf()
    expectFallbackShowing()
    for (let i = 0; i < 3; i++) {
      act(() => {
        _commitPartonLane(
          <Activity mode="visible">
            {peb(sib.leaf, "mk", <div data-testid={`sib-${i}`} />)}
          </Activity>,
          null,
          sib.leaf,
        )
      })
      flushRaf()
    }
    expectFallbackShowing()
    await commitPriceLaneAndSettle(ids)
    expectPriceHealed()
  })

  it("a fallback-less spec's stub must NOT interpose its own Suspense — the app fallback owns the region", async () => {
    // THE EMPTY-AT-REST MECHANISM (found via the in-browser fiber
    // probe on /magento/browse): `const fallback = opts.fallback ??
    // null` (partial.tsx:1987) makes the spec-level fallback NULL —
    // never undefined — for a spec that declared none, and the
    // streamStub branch's `fallback !== undefined` guard then wraps
    // EVERY stub in `<Suspense fallback={null}>`. That null-fallback
    // boundary is a real boundary: it catches the PendingSlot gate's
    // suspension and commits `null` as its fallback (an empty
    // Fragment), so the suspension never reaches the app-level
    // Suspense — the price region sits committed-empty until the
    // follow-up lane stores (fiber dump: inner Suspense in fallback
    // state with an empty-props Fragment; outer app Suspense in
    // content state).
    //
    // This spec drives the CORRECT emission for a fallback-less spec —
    // the gate bare under the app Suspense (no interposed boundary) —
    // which is what the streamStub branch must produce when
    // `opts.fallback` is undefined. The next spec documents why: the
    // interposed null-fallback form swallows the suspension.
    const ids = freshIds()
    mountPage(placeholder(ids.leaf, "mk"))
    act(() => {
      _commitPartonLane(leafLaneTree(ids, { activity: true }), null, ids.leaf)
    })
    flushRaf()
    expectFallbackShowing()
    await commitPriceLaneAndSettle(ids)
    expectPriceHealed()
  })

  it("MECHANISM: an interposed <Suspense fallback={null}> in the stub swallows the gate's suspension", async () => {
    // The CURRENT emission shape for a fallback-less `defer: "stream"`
    // spec (partial.tsx:1987 + the streamStub branch's
    // `fallback !== undefined` guard). Documents the swallow through
    // the real pipeline: the inner null-fallback boundary catches the
    // PendingSlot throw and commits an EMPTY region; the app-level
    // fallback never renders. The framework fix is to key the guard on
    // `opts.fallback` (the author's declaration), never the
    // `?? null`-defaulted variable — after which this wire shape is no
    // longer produced for fallback-less specs.
    const ids = freshIds()
    mountPage(placeholder(ids.leaf, "mk"))
    const swallowedStub = peb(
      ids.price,
      "mk",
      <Suspense fallback={null}>{gatedPendingMarker(ids.price, "mk")}</Suspense>,
    )
    const cardBody = (
      <div data-testid="card-shell">
        <h3>Product name</h3>
        <div className="mt-auto">
          <Suspense fallback={<div data-testid="fb">loading price…</div>}>
            <Activity mode="visible">{swallowedStub}</Activity>
          </Suspense>
        </div>
      </div>
    )
    act(() => {
      _commitPartonLane(
        leafLaneTree(ids, { activity: true, cardChildren: cardBody }),
        null,
        ids.leaf,
      )
    })
    flushRaf()
    // The swallow: card shell committed, app fallback ABSENT, region
    // visually empty — the exact /magento/browse symptom.
    expect(container.querySelector('[data-testid="card-shell"]')).not.toBeNull()
    expect(
      container.querySelector('[data-testid="fb"]'),
      "the interposed null-fallback boundary should have swallowed the suspension",
    ).toBeNull()
    expect(container.querySelector(".mt-auto")?.textContent ?? "").toBe("")
    // The follow-up lane still heals the region.
    await commitPriceLaneAndSettle(ids)
    expectPriceHealed()
  })

  it("stub row settles between the walk and React's reconcile (raw-reveal TOCTOU) — the gate holds", async () => {
    // The row settles mid-render (forced by a component rendering
    // before the price region), so React commits the RAW wire form
    // natively, with no substitution pass over it. The PendingSlot
    // gate makes the raw form suspend instead of revealing the
    // boundary with the bare marker.
    const ids = freshIds()
    mountPage(placeholder(ids.leaf, "mk"))
    const stubChunk = makeChunk()
    const rawStub = (
      <Activity mode="visible">
        {peb(ids.price, "mk", gatedPendingMarker(ids.price, "mk"))}
      </Activity>
    )
    function SettleDuringRender(): ReactNode {
      stubChunk.resolve(rawStub)
      return <h3>Product name</h3>
    }
    const cardBody = (
      <div data-testid="card-shell">
        <SettleDuringRender />
        <div className="mt-auto">
          <Suspense fallback={<div data-testid="fb">loading price…</div>}>
            {stubChunk.node}
          </Suspense>
        </div>
      </div>
    )
    await act(async () => {
      _commitPartonLane(
        leafLaneTree(ids, { activity: true, cardChildren: cardBody }),
        null,
        ids.leaf,
      )
    })
    await act(async () => {
      await _settleLaneRewalksForTest(ids.leaf)
    })
    flushRaf()
    expectFallbackShowing()
    await commitPriceLaneAndSettle(ids)
    expectPriceHealed()
  })
})
