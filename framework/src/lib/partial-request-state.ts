/**
 * Per-request state for the Partial render pipeline.
 *
 * `<Partial>` runs its own body on every render and makes all the
 * decisions itself: fingerprint compute, fingerprint-match skip,
 * cache-mode filter, duplicate-id detection. It needs per-request
 * state to do that — the parsed request params, plus an accumulator
 * for "what has this request produced so far" (for duplicate-id
 * detection and visibility into what was rendered).
 *
 * This module provides an `AsyncLocalStorage`-backed store. The outer
 * `<PartialRoot>` parses the request, seeds the store, and runs its
 * children inside it; each `<Partial>` reads from it during render.
 */
import { AsyncLocalStorage } from "node:async_hooks"

export interface PartialRequestState {
  /** Effective ids explicitly requested (a lane render's own target).
   *  Null = no filter, render everything. */
  requestedIds: Set<string> | null
  /** Whether the render is an isolated snapshot reconstruction (a lane
   *  render) vs a whole-tree render (streaming mode). */
  isPartialRefetch: boolean
  /** The client manifest's fingerprints (`id:matchKey:fp` tokens — the
   *  attach statement's `cached`, or an action POST's capped `?cached=`
   *  URL form). Multi-fp per id supported (cold/warm fp drift);
   *  fingerprint-skip decisions consult this map. */
  cachedFingerprints: Map<string, Set<string>>
  /** The manifest's matchKeys per id, derived from the same wire
   *  tokens. Drives hidden Activity sibling emission so navigating
   *  across variants of the same spec (`/pokemon/1` ↔ `/pokemon/2`)
   *  parks the prior variant rather than unmounting it. matchKey is
   *  `stableStringify(matchParams)`, stable across refreshes of the
   *  same route. */
  cachedMatchKeys: Map<string, Set<string>>
  /** The live connection's ACKED mirror layer — fps whose delivering
   *  emission the client COMMITTED (cumulative delivery acks; see
   *  `ConnectionSession.ackedFps`). The fp-skip verdict consults the
   *  OPTIMISTIC layer (`cachedFingerprints`) first — a same-parton
   *  re-lane within one RTT must still skip off the emit-time
   *  promotion — and falls back here on a miss: a client-proven fp the
   *  optimistic per-id cap evicted still skips. Absent on requests
   *  without a connection session. */
  ackedFingerprints?: ReadonlyMap<string, ReadonlySet<string>> | null
  /** Effective ids explicitly targeted this render (a url statement's
   *  `__force` labels resolved to ids, a forced lane). Never skipped —
   *  the refetch contract. */
  explicitIds: Set<string>
  /** Effective ids seen this request — debug-only record of what
   *  rendered. Multiple placements of the same keyless spec are
   *  allowed; this set is a `Set` but the values aren't unique. */
  seenIds: Set<string>
}

const als = new AsyncLocalStorage<PartialRequestState>()

/**
 * Enter the partial-state context for the remainder of the current
 * async execution. Used by `<PartialRoot>`: sets the state before
 * returning its JSX so that when React later renders the tree (via
 * async continuations in the same context), every `<Partial>` body
 * sees the store.
 *
 * `als.run(state, fn)` won't do here — it only scopes ALS for
 * synchronous code inside `fn` plus awaits chained off it. React's
 * rendering of the returned tree happens in the caller's continuation,
 * which is outside `fn`'s scope. `enterWith` sets the store on the
 * current async context itself, which React's render inherits.
 */
export function enterPartialState(state: PartialRequestState): void {
  als.enterWith(state)
}

export function runWithPartialState<T>(state: PartialRequestState, fn: () => T): T {
  return als.run(state, fn)
}

export function getPartialState(): PartialRequestState | undefined {
  return als.getStore()
}

export function requirePartialState(): PartialRequestState {
  const state = als.getStore()
  if (!state) {
    throw new Error(
      "<Partial> must be rendered inside <PartialRoot>. " +
        "The enclosing PartialRoot sets up the request-scoped state the Partial needs.",
    )
  }
  return state
}
