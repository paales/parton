"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@parton/copies/components/ui/button"
import { bumpPrice } from "./price-actions.ts"

/**
 * Per-card refresh button — fires the sku-constrained price bump
 * (`refreshSelector("price?sku=<sku>")`). Each `<LivePrice sku=…/>`
 * placement reads the matching constrained tag, so the bump lanes
 * exactly the clicked card; the "refresh all" companion bumps the
 * bare `price` name to fan out across every instance.
 */
export function RefreshPriceButton({ sku }: { sku: string }) {
  const [pending, setPending] = useState(false)
  // Per-button hydration marker. The price cards stream in via
  // Suspense and hydrate progressively AFTER the page shell — until a
  // card's boundary has hydrated, its DOM is React-unowned: a commit
  // that re-renders the boundary replaces those nodes wholesale.
  // Client-state assertions (the e2e state-preservation spec) wait
  // for `data-hydrated` on each button before treating its DOM node
  // as a stable, state-carrying instance.
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    ref.current?.setAttribute("data-hydrated", "")
  }, [])
  return (
    <Button
      ref={ref}
      type="button"
      size="icon-xs"
      variant="ghost"
      data-testid={`refresh-price-${sku}`}
      onClick={() => {
        setPending(true)
        void bumpPrice(sku).finally(() => setPending(false))
      }}
      disabled={pending}
      className="text-primary"
    >
      {pending ? "…" : "↻"}
    </Button>
  )
}
