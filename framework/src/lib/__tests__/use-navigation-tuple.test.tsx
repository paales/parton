// @vitest-environment jsdom
import React, { act, useRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
 * `cap.caughtByBoundary`). The host's `__rsc_partial_refetch` is
 * stubbed to return `{streaming, finished}` exactly as the real entry
 * does.
 */

let container: HTMLElement
let root: Root | null = null
let refetchSpy: ReturnType<typeof vi.fn>

/**
 * Helper for failure mocks: returns a `{streaming, finished}` pair
 * pre-rejected with `err`, with no-op rejection handlers attached so
 * `unhandledrejection` doesn't fire between mock construction and the
 * framework's downstream `.then(_, errHandler)` attachment. The
 * pre-attached `.catch` doesn't consume the rejection — subsequent
 * handlers still see it.
 */
function rejectingMilestones(err: unknown) {
  const streaming = Promise.reject<void>(err as never)
  const finished = Promise.reject<void>(err as never)
  streaming.catch(() => {})
  finished.catch(() => {})
  return { streaming, finished }
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  refetchSpy = vi.fn(() => ({
    streaming: Promise.resolve(),
    finished: Promise.resolve(),
  }))
  ;(window as Window & { __rsc_partial_refetch?: unknown }).__rsc_partial_refetch = refetchSpy
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  container.remove()
  delete (window as Window & { __rsc_partial_refetch?: unknown }).__rsc_partial_refetch
})

interface FireOpts {
  selector?: string | string[]
}

interface Capture {
  /** Returns the `finished` milestone of the most recent fire — most
   *  tests just want "await the navigation to complete." */
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

  it("flips committed → streaming → finished as a fire progresses", async () => {
    const cap = newCapture()
    let resolveStreaming!: () => void
    let resolveFinished!: () => void
    refetchSpy.mockImplementation(() => ({
      streaming: new Promise<void>((res) => {
        resolveStreaming = res
      }),
      finished: new Promise<void>((res) => {
        resolveFinished = res
      }),
    }))
    await render(cap)
    cap.states = []

    let firePromise!: Promise<unknown>
    await act(async () => {
      firePromise = cap.fire!({ selector: "#hero" })
    })
    // For a selector reload, committed resolves immediately (no URL
    // change), but streaming + finished are still pending.
    expect(cap.states[cap.states.length - 1]).toMatchObject({
      committed: true,
      streaming: false,
      finished: false,
    })

    // First segment lands.
    await act(async () => {
      resolveStreaming()
    })
    expect(cap.states[cap.states.length - 1]).toMatchObject({
      committed: true,
      streaming: true,
      finished: false,
    })

    // Body drains.
    await act(async () => {
      resolveFinished()
      await firePromise
    })
    expect(cap.states[cap.states.length - 1]).toEqual(ALL_TRUE)
  })

  it("throws a NavigationError to the boundary when the refetch rejects", async () => {
    const cap = newCapture()
    const failure = new NavigationError({
      kind: "network",
      url: "http://x/?partials=hero",
      message: "boom",
    })
    refetchSpy.mockImplementation(() => rejectingMilestones(failure))
    await render(cap)

    await act(async () => {
      // The fire's finished promise rejects — swallow so the test
      // doesn't error.
      await cap.fire!({ selector: "#hero" }).catch(() => {})
    })

    expect(cap.caughtByBoundary).toBe(failure)
  })

  it("classifies a plain TypeError as a network error and throws it", async () => {
    const cap = newCapture()
    const failure = new TypeError("Failed to fetch")
    refetchSpy.mockImplementation(() => rejectingMilestones(failure))
    await render(cap)

    await act(async () => {
      await cap.fire!({ selector: "#hero" }).catch(() => {})
    })

    expect(cap.caughtByBoundary).toBeInstanceOf(NavigationError)
    expect((cap.caughtByBoundary as NavigationError).kind).toBe("network")
  })

  it("flips finished → true on AbortError but stores no error", async () => {
    const cap = newCapture()
    const abort = new Error("aborted")
    abort.name = "AbortError"
    refetchSpy.mockImplementation(() => rejectingMilestones(abort))
    await render(cap)
    cap.states = []

    await act(async () => {
      await cap.fire!({ selector: "#hero" }).catch(() => {})
    })

    const last = cap.states[cap.states.length - 1]
    // Abort still lands the lifecycle — finished flips true.
    // committed flips true because the URL didn't change. streaming
    // stays false because the abort came before the first segment.
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
      await cap.fire!({ selector: "@self" })
    })

    const url = new URL(refetchSpy.mock.calls[0]?.[0] as string)
    expect(url.searchParams.get("partials")).toBe("hero:abc")
  })

  it('substitutes "@self" inside an array selector alongside other labels', async () => {
    const cap = newCapture()
    await render(cap, "card:xyz")

    await act(async () => {
      await cap.fire!({ selector: ["@self", ".price"] })
    })

    const labels = (
      new URL(refetchSpy.mock.calls[0]?.[0] as string).searchParams.get("partials") ?? ""
    ).split(",")
    expect(labels).toContain("card:xyz")
    expect(labels).toContain("price")
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
    // render-throw bubbler path — same channel as a network failure.
    expect(caught).toBeInstanceOf(NavigationError)
    expect((caught as NavigationError).message).toContain("@self")
    expect(refetchSpy).not.toHaveBeenCalled()
    expect(cap.caughtByBoundary).toBeInstanceOf(NavigationError)
  })

  it("leaves selectors without @self untouched even when ambient id is set", async () => {
    const cap = newCapture()
    await render(cap, "hero:abc")

    await act(async () => {
      await cap.fire!({ selector: "#cart" })
    })

    const url = new URL(refetchSpy.mock.calls[0]?.[0] as string)
    expect(url.searchParams.get("partials")).toBe("cart")
  })
})
