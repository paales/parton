"use client"

import { _windowNav } from "./partial-client.tsx"
import { getNavigation } from "../runtime/navigation-api.ts"

const DEFAULT_INTERVAL_MS = 5_000

interface HeartbeatOptions {
  /** Interval (ms) between periodic re-fires. While a streaming
   *  connection is already open, the interval tick is a no-op. */
  intervalMs?: number
}

/**
 * Opt-in heartbeat that holds a `?streaming=1` long-poll connection
 * to the current URL open, so the server's segment driver can push
 * `refreshSelector` and `expiresAt` updates as they happen.
 *
 * Called once from the app's browser entry, AFTER `hydrateRoot`:
 *
 *   import { startLivePageHeartbeat } from "@parton/framework"
 *   hydrateRoot(document, browserRoot, …)
 *   startLivePageHeartbeat()
 *
 * Behaviour:
 *   - Initial fire happens immediately. Because `enqueueRefetch`
 *     coalesces fires within a microtask, this initial fire
 *     naturally batches with any client-side activator fires
 *     (when-stored, when-visible) that mount in the same tick.
 *   - Every `intervalMs` (default 5s), re-fires IF no stream is
 *     currently open. While a stream is open it IS the heartbeat,
 *     so the interval tick is a no-op. When the server's keepalive
 *     elapses and the stream closes, the next interval tick
 *     reopens it.
 *   - On `navigate` (URL change), aborts the in-flight stream.
 *     The framework's nav handler opens the new page's fetch;
 *     once that fetch commits, the heartbeat's next interval tick
 *     opens a fresh streaming connection on the new URL.
 *
 * Actions complete normally (no streaming mode) and call
 * `refreshSelector` inside their bodies. The already-open stream
 * wakes on the bump and emits the next segment. There's never
 * more than one streaming connection per page lifetime.
 */
export function startLivePageHeartbeat(options: HeartbeatOptions = {}): void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const nav = _windowNav()
  let inFlight: AbortController | null = null

  const fire = () => {
    if (inFlight) return
    inFlight = new AbortController()
    const { finished } = nav.reload({ streaming: true, signal: inFlight.signal })
    finished
      .catch(() => {
        // Network error / abort — same continuation: clear the
        // in-flight slot so the next interval tick can reopen.
      })
      .finally(() => {
        inFlight = null
      })
  }

  // Defer the initial fire to a macrotask. React's commit-phase
  // useEffects fire after synchronous return from `hydrateRoot`,
  // and one of them wires up the response-commit handler
  // (`setPayloadRaw`). Firing synchronously here would race that
  // setup and the first segment's commit would fail. `setTimeout(0)`
  // yields long enough for React to commit + run effects.
  setTimeout(fire, 0)
  setInterval(fire, intervalMs)

  const browserNav = getNavigation()
  browserNav?.addEventListener("navigate", () => {
    if (inFlight) inFlight.abort()
  })
}
