import {
  createFromReadableStream,
  createFromFetch,
  setServerCallback,
  createTemporaryReferenceSet,
  encodeReply,
} from "@vitejs/plugin-rsc/browser"
import React from "react"
import { createRoot, hydrateRoot } from "react-dom/client"
import { rscStream } from "rsc-html-stream/client"
import type { RscPayload } from "./entry.rsc"
import { GlobalErrorBoundary } from "@parton/framework/runtime/error-boundary.tsx"
import { NavigationError } from "@parton/framework/runtime/navigation-error.ts"
import { createRscRenderRequest } from "@parton/framework/runtime/request.tsx"
import {
  _collectFramePaths,
  _dispatchFrameRefetch,
  _readFramesSnapshot,
  getCachedPartialIds,
  isFrameworkSilentInfo,
} from "@parton/framework/lib/partial-client.tsx"
import { getNavigation } from "@parton/framework/runtime/navigation-api.ts"

async function main() {
  let setPayload: (v: RscPayload) => void
  let setPayloadRaw: (v: RscPayload) => void

  const initialPayload = await createFromReadableStream<RscPayload>(rscStream)

  function BrowserRoot() {
    const [payload, setPayload_] = React.useState(initialPayload)

    React.useEffect(() => {
      setPayload = (v) => React.startTransition(() => setPayload_(v))
      setPayloadRaw = setPayload_
    }, [setPayload_])

    React.useEffect(() => {
      return listenNavigation((url) => fetchRscPayload(url).finished)
    }, [])

    return payload.root
  }

  /**
   * Returns synchronously with `{streaming, finished}` promises so
   * navigation-handle callers can branch off the first-segment moment
   * separately from the full-body-drained moment. The work runs in a
   * detached async IIFE so the caller can attach handlers before the
   * fetch even starts.
   */
  function fetchRscPayload(
    overrideUrl?: string,
    signal?: AbortSignal,
  ): { streaming: Promise<void>; finished: Promise<void> } {
    let resolveStreaming!: () => void
    let rejectStreaming!: (err: unknown) => void
    let resolveFinished!: () => void
    let rejectFinished!: (err: unknown) => void
    const streaming = new Promise<void>((res, rej) => {
      resolveStreaming = res
      rejectStreaming = rej
    })
    const finished = new Promise<void>((res, rej) => {
      resolveFinished = res
      rejectFinished = rej
    })
    streaming.catch(() => {})

    void (async () => {
      let streamingResolved = false
      try {
        // Tell the server which partials are already cached so it can skip them.
        // If the caller already set ?cached= (e.g. a targeted refetch built by
        // `useNavigation().reload({selector})`), respect that instead of overwriting
        // with the full list.
        const url = new URL(overrideUrl ?? window.location.href)
        if (!url.searchParams.has("cached")) {
          const cachedIds = getCachedPartialIds()
          if (cachedIds.length > 0) {
            url.searchParams.set("cached", cachedIds.join(","))
          }
        }
        // See `e2e-testing/src/entry.browser.tsx` for the streaming-vs-
        // transition rationale. `?streaming=1` opts into the
        // setPayloadRaw path; default is the transition wrap.
        const streamingMode = url.searchParams.has("streaming")
        const renderRequest = createRscRenderRequest(url.toString())
        // Classify fetch failures so they reach the NavigationError
        // surface — see e2e-testing/src/entry.browser.tsx for rationale.
        let response: Response
        try {
          response = await fetch(renderRequest, { signal })
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") throw err
          throw new NavigationError({
            kind: "network",
            url: renderRequest.url,
            cause: err,
          })
        }
        if (!response.ok || !response.body) {
          throw new NavigationError({
            kind: "http",
            url: renderRequest.url,
            status: response.status,
          })
        }
        let payload: RscPayload
        try {
          payload = await createFromReadableStream<RscPayload>(response.body)
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") throw err
          throw new NavigationError({
            kind: "decode",
            url: renderRequest.url,
            cause: err,
          })
        }
        if (streamingMode) {
          setPayloadRaw(payload)
        } else {
          setPayload(payload)
        }
        streamingResolved = true
        resolveStreaming()
        resolveFinished()
      } catch (err) {
        if (!streamingResolved) rejectStreaming(err)
        rejectFinished(err)
      }
    })()

    return { streaming, finished }
  }

  // Navigation handles (useNavigation / frame) dispatch targeted
  // refetches by calling this handler with a fully-formed URL.
  // Exposed on `window` directly to avoid module-instance duplication
  // between the browser entry bundle and "use client" component
  // bundles.
  ;(window as any).__rsc_partial_refetch = (
    url: string,
    signal?: AbortSignal,
  ) => fetchRscPayload(url, signal)

  setServerCallback(async (id, args) => {
    const temporaryReferences = createTemporaryReferenceSet()
    // Include cached partial fingerprints so the server can skip
    // unchanged partials after a server action (same as navigation).
    const actionUrl = new URL(window.location.href)
    const cachedIds = getCachedPartialIds()
    if (cachedIds.length > 0) {
      actionUrl.searchParams.set("cached", cachedIds.join(","))
    }
    const renderRequest = createRscRenderRequest(actionUrl.toString(), {
      id,
      body: await encodeReply(args, { temporaryReferences }),
    })
    const payload = await createFromFetch<RscPayload>(fetch(renderRequest), {
      temporaryReferences,
    })

    setPayload(payload)
    const { ok, data } = payload.returnValue!
    if (!ok) throw data
    return data
  })

  const browserRoot = (
    <React.StrictMode>
      <GlobalErrorBoundary>
        <BrowserRoot />
      </GlobalErrorBoundary>
    </React.StrictMode>
  )

  if ("__NO_HYDRATE" in globalThis) {
    createRoot(document).render(browserRoot)
  } else {
    hydrateRoot(document, browserRoot, {
      formState: initialPayload.formState,
      onRecoverableError: silenceTornStream,
    })
  }

  if (import.meta.hot) {
    import.meta.hot.on("rsc:update", () => {
      fetchRscPayload().finished.catch((err) => {
        if (err instanceof Error && err.name === "AbortError") return
        console.error(err)
      })
    })
  }
}

