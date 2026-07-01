"use client"

import { useNavigation } from "@parton/framework/lib/partial-client.tsx"
import { Button } from "@parton/copies/components/ui/button"

/**
 * Targets a specific remote frame by its spec selector and fires a
 * targeted reload. The host's refetch machinery picks the matching
 * snapshot and re-renders it — in same-origin v1 this round-trips
 * through the host's local copy of the spec (the remote endpoint
 * isn't re-hit). v2 cross-origin will need an explicit "this id is
 * hosted at <origin>" annotation on the snapshot so the refetch is
 * routed to the remote.
 */
export function RemoteRefreshButton({ selector, label }: { selector: string; label: string }) {
  const [reload, { committed, finished }] = useNavigation().reload()
  const pending = committed && !finished
  return (
    <Button
      // `data-hydrated`: React owns the button (onClick live) — the
      // host chrome hydrates after the page shell; e2e specs click via
      // the marker-qualified locator.
      ref={(el) => el?.setAttribute("data-hydrated", "")}
      type="button"
      size="sm"
      variant="outline"
      onClick={() => reload({ selector })}
      disabled={pending}
      data-testid={`rfd-refresh-${selector}`}
    >
      {pending ? "…" : label}
    </Button>
  )
}
