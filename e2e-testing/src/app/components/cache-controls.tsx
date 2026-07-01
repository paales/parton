"use client"

import { useNavigation } from "@parton/framework/lib/partial-client.tsx"
import { Button } from "@parton/copies/components/ui/button"

/**
 * Client-side buttons to trigger refetches against the cache-demo
 * partials. Each hook owns its own progress so the "…" indicator
 * reflects only this widget's in-flight work.
 */
export function CacheControls() {
  const nav = useNavigation()
  const [reload, reloadProgress] = nav.reload()
  const [navigate, navigateProgress] = nav.navigate()
  const isPending =
    (reloadProgress.committed && !reloadProgress.finished) ||
    (navigateProgress.committed && !navigateProgress.finished)

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Button
        // `data-hydrated`: React owns the button (onClick live) — the
        // controls hydrate after the page shell; e2e specs click via
        // the marker-qualified locator.
        ref={(el) => el?.setAttribute("data-hydrated", "")}
        type="button"
        size="sm"
        variant="outline"
        onClick={() => reload({ selector: "#slow" })}
        data-testid="refetch-slow"
      >
        Refetch slow
      </Button>
      <Button
        // `data-hydrated`: React owns the button (onClick live) — the
        // controls hydrate after the page shell; e2e specs click via
        // the marker-qualified locator.
        ref={(el) => el?.setAttribute("data-hydrated", "")}
        type="button"
        size="sm"
        variant="outline"
        onClick={() => reload({ selector: "#clock" })}
        data-testid="refetch-clock"
      >
        Refetch clock
      </Button>
      <Button
        // `data-hydrated`: React owns the button (onClick live) — the
        // controls hydrate after the page shell; e2e specs click via
        // the marker-qualified locator.
        ref={(el) => el?.setAttribute("data-hydrated", "")}
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          const url = new URL(window.location.href)
          const current = url.searchParams.get("flavor") ?? "vanilla"
          const next = current === "vanilla" ? "chocolate" : "vanilla"
          url.searchParams.set("flavor", next)
          // Push the new `?flavor=` and refetch just `#slow`. Slow reads
          // `flavor` from the URL via its own `vary`, so the refetch
          // re-derives it against the updated URL.
          void navigate(url.toString(), {
            history: "push",
            selector: "#slow",
          })
        }}
        data-testid="toggle-flavor"
      >
        Toggle flavor
      </Button>
      {isPending && <span className="text-muted-foreground">…</span>}
    </div>
  )
}
