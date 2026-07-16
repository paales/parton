/**
 * Group — layout primitive with editable direction/align/justify/gap/
 * padding/wrap. Children plug in via the `items` slot (any block).
 */

import { block, type RenderArgs } from "@parton/framework"
import type { ReactNode } from "react"
import { cn } from "@parton/copies/lib/utils"

const DIRECTIONS = ["column", "row"] as const
const ALIGN_VALUES = ["start", "center", "end", "stretch"] as const
const JUSTIFY_VALUES = ["start", "center", "end", "between", "around"] as const

const FLEX_DIR: Record<(typeof DIRECTIONS)[number], string> = {
  column: "flex-col",
  row: "flex-row",
}
const ALIGN_ITEMS: Record<(typeof ALIGN_VALUES)[number], string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
}
const JUSTIFY_CONTENT: Record<(typeof JUSTIFY_VALUES)[number], string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  between: "justify-between",
  around: "justify-around",
}

export const GroupBlock = block(
  function GroupRender({
    direction,
    align,
    justify,
    gap,
    padding,
    wrap,
    items,
  }: {
    direction: (typeof DIRECTIONS)[number]
    align: (typeof ALIGN_VALUES)[number]
    justify: (typeof JUSTIFY_VALUES)[number]
    gap: number
    padding: number
    wrap: "nowrap" | "wrap"
    items: ReactNode
  } & RenderArgs) {
    return (
      <div
        className={cn(
          "flex",
          FLEX_DIR[direction],
          ALIGN_ITEMS[align],
          JUSTIFY_CONTENT[justify],
          wrap === "wrap" && "flex-wrap",
        )}
        style={{ gap: `${gap}px`, padding: padding > 0 ? `${padding}px` : undefined }}
        data-testid="group-block"
      >
        {items}
      </div>
    )
  },
  {
    schema: ({ cms }) => ({
      direction: cms.enum("direction", DIRECTIONS),
      align: cms.enum("align", ALIGN_VALUES),
      justify: cms.enum("justify", JUSTIFY_VALUES),
      gap: cms.number("gap"),
      padding: cms.number("padding"),
      wrap: cms.enum("wrap", ["nowrap", "wrap"] as const),
      items: cms.blocks("items"),
    }),
  },
)
