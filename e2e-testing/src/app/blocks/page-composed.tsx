/**
 * Composed container — has its own `body` slot of demo blocks.
 */

import { ReactCms, type RenderArgs } from "@react-cms/framework"
import type { ReactNode } from "react"

export const PageComposedBlock = ReactCms.block(
  function PageComposedRender({ body }: { body: ReactNode } & RenderArgs) {
    return (
      <section data-testid="cms-demo-composed-section">
        <h2 className="mt-8 mb-3 text-lg font-semibold">Composed from a slot</h2>
        <div data-testid="cms-demo-composed-slot">{body}</div>
      </section>
    )
  },
  {
    selector: ".page-block",
    schema: ({ cms }) => ({
      body: cms.blocks("body", ".demo-block"),
    }),
  },
)
