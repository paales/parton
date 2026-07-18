import { Card, CardContent } from "@parton/copies/components/ui/card"

/**
 * The app's 404 document body — `createRscHandler({ notFound })`. The
 * entry renders it whenever a request resolves `notFound()`: an
 * explicit throw from a page render, or the declared 404 boundary
 * (`unmatched: "not-found"`) catching a URL no match pattern covers.
 */
export function NotFoundPage() {
  return (
    <main data-testid="not-found">
      <title>404 — Not Found</title>
      <Card className="mt-4 p-8 text-center">
        <CardContent className="flex flex-col gap-2">
          <h1 className="text-4xl font-semibold">404</h1>
          <div className="text-sm text-muted-foreground">
            This URL doesn't match any known route.
          </div>
        </CardContent>
      </Card>
    </main>
  )
}
