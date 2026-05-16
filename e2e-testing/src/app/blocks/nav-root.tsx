/**
 * App nav root — styled `<nav>` chrome around the editable list of
 * `.nav-item` blocks. Singleton block whose CMS storage key falls
 * out of the spec's id: `selector: "#app-nav"` pins the id to
 * `"app-nav"`, which is both the refetch token
 * (`nav.reload({selector:"#app-nav"})`) and the row in `content.json`
 * the schema reads from.
 */

import { block, type RenderArgs } from "@parton/framework"
import type { ReactNode } from "react"

export const AppNavBlock = block(
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
