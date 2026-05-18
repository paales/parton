"use client"

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
