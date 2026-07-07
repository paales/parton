// @vitest-environment jsdom
import React, { act, useRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  _channelEstablished,
  _channelNavPoint,
  _channelNavSegmentCommitted,
  _channelNavSegmentSettled,
  _channelNavSubsumedByAttach,
  _resetChannelClient,
} from "../channel-client.ts"
import { PartialIdContext, useNavigation } from "../partial-client.tsx"
import { NavigationError } from "../../runtime/navigation-error.ts"
import type { NavigationProgress } from "../../runtime/navigation-api.ts"

/**
 * Hook contract under test:
 *
 *   const [reload, progress] = useNavigation().reload()
 *
 *   - `reload(options?)` returns `NavigationMilestones` synchronously:
 *     `{ committed: Promise, streaming: Promise, finished: Promise }`.
 *     Each rejects with a NavigationError on failure or AbortError on
 *     supersede.
 *   - `progress` is `{ committed, streaming, finished }` booleans,
 *     monotonic-per-fire, reset on each new fire.
 *   - On rejection (non-Abort), the hook throws on the next render so
 *     the nearest enclosing React error boundary catches. AbortError
 *     never throws (lifecycle signal, not a failure).
 *
 * Tests wrap `Probe` in a `TestBoundary` to capture both the per-render
 * progress booleans (via `cap.states`) AND the thrown error (via
 * `cap.caughtByBoundary`). The transport is the channel: a selector
 * reload is a `?__force=` url statement whose milestones resolve at the
 * covering segment's commit/settle — the tests drive those moments
 * directly (`_channelNavSegmentCommitted` / `Settled`) and read the
 * statement's content off the attach subsume's folded intent.
 */

let container: HTMLElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  _resetChannelClient()
  _channelEstablished("tuple-test")
  // Envelope flushes (when the environment provides rAF) go nowhere.
  vi.stubGlobal("fetch", () => Promise.resolve({ status: 204 }))
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  container.remove()
  _resetChannelClient()
  vi.unstubAllGlobals()
})

interface FireOpts {
  selector?: string | string[]
  signal?: AbortSignal
}

interface Capture {
  /** Returns the `finished` milestone of the most recent fire. */
  fire: ((opts?: FireOpts) => Promise<unknown>) | null
  states: NavigationProgress[]
  caughtByBoundary: Error | null
}

function Probe({ capture }: { capture: Capture }) {
  const [reload, progress] = useNavigation().reload()
  const fireRef = useRef(reload)
  fireRef.current = reload
  capture.fire = (opts) => reload(opts).finished
  capture.states.push({
    committed: progress.committed,
    streaming: progress.streaming,
    finished: progress.finished,
  })
  return null
}

class TestBoundary extends React.Component<
  { capture: Capture; children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    this.props.capture.caughtByBoundary = error
  }
  render() {
    if (this.state.error) return null
    return this.props.children
  }
}

async function render(capture: Capture, partialId: string | null = null) {
  await act(async () => {
    root = createRoot(container)
    root.render(
      <TestBoundary capture={capture}>
        <PartialIdContext.Provider value={partialId}>
          <Probe capture={capture} />
        </PartialIdContext.Provider>
      </TestBoundary>,
    )
  })
}

function newCapture(): Capture {
  return { fire: null, states: [], caughtByBoundary: null }
}

/** The labels the most recent fire stated, read off the attach
 *  subsume's folded intent (`?__force=` on the pending statement's
 *  URL). Also re-anchors the pending records at 0 — `settleAll`
 *  resolves them. */
function statedForce(): string | null {
  const intent = _channelNavSubsumedByAttach()
  if (intent.url === null) return null
  return new URL(intent.url, "http://t").searchParams.get("__force")
}

/** Resolve every pending record (post-subsume, as-of 0 covers all). */
async function settleAll(): Promise<void> {
  await act(async () => {
    _channelNavSegmentCommitted(0)
    _channelNavSegmentSettled(0)
  })
}