function listenNavigation(onNavigation: (url: string) => Promise<void>) {
  const nav = getNavigation()
  if (!nav) return () => {}
  const handler = (event: NavigateEvent) => {
    if (!event.canIntercept) return
    if (event.hashChange || event.downloadRequest !== null) return
    // `formMethod` isn't on TS 6's NavigateEvent type but is in the
    // spec (and runtime). Reach it via a narrow cast to avoid a type
    // error without broadening `event`'s type everywhere else.
    if ((event as { formMethod?: string | null }).formMethod === "POST") return
    // `window.location.reload()` fires a navigate event with
    // `navigationType: "reload"` that the browser *can* intercept as
    // same-document. Intercepting defeats the whole point of a reload
    // (it re-runs against the existing module state). Pass it through
    // so the browser does a real cross-document reload.
    if (event.navigationType === "reload") return

    // Framework-internal URL syncs stamp a branded `info` payload on
    // their `navigation.navigate(...)` call. Two variants:
    //   - window-silent: caller updated the URL only (or will dispatch
    //     its own targeted refetch).
    //   - frame:         caller pushed a frame-state entry; the frame
    //     subtree refetch runs in `frameNavigateImpl` after commit.
    // In both cases we call `event.intercept()` with no handler to
    // declare the navigation as same-document and avoid a page load.
    //
    // `focusReset: "manual"` opts out of the Navigation API's default
    // post-commit focus reset to <body>. Without it, any input driving
    // a live refetch (the search input typing into `selector: ".…"`,
    // a filter that updates a frame URL, etc.) loses focus on every
    // keystroke.
    if (isFrameworkSilentInfo(event.info)) {
      event.intercept({ focusReset: "manual" })
      return
    }

    // Browser back/forward. Two axes need handling on a traverse:
    //   1. Page URL changed (e.g. /frames-demo?product=beta → /frames-demo)
    //      — the main page content needs a full refetch.
    //   2. Frame snapshots differ between destination and current
    //      — each differing frame needs its server session updated
    //      AND its subtree re-rendered. This fires when the user has
    //      done explicit `history: "push"` / `"replace"` frame navs
    //      (which create browser entries). The default `history:
    //      "auto"` on frames uses `updateCurrentEntry`, which doesn't
    //      create entries, so drawer-shaped frames never show up here.
    //
    // Both axes are handled in one request: we build a refetch URL
    // with the destination's page URL AND append `__frame/__frameUrl`
    // pairs for every frame that changed, so the server applies the
    // session updates, then does a streaming render for the new URL.
    //
    // If the URL didn't change and only frames changed, skip the full
    // render and fire targeted per-frame refetches instead.
    if (event.navigationType === "traverse") {
      const destPaths = _collectFramePaths(_readFramesSnapshot(event.destination.getState?.()))
      const currentPaths = _collectFramePaths(
        _readFramesSnapshot(nav.currentEntry?.getState() ?? null),
      )
      const names = new Set([...Object.keys(destPaths), ...Object.keys(currentPaths)])
      // Each diff entry carries the dotted frame path and the destination URL.
      const diffs: Array<{ key: string; url: string }> = []
      for (const name of names) {
        const dest = destPaths[name]?.url
        const cur = currentPaths[name]?.url
        if (dest && dest !== cur) diffs.push({ key: name, url: dest })
      }
      const urlChanged = event.destination.url !== window.location.href
      if (urlChanged) {
        event.intercept({
          handler: () =>
            swallowNavigationAbort(async () => {
              const url = new URL(event.destination.url)
              for (const d of diffs) {
                url.searchParams.append("__frame", d.key)
                url.searchParams.append("__frameUrl", d.url)
              }
              const handler = (
                window as Window & {
                  __rsc_partial_refetch?: (
                    url: string,
                    signal?: AbortSignal,
                  ) => { streaming: Promise<void>; finished: Promise<void> }
                }
              ).__rsc_partial_refetch
              if (handler) await handler(url.toString()).finished
            }),
        })
        return
      }
      if (diffs.length > 0) {
        event.intercept({
          handler: () =>
            swallowNavigationAbort(() =>
              Promise.all(
                diffs.map((d) => _dispatchFrameRefetch(d.key.split("."), d.url).finished),
              ).then(() => undefined),
            ),
        })
        return
      }
    }

    event.intercept({
      handler: () => swallowNavigationAbort(() => onNavigation(event.destination.url)),
    })
  }

  nav.addEventListener("navigate", handler)
  return () => nav.removeEventListener("navigate", handler)
}

// When a client-initiated navigation (or the in-flight refetch for the
// initial page) gets cancelled mid-stream — user clicks away, newer
// navigation supersedes — React sees a Suspense boundary that never
// finished and logs "The server could not finish this Suspense boundary"
// through onRecoverableError. Expected; swallow it. Any other recoverable
// error still surfaces.
function silenceTornStream(error: unknown): void {
  if (
    error instanceof Error &&
    (error.message.includes("The server could not finish this Suspense boundary") ||
      error.name === "AbortError")
  ) {
    return
  }
  console.error(error)
}

// Wrap a navigate-intercept handler so AbortError (newer navigation
// supersedes an in-flight one) doesn't surface as an unhandled rejection.
async function swallowNavigationAbort(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return
    throw err
  }
}

main()
