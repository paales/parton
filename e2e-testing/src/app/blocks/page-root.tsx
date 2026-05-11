/**
 * Page-level root container — single `body` slot accepting `.page-block`.
 */

import { ReactCms, type RenderArgs } from "@react-cms/framework"
import type { ReactNode } from "react"

export const PageRootBlock = ReactCms.block(
  function PageRootRender({ body }: { body: ReactNode } & RenderArgs) {
    return body
  },
  {
    schema: ({ cms }) => ({
      body: cms.blocks("body", ".page-block"),
    }),
  },
)
