"use client"

import { useState } from "react"
import { useNavigation } from "@parton/framework/lib/partial-client.tsx"
import { Button } from "@parton/copies/components/ui/button"

/**
 * Targets a specific remote frame by its spec selector and fires
 * `nav.reload({ selector })`. The host's refetch machinery picks
 * the matching snapshot and re-renders it — in same-origin v1 this
 * round-trips through the host's local copy of the spec (the remote
 * endpoint isn't re-hit). v2 cross-origin will need an explicit
 * "this id is hosted at <origin>" annotation on the snapshot so
 * the refetch is routed to the remote.
 */
export function RemoteRefreshButton({
  selector,
  label,
}: {
  selector: string
  label: string
}) {
  const nav = useNavigation()
  const [pending, setPending] = useState(false)
  async function onClick() {
    setPending(true)
    try {
      await nav.reload({ selector }).finished
    } finally {
      setPending(false)
    }
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={onClick}
      disabled={pending}
      data-testid={`rfd-refresh-${selector}`}
    >
      {pending ? "…" : label}
    </Button>
  )
}
