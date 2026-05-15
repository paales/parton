/**
 * App nav root — styled `<nav>` chrome around the editable list of
 * `.nav-item` blocks. Singleton block bound to CMS content row
 * `app-nav` via the explicit `cmsId:` option. The cmsId is the storage
 * key AND the spec's catalog id, so external code can refetch via
 * `nav.reload({ selector: "#app-nav" })`.
 */

import { ReactCms, type RenderArgs } from "@react-cms/framework"
import type { ReactNode } from "react"

export const AppNavBlock = ReactCms.block(
  function AppNavRender({ links }: { links: ReactNode } & RenderArgs) {
    return <nav className="mb-6 flex flex-wrap gap-1 border-b pb-3">{links}</nav>
  },
  {
    cmsId: "app-nav",
    schema: ({ cms }) => ({
      links: cms.blocks("links", ".nav-item"),
    }),
  },
)
