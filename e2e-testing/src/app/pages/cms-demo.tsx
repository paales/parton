/**
 * /cms-demo — root-as-page-slot.
 *
 * One spec matches both `/cms-demo` and `/cms-demo/:slug` via the
 * `/cms-demo{/*}?` URLPattern (optional `/*` tail). The render is a
 * single `body` slot whose entries (registered as `page-*` blocks in
 * the catalog) compose the page.
 */

import { parton, block } from "@parton/framework"
import type { ReactNode } from "react"
import type { RenderArgs } from "@parton/framework"
import { Card, CardContent } from "@parton/copies/components/ui/card"

export const CmsDemoRootBlock = block(
  function CmsDemoRootRender({ body }: { body: ReactNode } & RenderArgs) {
    return body
  },
  {
    schema: ({ cms }) => ({
      body: cms.blocks("body", ".page-block"),
    }),
  },
)

export const CmsDemoPage = parton(
  function CmsDemoExplainerRender({ parent }) {
    return (
      <>
        <CmsDemoRootBlock parent={parent} />

        <Card className="mt-8 p-5">
          <CardContent className="px-0 text-sm text-muted-foreground">
            <p className="mb-2 font-semibold text-foreground">What you're looking at</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                The page above is a single spec (
                <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
                  #cms-demo-root
                </code>
                ) whose schema reads a{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
                  cms.blocks("body", ".page-block")
                </code>{" "}
                slot. Every visible piece is a slot child in the CMS store.
              </li>
              <li>
                Per-slug content uses match clauses on slot-child entries — visit /cms-demo/alpha vs
                /cms-demo to see it.
              </li>
            </ul>
          </CardContent>
        </Card>
      </>
    )
  },
  { match: "/cms-demo{/*}?" },
)
