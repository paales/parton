/**
 * Broadcast lanes — render once, fan the encoded Flight body to every
 * viewer of the same world (delivery-plane D2, the multiplayer read
 * side).
 *
 * N held connections subscribed to one route each receive a bump's
 * delivery through the inverted wake index; without this module every
 * one of them re-renders the same parton body — N×M renders per wake
 * round for N viewers and M bumped partons, identical bytes N times
 * over. The broadcast slot collapses the render: the FIRST drainer of
 * an eligible lane renders + encodes once and publishes the body
 * bytes; every other drainer within the same generation consumes the
 * bytes and only pays framing.
 *
 * What is shared is ONLY the render+encode. Everything per-connection
 * stays per-connection: delivery seqs, mux framing, fp-trailer
 * bookkeeping, the mirror promotes, and — crucially — the fp-SKIP
 * decision (a connection whose mirror says the client already holds
 * the fp falls back to the normal render, whose own verdict ships the
 * skip placeholder; the driver evaluates that BEFORE consulting the
 * slot — see `segmented-response.ts`).
 *
 * ── Eligibility is the dep record ──
 * A snapshot is broadcast-eligible iff its recorded reads contain no
 * per-viewer axis. The read set is the proof — no declarations, no
 * heuristics — and the classification is CONSERVATIVE: any dep that
 * cannot be positively classified as viewer-independent makes the lane
 * ineligible (each viewer renders its own — over-render, never wrong
 * bytes). Per dep kind:
 *
 *   - `search:` / `pathname:` / `match:` — viewer-independent GIVEN
 *     equal request URLs, which the slot key binds (it carries the
 *     connection's effective URL), so two viewers on different URLs
 *     can never share a slot.
 *   - `tag:` — the process-global invalidation registry; safe.
 *   - `cell:` — safe only when the cell's storage is the process-global
 *     persistent singleton AND its partition cannot derive from request
 *     scope (`_cellBroadcastSafe` in cell.ts). Ephemeral storage is
 *     request/connection-scoped state; a request-derived partition can
 *     bake a session/cookie identity into the partition WITHOUT a
 *     tracked read.
 *   - `cookie:` / `session:` / `header:` / `visible:` — per-viewer by
 *     definition (`visible:` reads the connection session's viewport
 *     set, so every cullable parton — the world's chunks — is
 *     ineligible; their per-connection park/flip machinery is exactly
 *     the per-viewer axis).
 *   - unknown/custom kinds (`cms:`, app-registered) — unclassifiable,
 *     ineligible.
 *
 * Beyond deps: framed snapshots (session-scoped frame URL), remote
 * snapshots (`source`), and `fpSkip: false` specs (always-authoritative
 * surfaces) are ineligible. A lane renders the carrier's whole SUBTREE,
 * so eligibility ANDs over the carrier and every route descendant.
 *
 * The flag derives where deps live — memoized per snapshot OBJECT (a
 * re-render registers a fresh object, so a changed dep record
 * recomputes automatically; the same WeakMap shape as
 * `segment-relevance.ts`' surface-query memo).
 *
 * ── The generation is the recomputed fp ──
 * A slot is keyed by the fp-recompute the trailer machinery already
 * defines (`_recomputeSubtreeWarmFp` in fp-trailer.ts): the fold of the
 * snapshot's dep evaluation, invalidation timestamps, props, and
 * descendant contributions at the CURRENT moment. Equal generations ⇒
 * a render now would produce the same bytes — the exact soundness
 * argument fp-skip stands on. A newer bump moves the folded ts, the
 * generations diverge, and the consumer misses (renders fresh): a
 * newer bump can never be served an older slot. Time rides separately:
 * a slot is invalid past its body's declared `expires()` boundary, and
 * a TTL bounds slot lifetime regardless.
 *
 * ── Lifecycle ──
 * Slots hold encoded bytes only, never React state, so eviction is
 * always safe (a consumer that misses re-renders — over-fetch, never
 * stale). They live under a per-(scope, effective URL) route entry
 * refcounted by the live connections subscribed there (the driver
 * acquires at drive start, moves at a navigation consume, releases at
 * close — the same lifetime as the connection's wake-index
 * registration); the last subscriber's exit drops the route's slots
 * wholesale.
 */

import { parseSelector } from "../runtime/invalidation-registry.ts"
import { _cellBroadcastSafe } from "./cell.ts"
import type { FpUpdatesPayload } from "./fp-trailer-marker.ts"
import type { PartialSnapshot } from "./partial-registry.ts"
import { getSpecById } from "./spec-catalog.ts"

// ─── Eligibility ──────────────────────────────────────────────────────

/** Per-snapshot-object memo of the self classification. A re-render
 *  registers a FRESH snapshot object, so a changed dep record is
 *  reclassified automatically — "recompute when deps change" for free. */