const ALL_FALSE: NavigationProgress = {
  committed: false,
  streaming: false,
  finished: false,
}
const ALL_TRUE: NavigationProgress = {
  committed: true,
  streaming: true,
  finished: true,
}

describe("useNavigation().reload() progress tuple", () => {
  it("starts with all milestones false", async () => {
    const cap = newCapture()
    await render(cap)
    expect(cap.states[cap.states.length - 1]).toEqual(ALL_FALSE)
  })

  it("flips committed → streaming → finished as the covering segment lands", async () => {
    const cap = newCapture()
    await render(cap)
    cap.states = []

    let firePromise!: Promise<unknown>
    await act(async () => {
      firePromise = cap.fire!({ selector: "#hero" })
    })
    // For a selector reload, committed resolves immediately (no URL
    // change), but streaming + finished await the covering segment.
    expect(cap.states[cap.states.length - 1]).toMatchObject({
      committed: true,
      streaming: false,
      finished: false,
    })
    const navPoint = _channelNavPoint()
    expect(navPoint).toBeGreaterThan(0)

    // The covering segment commits.
    await act(async () => {
      _channelNavSegmentCommitted(navPoint)
    })
    expect(cap.states[cap.states.length - 1]).toMatchObject({
      committed: true,
      streaming: true,
      finished: false,
    })

    // The covering segment settles.
    await act(async () => {
      _channelNavSegmentSettled(navPoint)
      await firePromise
    })
    expect(cap.states[cap.states.length - 1]).toEqual(ALL_TRUE)
  })

  it("flips finished → true on AbortError but stores no error", async () => {
    const cap = newCapture()
    await render(cap)
    cap.states = []

    const controller = new AbortController()
    await act(async () => {
      const p = cap.fire!({ selector: "#hero", signal: controller.signal })
      controller.abort()
      await p.catch(() => {})
    })

    const last = cap.states[cap.states.length - 1]
    // Abort still lands the lifecycle — finished flips true.
    // committed flips true because the URL didn't change. streaming
    // stays false because the abort came before the covering segment.
    expect(last.finished).toBe(true)
    expect(last.committed).toBe(true)
    expect(last.streaming).toBe(false)
    // The bubbler never receives an abort.
    expect(cap.caughtByBoundary).toBeNull()
  })
})

describe('"@self" token resolution', () => {
  it('substitutes "@self" with the ambient partial id in selector', async () => {
    const cap = newCapture()
    await render(cap, "hero:abc")

    await act(async () => {
      void cap.fire!({ selector: "@self" })
    })
    expect(statedForce()).toBe("hero:abc")
    await settleAll()
  })

  it('substitutes "@self" inside an array selector alongside other labels', async () => {
    const cap = newCapture()
    await render(cap, "card:xyz")

    await act(async () => {
      void cap.fire!({ selector: ["@self", ".price"] })
    })
    const labels = (statedForce() ?? "").split(",")
    expect(labels).toContain("card:xyz")
    expect(labels).toContain("price")
    await settleAll()
  })

  it("throws a NavigationError to the boundary when @self is used outside a partial", async () => {
    const cap = newCapture()
    await render(cap, null)

    let caught: unknown
    await act(async () => {
      caught = await cap.fire!({ selector: "@self" }).catch((e) => e)
    })
    // Errors thrown synchronously from the fire body (resolveSelfIn…
    // throws on missing partial id) get wrapped into a
    // NavigationError and surface through the milestone-rejection /
    // render-throw bubbler path.
    expect(caught).toBeInstanceOf(NavigationError)
    expect((caught as NavigationError).message).toContain("@self")
    // Nothing was stated — no pending statement folds into an attach.
    expect(statedForce()).toBeNull()
    expect(cap.caughtByBoundary).toBeInstanceOf(NavigationError)
  })

  it("leaves selectors without @self untouched even when ambient id is set", async () => {
    const cap = newCapture()
    await render(cap, "hero:abc")

    await act(async () => {
      void cap.fire!({ selector: "#cart" })
    })
    expect(statedForce()).toBe("cart")
    await settleAll()
  })
})
