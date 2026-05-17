"use client"

import { useNavigation } from "@parton/framework/lib/partial-client.tsx"
import { Button } from "@parton/copies/components/ui/button"

/**
 * Per-card refresh button. The `@self` selector token resolves to
 * the enclosing partial's effective id at fire time — the framework
 * reads it off `PartialIdContext` which `PartialErrorBoundary`
 * populates per instance. Each `<LivePrice sku=…/>` placement gets
 * a distinct id (auto-derived from `spec.id + hash(props)`), so the
 * refetch targets exactly the clicked card. The "refresh all"
 * companion button uses the class-level `.price` selector to fan
 * out across every instance.
 */
export function RefreshPriceButton({ sku }: { sku: string }) {
  const [reload, isPending] = useNavigation().reload()
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      data-testid={`refresh-price-${sku}`}
      onClick={() => reload({ selector: "@self" })}
      disabled={isPending}
      className="text-primary"
    >
      {isPending ? "…" : "↻"}
    </Button>
  )
}
