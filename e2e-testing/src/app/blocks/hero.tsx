/**
 * Demo hero block — small card used inside composed slots.
 */

import { block, type RenderArgs } from "@parton/framework"
import { Card, CardContent } from "@parton/copies/components/ui/card"
import { cn } from "@parton/copies/lib/utils"

export const HeroBlock = block(
  function HeroRender({
    headline,
    subhead,
    tone,
  }: { headline: string; subhead: string; tone: "calm" | "loud" } & RenderArgs) {
    return (
      <Card
        className={cn(
          "mb-3 p-5",
          tone === "loud" && "border-amber-400/60 bg-amber-500/5 dark:bg-amber-400/10",
        )}
        data-testid="composed-hero"
      >
        <CardContent className="px-0">
          <h3 className="text-base font-semibold" data-testid="composed-hero-headline">
            {headline || "Untitled hero"}
          </h3>
          {subhead && (
            <p className="mt-1 text-sm text-muted-foreground" data-testid="composed-hero-subhead">
              {subhead}
            </p>
          )}
        </CardContent>
      </Card>
    )
  },
  {
    schema: ({ cms }) => ({
      headline: cms.text("headline"),
      subhead: cms.text("subhead"),
      tone: cms.enum("tone", ["calm", "loud"] as const),
    }),
  },
)
