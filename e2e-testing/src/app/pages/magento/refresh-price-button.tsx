"use client"

import {
  useEnclosingPartialId,
  useNavigation,
} from "@parton/framework/lib/partial-client.tsx"
import { Button } from "@parton/copies/components/ui/button"

/**
 * Per-card refresh button. Reads the enclosing partial instance's id
 * via `useEnclosingPartialId()` and refetches just that one. The id
 * for a `<LivePrice sku=…/>` placement auto-derives in the framework
 * from `spec.id + hash(props)` — each card gets a distinct one, so
 * the refetch targets exactly the clicked card. The "refresh all"
 * companion button uses the class-level `.price` selector to fan
 * out across every instance.
 */
export function RefreshPriceButton({ sku }: { sku: string }) {
  const [reload, isPending] = useNavigation().reload()
  const myId = useEnclosingPartialId()
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      data-testid={`refresh-price-${sku}`}
      onClick={() => myId && reload({ selector: myId })}
      disabled={isPending || !myId}
      className="text-primary"
    >
      {isPending ? "…" : "↻"}
    </Button>
  )
}
