"use client"

/**
 * The scroller's client half — three framework-internal components
 * (placed by the scroller root/leaf specs, never by an app):
 *
 *  - `ScrollerLeafShell` — a culled leaf's emission: `n` generic
 *    skeleton cells (`.parton-skel`, styled by app CSS) in the one
 *    outer grid, so a slice streams in over exactly the cells it
 *    culls out to.
 *  - `ScrollerReservation` — the space outside the placed span, held
 *    with pure CSS arithmetic
 *    (`round(up, count / var(--scroller-cols)) * var(--scroller-row)`).
 *    When the viewport lands inside it, it SELF-MATERIALIZES a local
 *    skeleton band the same frame — structure is arithmetic under
 *    uniform rows, so no server is consulted to paint. Display only:
 *    the window statement belongs to the anchor sync.
 *  - `ScrollerAnchorSync` — THE one writer. Throttled while scrolling
 *    (plus a trailing settle run) it computes the item under the
 *    viewport center — from LAYOUT in-span, arithmetically inside
 *    reservations — and states it through the anchor
 *    param: silently when the landing is inside the placed span
 *    (culling handles materialization), as an IN-PLACE navigation
 *    (`scroll: "manual"`) when it is inside a reservation (the span
 *    must move). The only DOM it consults is the wrapper (by its
 *    public `id=<name>`) plus one occlusion hit-test — an overlay
 *    covering the collection silences the writer entirely.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useNavigation } from "./use-navigation.tsx"

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect

// ─── Leaf shell ────────────────────────────────────────────────────────

/** A culled leaf's skeleton cells. Receives the placement's cull
 *  props (`{o, n, aid?}`); the cells are grid items of the outer
 *  grid, sized by its `grid-auto-rows`, styled via `.parton-skel`.
 *  A boundary leaf's `aid` lands on the FIRST cell, so the public
 *  anchor id exists in the culled state too. */
export function ScrollerLeafShell({ n, aid }: { o: number; n: number; aid?: string }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} id={i === 0 ? aid : undefined} className="parton-skel" aria-hidden />
      ))}
    </>
  )
}

// ─── Shared geometry ───────────────────────────────────────────────────

/** The grid's resolved geometry. `gridTemplateColumns` computes to a
 *  resolved px list, so the column count is its length; the row
 *  ESTIMATE comes from the `--scroller-row` variable (rows are
 *  `minmax(estimate, auto)` — real heights belong to layout, the
 *  estimate to reservations and unmaterialized space). */
function gridGeometry(gridEl: Element | null): { cols: number; rowH: number; gap: string } | null {
  if (!gridEl) return null
  const cs = getComputedStyle(gridEl)
  const cols = cs.gridTemplateColumns.split(" ").length
  const rowH =
    Number.parseFloat(cs.getPropertyValue("--scroller-row")) || Number.parseFloat(cs.gridAutoRows)
  if (!(cols >= 1) || !(rowH > 0) || !Number.isFinite(rowH)) return null
  return { cols, rowH, gap: cs.columnGap }
}

// ─── Reservation ───────────────────────────────────────────────────────

interface Band {
  cells: number
  topPx: number
  template: string
  columnGap: string
  rowPx: number
}

