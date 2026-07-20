"use client"

/**
 * The client half of a `defer: "stream"` STUB — the gate that makes
 * the stub's suspension a property of the WIRE FORM itself, not of
 * any particular client rendering path.
 *
 * The server emits a stream-deferred parton (inside a driver-owned
 * body) as `<PendingSlot partonId matchKey>` wrapping the inert
 * `<i data-partial data-partial-pending>` marker. While the id's
 * cache slot is EMPTY, this component throws the slot-fill promise —
 * the enclosing app `<Suspense>` fallback holds — and the promise
 * resolves at the follow-up lane's first store. Once the slot fills,
 * it renders its children: the merge layer's substitution has by then
 * replaced the marker in `children` with the cached content, so the
 * steady state renders the real body straight through.
 *
 * Why the gate must live IN the emission: a lane body's rows can
 * settle between the commit walk's classification and React's
 * reconcile of the node (the raw-reveal TOCTOU) — React then unwraps
 * the row natively and commits whatever the wire carried, with no
 * substitution pass ever running over it. A bare marker committed
 * that way REVEALS the boundary with visually-empty content, and
 * React's transition semantics ("never hide already-revealed
 * content") keep it empty forever after. With the gate in the wire
 * form, every path to React — native or substituted — suspends
 * before the boundary can reveal empty. Pinned by
 * `__tests__/stream-defer-suspender.test.tsx`.
 */

import type { ReactNode } from "react"
import { cacheLookup, getCurrentPagePartials, slotFillPromise } from "./partial-client-state.ts"

export function PendingSlot({
  partonId,
  matchKey,
  children,
}: {
  partonId: string
  matchKey: string
  children?: ReactNode
}): ReactNode {
  // Stubs exist only in driver-owned channel bodies, so this never
  // renders during SSR — but a guard beats a crash: with no client
  // cache to consult, pass the children through.
  if (typeof window === "undefined") return children
  if (cacheLookup(getCurrentPagePartials(), partonId, matchKey) === undefined) {
    throw slotFillPromise(partonId)
  }
  return children
}
