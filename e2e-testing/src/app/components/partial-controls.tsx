"use client"

import { useState } from "react"
import { Button } from "@parton/copies/components/ui/button"
import { bumpTag } from "../pages/tag-demo-actions.ts"

/**
 * Client component demonstrating tag-driven re-fetching.
 *
 * One button per tag. The detail partons subscribe by reading —
 * `tag("hero")` / `tag("stats")` / `tag("species")` — and each button
 * fires the `bumpTag` server action, whose `refreshSelector` wakes
 * exactly that tag's reader.
 */
export function PartialControls() {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">refreshSelector(tag):</span>
      {(["hero", "stats", "species"] as const).map((name) => (
        <BumpTagButton key={name} name={name} />
      ))}
    </div>
  )
}

function BumpTagButton({ name }: { name: "hero" | "stats" | "species" }) {
  const [pending, setPending] = useState(false)
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => {
        setPending(true)
        void bumpTag(name).finally(() => setPending(false))
      }}
      disabled={pending}
    >
      {pending ? "Refreshing..." : `Refresh ${name[0].toUpperCase()}${name.slice(1)}`}
    </Button>
  )
}
