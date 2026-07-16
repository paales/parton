/**
 * /embed-demo — `<RemoteFrame>` page-embed validation surfaces (the
 * iframe model, same-origin).
 *
 * The host pages embed ORDINARY pages of this same app by fetching
 * them from its own origin with the RSC-render + embed headers. No
 * dedicated endpoint is involved: the embedded render replies with
 * the slice marker instead of the page shell, and the host strips the
 * document chrome (html/head/body wrappers, title/meta/link
 * hoistables) before stitching the body content into its own tree —
 * like an iframe, minus the separate browsing context.
 *
 *  - /embed-demo          — embeds `/pokemon/1` (a full content page).
 *  - /embed-nested-demo   — chains host → /embed-demo → /pokemon/1.
 *  - /embed-self-demo     — embeds ITSELF; terminates at the max
 *                           embed depth with an inert marker, and each
 *                           nesting level carries its own placement-
 *                           namespaced parton ids (hydration-stable).
 *  - /embed-duplicate-demo — embeds the SAME page twice; the two
 *                           placements mint distinct namespaces, and a
 *                           label refetch fans out to both.
 *  - /embed-refetch-demo  — one embed plus a refresh button; the
 *                           reload routes back through `?partials=` at
 *                           the embedded URL (the snapshot's page
 *                           source stamp).
 */

import { parton, RemoteFrame, type RenderArgs } from "@parton/framework"
import { Suspense } from "react"
import { RemoteRefreshButton } from "../components/remote-refresh-button.tsx"

export const EmbedDemoPage = parton(
  function EmbedDemoRender(_: RenderArgs) {
    return (
      <>
        <header className="mb-4" data-testid="embed-demo-header">
          <h1 className="text-2xl font-semibold">Page Embed Demo</h1>
          <p className="text-sm text-muted-foreground">
            The frame below embeds the ordinary page <code>/pokemon/1</code> from this same app —
            full page fetched as Flight, head sliced away, body content stitched in.
          </p>
        </header>
        <section
          className="rounded-lg border border-dashed border-sky-500/50 p-4"
          data-testid="embed-demo-frame"
        >
          <Suspense
            fallback={
              <div className="italic text-muted-foreground" data-testid="embed-demo-fallback">
                Loading embedded page…
              </div>
            }
          >
            <RemoteFrame url="/pokemon/1" />
          </Suspense>
        </section>
      </>
    )
  },
  { match: "/embed-demo" },
)

/** Two-level chain of DIFFERENT pages: host → /embed-demo → /pokemon/1.
 *  Isolates nesting depth from page identity. */
export const EmbedNestedDemoPage = parton(
  function EmbedNestedDemoRender(_: RenderArgs) {
    return (
      <>
        <header className="mb-4" data-testid="embed-nested-header">
          <h2 className="text-xl font-semibold">Nested embed (different pages)</h2>
        </header>
        <section
          className="rounded-lg border border-dashed border-emerald-500/50 p-4"
          data-testid="embed-nested-frame"
        >
          <Suspense fallback={<div className="italic">Loading nested embed…</div>}>
            <RemoteFrame url="/embed-demo" />
          </Suspense>
        </section>
      </>
    )
  },
  { match: "/embed-nested-demo" },
)

export const EmbedSelfDemoPage = parton(
  function EmbedSelfDemoRender(_: RenderArgs) {
    return (
      <>
        <header className="mb-4" data-testid="embed-self-header">
          <h2 className="text-xl font-semibold">Self-embedding page</h2>
          <p className="text-sm text-muted-foreground">
            This page embeds itself. The recursion guard terminates the chain at the framework's max
            embed depth — the deepest frame renders an inert depth-limit marker instead of fetching
            forever — and each level's partons carry their own placement namespace, so the whole
            chain hydrates.
          </p>
        </header>
        <section
          className="rounded-lg border border-dashed border-amber-500/50 p-4"
          data-testid="embed-self-frame"
        >
          <Suspense
            fallback={<div className="italic text-muted-foreground">Loading self-embed…</div>}
          >
            <RemoteFrame url="/embed-self-demo" />
          </Suspense>
        </section>
      </>
    )
  },
  { match: "/embed-self-demo" },
)

/** The SAME page embedded twice, side by side. Each placement mints
 *  its own namespace (distinct parton ids end-to-end); a label
 *  refetch (`remote-fast`) fans out to both. */
export const EmbedDuplicateDemoPage = parton(
  function EmbedDuplicateDemoRender(_: RenderArgs) {
    return (
      <>
        <header className="mb-4" data-testid="embed-duplicate-header">
          <h2 className="text-xl font-semibold">Duplicate embeds of one page</h2>
          <div className="mt-2">
            <RemoteRefreshButton name="remote-fast" label="Refresh both (tag fan-out)" />
          </div>
        </header>
        <section
          className="rounded-lg border border-dashed border-violet-500/50 p-4"
          data-testid="embed-duplicate-a"
        >
          <Suspense fallback={<div className="italic">Loading copy A…</div>}>
            <RemoteFrame url="/remote/remote-fast" />
          </Suspense>
        </section>
        <section
          className="mt-3 rounded-lg border border-dashed border-violet-500/50 p-4"
          data-testid="embed-duplicate-b"
        >
          <Suspense fallback={<div className="italic">Loading copy B…</div>}>
            <RemoteFrame url="/remote/remote-fast" />
          </Suspense>
        </section>
      </>
    )
  },
  { match: "/embed-duplicate-demo" },
)

/** One embed plus a targeted refresh — proves the refetch routes back
 *  through the embedded page (`?partials=<id>` at `/remote/remote-fast`)
 *  via the snapshot's `source: {kind: "page"}` stamp. */
export const EmbedRefetchDemoPage = parton(
  function EmbedRefetchDemoRender(_: RenderArgs) {
    return (
      <>
        <header className="mb-4" data-testid="embed-refetch-header">
          <h2 className="text-xl font-semibold">Embed refetch</h2>
          <div className="mt-2">
            <RemoteRefreshButton name="remote-fast" label="Refresh embedded parton" />
          </div>
        </header>
        <section
          className="rounded-lg border border-dashed border-pink-500/50 p-4"
          data-testid="embed-refetch-frame"
        >
          <Suspense fallback={<div className="italic">Loading embed…</div>}>
            <RemoteFrame url="/remote/remote-fast" />
          </Suspense>
        </section>
      </>
    )
  },
  { match: "/embed-refetch-demo" },
)
