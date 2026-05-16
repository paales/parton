"use client"

import { useEffect, useState } from "react"
import { usePartialReconcile } from "@parton/framework/lib/partial-client.tsx"

/**
 * Renders a small "flash" indicator that pulses for 800ms every
 * time the enclosing parton's server fingerprint changes — i.e.
 * every refetch / invalidate / vary-result change.
 *
 * Stamps `data-reconcile-count` and `data-reconcile-flash` so e2e
 * tests can observe the RepNotify channel firing without scraping
 * timing-fragile animations.
 *
 * Demonstrates `usePartialReconcile` from
 * `@parton/framework`. See `docs/notes/replicated-state.md` for
 * the broader replication-model context.
 */
export function ReconcileFlash() {
  const [count, setCount] = useState(0)
  const [flash, setFlash] = useState(false)

  usePartialReconcile(() => {
    setCount((c) => c + 1)
    setFlash(true)
  })

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(false), 800)
    return () => clearTimeout(t)
  }, [flash])

  return (
    <span
      data-testid="reconcile-flash"
      data-reconcile-count={String(count)}
      data-reconcile-flash={flash ? "1" : "0"}
      className={
        "ml-2 inline-block rounded px-2 py-0.5 text-xs transition-colors " +
        (flash
          ? "bg-amber-500/30 text-amber-200"
          : "bg-muted text-muted-foreground")
      }
    >
      reconciled ×{count}
    </span>
  )
}
