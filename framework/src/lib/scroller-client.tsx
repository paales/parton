"use client"

/**
 * The scroller's anchor↔URL glue — two-way sync between the anchor
 * param (`?page=N`) and the scroll position, framework-internal
 * (placed by the scroller root, never by an app).
 *
 *  - On mount, an anchored deep link (or the entry a back-nav
 *    restores) scrolls the target interval into view — in a LAYOUT
 *    effect, so a client nav lands at the anchor on first paint
 *    instead of painting at the head and jumping. (The cold document
 *    path is the root's pre-hydration inline script.)
 *  - As the user scrolls, the interval crossing the viewport's center
 *    is mirrored back to the param — `navigate({history: "replace",
 *    silent: true})`: no refetch (culling already follows the
 *    viewport), no history pile-up. Framework-silent navs are
 *    intercepted with `scroll: "manual"`, so the mirror never moves
 *    the viewport it's describing.
 *
 * Position is read from the interval markers the tree's parents emit
 * (`[data-s=<name>]` with `data-so`/`data-sn`): they exist in every
 * cull state, so deep links land inside still-culled regions (the
 * shell's reservation is the landing strip). The scroll listener is
 * capture-phase on window, so container scrollers (an overflow panel
 * hosting the collection) mirror the same way as the document.
 */

import { useEffect, useLayoutEffect } from "react"
import { useNavigation } from "./use-navigation.tsx"

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect

/** The deepest marked interval of `name` containing item index `t` —
 *  deepest = smallest span, the most precise landing box. */
function intervalFor(name: string, t: number): HTMLElement | null {
  let best: HTMLElement | null = null
  for (const el of document.querySelectorAll<HTMLElement>(`[data-s="${CSS.escape(name)}"]`)) {
    const o = Number(el.dataset.so)
    const n = Number(el.dataset.sn)
    if (!(t >= o && t < o + n)) continue
    if (best === null || n < Number(best.dataset.sn)) best = el
  }
  return best
}

export function ScrollerAnchorSync({
  name,
  param,
  step,
}: {
  name: string
  param: string
  step: number
}) {
  const nav = useNavigation()
  const [navigate] = nav.navigate()

  // Deep-link / restore landing — before paint.
  useIsoLayoutEffect(() => {
    const url = nav.currentEntry?.url
    const page = url ? Number(new URL(url).searchParams.get(param) || "1") : 1
    if (page > 1) {
      intervalFor(name, (page - 1) * step)?.scrollIntoView({ block: "start" })
    }
    // Mount-only: the landing is for the entry this mount belongs to.
  }, [])

  // Mirror the centered interval back to the param after scroll settles.
  useEffect(() => {
    const url0 = nav.currentEntry?.url
    let lastVal = url0 ? (new URL(url0).searchParams.get(param) ?? "") : ""
    let timer: ReturnType<typeof setTimeout> | undefined
    const sync = () => {
      const cy = window.innerHeight / 2
      // The interval under the viewport's center — resolved by HIT
      // TEST, not marker geometry. `elementFromPoint` is occlusion-
      // aware: while an overlay (search dialog, drawer) covers the
      // collection, the hit lands on the overlay, no marker is found,
      // and the mirror stands down — the position of an occluded
      // collection isn't meaningful, and a mirror write here would
      // race whatever the overlay is doing. (The predecessor of this
      // guard was a load-more sentinel sniffing `?search=` out of the
      // URL — an app-coupled heuristic; the hit test is the signal
      // itself.) The deepest marker containing the hit is the
      // leaf-most interval at center.
      const hit = document.elementFromPoint(window.innerWidth / 2, cy)
      const center = hit?.closest<HTMLElement>(`[data-s="${CSS.escape(name)}"]`) ?? null
      if (center === null) return
      const o = Number(center.dataset.so)
      const n = Number(center.dataset.sn)
      const r = center.getBoundingClientRect()
      const frac = r.height > 0 ? Math.min(1, Math.max(0, (cy - r.top) / r.height)) : 0
      const page = Math.floor((o + frac * n) / step) + 1
      const want = page > 1 ? String(page) : ""
      if (want === lastVal) return
      lastVal = want
      navigate(
        (url) => {
          if (want) url.searchParams.set(param, want)
          else url.searchParams.delete(param)
          return url
        },
        { history: "replace", silent: true },
      )
    }
    const onScroll = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(sync, 150)
    }
    // Capture-phase: scroll events don't bubble, but capture sees
    // container scrollers hosting the collection, not just the window.
    window.addEventListener("scroll", onScroll, { passive: true, capture: true })
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true })
      if (timer) clearTimeout(timer)
    }
  }, [nav, navigate, name, param, step])

  return null
}
