"use client"

import { useNavigation } from "@parton/framework/lib/partial-client.tsx"
import { Button } from "@parton/copies/components/ui/button"

export function RefreshAllPricesButton() {
  const [reload, isPending] = useNavigation().reload()
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-testid="refresh-all-prices"
      onClick={() => reload({ selector: ".price" })}
      disabled={isPending}
      className="mb-4"
    >
      {isPending ? "Refreshing all prices…" : "Refresh all prices"}
    </Button>
  )
}