const selfEligibility = new WeakMap<PartialSnapshot, boolean>()

function snapshotSelfEligible(snap: PartialSnapshot): boolean {
  let eligible = selfEligibility.get(snap)
  if (eligible === undefined) {
    eligible = classifySnapshot(snap)
    selfEligibility.set(snap, eligible)
  }
  return eligible
}

function classifySnapshot(snap: PartialSnapshot): boolean {
  // Framed specs route + key on the frame's URL — session-scoped state.
  if (snap.framePath.length > 0) return false
  // Remote-sourced snapshots re-render through a fresh <RemoteFrame>
  // fetch; keep that per-connection.
  if (snap.source !== undefined) return false
  // `fpSkip: false` declares an always-authoritative surface — the
  // author wants every connection's render to run.
  if (getSpecById(snap.type)?.fpSkip === false) return false
  if (snap.deps) {
    for (const key of snap.deps) {
      if (!depIsViewerIndependent(key)) return false
    }
  }
  return true
}

function depIsViewerIndependent(key: string): boolean {
  const colon = key.indexOf(":")
  if (colon <= 0) return false
  const kind = key.slice(0, colon)
  switch (kind) {
    // URL dimensions — the slot key binds the connection's effective
    // URL, so equal keys imply equal values for these reads.
    case "search":
    case "pathname":
    case "match":
      return true
    // Process-global invalidation timeline; the generation folds it.
    case "tag":
      return true
    case "cell": {
      // The dep is the partition-scoped selector `cell:<id>?<args>`;
      // parseSelector yields name `cell:<id>` — strip the kind for the
      // registry lookup.
      const name = parseSelector(key).name
      return _cellBroadcastSafe(name.slice(colon + 1))
    }
    // cookie / session / header / visible and any custom kind: per-
    // viewer or unclassifiable — conservative.
    default:
      return false
  }
}

/**
 * Whether `id`'s lane may broadcast: the carrier snapshot AND every
 * route descendant (the lane renders the whole subtree) classify as
 * viewer-independent. `snapshots`/`descendants` are the route bucket's
 * canonical map + parent→children index — the same reads the drain
 * already does.
 */
export function _broadcastEligible(
  id: string,
  snapshots: ReadonlyMap<string, PartialSnapshot>,
  descendants: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const self = snapshots.get(id)
  if (!self || !self.emittedFp) return false
  if (!snapshotSelfEligible(self)) return false
  const subtree = descendants.get(id)
  if (subtree) {
    for (const did of subtree) {
      const snap = snapshots.get(did)
      if (snap && !snapshotSelfEligible(snap)) return false
    }
  }
  return true
}

// ─── The slot store ───────────────────────────────────────────────────

/**
 * Slot TTL — one drain window. Correctness never rides on it (the
 * generation check catches every tracked change and the `expires()`
 * gate owns time), so the bound is memory hygiene: a wake round fans
 * one body across every subscriber within milliseconds; a slot still
 * resident a full second later is serving nobody and only holds bytes.
 */
const SLOT_TTL_MS = 1_000

/** The published outcome of one shared render. Bytes + the trailer
 *  heals the flush emitted — everything a consumer needs to frame the
 *  body on its own wire and run its own mirror bookkeeping. */
export interface BroadcastResult {
  ok: boolean
  /** The wrapped lane body (Flight payload + its own fp trailer), in
   *  producer chunk order. */
  chunks: readonly Uint8Array[]
  /** The flush's `{from, to}` warm heals — folded into each consumer's
   *  mirror exactly as its own render's `onUpdates` would be. */
  heals: FpUpdatesPayload
  /** The committed fresh snapshot (canonical-pointer validity check). */
  resultSnap: PartialSnapshot | null
  /** The publish-time generation — consumers recompute under their own
   *  request and consume only on equality. */
  gen: string | null
  /** Wall-clock validity bound: min(declared `expires()` boundary,
   *  publish + TTL). */
  expiresAt: number
}

interface BroadcastSlot {
  /** The pre-render snapshot + generation the publisher claimed under —
   *  what an in-flight joiner must match. */
  claimSnap: PartialSnapshot
  claimGen: string
  settled: BroadcastResult | null
  result: Promise<BroadcastResult>
  resolve: (r: BroadcastResult) => void
}

interface RouteSlots {
  count: number
  slots: Map<string, BroadcastSlot>
  /** Ids whose shared render marked itself a producer
   *  (`markConnectionLive()`) — producer bodies stream until an
   *  unbounded await resolves, so they can never buffer into a slot.
   *  Remembered so the wasted probe render happens once per route. */
  producers: Set<string>
}

const routes = new Map<string, RouteSlots>()

/** A connection's refcount handle on a route's slot space. */
export interface BroadcastRouteHandle {
  key: string
  /** Re-point the handle at a new route key (a navigation consume):
   *  releases the old key, acquires the new. */
  move(key: string): void
  release(): void
}

