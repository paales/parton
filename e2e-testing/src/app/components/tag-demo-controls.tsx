"use client"

import { useState } from "react"
import { Button } from "@parton/copies/components/ui/button"
import { bumpTag } from "../pages/tag-demo-actions.ts"

/**
 * Button that fires a tag bump via the `bumpTag` server action — the
 * event-shaped refresh signal. Readers of the tag re-render on the
 * held connection's lanes; the button itself just invokes the action.
 */
export function TagBumpButton({
  name,
  label,
  testId,
}: {
  name: string
  label: string
  testId: string
}) {
  const [pending, setPending] = useState(false)
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
      onClick={() => {
        setPending(true)
        void bumpTag(name).finally(() => setPending(false))
      }}
      disabled={pending}
    >
      {pending ? "…" : label}
    </Button>
  )
}
