import { type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FrameNameProvider, PageUrlProvider, useNavigation } from "../partial-client.tsx"

/**
 * `useNavigation()` is isomorphic: on the client it reads the browser
 * Navigation API, but during SSR (and pre-hydration) that API is
 * absent, so `currentEntry.url` resolves from a Flight-borne context —
 * `PageUrlProvider` for the window scope (seeded by `PartialRoot`) and
 * `FrameNameProvider`'s `initialUrl` for a frame scope (seeded by
 * `<Frame>`). These render server-side with the Navigation API removed
 * and assert the URL still resolves, so URL-derived view state (e.g. an
 * active nav highlight) is correct on the first paint with no flash.
 */

// Simulate the server: no browser Navigation API. The jsdom node-tier
// setup installs a shim, so drop it for these renders and restore after.
let savedNav: unknown
beforeEach(() => {
  savedNav = (globalThis as { navigation?: unknown }).navigation
  delete (globalThis as { navigation?: unknown }).navigation
})
afterEach(() => {
  ;(globalThis as { navigation?: unknown }).navigation = savedNav
})

function UrlProbe({ frame }: { frame?: string }): ReactNode {
  const { currentEntry } = useNavigation(frame)
  return <span data-url={currentEntry?.url ?? "NULL"} />
}

describe("useNavigation — isomorphic SSR resolution", () => {
  it("page scope: currentEntry.url comes from PageUrlProvider", () => {
    const html = renderToStaticMarkup(
      <PageUrlProvider url="http://localhost/cache-demo?x=1">
        <UrlProbe />
      </PageUrlProvider>,
    )
    expect(html).toContain('data-url="http://localhost/cache-demo?x=1"')
  })

  it("degrades to a null entry with no provider (no throw)", () => {
    const html = renderToStaticMarkup(<UrlProbe />)
    expect(html).toContain('data-url="NULL"')
  })

  it("frame scope: currentEntry.url comes from <Frame>'s initialUrl, origin-resolved", () => {
    const html = renderToStaticMarkup(
      <PageUrlProvider url="http://localhost/page">
        <FrameNameProvider path={["cart"]} initialUrl="/cart/open">
          <UrlProbe />
        </FrameNameProvider>
      </PageUrlProvider>,
    )
    // Frame URL resolved against the page origin (mirrors the client's
    // `projectEntryForFrame`), so the pathname is /cart/open.
    expect(html).toContain('data-url="http://localhost/cart/open"')
  })
})