export function _acquireBroadcastRoute(key: string): BroadcastRouteHandle {
  acquire(key)
  const handle: BroadcastRouteHandle = {
    key,
    move(next: string) {
      if (next === handle.key) return
      release(handle.key)
      acquire(next)
      handle.key = next
    },
    release() {
      release(handle.key)
    },
  }
  return handle
}

function acquire(key: string): void {
  let route = routes.get(key)
  if (!route) {
    route = { count: 0, slots: new Map(), producers: new Set() }
    routes.set(key, route)
  }
  route.count++
}

function release(key: string): void {
  const route = routes.get(key)
  if (!route) return
  route.count--
  // Last subscriber out: the slots serve nobody — drop them wholesale
  // (encoded bytes only, so dropping is always safe).
  if (route.count <= 0) routes.delete(key)
}

export function _broadcastMarkProducer(key: string, id: string): void {
  routes.get(key)?.producers.add(id)
}

/**
 * Whether the route has anyone to SHARE with — at least two
 * subscribers. A single-viewer route takes the ordinary per-connection
 * render path untouched (byte-identical wire, per-connection descendant
 * fp-skips inside the body, no buffering): broadcast only ever engages
 * where a second viewer exists to save a render for.
 */
export function _broadcastRouteShared(key: string): boolean {
  return (routes.get(key)?.count ?? 0) >= 2
}

/** What `_claimBroadcastSlot` hands the caller. `null` = no slot path
 *  for this lane (no acquired route, a remembered producer, or an
 *  in-flight publish under a DIFFERENT generation) — render your own. */
export type BroadcastClaim =
  | {
      role: "publish"
      /** Publish the finished result (ok or failed) — settles every
       *  joiner's await. */
      publish: (r: BroadcastResult) => void
      /** Abandon the claim (torn/producer/error): settles joiners with
       *  a failed result and removes the slot so the next drainer
       *  re-claims. */
      abandon: () => void
    }
  | { role: "consume"; result: Promise<BroadcastResult> }

const FAILED: BroadcastResult = {
  ok: false,
  chunks: [],
  heals: {},
  resultSnap: null,
  gen: null,
  expiresAt: 0,
}

/**
 * Consult the slot for `(routeKey, id)` at generation `gen` (the
 * caller's pre-render recompute over `snap`, the current canonical
 * snapshot). Synchronous — the first drainer claims (no await sits
 * between a miss and the claim, so exactly one publisher exists per
 * generation); later drainers within the generation consume, awaiting
 * an in-flight publish rather than rendering their own copy.
 */
export function _claimBroadcastSlot(
  routeKey: string,
  id: string,
  snap: PartialSnapshot,
  gen: string,
  now: number,
): BroadcastClaim | null {
  const route = routes.get(routeKey)
  // `count < 2`: nobody to share with — see `_broadcastRouteShared`.
  if (!route || route.count < 2) return null
  if (route.producers.has(id)) return null
  const existing = route.slots.get(id)
  if (existing) {
    if (existing.settled === null) {
      // In-flight publish. Join only when it is rendering THIS
      // generation from THIS snapshot; a different in-flight
      // generation is already stale for us — render our own rather
      // than wait on bytes we would have to discard.
      if (existing.claimGen === gen && existing.claimSnap === snap) {
        return { role: "consume", result: existing.result }
      }
      return null
    }
    const r = existing.settled
    if (r.ok && r.gen === gen && now < r.expiresAt) {
      return { role: "consume", result: existing.result }
    }
    // Expired / failed / superseded — fall through to a fresh claim.
  }
  let resolve!: (r: BroadcastResult) => void
  const result = new Promise<BroadcastResult>((res) => {
    resolve = res
  })
  const slot: BroadcastSlot = { claimSnap: snap, claimGen: gen, settled: null, result, resolve }
  route.slots.set(id, slot)
  return {
    role: "publish",
    publish: (r: BroadcastResult) => {
      slot.settled = r
      slot.resolve(r)
    },
    abandon: () => {
      slot.settled = FAILED
      slot.resolve(FAILED)
      if (route.slots.get(id) === slot) route.slots.delete(id)
    },
  }
}

/** The slot TTL a publisher folds into its result's `expiresAt`. */
export function _broadcastSlotTtlMs(): number {
  return SLOT_TTL_MS
}

/** Test/debug: store shape. */
export function _broadcastStats(): { routes: number; slots: number; subscribers: number } {
  let slots = 0
  let subscribers = 0
  for (const route of routes.values()) {
    slots += route.slots.size
    subscribers += route.count
  }
  return { routes: routes.size, slots, subscribers }
}

/** Test-only: wipe every route entry and slot. */
export function _clearBroadcastSlots(): void {
  routes.clear()
}
