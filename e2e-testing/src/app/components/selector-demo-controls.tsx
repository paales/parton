"use client"

import { useEffect } from "react"
import { useNavigation } from "@parton/framework/lib/partial-client.tsx"
import { Button } from "@parton/copies/components/ui/button"

/**
 * Button that fires a targeted reload via `useNavigation().reload()`.
 */
export function SelectorRefetchButton({
  selector,
  label,
  testId,
}: {
  selector: string
  label: string
  testId: string
}) {
  const [reload, { committed, finished }] = useNavigation().reload()
  const pending = committed && !finished
  return (
    <Button
      // `data-hydrated`: React owns the button (onClick live) — the
      // controls hydrate after the page shell; e2e specs click via
      // the marker-qualified locator.
      ref={(el) => el?.setAttribute("data-hydrated", "")}
      type="button"
      size="sm"
      variant="outline"
      data-testid={testId}
      onClick={() => reload({ selector })}
      disabled={pending}
    >
      {pending ? "…" : label}
    </Button>
  )
}

/**
 * Test affordance: exposes `window.__fireProductReload()` to drive
 * overlapping `.product` reloads WITHOUT the button's
 * disabled-while-pending guard. A spec uses it to fire two superseding
 * same-URL refetches (whose `<ServerTime>` content differs per render)
 * and assert the framework commits them in ISSUE order, not arrival
 * order. Renders nothing.
 */
export function ProductReloadProbe() {
  const [reload] = useNavigation().reload()
  useEffect(() => {
    const w = window as unknown as { __fireProductReload?: () => void }
    w.__fireProductReload = () => reload({ selector: ".product" })
    return () => {
      delete w.__fireProductReload
    }
  }, [reload])
  return null
}
