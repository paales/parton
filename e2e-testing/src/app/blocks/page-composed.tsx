/**
 * Composed container — has its own `body` slot of demo blocks.
 */

import { block, type RenderArgs } from "@parton/framework"
import type { ReactNode } from "react"

export const PageComposedBlock = block(
  function PageComposedRender({ body }: { body: ReactNode } & RenderArgs) {
    return (
      <section data-testid="cms-demo-composed-section">
        <h2 className="mt-8 mb-3 text-lg font-semibold">Composed from a slot</h2>
        <div data-testid="cms-demo-composed-slot">{body}</div>
      </section>
    )
  },
  {
    schema: ({ cms }) => ({
      body: cms.blocks("body"),
    }),
  },
)
