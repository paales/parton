/**
 * Page-level root container — single `body` slot accepting `.page-block`.
 */

import { block, type RenderArgs } from "@parton/framework"
import type { ReactNode } from "react"

export const PageRootBlock = block(
  function PageRootRender({ body }: { body: ReactNode } & RenderArgs) {
    return body
  },
  {
    schema: ({ cms }) => ({
      body: cms.blocks("body", ".page-block"),
    }),
  },
)
