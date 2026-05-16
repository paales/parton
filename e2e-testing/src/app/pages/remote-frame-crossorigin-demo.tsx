/**
 * /remote-frame-crossorigin-demo — true cross-origin `<RemoteFrame>`.
 *
 * Same-origin v1 (`/remote-frame-demo`) embeds partons defined in
 * the host app via `/__remote/<id>`. This page embeds partons
 * defined in a SEPARATE process (`e2e-magento` on port 5181) via
 * `http://localhost:5181/__remote/<id>`.
 *
 * What the framework does for cross-origin:
 *
 * - `<RemoteFrame>` detects `src` is absolute, auto-enables the
 *   module-ref rewriter (`moduleRefRewriter` in
 *   `flight-rewrite.ts`). Any relative module paths the remote's
 *   bytes carry get rewritten to absolute URLs at the remote's
 *   origin so the host's browser can dynamically import them.
 * - Browser fires a CORS preflight (OPTIONS) before the GET.
 *   The remote's entry.rsc handles OPTIONS with permissive headers
 *   for v1; capability-scoping will tighten this in v2.
 * - Snapshot trailer flows back as before, registers in the host
 *   request registry. Selector-targeted refetch from a host button
 *   currently hits the host's local spec catalog — which does NOT
 *   have the remote-only specs registered, so refetch resolves to
 *   a registry miss and falls back to a full page reload. v2 needs
 *   `source: "remote:<origin>"` on the snapshot so the host's
 *   refetch dispatcher routes back to the remote endpoint.
 *
 * To exercise this page, both dev servers must be running:
 *   - `yarn dev` (this app, port 5173)
 *   - `yarn dev:magento` (the remote, port 5181)
 */

import { parton, RemoteFrame, type RenderArgs } from "@parton/framework"
import { Suspense } from "react"
import { Card, CardContent } from "@parton/copies/components/ui/card"

const REMOTE_ORIGIN = "http://localhost:5181"

export const RemoteFrameCrossOriginDemoPage = parton(
  function RemoteFrameCrossOriginDemoRender({ parent }: RenderArgs) {
    return (
      <>
        <header className="mb-4" data-testid="rfxd-header">
          <h1 className="text-2xl font-semibold">Cross-Origin Remote Frame Demo</h1>
          <p className="text-sm text-muted-foreground">
            Host rendered at <code>{new Date().toISOString()}</code>.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            The two cards below are rendered by a SEPARATE Node process running on{" "}
            <code>{REMOTE_ORIGIN}</code> (the <code>e2e-magento</code> workspace
            with <code>yarn dev:magento</code>). The host fetches their Flight
            bytes cross-origin, runs the module-reference rewriter so any inline
            module paths resolve at the remote's origin, decodes the result, and
            stitches it into this response. If you don't see content below, the{" "}
            <code>e2e-magento</code> dev server isn't running.
          </p>
        </header>

        <Suspense
          fallback={
            <Card className="mb-2 p-4" data-testid="rfxd-greeting-fallback">
              <CardContent className="px-0 italic text-muted-foreground">
                Fetching cross-origin greeting…
              </CardContent>
            </Card>
          }
        >
          <RemoteFrame
            src={`${REMOTE_ORIGIN}/__remote/magento-greeting`}
            parent={parent}
          />
        </Suspense>

        <Suspense
          fallback={
            <Card className="mb-2 p-4" data-testid="rfxd-stocks-fallback">
              <CardContent className="px-0 italic text-muted-foreground">
                Fetching cross-origin stock ticker…
              </CardContent>
            </Card>
          }
        >
          <RemoteFrame
            src={`${REMOTE_ORIGIN}/__remote/magento-stocks`}
            parent={parent}
          />
        </Suspense>

        <footer className="mt-4 text-xs text-muted-foreground" data-testid="rfxd-footer">
          Footer rendered at <code>{new Date().toISOString()}</code>. The host
          paints chrome immediately; each cross-origin fetch resolves
          independently and stitches in via its Suspense boundary.
        </footer>
      </>
    )
  },
  { match: "/remote-frame-crossorigin-demo" },
)
