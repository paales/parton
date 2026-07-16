"use client"

import { useState } from "react"
import { Button } from "@parton/copies/components/ui/button"
import { bumpTag } from "../pages/tag-demo-actions.ts"

/**
 * Refreshes embedded remote content by bumping the tag the remote
 * parton reads (`tag("<name>")` in the producer's Render). The bump
 * matches the embed's host-registered snapshot labels; the wake lanes
 * a focused re-embed (`?partials=<id>` back at the embedded URL).
 * Several embeds reading one tag fan out on one bump.
 */
export function RemoteRefreshButton({ name, label }: { name: string; label: string }) {
  const [pending, setPending] = useState(false)
  return (
    <Button
      // `data-hydrated`: React owns the button (onClick live) — the
      // host chrome hydrates after the page shell; e2e specs click via
      // the marker-qualified locator.
      ref={(el) => el?.setAttribute("data-hydrated", "")}
      type="button"
      size="sm"
      variant="outline"
      onClick={() => {
        setPending(true)
        void bumpTag(name).finally(() => setPending(false))
      }}
      disabled={pending}
      data-testid={`rfd-refresh-${name}`}
    >
      {pending ? "…" : label}
    </Button>
  )
}
