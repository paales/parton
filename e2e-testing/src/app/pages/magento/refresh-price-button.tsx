"use client"

import { useState } from "react"
import { useNavigation } from "@react-cms/framework/lib/partial-client.tsx"
import { Button } from "@react-cms/copies/components/ui/button"

/**
 * Per-card refresh button. Triggers a class-scoped refetch
 * (`reload({selector: ".price"})`) — every LivePrice on the page
 * refreshes together. There's no per-instance addressing for
 * keyless multi-instance specs; the underlying assumption is that
 * a single price refresh and a fan-out refresh look the same to
 * the user (both go through the same data source).
 */
export function RefreshPriceButton({ sku }: { sku: string }) {
  const nav = useNavigation()
  const [isPending, setIsPending] = useState(false)
  async function refresh() {
    setIsPending(true)
    try {
      await nav.reload({ selector: ".price" }).finished
    } finally {
      setIsPending(false)
    }
  }
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      data-testid={`refresh-price-${sku}`}
      onClick={refresh}
      disabled={isPending}
      className="text-primary"
    >
      {isPending ? "…" : "↻"}
    </Button>
  )
}
