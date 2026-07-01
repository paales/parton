"use client"

import { useEffect, useRef } from "react"
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
  const [reload, { committed, finished }] = useNavigation().reload()
  const pending = committed && !finished
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
      onClick={() => reload({ selector: "@self" })}
      disabled={pending}
      className="text-primary"
    >
      {pending ? "…" : "↻"}
    </Button>
  )
}