export function ScrollerReservation({ count }: { count: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [band, setBand] = useState<Band | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let intersecting = false
    let raf = 0

    const compute = () => {
      raf = 0
      if (!intersecting) return
      const gridEl = el.parentElement?.querySelector(":scope > .parton-scroller-grid") ?? null
      const geo = gridGeometry(gridEl)
      if (!geo) return
      const rect = el.getBoundingClientRect()
      const totalRows = Math.max(1, Math.ceil(count / geo.cols))
      const rowH = rect.height / totalRows
      if (!(rowH > 0)) return
      const vh = window.innerHeight
      const firstRow = Math.max(0, Math.floor((-rect.top - vh / 2) / rowH))
      const lastRow = Math.min(totalRows, Math.ceil((-rect.top + vh * 1.5) / rowH))
      if (lastRow <= firstRow) {
        setBand(null)
        return
      }
      setBand({
        cells: Math.max(0, Math.min((lastRow - firstRow) * geo.cols, count - firstRow * geo.cols)),
        topPx: firstRow * rowH,
        template: getComputedStyle(gridEl as Element).gridTemplateColumns,
        columnGap: geo.gap,
        rowPx: rowH,
      })
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
    }
  }, [count])

  return (
    <div
      ref={ref}
      className="parton-scroller-res"
      aria-hidden
      style={{
        position: "relative",
        overflow: "hidden",
        // Never an anchor candidate: the browser anchoring onto a
        // transient band skeleton, then compensating as we rewrote
        // its geometry, was the measured viewport-teleport bug.
        overflowAnchor: "none",
        // A plain BLOCK spacer — deliberately not a grid item (a
        // fixed `grid-auto-rows` track would overflow; a row span
        // would cost tens of thousands of implicit tracks). Height is
        // pure CSS arithmetic on the app's variables — exact at every
        // breakpoint, before hydration, with zero JS.
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

// ─── Anchor sync — the one writer ──────────────────────────────────────

/** The writer's cadence: `sync` runs at most once per interval WHILE
 *  scrolling (the anchor follows along — silent in-span mirrors, and
 *  the window moves ahead of a sustained scroll instead of waiting
 *  for a stop), plus one trailing run at settle. */
const SYNC_MS = 250

export function ScrollerAnchorSync({
  name,
  param,
  step,
  start,
  end,
  total,
}: {
  name: string
  param: string
  step: number
  /** The placed span's item bounds — landings inside it write
   *  silently; landings outside it move the window (a real,
   *  in-place navigation). */
  start: number
  end: number
  total: number
}) {
  const nav = useNavigation()
  const [navigate] = nav.navigate()
  /** The writer's own last statement — how the URL-watch below tells
   *  a mirror of the user's scroll from an EXTERNAL anchor statement
   *  (a pagination link, a traverse). */
  const selfWrite = useRef<string | null>(null)

  // Deep-link / restore landing on client navs — before paint, by the
  // public anchor id. (Document loads use the streamed landing
  // script; running this again on hydration is idempotent.)
  useIsoLayoutEffect(() => {
    const url = nav.currentEntry?.url
    const page = url ? Number(new URL(url).searchParams.get(param) || "1") : 1
    if (page > 1) {
      document.getElementById(`${name}-p${page}`)?.scrollIntoView({ block: "start" })
    }
    // Mount-only: the landing is for the entry this mount belongs to.
  }, [])

  // EXTERNAL ANCHOR STATEMENTS. The writer mirrors scroll into the
  // param — but the param is a public surface anyone can state: a
  // pagination link, a traverse, an app's own navigate. EVERY foreign
  // navigation is an anchor statement — including one that leaves the
  // param untouched or absent (absent = page 1): a facet link that
  // drops `?page=` states "the reshaped collection, from the top",
  // and without enforcement the browser's scroll clamp against the
  // shrunken document would strand the viewport mid-collection for
  // the writer to mirror as a page the user never chose (measured:
  // toggling facets teleported to page 3). Measure-first: if the
  // viewport already centers the stated page (a traverse whose
  // scroll restoration landed it, the writer's own mirror riding a
  // stale selfWrite), nothing moves — only a real mismatch scrolls.
  // Target resolution follows the landing rule: the boundary id's
  // LAYOUT when it exists (in span — correct under any heights), the
  // estimate arithmetic where nothing exists to measure (a
  // reservation — exact there).
  useEffect(() => {
    // `useNavigation` is a live proxy — URL changes don't re-render
    // this component, so the watch subscribes to the Navigation API's
    // own entry-change event. No mount call: the landing entry
    // belongs to the stage scripts / the layout effect above.
    const ambient = (
      window as Window & { navigation?: EventTarget & { currentEntry?: { url?: string } } }
    ).navigation
    if (!ambient) return
    const check = () => {
      const url = ambient.currentEntry?.url
      if (!url) return
      const val = new URL(url).searchParams.get(param) ?? ""
      if (selfWrite.current === val) {
        selfWrite.current = null
        return
      }
      const page = Math.max(1, Number(val) || 1)
      const wrapper = document.getElementById(name)
      const gridEl = wrapper?.querySelector(":scope > .parton-scroller-grid")
      const geo = gridGeometry(gridEl ?? null)
      if (!wrapper || !geo) return
      const top = wrapper.getBoundingClientRect().top + window.scrollY
      // Already there? (Estimate arithmetic — a ±1-page tolerance
      // absorbs real-height drift.)
      const centerRow = Math.floor((window.innerHeight / 2 + window.scrollY - top) / geo.rowH)
      const curPage = Math.floor(Math.max(0, centerRow * geo.cols) / step) + 1
      if (Math.abs(curPage - page) <= 1) return
      const el = document.getElementById(`${name}-p${page}`)
      if (el && el.offsetParent !== null) {
        el.scrollIntoView({ block: "start" })
        return
      }
      window.scrollTo(0, top + (((page - 1) * step) / geo.cols) * geo.rowH)
    }
    ambient.addEventListener("currententrychange", check)
    return () => ambient.removeEventListener("currententrychange", check)
  }, [name, param, step])

  // WINDOW-MOVE ANCHORING SUPPRESSION. A window move never moves an
  // ITEM: the reservation cedes exactly the rows the new leaves
  // occupy, so every index keeps its document offset. What DOES move
  // is the grid container's own top edge (and, with it, cells near
  // the span boundary the browser may have anchored on) — and native
  // anchoring "compensates" that arithmetic no-op with a real
  // viewport teleport (measured: dy === the reservation delta,
  // page-exact multiples). `overflow-anchor: none` on the grid is no
  // fix — exclusion covers the whole subtree, which would also kill
  // the designed materialization anchoring. Instead we suppress for
  // exactly the move's own layout flush — from an INSERTION effect:
  // it runs before the commit's DOM mutations and before every
  // layout effect, so the exclusion is in place even when a child's
  // layout effect forces a reflow (which would otherwise run the
  // anchoring adjustment ahead of a layout-effect suppression). The
  // restore waits two frames (a same-frame rAF still precedes this
  // frame's layout), token-guarded so back-to-back moves extend
  // rather than truncate each other's suppression.
  const spanRef = useRef<{ start: number; end: number } | null>(null)
  const suppressToken = useRef(0)
  React.useInsertionEffect(() => {
    const prev = spanRef.current
    spanRef.current = { start, end }
    if (!prev || (prev.start === start && prev.end === end)) return
    const wrapper = document.getElementById(name)
    if (!wrapper) return
    const token = ++suppressToken.current
    wrapper.style.overflowAnchor = "none"
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (suppressToken.current === token) wrapper.style.overflowAnchor = ""
      })
    })
  }, [name, start, end])

  // RE-ANCHOR BACKSTOP. Native scroll anchoring owns the everyday
  // case (content above the viewport growing inside kept nodes), but
  // this collection also REPLACES nodes wholesale — a span swap, a
  // leaf's skeleton cells giving way to content cells — and an anchor
  // node that dies mid-flush leaves the browser nothing to track.
  // Our ids are INDEX-derived, so they survive every replacement:
  // record the nearest boundary id at-or-above the viewport top on
  // every scroll; on any wrapper resize, re-locate the id and correct
  // by its measured delta. The measurement is ABSOLUTE against the
  // recorded baseline, so when native anchoring already compensated
  // the delta is zero — the backstop only ever corrects the residual.
  useEffect(() => {
    const wrapper = document.getElementById(name)
    if (!wrapper) return
    let ref: { id: string; top: number } | null = null
    const record = () => {
      // Nearest boundary id at-or-above the viewport top; when none
      // exists — the viewport is inside a RESERVATION, which carries
      // no ids — the nearest one BELOW. The fallback is what breaks
      // the up-scroll cascade: without it a window move under a
      // reservation-parked viewport has no reference at all, the
      // materialization shift above goes uncorrected, the writer reads
      // the displaced viewport as a smaller page and states another
      // move — a staircase to the top. Pinning a below-the-top ref is
      // an approximation (growth between the viewport top and the ref
      // moves the eye by up to that span's estimate error), but the
      // error is bounded by a few rows and the very next record()
      // tightens the ref once in-span ids exist.
      let best: { id: string; top: number } | null = null
      let below: { id: string; top: number } | null = null
      for (const el of wrapper.querySelectorAll<HTMLElement>(`[id^="${CSS.escape(name)}-p"]`)) {
        if (el.offsetParent === null) continue
        const t = el.getBoundingClientRect().top
        if (t <= 1) {
          if (best === null || t > best.top) best = { id: el.id, top: t }
        } else if (below === null || t < below.top) below = { id: el.id, top: t }
      }
      ref = best ?? below
    }
    const correct = () => {
      if (!ref) {
        record()
        return
      }
      const el = document.getElementById(ref.id)
      if (!el || el.offsetParent === null) {
        record()
        return
      }
      const d = el.getBoundingClientRect().top - ref.top
      if (Math.abs(d) > 0.5) window.scrollBy({ top: d, behavior: "instant" })
      record()
    }
    const ro = new ResizeObserver(() => correct())
    ro.observe(wrapper)
    record()
    window.addEventListener("scroll", record, { passive: true, capture: true })
    return () => {
      ro.disconnect()
      window.removeEventListener("scroll", record, { capture: true })
    }
  }, [name])

  // The writer: item-under-center → anchor param, throttled while
  // scrolling + once at settle.
  useEffect(() => {
    const url0 = nav.currentEntry?.url
    let lastVal = url0 ? (new URL(url0).searchParams.get(param) ?? "") : ""
    let timer: ReturnType<typeof setTimeout> | undefined
    const sync = () => {
      const wrapper = document.getElementById(name)
      if (!wrapper) return
      // Occlusion: state only what the user actually SEES. An overlay
      // covering the collection (dialog, drawer) hits itself, not the
      // wrapper's subtree, and the writer stands down.
      const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
      if (!hit || !wrapper.contains(hit)) return
      const gridEl = wrapper.querySelector(":scope > .parton-scroller-grid")
      if (!gridEl) return
      // MEASURE where content exists, COMPUTE only where nothing
      // does. In-span, the index comes from layout: the hit's grid
      // cell, walked back to the nearest boundary id — correct under
      // any item heights or breakpoints. Inside a reservation there
      // is nothing to measure; row arithmetic on its own box is the
      // (self-correcting) estimate.
      let idx: number
      const res = hit.closest(".parton-scroller-res")
      if (res) {
        const geo = gridGeometry(gridEl)
        if (!geo) return
        const before =
          (res.compareDocumentPosition(gridEl) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        const base = before ? 0 : end
        const count = Math.max(1, before ? start : total - end)
        const r = res.getBoundingClientRect()
        const rowH = r.height / Math.max(1, Math.ceil(count / geo.cols))
        if (!(rowH > 0)) return
        const rows = Math.floor((window.innerHeight / 2 - r.top) / rowH)
        idx = base + Math.min(count - 1, Math.max(0, rows * geo.cols))
      } else {
        let cell: Element | null = hit
        while (cell && cell.parentElement !== gridEl) cell = cell.parentElement
        if (!cell) {
          // The center point landed BETWEEN cells — a column gap or a
          // cell's margin band hits the grid element itself, and that
          // is the common case, not the exception (a 12px gap under
          // every row puts the center there for whole scroll bands).
          // Fall back to geometry: the laid-out grid child at center
          // height, or the nearest one below it.
          const cy = window.innerHeight / 2
          let next: { el: Element; top: number } | null = null
          for (const c of gridEl.children) {
            if ((c as HTMLElement).offsetParent === null) continue
            const r = c.getBoundingClientRect()
            if (r.top <= cy && cy < r.bottom) {
              cell = c
              break
            }
            if (r.top > cy && (next === null || r.top < next.top)) next = { el: c, top: r.top }
          }
          if (!cell) cell = next?.el ?? null
        }
        if (!cell) return
        const re = new RegExp(`^${CSS.escape(name)}-p(\\d+)$`)
        let steps = 0
        let hops = 0
        let el: Element | null = cell
        let baseIdx: number | null = null
        while (el && hops < step * 4 + 64) {
          const m = el.id ? re.exec(el.id) : null
          if (m) {
            baseIdx = (Number(m[1]) - 1) * step
            break
          }
          // Count only laid-out cells — scripts, holes, and parked
          // (display:none) DOM don't occupy grid positions.
          if ((el as HTMLElement).offsetParent !== null) steps++
          el = el.previousElementSibling
          hops++
        }
        if (baseIdx === null) return
        idx = Math.min(Math.max(total, 1) - 1, baseIdx + steps)
      }
      const page = Math.floor(idx / step) + 1
      const want = page > 1 ? String(page) : ""
      if (want === lastVal) return
      lastVal = want
      selfWrite.current = want
      const inSpan = idx >= start && idx < end
      navigate(
        (url) => {
          if (want) url.searchParams.set(param, want)
          else url.searchParams.delete(param)
          return url
        },
        // In-span: a bookmarkability-only mirror — culling already
        // follows the viewport. Outside the span: the window must
        // move — a real refetch, IN-PLACE (this nav DESCRIBES where
        // the user already is; the browser's deferred default scroll
        // must never fire).
        inSpan ? { history: "replace", silent: true } : { history: "replace", scroll: "manual" },
      )
    }
    // FOLLOW ALONG, then settle. A sustained scroll (inertial wheel,
    // scrollbar drag) never stops emitting events, so a pure trailing
    // debounce would starve the writer until the gesture fully ends —
    // the param freezes and, worse, the window can never move ahead of
    // the user (window movement lives in `sync`), so every sustained
    // scroll outruns the ring into reservation skeletons. Instead the
    // writer THROTTLES: it fires at most every SYNC_MS while scrolling
    // (in-span writes are silent and free; a reservation landing
    // states an in-place window move, so the span follows the scroll),
    // plus one trailing run at settle for the final position.
    let lastRun = 0
    const onScroll = () => {
      const now = performance.now()
      if (now - lastRun >= SYNC_MS) {
        lastRun = now
        sync()
      }
      if (timer) clearTimeout(timer)
      timer = setTimeout(sync, SYNC_MS)
    }
    window.addEventListener("scroll", onScroll, { passive: true, capture: true })
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true })
      if (timer) clearTimeout(timer)
    }
  }, [nav, navigate, name, param, step, start, end, total])

  return null
}
