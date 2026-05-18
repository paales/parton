"use client"

import { useNavigation } from "@parton/framework/lib/partial-client.tsx"
import { Button } from "@parton/copies/components/ui/button"

/**
 * Client component demonstrating partial-level re-fetching.
 *
 * One button per partial id. Each button uses its own
 * `useNavigation().reload()` hook so its progress reflects only that
 * button's in-flight refetch — sibling buttons stay clickable while
 * one is loading. Multiple reloads in the same tick are still
 * batched into one RSC request by the navigation dispatcher.
 */
export function PartialControls() {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">
        reload({"{"}selector{"}"}):
      </span>
      {(["hero", "stats", "species"] as const).map((id) => (
        <RefreshPartialButton key={id} id={id} />
      ))}
    </div>
  )
}

function RefreshPartialButton({ id }: { id: "hero" | "stats" | "species" }) {
  const [reload, { committed, finished }] = useNavigation().reload()
  const pending = committed && !finished
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => reload({ selector: `#${id}` })}
      disabled={pending}
    >
      {pending ? "Refreshing..." : `Refresh ${id[0].toUpperCase()}${id.slice(1)}`}
    </Button>
  )
}
