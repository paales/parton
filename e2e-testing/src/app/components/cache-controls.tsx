"use client"

import { useNavigation } from "@parton/framework/lib/partial-client.tsx"
import { Button } from "@parton/copies/components/ui/button"

/**
 * Client-side buttons to trigger refetches against the cache-demo
 * partials. Each button gets its own tuple hook so `isPending`
 * reflects only that button's in-flight refetch.
 */
export function CacheControls() {
  const nav = useNavigation()
  const [reload, reloadPending] = nav.reload()
  const [navigate, navigatePending] = nav.navigate()
  const isPending = reloadPending || navigatePending

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => reload({ selector: "#slow" })}
        data-testid="refetch-slow"
      >
        Refetch slow
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => reload({ selector: "#clock" })}
        data-testid="refetch-clock"
      >
        Refetch clock
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          const url = new URL(window.location.href)
          const current = url.searchParams.get("flavor") ?? "vanilla"
          const next = current === "vanilla" ? "chocolate" : "vanilla"
          url.searchParams.set("flavor", next)
          // Targeted refetch of `#slow` with the new flavor sent
          // alongside as a JSX-style prop. The wrapper isn't
          // re-evaluated in cache mode, so partial-refetch needs
          // the prop wired explicitly — same mechanism
          // `<WhenStored>` uses.
          void navigate(url.toString(), {
            history: "push",
            selector: "#slow",
            props: { slow: { flavor: next } },
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
