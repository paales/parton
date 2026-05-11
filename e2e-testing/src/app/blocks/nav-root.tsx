/**
 * App nav root — styled `<nav>` chrome around the editable list of
 * `.nav-item` blocks. Singleton block bound to cmsId `app-nav` via the
 * `#app-nav` token in its selector.
 */

import { ReactCms, type RenderArgs } from "@react-cms/framework"
import type { ReactNode } from "react"

export const AppNavBlock = ReactCms.block(
  function AppNavRender({ links }: { links: ReactNode } & RenderArgs) {
    return <nav className="mb-6 flex flex-wrap gap-1 border-b pb-3">{links}</nav>
  },
  {
    selector: "#app-nav",
    schema: ({ cms }) => ({
      links: cms.blocks("links", ".nav-item"),
    }),
  },
)
