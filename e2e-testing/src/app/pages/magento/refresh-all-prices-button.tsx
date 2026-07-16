"use client"

import { useState } from "react"
import { Button } from "@parton/copies/components/ui/button"
import { bumpAllPrices } from "./price-actions.ts"

export function RefreshAllPricesButton() {
  const [pending, setPending] = useState(false)
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
      onClick={() => {
        setPending(true)
        void bumpAllPrices().finally(() => setPending(false))
      }}
      disabled={pending}
      className="mb-4"
    >
      {pending ? "Refreshing all prices…" : "Refresh all prices"}
    </Button>
  )
}
