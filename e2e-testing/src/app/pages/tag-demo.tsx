/**
 * /tag-demo — the event-shaped refresh signal: partons subscribe by
 * READING a tag (`tag(name)` — the read IS the subscription), and a
 * server-side `refreshSelector(name)` wakes every reader. Tags fan
 * out by name: several partons reading one tag all re-render on one
 * bump; a parton reading several tags re-renders on any of them.
 *
 * A tag name is a process-wide address: a bump reaches every reader of
 * that name, in every page held open anywhere in the process. This
 * page's family lives under a `tag-demo:` prefix so its illustrative
 * bumps stay its own — a bare `price` here would re-price the real
 * product cards over on /magento, whose `tag("price?sku=…")` readers
 * an unconstrained `price` bump matches.
 */

import { parton, tag, type RenderArgs } from "@parton/framework"
import { TagBumpButton } from "../components/tag-demo-controls.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "@parton/copies/components/ui/card"

function ServerTime({ label }: { label: string }) {
  return (
    <div data-testid={`time-${label}`} className="font-mono">
      <strong>{label}:</strong> {new Date().toISOString()}
    </div>
  )
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">{children}</code>
}

export const TagProductPartial = parton(function TagProductRender({}: RenderArgs) {
  tag("tag-demo:product")
  return <ServerTime label="product" />
})

export const TagPriceAPartial = parton(function TagPriceARender({}: RenderArgs) {
  tag("tag-demo:price")
  tag("tag-demo:price-a")
  return <ServerTime label="price-a" />
})

export const TagPriceBPartial = parton(function TagPriceBRender({}: RenderArgs) {
  tag("tag-demo:price")
  tag("tag-demo:featured")
  return <ServerTime label="price-b" />
})

export const TagPriceCPartial = parton(function TagPriceCRender({}: RenderArgs) {
  tag("tag-demo:price")
  tag("tag-demo:featured")
  return <ServerTime label="price-c" />
})

export const TagDemoPage = parton(
  function TagDemoRender() {
    return (
      <main className="py-4">
        <title>Tag Demo</title>
        <h1 className="mb-4 text-2xl font-semibold">Tag-driven refresh</h1>
        <p className="mb-8 text-muted-foreground">
          A parton subscribes by reading — <InlineCode>tag(&quot;tag-demo:price&quot;)</InlineCode>{" "}
          — and a server-side <InlineCode>refreshSelector(&quot;tag-demo:price&quot;)</InlineCode>{" "}
          re-renders every reader.
        </p>

        <Card className="mb-6 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">
              <InlineCode>tag(&quot;tag-demo:product&quot;)</InlineCode> — one reader
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <TagProductPartial />
          </CardContent>
        </Card>

        <Card className="mb-6 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">
              <InlineCode>tag-demo:price</InlineCode> family
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 px-0">
            <TagPriceAPartial />
            <TagPriceBPartial />
            <TagPriceCPartial />
          </CardContent>
        </Card>

        <Card className="p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">Bump controls</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2 px-0">
            <TagBumpButton name="tag-demo:product" label="bump product" testId="refresh-product" />
            <TagBumpButton
              name="tag-demo:price"
              label="bump price (3 partons)"
              testId="refresh-price"
            />
            <TagBumpButton
              name="tag-demo:featured"
              label="bump featured (2 partons)"
              testId="refresh-price-featured"
            />
            <TagBumpButton name="tag-demo:price-a" label="bump price-a" testId="refresh-price-a" />
          </CardContent>
        </Card>
      </main>
    )
  },
  { match: "/tag-demo" },
)
