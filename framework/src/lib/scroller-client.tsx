"use client"

/**
 * The scroller's client half — three framework-internal components
 * (placed by the scroller root/leaf specs, never by an app):
 *
 *  - `ScrollerLeafShell` — a culled leaf's emission: `n` generic
 *    skeleton cells (`.parton-skel`, styled by app CSS) in the one
 *    outer grid, so a slice streams in over exactly the cells it
 *    culls out to.
 *  - `ScrollerReservation` — the space of everything outside the
 *    placed span, held with pure CSS arithmetic
 *    (`round(up, count / var(--scroller-cols)) * var(--scroller-row)`).
 *    When the viewport lands inside it (scrollbar jump, fast scroll)
 *    it SELF-MATERIALIZES a local skeleton band the same frame —
 *    structure is arithmetic under uniform rows, so no server is
 *    consulted to paint — and once the scroll settles it states the
 *    landing through the anchor param as an ordinary replace
 *    navigation: the window moves, the URL stays honest.
 *  - `ScrollerAnchorSync` — deep-link landing on client navs, and
 *    the silent scroll→param mirror. The mirror's position source is
 *    a HIT TEST (`elementFromPoint`): occlusion-aware (an overlay
 *    covering the collection silences it), and reservations are
 *    skipped — they own their own, non-silent, statements.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useNavigation } from "./use-navigation.tsx"

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect

// ─── Leaf shell ────────────────────────────────────────────────────────

/** A culled leaf's skeleton cells. Receives the placement's cull
 *  props (`{o, n}`); the cells are grid items of the OUTER grid (the
 *  leaf marker is `display: contents`), sized by the grid's own
 *  `grid-auto-rows`, styled by the app via `.parton-skel`. */
export function ScrollerLeafShell({ n }: { o: number; n: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="parton-skel" aria-hidden />
      ))}
    </>
  )
}

// ─── Reservation ───────────────────────────────────────────────────────

interface Band {
  /** Rendered skeleton cell count. */
  cells: number
  /** Px offset of the band inside the reservation. */
  topPx: number
  /** Grid geometry replicated from the span's grid — the RESOLVED
   *  template (px values), so the band's cells align column-for-
   *  column with the real grid. */
  template: string
  columnGap: string
  rowPx: number
}

