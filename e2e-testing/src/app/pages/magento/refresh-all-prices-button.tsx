"use client"

import { useNavigation } from "@parton/framework/lib/partial-client.tsx"
import { Button } from "@parton/copies/components/ui/button"

export function RefreshAllPricesButton() {
  const [reload, { committed, finished }] = useNavigation().reload()
  const pending = committed && !finished
  return (
    <Button
      // `data-hydrated`: React owns the button (onClick live) — the
      // header controls hydrate after the page shell; e2e specs click
      // via the marker-qualified locator.
      ref={(el) => el?.setAttribute("data-hydrated", "")}
      type="button"
      size="sm"
      variant="outline"
      data-testid="refresh-all-prices"
      onClick={() => reload({ selector: ".price" })}
      disabled={pending}
      className="mb-4"
    >
      {pending ? "Refreshing all prices…" : "Refresh all prices"}
    </Button>
  )
}
