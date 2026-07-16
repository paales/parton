/**
 * Multi-slot container — `body` + `sidebar`.
 */

import { block, type RenderArgs } from "@parton/framework"
import type { ReactNode } from "react"

export const PageMultiSlotBlock = block(
  function PageMultiSlotRender({
    body,
    sidebar,
  }: { body: ReactNode; sidebar: ReactNode } & RenderArgs) {
    return (
      <section
        className="mt-8 grid gap-4 md:grid-cols-[1fr_280px]"
        data-testid="cms-demo-multi-slot-section"
      >
        <div data-testid="cms-demo-multi-slot-body">
          <h3 className="mb-2 text-sm uppercase tracking-wide text-muted-foreground">Body</h3>
          {body}
        </div>
        <aside data-testid="cms-demo-multi-slot-sidebar">
          <h3 className="mb-2 text-sm uppercase tracking-wide text-muted-foreground">Sidebar</h3>
          {sidebar}
        </aside>
      </section>
    )
  },
  {
    schema: ({ cms }) => ({
      body: cms.blocks("body"),
      sidebar: cms.blocks("sidebar"),
    }),
  },
)
