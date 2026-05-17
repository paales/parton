"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { useNavigation } from "@parton/framework/lib/partial-client.tsx"
import { Button } from "@parton/copies/components/ui/button"
import { Input } from "@parton/copies/components/ui/input"

/**
 * Search toggle buttons for the header.
 *
 * Two variants:
 * - "Search (URL)":   sets `?search=1` on the PAGE URL.
 * - "Search (Frame)": navigates the `search` frame to `/?search=1`.
 *
 * `<SearchArea/>` is the same component in both modes; its scope
 * decides where `?search=` is read from.
 */
export function SearchToggle({ urlOpen }: { urlOpen: boolean }) {
  const [pageNavigate, pagePending] = useNavigation().navigate()
  const frameNav = useNavigation("search")
  const [frameNavigate] = frameNav.navigate()
  const frameEntryUrl = frameNav.currentEntry?.url
  const frameOpen = frameEntryUrl ? new URL(frameEntryUrl).searchParams.has("search") : false

  function openUrl() {
    void pageNavigate(
      (url) => {
        url.searchParams.set("search", "1")
        return url
      },
      { history: "push", selector: "#search-page" },
    )
  }

  function closeUrl() {
    void pageNavigate(
      (url) => {
        url.searchParams.delete("search")
        url.searchParams.delete("q")
        return url
      },
      { history: "push", selector: "#search-page" },
    )
  }

  function openFrame() {
    void frameNavigate("/?search=1")
  }

  function closeFrame() {
    void frameNavigate("/")
  }

  const Spinner = () => (
    <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-muted-foreground/60 border-t-foreground" />
  )

  if (urlOpen) {
    return (
      <Button type="button" size="sm" variant="secondary" onClick={closeUrl}>
        {pagePending ? <Spinner /> : <span>✕</span>}
        Close
      </Button>
    )
  }

  if (frameOpen) {
    return (
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={closeFrame}
        data-testid="search-frame-close"
      >
        <span>✕</span>
        Close
      </Button>
    )
  }

  return (
    <div className="flex gap-2">
      <Button type="button" size="sm" variant="outline" onClick={openUrl}>
        {pagePending ? <Spinner /> : <span>🔍</span>}
        Search (URL)
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={openFrame}
        data-testid="search-frame-open"
      >
        <span>🔍</span>
        Search (Frame)
      </Button>
    </div>
  )
}

/**
 * Dialog wrapper for the search overlay. Uses the native <dialog>
 * element with showModal() for focus trap + backdrop + Escape.
 */
export function SearchDialog({ open, children }: { open: boolean; children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const nav = useNavigation()
  const [navigate] = nav.navigate()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  function handleClose() {
    void navigate(
      (url) => {
        url.searchParams.delete("search")
        url.searchParams.delete("q")
        return url
      },
      {
        history: "push",
        selector: nav.name === null ? "#search-page" : undefined,
      },
    )
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={handleClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) handleClose()
      }}
      className="top-[15vh] max-h-[80vh] w-[calc(100vw-2em)] max-w-[720px] justify-self-center overflow-auto rounded-xl border bg-card p-5 text-card-foreground backdrop:bg-black/60"
    >
      {children}
    </dialog>
  )
}

/**
 * Search input with live partial refetch — scope-agnostic.
 *
 * Sequencing: only one navigation in flight at a time. Newer
 * keystrokes update `latestRef`; the active navigation's settle
 * handler re-checks and fires the next one if needed. `isPending`
 * from the tuple drives the spinner directly — no parallel state.
 */
export function SearchInput({ query }: { query: string }) {
  const nav = useNavigation()
  const [navigate, isPending] = nav.navigate()
  const [value, setValue] = useState(query)
  const [disableTransition, setDisableTransition] = useState(false)
  const disableTransitionRef = useRef(disableTransition)
  disableTransitionRef.current = disableTransition

  const latestRef = useRef(query)
  const dispatchedRef = useRef(query)
  const inFlightRef = useRef(false)

  async function sendLatest() {
    if (inFlightRef.current) return
    const q = latestRef.current
    if (q === dispatchedRef.current) return

    inFlightRef.current = true
    dispatchedRef.current = q

    try {
      await navigate(
        (url) => {
          if (q) url.searchParams.set("q", q)
          else url.searchParams.delete("q")
          return url
        },
        {
          history: "replace",
          disableTransition: disableTransitionRef.current,
          selector: ".search-results",
        },
      )
    } finally {
      inFlightRef.current = false
      sendLatest()
    }
  }

  function handleChange(next: string) {
    setValue(next)
    latestRef.current = next
    sendLatest()
  }

  const isStale = value !== dispatchedRef.current || isPending

  return (
    <div>
      <div className="relative">
        <Input
          type="text"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Search pokemon by name..."
          autoFocus
          className="h-11 pr-10 text-base"
        />
        {isStale && (
          <span className="pointer-events-none absolute top-1/2 right-3 inline-block size-4 -translate-y-1/2 animate-spin rounded-full border-2 border-muted-foreground/60 border-t-foreground" />
        )}
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <label
          data-testid="disable-transition-toggle"
          className="inline-flex cursor-pointer select-none items-center gap-2"
        >
          <input
            type="checkbox"
            checked={disableTransition}
            onChange={(e) => setDisableTransition(e.target.checked)}
          />
          <span>
            disableTransition:{" "}
            <code className={disableTransition ? "text-emerald-400" : "text-sky-400"}>
              {String(disableTransition)}
            </code>
          </span>
          <span className="text-muted-foreground/70">
            {disableTransition
              ? "plain setState — fallback flashes, streams per chunk"
              : "startTransition — preserve UI, no fallback, no streaming"}
          </span>
        </label>
        <span className="text-muted-foreground/70">
          {nav.name === null ? "page URL scope" : `frame "${nav.name}" scope`}
        </span>
      </div>
    </div>
  )
}
