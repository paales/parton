import { block, type RenderArgs } from "@parton/framework"
import { Card, CardContent } from "@parton/copies/components/ui/card"
import { Badge } from "@parton/copies/components/ui/badge"
import { cn } from "@parton/copies/lib/utils"

export const PageGreetingBlock = block(
  function PageGreetingRender({
    headline,
    body,
    tone,
    accent,
    emphasize,
  }: {
    headline: string
    body: string
    tone: "calm" | "loud"
    accent: number
    emphasize: boolean
  } & RenderArgs) {
    return (
      <Card
        className={cn(
          "mb-4 p-6",
          tone === "loud" && "border-emerald-400/60 bg-emerald-500/5 dark:bg-emerald-400/10",
        )}
        data-testid="cms-demo-greeting"
      >
        <CardContent className="px-0">
          <div className="flex items-center gap-3">
            <h2
              className={cn("text-xl font-semibold", emphasize && "uppercase tracking-wide")}
              data-testid="cms-demo-greeting-headline"
            >
              {headline}
            </h2>
            {accent > 0 && (
              <Badge variant="secondary" data-testid="cms-demo-greeting-accent">
                accent {accent}
              </Badge>
            )}
          </div>
          <p className="mt-2 text-muted-foreground" data-testid="cms-demo-greeting-body">
            {body}
          </p>
        </CardContent>
      </Card>
    )
  },
  {
    selector: ".page-block",
    schema: ({ cms }) => ({
      headline: cms.text("headline"),
      body: cms.text("body"),
      tone: cms.enum("tone", ["calm", "loud"] as const),
      accent: cms.number("accent"),
      emphasize: cms.boolean("emphasize"),
    }),
  },
)
