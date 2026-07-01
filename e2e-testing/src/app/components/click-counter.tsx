"use client"

import { useState } from "react"
import { Button } from "@parton/copies/components/ui/button"

export function ClickCounter() {
  const [n, setN] = useState(0)
  return (
    <Button
      // `data-hydrated` marks the button React-owned: the callback ref
      // fires at the commit that attaches (or hydration-adopts) the
      // element — the same moment onClick goes live. The counter sits
      // inside cached / remote subtrees that hydrate AFTER the page
      // shell; e2e specs wait for the marker before clicking, because
      // clicks fired earlier hit inert DOM and are silently lost.
      ref={(el) => el?.setAttribute("data-hydrated", "")}
      type="button"
      size="sm"
      variant="outline"
      onClick={() => setN((x) => x + 1)}
      data-testid="click-counter"
    >
      clicked {n}×
    </Button>
  )
}
