"use client"

import { useEffect } from "react"
// Client components import framework hooks from the client subpath, not the
// `@parton/framework` barrel — the barrel pulls server-only modules into the
// client bundle (see framework/index.ts).
import { useNavigation } from "@parton/framework/lib/partial-client.tsx"

/**
 * Two-way sync between the `?page=` URL and the browse grid's scroll
 * position — the app-side glue around the framework's culling (the app owns
 * its own `?page=` URL semantics; the framework owns observation + refetch):
 *
 *  - on mount, a deep-link `?page=N` scrolls section N into view;
 *  - as you scroll, the centered section's page is mirrored back to `?page=`
 *    so the position is shareable.
 *
 * The write is `navigate({ history: "replace", silent: true })`: silent (no
 * refetch — the cull already follows the viewport), replace (no history
 * pile-up). It stays out of the culling's way because (1) the framework
 * intercepts framework-silent navs with `scroll: "manual"`, so the viewport
 * doesn't jump, and (2) the host strips `page` from its stale-commit key, so
 * a ticking anchor doesn't drop in-flight culling commits.
 *
 * The scroll mirror is a debounced (trailing-edge) write, so it can't use
 * `useEffectEvent` — effect events only fire synchronously inside an effect
 * or handler, never from a `setTimeout`. It uses the stable `navigate` (a
 * dep) and reads the current `?page=` once at mount, the way `load-more`
 * does.
 */
export function PageUrlSync() {
  const nav = useNavigation()
  const [navigate] = nav.navigate()

  useEffect(() => {
    const url0 = nav.currentEntry?.url
    const path = url0 ? new URL(url0).pathname : "/magento/browse"
    const pageParam = url0 ? new URL(url0).searchParams.get("page") || "" : ""

    // Deep-link landing: scroll ?page=N into view on mount.
    if (Number(pageParam) > 1) {
      document.querySelector(`[data-page="${pageParam}"]`)?.scrollIntoView({ block: "start" })
    }

    // Mirror the centered page back to ?page= after the scroll settles.
    let lastPage = pageParam
    let timer: ReturnType<typeof setTimeout> | undefined
    const sync = () => {
      const cy = window.innerHeight / 2
      let center: number | null = null
      for (const s of document.querySelectorAll<HTMLElement>("[data-page]")) {
        const r = s.getBoundingClientRect()
        if (r.top <= cy && r.bottom >= cy) {
          center = Number(s.dataset.page)
          break
        }
      }
      if (center == null) return
      const want = center > 1 ? String(center) : ""
      if (want === lastPage) return
      lastPage = want
      navigate(want ? `${path}?page=${want}` : path, { history: "replace", silent: true })
    }
    const onScroll = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(sync, 150)
    }
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      window.removeEventListener("scroll", onScroll)
      if (timer) clearTimeout(timer)
    }
  }, [nav, navigate])

  return null
}
