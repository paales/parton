"use client"

import { useState } from "react"
import {
  useEnclosingPartialId,
  useNavigation,
} from "@react-cms/framework/lib/partial-client.tsx"
import { Button } from "@react-cms/copies/components/ui/button"

export function RefreshPriceButton({ sku }: { sku: string }) {
  const nav = useNavigation()
  // `useEnclosingPartialId()` resolves to this LivePrice instance's
  // framework-internal id (derived from props hash). Externally,
  // instances are only addressable by class (`.price`); from inside
  // the block we can self-target via this hook.
  const myId = useEnclosingPartialId()
  const [isPending, setIsPending] = useState(false)
  async function refresh() {
    if (!myId) return
    setIsPending(true)
    try {
      await nav.reload({ selector: [`#${myId}`] }).finished
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
