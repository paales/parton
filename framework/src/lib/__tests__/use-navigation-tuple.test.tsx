// @vitest-environment jsdom
import { act, useRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PartialIdContext, useNavigation } from "../partial-client.tsx"
import { NavigationError } from "../../runtime/navigation-error.ts"

/**
 * Tuple hook contract:
 *
 *   const [reload, isPending, error] = useNavigation().reload()
 *
 *   - `reload(options?)` returns a Promise<entry> that rejects with a
 *     NavigationError on failure or AbortError on supersede.
 *   - `isPending` is `true` from fire until the promise settles.
 *   - `error` holds the last NavigationError (or null). AbortError
 *     never sets error, just clears pending.
 *
 * Tests rely on the same stubbing of `__rsc_partial_refetch` that
 * `when-stored.test.tsx` uses — the targeted-refetch path that
 * `reload({selector})` dispatches through.
 */

let container: HTMLElement
let root: Root | null = null
let refetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  refetchSpy = vi.fn(() => Promise.resolve())
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

interface Capture {
  fire: ((opts?: { selector: string }) => Promise<unknown>) | null
  states: Array<{ pending: boolean; error: NavigationError | null }>
}

function Probe({ capture }: { capture: Capture }) {
  const [reload, isPending, error] = useNavigation().reload()
  const fireRef = useRef(reload)
  fireRef.current = reload
  capture.fire = (opts) => reload(opts)
  capture.states.push({ pending: isPending, error })
  return null
}

async function render(capture: Capture) {
  await act(async () => {
    root = createRoot(container)
    root.render(<Probe capture={capture} />)
  })
}

function newCapture(): Capture {
  return { fire: null, states: [] }
}

describe("useNavigation().reload() tuple hook", () => {
  it("starts with [_, false, null]", async () => {
    const cap = newCapture()
    await render(cap)
    expect(cap.states[cap.states.length - 1]).toEqual({ pending: false, error: null })
  })

  it("sets pending true on fire, clears on success", async () => {
    const cap = newCapture()
    let resolveFetch!: () => void
    refetchSpy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveFetch = resolve
        }),
    )
    await render(cap)
    cap.states = []

    let firePromise: Promise<unknown>
    await act(async () => {
      firePromise = cap.fire!({ selector: "#hero" })
    })
    // After fire, pending should be true.
    expect(cap.states.some((s) => s.pending)).toBe(true)
    expect(cap.states[cap.states.length - 1].pending).toBe(true)

    // Resolve the in-flight refetch; pending clears.
    await act(async () => {
      resolveFetch()
      await firePromise
    })
    expect(cap.states[cap.states.length - 1]).toEqual({ pending: false, error: null })
  })

  it("publishes a NavigationError when the refetch rejects", async () => {
    const cap = newCapture()
    const failure = new NavigationError({
      kind: "network",
      url: "http://x/?partials=hero",
      message: "boom",
    })
    refetchSpy.mockImplementation(() => Promise.reject(failure))
    await render(cap)
    cap.states = []

    await act(async () => {
      // The fire promise rejects — swallow so the test doesn't error.
      await cap.fire!({ selector: "#hero" }).catch(() => {})
    })

    const last = cap.states[cap.states.length - 1]
    expect(last.pending).toBe(false)
    expect(last.error).toBe(failure)
  })

  it("classifies a plain TypeError as a network error", async () => {
    const cap = newCapture()
    refetchSpy.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")))
    await render(cap)
    cap.states = []

    await act(async () => {
      await cap.fire!({ selector: "#hero" }).catch(() => {})
    })

    const last = cap.states[cap.states.length - 1]
    expect(last.pending).toBe(false)
    expect(last.error).toBeInstanceOf(NavigationError)
    expect(last.error?.kind).toBe("network")
  })

  it("silently clears pending on AbortError (no error stored)", async () => {
    const cap = newCapture()
    const abort = new Error("aborted")
    abort.name = "AbortError"
    refetchSpy.mockImplementation(() => Promise.reject(abort))
    await render(cap)
    cap.states = []

    await act(async () => {
      await cap.fire!({ selector: "#hero" }).catch(() => {})
    })

    const last = cap.states[cap.states.length - 1]
    expect(last.pending).toBe(false)
    expect(last.error).toBeNull()
  })
})

describe('"@self" token resolution', () => {
  /**
   * Render Probe under a PartialIdContext.Provider so the ambient
   * id is set — same wiring `<PartialErrorBoundary>` does in the
   * real tree.
   */
  async function renderInPartial(cap: Capture, partialId: string | null) {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <PartialIdContext.Provider value={partialId}>
          <Probe capture={cap} />
        </PartialIdContext.Provider>,
      )
    })
  }

  it('substitutes "@self" with the ambient partial id in selector', async () => {
    const cap = newCapture()
    await renderInPartial(cap, "hero:abc")

    await act(async () => {
      await cap.fire!({ selector: "@self" })
    })

    const url = new URL(refetchSpy.mock.calls[0]?.[0] as string)
    expect(url.searchParams.get("partials")).toBe("hero:abc")
  })

  it('substitutes "@self" inside an array selector alongside other labels', async () => {
    const cap = newCapture()
    await renderInPartial(cap, "card:xyz")

    await act(async () => {
      await cap.fire!({ selector: ["@self", ".price"] })
    })

    const labels = (new URL(refetchSpy.mock.calls[0]?.[0] as string).searchParams.get("partials") ?? "").split(
      ",",
    )
    expect(labels).toContain("card:xyz")
    expect(labels).toContain("price")
  })

  it('rekeys props["@self"] to the ambient partial id', async () => {
    const cap = newCapture()
    await renderInPartial(cap, "slow:1")

    await act(async () => {
      await cap.fire!({
        selector: "@self",
        props: { "@self": { flavor: "vanilla" } },
      })
    })

    const url = new URL(refetchSpy.mock.calls[0]?.[0] as string)
    const props = JSON.parse(url.searchParams.get("partialProps") ?? "{}")
    expect(props).toEqual({ "slow:1": { flavor: "vanilla" } })
  })

  it("rejects with a NavigationError when @self is used outside a partial", async () => {
    const cap = newCapture()
    await renderInPartial(cap, null)
    cap.states = []

    let caught: unknown
    await act(async () => {
      caught = await cap.fire!({ selector: "@self" }).catch((e) => e)
    })
    expect(caught).toBeInstanceOf(NavigationError)
    expect((caught as NavigationError).message).toContain("@self")
    expect(refetchSpy).not.toHaveBeenCalled()

    const last = cap.states[cap.states.length - 1]
    expect(last.pending).toBe(false)
    expect(last.error).toBeInstanceOf(NavigationError)
  })

  it("leaves selectors without @self untouched even when ambient id is set", async () => {
    const cap = newCapture()
    await renderInPartial(cap, "hero:abc")

    await act(async () => {
      await cap.fire!({ selector: "#cart" })
    })

    const url = new URL(refetchSpy.mock.calls[0]?.[0] as string)
    expect(url.searchParams.get("partials")).toBe("cart")
  })
})