export function ScrollerReservation({
  name,
  base,
  count,
  param,
  step,
}: {
  name: string
  /** First item index this reservation covers. */
  base: number
  /** Item count it reserves space for. */
  count: number
  param: string
  step: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [band, setBand] = useState<Band | null>(null)
  const nav = useNavigation()
  const [navigate] = nav.navigate()

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let intersecting = false
    let raf = 0
    let settle: ReturnType<typeof setTimeout> | undefined
    let lastStated = ""

    /** The sibling grid — the span's container; its computed style is
     *  the resolved truth for columns and gaps. */
    const gridEl = (): HTMLElement | null =>
      el.parentElement?.querySelector<HTMLElement>(":scope > [data-sgrid]") ?? null

    const geometry = () => {
      const g = gridEl()
      if (!g) return null
      const cs = getComputedStyle(g)
      const template = cs.gridTemplateColumns
      const cols = template.split(" ").length
      const rect = el.getBoundingClientRect()
      const totalRows = Math.max(1, Math.ceil(count / cols))
      const rowH = rect.height / totalRows
      if (!(rowH > 0) || !Number.isFinite(rowH)) return null
      return { rect, cols, rowH, template, columnGap: cs.columnGap }
    }

    const compute = () => {
      raf = 0
      if (!intersecting) return
      const geo = geometry()
      if (!geo) return
      const { rect, cols, rowH, template, columnGap } = geo
      const vh = window.innerHeight
      const totalRows = Math.max(1, Math.ceil(count / cols))
      // The band: viewport ± half a viewport of runway, in rows.
      const firstRow = Math.max(0, Math.floor((-rect.top - vh / 2) / rowH))
      const lastRow = Math.min(totalRows, Math.ceil((-rect.top + vh * 1.5) / rowH))
      if (lastRow <= firstRow) {
        setBand(null)
        return
      }
      setBand({
        cells: Math.max(0, Math.min((lastRow - firstRow) * cols, count - firstRow * cols)),
        topPx: firstRow * rowH,
        template,
        columnGap,
        rowPx: rowH,
      })
      // Settled landing → state it through the anchor: an ordinary
      // replace navigation. The root re-renders with the span moved
      // here; this shell shrinks or unmounts under it. Geometry is
      // RE-measured at fire time — the layout may have shifted since
      // the band was computed.
      if (settle) clearTimeout(settle)
      settle = setTimeout(() => {
        if (!intersecting) return
        // Occlusion discipline (the mirror's rule): state only a
        // landing the user actually SEES. An overlay covering the
        // reservation (a search dialog, a drawer — or a stray
        // focus-scroll behind one) hits the overlay, not us, and the
        // statement stands down.
        const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
        if (!hit || !el.contains(hit)) return
        const now = geometry()
        if (!now) return
        const centerRow = (-now.rect.top + window.innerHeight / 2) / now.rowH
        if (centerRow < 0 || now.rect.top > window.innerHeight) return
        const idx = Math.min(count - 1, Math.max(0, Math.round(centerRow * now.cols))) + base
        const want = String(Math.floor(idx / step) + 1)
        if (want === lastStated) return
        lastStated = want
        navigate(
          (url) => {
            url.searchParams.set(param, want)
            return url
          },
          { history: "replace" },
        )
      }, 250)
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(compute)
    }

    const io = new IntersectionObserver(
      ([entry]) => {
        intersecting = entry.isIntersecting
        if (intersecting) schedule()
        else setBand(null)
      },
      { rootMargin: "50% 0px" },
    )
    io.observe(el)
    window.addEventListener("scroll", schedule, { passive: true, capture: true })
    window.addEventListener("resize", schedule)
    return () => {
      io.disconnect()
      window.removeEventListener("scroll", schedule, { capture: true })
      window.removeEventListener("resize", schedule)
      if (raf) cancelAnimationFrame(raf)
      if (settle) clearTimeout(settle)
    }
  }, [base, count, param, step, navigate])

  return (
    <div
      ref={ref}
      className="parton-scroller-res"
      data-s={name}
      data-so={base}
      data-sn={count}
      data-sres=""
      aria-hidden
      style={{
        position: "relative",
        overflow: "hidden",
        // A plain BLOCK spacer — deliberately not a grid item (a
        // fixed `grid-auto-rows` track would overflow; a row span
        // would cost tens of thousands of implicit tracks). Height is
        // pure CSS arithmetic on the app's two variables — exact at
        // every breakpoint, before hydration, with zero JS.
        height: `calc(round(up, ${count} / var(--scroller-cols, 4)) * var(--scroller-row, 240px))`,
      }}
    >
      {band ? (
        <div
          style={{
            position: "absolute",
            top: band.topPx,
            left: 0,
            right: 0,
            display: "grid",
            gridTemplateColumns: band.template,
            columnGap: band.columnGap,
            gridAutoRows: band.rowPx,
          }}
        >
          {Array.from({ length: band.cells }, (_, i) => (
            <div key={i} className="parton-skel" />
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ─── Anchor sync ───────────────────────────────────────────────────────

/** The deepest interval marker of `name` containing item index `t`
 *  (deepest = smallest span). Excludes reservations. */
function leafMarkerFor(name: string, t: number): HTMLElement | null {
  let best: HTMLElement | null = null
  for (const el of document.querySelectorAll<HTMLElement>(
    `[data-s="${CSS.escape(name)}"][data-so]`,
  )) {
    if (el.dataset.sres !== undefined) continue
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

  // Deep-link / restore landing — before paint. Leaf markers are
  // `display: contents`; the scroll target is their first child.
  useIsoLayoutEffect(() => {
    const url = nav.currentEntry?.url
    const page = url ? Number(new URL(url).searchParams.get(param) || "1") : 1
    if (page > 1) {
      const marker = leafMarkerFor(name, (page - 1) * step)
      const target = marker?.firstElementChild ?? marker
      target?.scrollIntoView({ block: "start" })
    }
    // Mount-only: the landing is for the entry this mount belongs to.
  }, [])

  // Silent mirror: the item under the viewport's center → the param.
  useEffect(() => {
    const url0 = nav.currentEntry?.url
    let lastVal = url0 ? (new URL(url0).searchParams.get(param) ?? "") : ""
    let timer: ReturnType<typeof setTimeout> | undefined
    const sync = () => {
      // Hit test — occlusion-aware: an overlay covering the
      // collection hits nothing of ours and the mirror stands down.
      // Sampled at several points around the center: a single point
      // can land in a column gap or a cell margin (resolving to the
      // container), which is layout background, not occlusion.
      let hit: Element | null = null
      let m: HTMLElement | null = null
      const w = window.innerWidth
      const h = window.innerHeight
      for (const [px, py] of [
        [0.5, 0.5],
        [0.4, 0.45],
        [0.6, 0.55],
        [0.5, 0.42],
      ]) {
        hit = document.elementFromPoint(w * px, h * py)
        const c = hit?.closest<HTMLElement>(`[data-s="${CSS.escape(name)}"][data-so]`) ?? null
        if (c && c.dataset.sroot === undefined) {
          m = c
          break
        }
      }
      // Reservations state their own (non-silent) landings.
      if (m === null || m.dataset.sres !== undefined) return
      const o = Number(m.dataset.so)
      // Which cell of the leaf contains the hit — its child index is
      // the item offset within the interval.
      let cell: Element | null = hit as Element
      while (cell && cell.parentElement !== m) cell = cell.parentElement
      const within = cell ? Array.prototype.indexOf.call(m.children, cell) : 0
      const idx = o + Math.max(0, within)
      const page = Math.floor(idx / step) + 1
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
    window.addEventListener("scroll", onScroll, { passive: true, capture: true })
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true })
      if (timer) clearTimeout(timer)
    }
  }, [nav, navigate, name, param, step])

  return null
}
