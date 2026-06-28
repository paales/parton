"use client"

import { useEffect, useEffectEvent } from "react"
import { useNavigation } from "@parton/framework/lib/partial-client.tsx"

/**
 * The scroller's client half — reports the camera to the server, with no
 * per-page sentinel and no shadow list of items: the live DOM sections
 * ARE the source of truth.
 *
 * It renders NOTHING and wraps nothing: it observes the page sections
 * through a stable `[data-testid="browse-scope"]` element the route
 * renders, and sits BESIDE `#browse-list` rather than around it (a clean
 * separation — the list stays an independently refetchable partial).
 *
 * One IntersectionObserver watches every `<section data-page>`; a
 * MutationObserver re-syncs its target set when the list re-commits. On
 * scroll it writes the anchor to the `browse_vis` cookie (the driver, off
 * the sharable url), reloads `#browse-list` against it so the ring follows
 * the viewport, and reflects the anchor on `?page=` for a sharable shadow.
 * Refetches are serialized so each committed window sticks. All URL work
 * goes through the Navigation API — see CLAUDE.md.
 */
export function BrowseScroller() {
  const nav = useNavigation()
  const [reload] = nav.reload()
  const [navigate] = nav.navigate()

  // Effect Events: stable callbacks that always see the latest bound
  // `reload` / `navigate` / `currentEntry`, so the effect below can stay
  // mount-only without writing to refs during render.
  const reloadList = useEffectEvent(() => reload({ selector: "#browse-list" }))
  const pageParam = useEffectEvent(() => {
    const url = nav.currentEntry?.url
    return url ? Number(new URL(url).searchParams.get("page") || "1") : 1
  })
  const writeAnchor = useEffectEvent((anchor: number) => {
    const url = nav.currentEntry?.url
    if (!url) return
    const next = new URL(url)
    if (next.searchParams.get("page") === String(anchor)) return
    next.searchParams.set("page", String(anchor))
    void navigate(next.pathname + next.search, { history: "replace", silent: true })
  })

  useEffect(() => {
    const scope = document.querySelector('[data-testid="browse-scope"]')
    if (!scope) return

    // Cold-start: a deep-linked `?page=N` rendered the ring centered on N.
    // Scroll N into view before observing, so the camera reports N — not
    // the top.
    const initialAnchor = pageParam()
    if (initialAnchor > 1) {
      scope.querySelector(`[data-page="${initialAnchor}"]`)?.scrollIntoView({ block: "start" })
    }

    const ratios = new Map<number, number>()
    let pendingAnchor = 1
    let committedAnchor = -1
    let inFlight = false
    let dirty = false
    let raf = 0
    let urlTimer: ReturnType<typeof setTimeout> | undefined

    // Reflect the anchor on `?page=` only once the scroll truly settles —
    // the silent navigate's commit disrupts an in-flight reload, so the
    // debounce must outlast the reload cycle. The URL is a lazy shadow;
    // during an active scroll the cookie+reload alone drive the ring.
    const scheduleUrl = (anchor: number) => {
      if (urlTimer) clearTimeout(urlTimer)
      urlTimer = setTimeout(() => writeAnchor(anchor), 600)
    }

    // Serialize the refetches: one in flight at a time, re-firing with the
    // latest anchor if it moved while a reload was outstanding. Rapid
    // fire-and-forget reloads of the same selector supersede each other
    // (and the slow product fetch means none would land); serializing
    // makes every committed window stick and still catches up to the camera.
    const fire = async () => {
      if (inFlight) {
        dirty = true
        return
      }
      inFlight = true
      try {
        do {
          dirty = false
          if (pendingAnchor === committedAnchor) break
          const anchor = pendingAnchor
          // Write the anchor to the `browse_vis` cookie (off the sharable
          // url), then reload the list against it — the cookie rides the
          // request. (document.cookie is not the History API.)
          document.cookie = `browse_vis=${anchor};path=/;samesite=lax;max-age=3600`
          await reloadList().finished.catch(ignoreAbort)
          committedAnchor = anchor
          scheduleUrl(anchor)
        } while (dirty)
      } finally {
        inFlight = false
      }
    }

    const report = () => {
      raf = 0
      const visible = [...ratios.entries()]
        .filter(([, r]) => r > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([p]) => p)
      if (visible.length === 0) return
      pendingAnchor = visible[0]
      void fire()
    }

    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(report)
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const raw = (entry.target as HTMLElement).dataset?.page
          const page = raw ? Number(raw) : NaN
          if (!Number.isFinite(page)) continue
          if (entry.isIntersecting && entry.intersectionRatio > 0) {
            ratios.set(page, entry.intersectionRatio)
          } else {
            ratios.delete(page)
          }
        }
        schedule()
      },
      // A generous vertical margin so the ring advances a little ahead of
      // the viewport rather than only once a page is centered.
      { threshold: [0, 0.01, 0.25, 0.5, 1], rootMargin: "600px 0px" },
    )

    // Keep the observer's target set in sync with the live sections as the
    // window slides and pages mount/unmount.
    const observed = new Set<Element>()
    const sync = () => {
      const live = new Set<Element>(scope.querySelectorAll("[data-page]"))
      for (const el of live) {
        if (!observed.has(el)) {
          io.observe(el)
          observed.add(el)
        }
      }
      for (const el of observed) {
        if (!live.has(el)) {
          io.unobserve(el)
          observed.delete(el)
          const raw = (el as HTMLElement).dataset?.page
          const page = raw ? Number(raw) : NaN
          if (Number.isFinite(page)) ratios.delete(page)
          schedule()
        }
      }
    }
    sync()
    const mo = new MutationObserver(sync)
    mo.observe(scope, { childList: true, subtree: true })

    return () => {
      if (raf) cancelAnimationFrame(raf)
      if (urlTimer) clearTimeout(urlTimer)
      mo.disconnect()
      io.disconnect()
    }
  }, [])

  return null
}

function ignoreAbort(err: unknown) {
  if ((err as { name?: string })?.name !== "AbortError") throw err
}
