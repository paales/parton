"use client"

import { useNavigation } from "@parton/framework/lib/partial-client.tsx"
import { Button } from "@parton/copies/components/ui/button"

/**
 * Manual activator: a plain button that calls a targeted reload.
 * Demonstrates `defer={true}` — the framework isn't wired to any
 * trigger; the app decides when to activate.
 */
export function ActivateButton({
  partialId,
  label,
  testId,
  streaming,
}: {
  partialId: string
  label?: string
  testId?: string
  /**
   * If true, the refetch commits each response on arrival (progressive
   * reveal with Suspense fallbacks) rather than being held back inside
   * a transition until the body is fully ready.
   */
  streaming?: boolean
}) {
  const [reload, { committed, finished }] = useNavigation().reload()
  const pending = committed && !finished
  // A `streaming` reload holds its connection open after the first
  // segment commits (`finished` resolves only when the stream closes),
  // so `committed && !finished` would pin the button disabled for the
  // stream's lifetime. Streaming refetches are rapid-fire / last-wins,
  // so they stay clickable; only one-shot reloads disable while loading.
  const disabled = streaming ? false : pending
  return (
    <Button
      // `data-hydrated`: React owns the button (onClick live) — the
      // demo controls hydrate after the page shell; e2e specs click
      // via the marker-qualified locator.
      ref={(el) => el?.setAttribute("data-hydrated", "")}
      type="button"
      size="sm"
      variant="outline"
      data-testid={testId ?? `activate-${partialId}`}
      onClick={() => reload({ selector: `#${partialId}`, streaming })}
      disabled={disabled}
    >
      {pending ? "…" : (label ?? "Activate")}
    </Button>
  )
}
