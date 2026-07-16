import { block, type RenderArgs } from "@parton/framework"

export const RichTextBlock = block(
  function RichTextRender({ body }: { body: string } & RenderArgs) {
    return (
      <div
        className="mb-3 rounded-lg border bg-card p-5 text-sm leading-relaxed"
        data-testid="composed-rich-text"
      >
        {body || <span className="text-muted-foreground italic">Empty rich-text block</span>}
      </div>
    )
  },
  {
    schema: ({ cms }) => ({ body: cms.richText("body") }),
  },
)
