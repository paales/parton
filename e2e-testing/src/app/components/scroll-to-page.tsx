"use client"

import { useEffect } from "react"
// Client components import framework hooks from the client subpath, not the
// `@parton/framework` barrel — the barrel pulls server-only modules into the
// client bundle (see framework/index.ts).
import { useNavigation } from "@parton/framework/lib/partial-client.tsx"

/**
 * Deep-link landing for `/magento/browse?page=N`: on mount, scroll the
 * Nth page section into view. The cold render already paints that
 * neighborhood full (the `visible()` anchor seed), so this just puts the
 * viewport there; the culling controller takes over from the first scroll.
 *
 * The one bit of app-side glue the culler needs — translating the app's
 * own `?page=` URL semantics into a scroll target. Everything else
 * (observation, refetch) is the framework's.
 */
export function ScrollToPage() {
  const nav = useNavigation()
  useEffect(() => {
    const url = nav.currentEntry?.url
    if (!url) return
    const page = Number(new URL(url).searchParams.get("page") || "1")
    if (page > 1) {
      document.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: "start" })
    }
    // Mount-only: deep-link landing is a one-shot; live position is the
    // controller's job thereafter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}
