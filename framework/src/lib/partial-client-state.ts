/**
 * Module-level client state for the partial merge layer.
 *
 * Every mutable map the client partial machinery relies on lives here,
 * behind accessor functions — one owner module, so the state's
 * lifecycle (what survives which kind of commit, what gets pruned
 * when) is auditable in one place. The state lives outside the React
 * tree so it survives the two-phase void→payload remount in the
 * browser bootstrap (`../entry/browser.tsx`). Without this, each
 * refetch would wipe the cache and force every partial to re-render.
 *
 * Consumers:
 *   - `partial-cache.ts` — the tree walks that fill the cache and
 *     fingerprint maps.
 *   - `partial-template.tsx` — the structural template render.
 *   - `partial-client.tsx` — the merge coordinator (`PartialsClient`).
 *   - `refetch.ts` / `frame-client.tsx` — the in-flight registry and
 *     frame-URL cache.
 */

import type { ReactNode } from "react"
import type { FpUpdatesPayload } from "./fp-trailer-marker.ts"

// ─── Partial cache + fingerprints ─────────────────────────────────

/**
 * Client cache of rendered partial subtrees, scoped to the CURRENT
 * page only. Pruned on every streaming-mode render against the
 * harvested `seen` set, so entries for partials that aren't on the
 * new page are dropped immediately. Survives the two-phase
 * void→payload remount in `../entry/browser.tsx` so cache-mode refetches
 * don't wipe everything between commits — but doesn't accumulate
 * across navigations. Steady-state size is bounded by the largest
 * single page the user visits, not by browsing history.
 *
 * Two-level keying:
 *   - Outer key: partial `id` (e.g. `"pokemon-page"`).
 *   - Inner key: `matchKey` (16-char hex hash of `stableStringify(
 *     matchParams)`) — identifies the rendered variant.
 *
 * Why nested: navigating `/pokemon/1` ↔ `/pokemon/2` produces two
 * different matchKeys for the same id. Both variants coexist in the
 * cache (rendered as hidden `<Activity>` siblings by the server when
 * the client advertises them via `?cached=`), so the prior variant's
 * fiber survives the round-trip. Specs without `match` resolve to a
 * constant matchKey — the inner map always has size 1.
 *
 * Eviction is purely per-page prune today: any (id, matchKey) not in
 * the new render's `seen` set is dropped on the next streaming-mode
 * commit. There is no time-based TTL or LRU; the steady-state bound
 * is the cartesian product of (live id) × (cached variants per id).
 * For a future LRU layer over the variant pool, see
 * `docs/notes/IDEAS.md` (Keepalive follow-ups).
 */
export type PartialCache = Map<string, Map<string, ReactNode>>

const _currentPagePartials: PartialCache = new Map()
const _currentPageFingerprints = new Map<string, Map<string, Set<string>>>()

// ─── Commit-order bookkeeping ─────────────────────────────────────
//
// The client commits deliveries in wire order, but a commit's WRITES
// can trail its walk: a payload holding still-pending Flight chunks is
// re-walked when the rows land (`scheduleLaneRewalk`, PartialsClient's
// incomplete-walk re-render), and by then a NEWER commit — a covering
// navigation segment, a fresher lane — may have replaced the slot. A
// late re-walk is an out-of-order write; letting it land would swap
// superseded content over the page (the client-side sibling of the
// server's as-of drop discipline). Every commit batch therefore runs
// under a monotonic store seq, recorded per slot; `cacheStore` drops a
// store whose seq is older than the slot's current occupant.

let _storeSeqCounter = 0
let _activeStoreSeq: number | null = null
const _slotStoreSeq = new Map<string, Map<string, number>>()

/** Mint the store seq for a new commit batch (one payload's walk and
 *  every settlement re-walk of that same payload). */
export function _nextStoreSeq(): number {
  return ++_storeSeqCounter
}

/** Run a (synchronous) commit walk under its batch's store seq. */
export function _runWithStoreSeq<T>(seq: number, fn: () => T): T {
  const prev = _activeStoreSeq
  _activeStoreSeq = seq
  try {
    return fn()
  } finally {
    _activeStoreSeq = prev
  }
}

function _recordSlotSeq(id: string, matchKey: string, seq: number): void {
  let inner = _slotStoreSeq.get(id)
  if (!inner) {
    inner = new Map()
    _slotStoreSeq.set(id, inner)
  }
  inner.set(matchKey, seq)
}

/** The store seq of a slot's current occupant — the ownership signal
 *  for the torn-delivery fp drop (a payload only un-advertises
 *  variants IT still owns). */
export function _slotStoreSeqOf(id: string, matchKey: string): number | undefined {
  return _slotStoreSeq.get(id)?.get(matchKey)
}

/** The one live `PartialCache` instance backing the current page. */
export function getCurrentPagePartials(): PartialCache {
  return _currentPagePartials
}

export function cacheLookup(
  cache: PartialCache,
  id: string,
  matchKey: string,
): ReactNode | undefined {
  return cache.get(id)?.get(matchKey)
}

/** One `cacheStore` call's outcome. `"first"` is a FIRST FILL (the
 *  commit walk's paint-blocking signal, see `LazyWalkStats.firstFill`);
 *  `"identical"` is a re-walk's re-store of the same node (kept);
 *  `"stale"` means the store was DROPPED by the out-of-order guard —
 *  the caller must not register fingerprints for it (the slot holds a
 *  newer commit's content the fp does not describe). */
export type CacheStoreOutcome = "first" | "replaced" | "identical" | "stale"

/** Store a wrapper into its `(id, matchKey)` slot. */
export function cacheStore(
  cache: PartialCache,
  id: string,
  matchKey: string,
  node: ReactNode,
): CacheStoreOutcome {
  let inner = cache.get(id)
  if (!inner) {
    inner = new Map()
    cache.set(id, inner)
  }
  const replacing = inner.has(matchKey)
  // A re-store of the IDENTICAL node is a re-walk of the same payload
  // (a settlement re-walk over rows that were pending on the first
  // pass), not new content — the slot's fingerprints still describe
  // exactly what it holds, including a cold→warm trailer alias that
  // may have landed between the walks. Only a store that CHANGES the
  // slot's content invalidates its fp-set.
  if (replacing && inner.get(matchKey) === node) return "identical"
  // Out-of-order guard: a store carrying an OLDER batch seq than the
  // slot's occupant is a late re-walk of a superseded payload (fuzz
  // class F9) — its delivery was covered by whatever wrote the slot
  // since, so it must not land. A store outside any batch is its own
  // (newest) batch.
  const seq = _activeStoreSeq ?? ++_storeSeqCounter
  if (replacing) {
    const slotSeq = _slotStoreSeq.get(id)?.get(matchKey)
    if (slotSeq !== undefined && slotSeq > seq) return "stale"
  }
  inner.set(matchKey, node)
  _recordSlotSeq(id, matchKey, seq)
  // Overwriting a cache slot invalidates any fingerprint that
  // referred to the old content. Without this, fps from prior
  // navs accumulate in `_currentPageFingerprints[id][matchKey]`
  // and travel back to the server in `?cached=`; the next visit
  // can fp-skip against a stale entry while the cache slot points
  // at fresh content, and `substituteNested` lands the wrong
  // subtree (or the right one for the wrong URL). Same matchKey
  // with different request-read values share a slot by design — the
  // fingerprint set must shrink to "what the current slot
  // actually represents", which is exactly the fp that
  // `registerClientPartial` is about to write after this call.
  if (replacing) {
    _currentPageFingerprints.get(id)?.delete(matchKey)
    // A replacing store is a new content generation for the id — any
    // cold→warm alias still waiting for its anchor and minted BEFORE
    // this store's batch described an OLD generation's bytes and dies
    // with the fp-set it would have joined. Aliases minted during this
    // batch (the store's own response's trailer, applied between the
    // walks) survive for the late registration that consumes them.
    const pendingAliases = _pendingFpAliases.get(id)
    if (pendingAliases) {
      for (const [from, entry] of pendingAliases) {
        if (entry.seq < seq) pendingAliases.delete(from)
      }
      if (pendingAliases.size === 0) _pendingFpAliases.delete(id)
    }
  }
  return replacing ? "replaced" : "first"
}

/**
 * Cold→warm aliases whose anchor has not registered yet, per id
 * (`from` → `to`). An fp-updates trailer can land while its response's
 * rows are still pending decode — the wrapper behind the pending chunk
 * registers its cold fp only at the settlement re-walk, AFTER the
 * trailer's `_applyFpUpdates` ran, so an anchor-at-apply-time-only
 * discipline silently drops the warm alias and the next presentation
 * re-renders the parton at full price (fuzz class F10 — the
 * registration-after-trailer gap). An unmatched alias pends here and
 * is consumed by the registration of its exact `from`; a REPLACING
 * content store clears the id's pending aliases (a new render owns the
 * slot — stale aliases die with the fp-set, same lifecycle).
 */
const _pendingFpAliases = new Map<string, Map<string, { to: string; seq: number }>>()

/**
 * Register a partial's fingerprint from the client side.
 *
 * Called by `<PartialErrorBoundary>` during its render, which is how
 * each `<Partial>`'s fingerprint gets into `_currentPageFingerprints`
 * without a server prop round-trip. Later `getCachedPartialIds()` reads
 * from here to tell the server what's already cached.
 *
 * Fingerprints are scoped to (id, matchKey) — cold/warm fp drift
 * accumulates within a single variant; cross-variant navigation
 * (`/pokemon/1` ↔ `/pokemon/2`) populates distinct matchKey slots.
 */
/** Soft cap on fps tracked per (id, matchKey). The cold→warm
 *  transition emits two fps per render cycle (one at boundary
 *  mount, one from the trailer post-resolution); live partials
 *  emit a fresh pair per segment. Keeping the LATEST few is
 *  enough for the cold/warm fp-skip on the next nav; older fps
 *  for the same variant are stale and only bloat `?cached=`. */
export const FP_CAP_PER_VARIANT = 4

/** Cap on `?cached=` manifest ENTRIES advertised to the server —
 *  the URL form only. The client's local fp cache is unbounded within
 *  a page (pruned to the live tree), but the URL manifest travels in
 *  the request line — a page with hundreds of partons (the website's
 *  chunk world) would otherwise blow the server's request-line limit
 *  (HTTP 431). Only the most recently REGISTERED variants are
 *  advertised; anything older re-renders server-side on its next
 *  appearance (over-fetch, never stale) and re-enters the manifest by
 *  registering again. The attach BODY manifest
 *  (`getAllCachedPartialTokens`) has no request line to protect and
 *  carries everything. */
export const CACHED_MANIFEST_CAP = 96

/** Cap on distinct ids retained in the client maps. A long journey
 *  across a cullable field accumulates entries for every parton ever
 *  visited; past the cap the LEAST-RECENTLY-SIGHTED ids are destroyed
 *  (cache + fps) — they re-render cold on a return visit. Bounds
 *  memory the same way the manifest cap bounds the URL.
 *
 *  Ids the LIVE TREE still references are exempt (see `_liveTreeIds`):
 *  the template re-substitutes their placeholders from the cache on
 *  every re-render, so destroying one blanks that subtree permanently —
 *  nothing refetches it (the fp-skip placeholder is the server saying
 *  "you have this"). The page shell is the canonical victim: its
 *  element identity is stable, so React bails out of re-rendering its
 *  boundary and it never re-registers for recency — under heavy
 *  registration churn (a scroll across a cullable field) it becomes
 *  the oldest entry while still being the subtree everything hangs
 *  off. A page whose live tree alone exceeds the cap keeps every live
 *  entry — correctness bounds memory there, the cap bounds the rest.
 *  The HEAVY budget — parked subtree DOM and fibers — is
 *  `CULL_PARK_CAP` in `cull-park.ts`, whose content eviction is what
 *  makes a parked id leave the live tree and become evictable here. */
export const CLIENT_POOL_CAP = 512

/**
 * Listener for ids leaving the client maps entirely — fired by
 * `pruneToLive` and the pool-cap eviction. This is THE page-membership
 * signal: an id is on the page for exactly as long as some commit
 * still references it (rendered, fp-skipped, or parked); when the
 * maps drop it, dependent client state must go too. The cull-park
 * module registers here to tear down its per-id state — observer
 * lifecycles can't stand in for this signal, because an Activity flip
 * can unmount one slot's observer in a different pass than it mounts
 * the other's.
 */
let _onIdPruned: ((id: string) => void) | null = null

export function _setIdPrunedListener(fn: (id: string) => void): void {
  _onIdPruned = fn
}

/** Ids the currently-displayed tree may need to re-substitute — the
 *  pool-cap eviction's exemption set. Rebuilt by each payload commit's
 *  prune (`pruneToLive` — the template's placeholder references), and
 *  extended by every LANE commit between payload commits
 *  (`_addLiveTreeIds`): a lane-delivered subtree is part of the
 *  displayed tree from the moment its commit's transition re-renders
 *  the template, so destroying it would blank a region the server has
 *  every reason to believe the client holds. A page whose live tree
 *  alone exceeds the cap keeps every live entry — correctness bounds
 *  memory there, the cap bounds the rest. */
let _liveTreeIds: Set<string> = new Set()

/** Fold lane-committed ids into the eviction exemption. Called by the
 *  lane commit walks (`_commitPartonLane` / the progressive variant)
 *  with every (id) the walk cached or sighted as a placeholder — both
 *  are referenced by the tree the commit's re-render displays. */
export function _addLiveTreeIds(ids: Iterable<string>): void {
  for (const id of ids) _liveTreeIds.add(id)
}

/**
 * Listener for committed content destroyed client-side — the loss
 * report's producer seam. The pool-cap eviction, the cull-park LRU
 * eviction (`evictCulledContent`), and the page prune all destroy
 * cache + fingerprint entries the server may still credit (optimistic
 * override, acked mirror layer); each destruction site reports the id
 * here, and the channel transport rides the ids upstream on the next
 * ack's `evicted` statement so the server revokes the credit. Explicit
 * per the no-heuristics rule: the destroying code path writes the
 * report; nothing infers loss.
 */
let _onContentLoss: ((id: string) => void) | null = null

export function _setContentLossListener(fn: (id: string) => void): void {
  _onContentLoss = fn
}

function evictOldest(): void {
  if (_currentPageFingerprints.size <= CLIENT_POOL_CAP) return
  for (const id of [..._currentPageFingerprints.keys()]) {
    if (_liveTreeIds.has(id)) continue
    _currentPageFingerprints.delete(id)
    _currentPagePartials.delete(id)
    _slotStoreSeq.delete(id)
    _pendingFpAliases.delete(id)
    _onContentLoss?.(id)
    _onIdPruned?.(id)
    if (_currentPageFingerprints.size <= CLIENT_POOL_CAP) return
  }
}

/**
 * Refresh an id's recency in the fingerprint map without changing its
 * entries. The payload walk calls this for every wrapper and
 * placeholder it sights, so map order means "recency of appearing in
 * a commit" — the server still emits the id — rather than "recency of
 * a fresh registration". Structural ancestors (a page shell that
 * fp-skips forever, appearing only as placeholders) stay at the tail;
 * the `CLIENT_POOL_CAP` FIFO then ages out exactly the ids commits
 * stopped mentioning — content parked deep inside another id's cached
 * subtree. No-op for unknown ids.
 */
export function touchClientPartial(id: string): void {
  const inner = _currentPageFingerprints.get(id)
  if (!inner) return
  _currentPageFingerprints.delete(id)
  _currentPageFingerprints.set(id, inner)
}

export function registerClientPartial(id: string, matchKey: string, fingerprint: string): void {
  // Advertise-honesty gate: an fp registers only while the
  // (id, matchKey) CONTENT slot holds the subtree it describes — the
  // invariant is "never advertise an fp for bytes you cannot restore".
  // Every holdings surface reads the fingerprint map (`?cached=`, the
  // attach body manifest, a culling flip's `cachedTokensFor`), and an
  // fp stated without content makes the server's honest fp-skip
  // verdict a GHOST CONFIRM: a zero-byte placeholder the substitution
  // cannot fill, with no delta left anywhere to heal it (the
  // scroll-stress parked-eviction deadlock). The commit walks store
  // content BEFORE registering, so every content-backed registration
  // passes; what this gates is `PartialErrorBoundary`'s render-time
  // fallback registration re-firing from a still-mounted fiber (parked
  // inline inside an ancestor's cached wrapper) AFTER an eviction
  // destroyed the id's slots — it would resurrect the advertised fp
  // with nothing restorable behind it. Fresh content (`cacheStore`)
  // re-opens registration; until then the id honestly advertises
  // nothing and its next appearance renders server-side.
  if (!_currentPagePartials.get(id)?.has(matchKey)) return
  let inner = _currentPageFingerprints.get(id)
  if (!inner) {
    inner = new Map()
    _currentPageFingerprints.set(id, inner)
  } else {
    // Re-insert at the tail so map order tracks registration
    // recency — `getCachedPartialIds` walks newest-first when
    // capping the manifest.
    _currentPageFingerprints.delete(id)
    _currentPageFingerprints.set(id, inner)
  }
  let set = inner.get(matchKey)
  if (!set) {
    set = new Set()
    inner.set(matchKey, set)
  }
  if (!set.has(fingerprint)) {
    set.add(fingerprint)
    evictOldest()
    // Evict the oldest entries (insertion order) once the cap is
    // reached. Without this, a live partial that re-renders every
    // segment would inflate `?cached=` unboundedly.
    while (set.size > FP_CAP_PER_VARIANT) {
      const oldest = set.values().next().value
      if (oldest === undefined) break
      set.delete(oldest)
    }
  }
  // A pending cold→warm alias anchored on this fp (its trailer landed
  // before this registration — see `_pendingFpAliases`): consume it so
  // the variant advertises the warm fp too.
  const pending = _pendingFpAliases.get(id)
  const alias = pending?.get(fingerprint)
  if (alias !== undefined) {
    pending!.delete(fingerprint)
    registerClientPartial(id, matchKey, alias.to)
  }
}

/**
 * Apply an fp-updates trailer (parsed JSON from the wire) to the
 * client's fingerprint map. Each entry is a `{from, to}` cold→warm
 * pair (see {@link FpUpdate}); `to` is aliased onto whichever
 * `(id, matchKey)` slot still holds `from`.
 *
 * See `lib/fp-trailer.ts` for the server-side emission, and
 * `lib/fp-trailer-marker.ts` for the wire sentinel + payload shape.
 */
export function _applyFpUpdates(updates: FpUpdatesPayload): void {
  for (const [id, { from, to }] of Object.entries(updates)) {
    const inner = _currentPageFingerprints.get(id)
    // Alias the warm fp `to` onto the variant slot whose set still
    // holds the cold fp `from` — matched by CONTENT. The trailer is
    // async: it lands after its response's body committed, by which
    // point a concurrent refetch for a DIFFERENT query against the same
    // stable `(id, matchKey)` may have overwritten the slot — and
    // cleared its fp-set (see `cacheStore`). Anchoring on `from` means
    // such a superseded trailer finds no slot NOW — it pends (below)
    // for the one registration that can legitimately consume it (its
    // own render's `from`, still decoding) and dies with the next
    // replacing store otherwise, so the advertised fp-set stays in
    // lockstep with the node the slot actually holds — the invariant
    // that makes every server fp-skip restore the content the server
    // matched it against. `from` folds in matchKey, so it pins exactly
    // one slot. registerClientPartial enforces the per-variant fp cap.
    let anchored = false
    if (inner) {
      for (const [mk, set] of inner) {
        if (set.has(from)) {
          registerClientPartial(id, mk, to)
          anchored = true
          break
        }
      }
    }
    if (!anchored) {
      // The anchor variant hasn't registered `from` yet (its rows are
      // still pending decode) — pend for the registration to consume.
      // The mint seq (the newest commit batch started so far) scopes
      // the entry's lifetime: a replacing store from a NEWER batch
      // clears it (its generation is over), while the response's own
      // batch — already started when its trailer applies — keeps it.
      let p = _pendingFpAliases.get(id)
      if (!p) {
        p = new Map()
        _pendingFpAliases.set(id, p)
      }
      p.set(from, { to, seq: _storeSeqCounter })
    }
  }
}

/**
 * Ids whose manifest tokens are advertised FIRST, ahead of the
 * newest-registration walk — the cull-park module registers its
 * parked-by-culling LRU here (see `cull-park.ts`). A parked id's
 * client state survives only as long as the server can CONFIRM its
 * fingerprints; on a busy live page the manifest's recency window
 * churns with every lane registration, and without priority a parked
 * subtree silently loses its `?cached=` slots — its next cull-in then
 * re-renders and drops the parked copy. Bounded by the parked pool's
 * own cap, so the priority block can never starve the recency walk
 * entirely.
 */
let _manifestPriorityIds: (() => readonly string[]) | null = null

export function _setManifestPriorityIds(fn: () => readonly string[]): void {
  _manifestPriorityIds = fn
}

/**
 * Module-level accessor for cached partial tokens.
 * Returns "id:matchKey:fingerprint" triples so the server can:
 *   - decide fp-skip per (id, fingerprint), unchanged from before;
 *   - emit hidden `<Activity>` siblings for cached matchKeys other
 *     than the current variant, so cross-variant navigation parks
 *     the prior variant rather than dropping its fiber.
 *
 * Used by the browser entry to build `?cached=` during navigation.
 *
 * Source of truth is `_currentPageFingerprints`, not
 * `_currentPagePartials`. Every rendered Partial — top-level OR deep
 * (`.map()`-generated, nested inside an ancestor's subtree) —
 * registers its (matchKey, fingerprint) client-side as the commit walk
 * caches its wrapper (with `PartialErrorBoundary`'s render as the
 * fallback vehicle). Reporting from `_currentPageFingerprints` means
 * the skip-on-unchanged optimization applies uniformly across the
 * entire tree — and the advertise-honesty gate keeps the map a subset
 * of the content slots, so every token stated here is restorable.
 */
export function getCachedPartialIds(): string[] {
  const out: string[] = []
  const emitted = new Set<string>()
  const emitId = (id: string): boolean => {
    const byMatchKey = _currentPageFingerprints.get(id)
    if (!byMatchKey) return true
    for (const [matchKey, fps] of byMatchKey) {
      for (const fp of fps) {
        out.push(`${id}:${matchKey}:${fp}`)
        if (out.length >= CACHED_MANIFEST_CAP) return false
      }
    }
    return true
  }
  // Priority block first: parked-by-culling ids (see
  // `_setManifestPriorityIds`) must keep advertising their variants
  // or their parked state is unrestorable.
  for (const id of _manifestPriorityIds?.() ?? []) {
    if (emitted.has(id)) continue
    emitted.add(id)
    if (!emitId(id)) return out
  }
  // Insertion order tracks registration recency (re-registration
  // re-inserts) — walk newest-first and stop at the manifest cap.
  const ids = [..._currentPageFingerprints.keys()].reverse()
  for (const id of ids) {
    if (emitted.has(id)) continue
    emitted.add(id)
    if (!emitId(id)) return out
  }
  return out
}

/**
 * The FULL client manifest — every advertised `id:matchKey:fp` token,
 * uncapped: the attach statement's `cached` (see `channel-protocol.ts`).
 * The attach travels as a POST body, so the request-line limit behind
 * `CACHED_MANIFEST_CAP` doesn't apply, and the priority walk is moot —
 * nothing is left out. The size is structurally bounded by the client
 * pool itself: at most `CLIENT_POOL_CAP` ids, each variant capped at
 * `FP_CAP_PER_VARIANT` fps (variants per id are pruned to the live
 * tree's references) — the manifest can never exceed what the maps
 * hold.
 */
export function getAllCachedPartialTokens(): string[] {
  const out: string[] = []
  for (const [id, byMatchKey] of _currentPageFingerprints) {
    for (const [matchKey, fps] of byMatchKey) {
      for (const fp of fps) out.push(`${id}:${matchKey}:${fp}`)
    }
  }
  return out
}

/**
 * The client's current cached tokens (`id:matchKey:fp`) for a specific
 * id set — the `visible` frame's holdings declaration (see
 * `channel-protocol.ts`): a culling flip tells the server exactly
 * what it holds for the flipped partons, so the lane's fp-skip verdict
 * can't confirm content the client already dropped.
 */
export function cachedTokensFor(ids: readonly string[]): string[] {
  const out: string[] = []
  for (const id of ids) {
    const byMatchKey = _currentPageFingerprints.get(id)
    if (!byMatchKey) continue
    for (const [matchKey, fps] of byMatchKey) {
      for (const fp of fps) out.push(`${id}:${matchKey}:${fp}`)
    }
  }
  return out
}

/**
 * Evict a variant a TORN delivery still owns — content slot,
 * advertised fingerprints, pending aliases, the loss report. A
 * progressive lane commit whose remaining rows REJECTED (a navigation
 * tore the body mid-stream) holds a subtree with pending-forever holes:
 * its fps describe the FULL body the server rendered (advertising them
 * would let the next presentation CONFIRM torn content — a ghost
 * confirm with no delta left to heal it), and the slot's node SHADOWS
 * good content through `substituteNested` (a later confirm of an
 * ancestor substitutes the torn slot over the ancestor's own fresh
 * inline copy). Evicting both makes the substitution keep whatever
 * inline content the displayed tree carries, the id's next appearance
 * render server-side (over-fetch, never stale), and the loss report
 * revoke the server's mirror credit.
 */
/**
 * Drop a variant's ADVERTISED fingerprints without touching its
 * content slot — the composition half of the torn-delivery discipline:
 * a cached wrapper whose content holds a PLACEHOLDER for an evicted
 * variant can no longer restore the composition its fp describes, so
 * the claim must go (its next presentation renders fresh — with the
 * evicted child inside — the full heal); the content stays for
 * whatever the displayed tree can still use of it.
 */
export function _dropVariantFingerprints(id: string, matchKey: string): void {
  const fps = _currentPageFingerprints.get(id)
  if (!fps?.delete(matchKey)) return
  if (fps.size === 0) _currentPageFingerprints.delete(id)
  _pendingFpAliases.delete(id)
  _onContentLoss?.(id)
}

export function _evictTornVariant(id: string, matchKey: string): void {
  const slots = _currentPagePartials.get(id)
  const held = slots?.delete(matchKey) ?? false
  if (slots !== undefined && slots.size === 0) _currentPagePartials.delete(id)
  const fps = _currentPageFingerprints.get(id)
  const advertised = fps?.delete(matchKey) ?? false
  if (fps !== undefined && fps.size === 0) _currentPageFingerprints.delete(id)
  _slotStoreSeq.get(id)?.delete(matchKey)
  _pendingFpAliases.delete(id)
  if (held || advertised) _onContentLoss?.(id)
}

/**
 * Prune both client maps down to the given live `(id, matchKey)` set.
 * Anything in the maps but not in `live` was superseded — a
 * churned-away instance id, an evicted variant, a partial from a
 * prior route — and the client can no longer restore it, so it must
 * stop being advertised in `?cached=`. Pruning is at (id, matchKey)
 * granularity — a parked variant whose hidden Activity sibling is
 * still referenced stays alive, while a variant no longer referenced
 * anywhere drops.
 */
export function pruneToLive(live: Map<string, Set<string>>): void {
  // Record the live id set for the pool-cap eviction guard: these are
  // the ids the committed template can re-substitute at any re-render,
  // so `evictOldest` must not destroy them. Rebuilt wholesale — lane
  // additions since the prior payload commit are superseded by this
  // commit's own references.
  _liveTreeIds = new Set(live.keys())
  const before = new Set<string>([
    ..._currentPagePartials.keys(),
    ..._currentPageFingerprints.keys(),
  ])
  // Ids whose advertised FINGERPRINTS this prune destroyed (fully or
  // per-variant) — the loss report set: the server may still credit
  // those fps (optimistic override, acked layer), and revoking the
  // credit is what keeps a later render from confirming a ghost.
  const lost = new Set<string>()
  for (const map of [_currentPagePartials, _currentPageFingerprints]) {
    for (const [id, byMatchKey] of map) {
      const liveMks = live.get(id)
      if (!liveMks) {
        map.delete(id)
        if (map === _currentPageFingerprints) lost.add(id)
        continue
      }
      for (const mk of [...byMatchKey.keys()]) {
        if (!liveMks.has(mk)) {
          byMatchKey.delete(mk)
          if (map === _currentPageFingerprints) lost.add(id)
        }
      }
      if (byMatchKey.size === 0) map.delete(id)
    }
  }
  for (const [id, byMk] of _slotStoreSeq) {
    const liveMks = live.get(id)
    if (!liveMks) {
      _slotStoreSeq.delete(id)
      _pendingFpAliases.delete(id)
      continue
    }
    for (const mk of [...byMk.keys()]) {
      if (!liveMks.has(mk)) byMk.delete(mk)
    }
    if (byMk.size === 0) _slotStoreSeq.delete(id)
  }
  if (_onContentLoss) for (const id of lost) _onContentLoss(id)
  // Page-membership teardown: an id that left BOTH maps is off the
  // page — no commit references it rendered, skipped, or parked.
  if (_onIdPruned) {
    for (const id of before) {
      if (!_currentPageFingerprints.has(id) && !_currentPagePartials.has(id)) {
        _onIdPruned(id)
      }
    }
  }
}

/**
 * Destroy a parton's parked CONTENT — the cull-park LRU's eviction
 * (see `cull-park.ts`). Deletes the id's cache slots and advertised
 * fingerprints (the skeleton isn't among them — it renders from the
 * pair's inline element, never the cache, so it keeps holding the
 * parton's space). The mounted parked fiber unmounts on the next
 * commit's template render (its placeholder no longer resolves), and
 * with no advertised fp the next cull-in renders cold — the
 * pre-parking behavior. The destruction is reported upstream
 * (`_setContentLossListener`) so the server revokes the id's mirror
 * credit — its next flip-in must re-render, never confirm the copy
 * this eviction just destroyed.
 */
export function evictCulledContent(id: string): void {
  const held = _currentPagePartials.has(id) || _currentPageFingerprints.has(id)
  _currentPagePartials.delete(id)
  _currentPageFingerprints.delete(id)
  _slotStoreSeq.delete(id)
  _pendingFpAliases.delete(id)
  if (held) _onContentLoss?.(id)
}

/**
 * TEST-ONLY: reset every module-level map/slot to its boot state. The
 * state is module-level BY DESIGN (it must survive the browser's
 * void→payload remount — see the module doc), which means a test that
 * drives the real merge layer (the v2 convergence fuzzer) needs an
 * explicit reset between trials; nothing in production calls this.
 */
export function _resetClientStateForTest(): void {
  _currentPagePartials.clear()
  _currentPageFingerprints.clear()
  _slotStoreSeq.clear()
  _pendingFpAliases.clear()
  _liveTreeIds = new Set()
  if (_pendingLaneNotify !== null) {
    _pendingLaneNotify.cancel()
    _pendingLaneNotify = null
  }
  _template = null
  _templateRoute = null
  _frameUrls.clear()
  _liveCatchupAnchor = null
  _documentAnchor = null
  _liveConnectionId = null
}

// ─── Lane commits ─────────────────────────────────────────────────

/**
 * Subscription for per-parton lane commits. A lane commit writes a
 * freshly-decoded parton subtree into the partial cache OUTSIDE any
 * payload render — nothing re-renders on a cache write by itself, so
 * `PartialsClient` subscribes here and schedules a transition
 * re-render of the template on every notify; `renderTemplate` /
 * `substituteNested` then swap the fresh subtree in place. See
 * `_commitPartonLane` in `partial-cache.ts`.
 */
const _laneCommitSubscribers = new Set<() => void>()

export function subscribeLaneCommits(cb: () => void): () => void {
  _laneCommitSubscribers.add(cb)
  return () => {
    _laneCommitSubscribers.delete(cb)
  }
}

/** The pending coalesced notify, or `null`. One slot: the cache is the
 *  single source the notified re-render reads, so one flush covers
 *  every commit that landed before it — nothing per-commit to queue. */
let _pendingLaneNotify: { cancel: () => void } | null = null

/**
 * Notify subscribers NOW — the immediate form, for commits servicing
 * an in-flight user statement (a frame navigation's lane, a covering
 * refetch): interactive content must never wait out the flush quantum.
 * A pending coalesced flush is cancelled rather than left to run — the
 * template re-render this notify triggers reads the cache's CURRENT
 * state, so it covers everything the pending flush would have.
 */
export function notifyLaneCommit(): void {
  if (_pendingLaneNotify !== null) {
    _pendingLaneNotify.cancel()
    _pendingLaneNotify = null
  }
  for (const cb of [..._laneCommitSubscribers]) cb()
}

/** Liveness bound on the coalesced notify. rAF alignment is an
 *  optimization, not a signal a frame will ever come: a page that
 *  produces no frames — an occluded background tab (which can still
 *  report `visibilityState: "visible"` in headless runs), a hidden
 *  page — stalls rAF indefinitely, and lane content would never reach
 *  the tree. The timer races the frame callback; whichever fires
 *  first runs the notify and cancels the other. At a flowing 60Hz the
 *  rAF always wins (≤16.7ms), so the backstop only ever fires where
 *  there is no paint to align with. */
const LANE_NOTIFY_BACKSTOP_MS = 50

/**
 * Notify subscribers on the next animation frame — the lane flush
 * quantum for STREAMING traffic (live pulse lanes, producer token
 * re-walks, resolve-time payload re-walks). At density the lane rate
 * outruns the display: each notify's template re-render + React commit
 * costs milliseconds, and per-lane notifies burn CPU on states no
 * frame will ever paint. Coalescing to one flush per frame bounds the
 * commit rate at the paint rate; the cache walks stay synchronous at
 * decode time (per-parton ordering, ack timing and loss reports are
 * all recorded there — the quantum only defers the RE-RENDER), and the
 * `LANE_NOTIFY_BACKSTOP_MS` timer bounds the deferral on pages with no
 * frame flow. No rAF at all (non-visual test environments) falls
 * through to the immediate notify.
 */
export function notifyLaneCommitCoalesced(): void {
  if (_pendingLaneNotify !== null) return
  if (typeof requestAnimationFrame !== "function") {
    notifyLaneCommit()
    return
  }
  let rafId: number
  let timerId: ReturnType<typeof setTimeout>
  const fire = (): void => {
    _pendingLaneNotify = null
    cancelAnimationFrame(rafId)
    clearTimeout(timerId)
    for (const cb of [..._laneCommitSubscribers]) cb()
  }
  rafId = requestAnimationFrame(fire)
  timerId = setTimeout(fire, LANE_NOTIFY_BACKSTOP_MS)
  _pendingLaneNotify = {
    cancel: () => {
      cancelAnimationFrame(rafId)
      clearTimeout(timerId)
    },
  }
}

// ─── Live catch-up anchor ─────────────────────────────────────────

/**
 * The document's registry anchor (`<!--live-anchor:{epoch,ts}-->`,
 * parsed by `_applyFpTrailerFromDocument`'s scan): the point on the
 * server's invalidation timeline this page's bytes represent. The
 * heartbeat TAKES it (once) for its first `?live=1` fire — the server
 * then skips the whole-route initial segment and opens straight into
 * lanes for everything that bumped after the document rendered.
 * Take-once: a reopened connection (keepalive elapsed) has consumed
 * lanes past the anchor with no client-side timeline to re-anchor on,
 * so it falls back to the full initial segment.
 */
let _liveCatchupAnchor: { epoch: string; ts: number } | null = null

/** Retained copy of the document anchor — never cleared. The transport
 *  upgrade's PROBE presents it so an anchor-honoring server opens the
 *  probe's throwaway session straight into a parked lanes region:
 *  `conn` arrives with near-zero server work and closing the probe
 *  socket tears no render. Never presented by a REAL attach — those
 *  keep the take-once semantic below (a reattach's first segment is
 *  whole-tree, the mirror's reconcile pass). */
let _documentAnchor: { epoch: string; ts: number } | null = null

export function _setLiveCatchupAnchor(anchor: { epoch: string; ts: number }): void {
  _liveCatchupAnchor = anchor
  _documentAnchor = anchor
}

export function _takeLiveCatchupAnchor(): { epoch: string; ts: number } | null {
  const anchor = _liveCatchupAnchor
  _liveCatchupAnchor = null
  return anchor
}

export function _documentCatchupAnchor(): { epoch: string; ts: number } | null {
  return _documentAnchor
}

// ─── Live connection id ───────────────────────────────────────────

/**
 * The connection id of the currently-established live stream, or
 * `null` when none is open. SERVER-minted: the segment driver creates
 * it at session open and ships it down as the stream's `conn` entry;
 * the channel transport (`channel-client.ts`) publishes it here on
 * receipt and clears it when the connection settles or an envelope's
 * delivery fails. Producers read it to decide the statement
 * transport: id in hand → frames on channel envelopes addressed to
 * the open connection; `null` → their discrete fallback.
 */
let _liveConnectionId: string | null = null

export function _setLiveConnectionId(id: string | null): void {
  _liveConnectionId = id
}

export function _getLiveConnectionId(): string | null {
  return _liveConnectionId
}

// ─── Structural template ──────────────────────────────────────────

/**
 * Structural layout skeleton, derived from the most recent full-payload
 * render via `deriveTemplate`. Persisted across refetches so the server
 * doesn't need to ship the template bytes on every partial refetch.
 * Re-derived whenever a full payload arrives (covers layout changes
 * across route navigations).
 *
 * Keyed by route (pathname + search). Same-URL refetches reuse the
 * cached template; different-URL navigations re-derive.
 */
let _template: ReactNode = null

/**
 * The page `_template` was derived for — the pathname only. The
 * structural skeleton is decided by which specs `match` (a path
 * concern), so a same-page change — a query/state param like
 * `?chat=open` or `?q=…`, a refetch's `?cached=`/`?streaming=`, a frame
 * URL — keeps the same structure and reuses the template, while a
 * different page re-derives. Gates the streaming-mode pending-lazy
 * fallback (see `PartialsClient`): without it, a cross-page nav whose
 * new page still has a Flight chunk in flight would re-render this STALE
 * prior-page template — the page sticks on the one you just left.
 */
let _templateRoute: string | null = null

/** Page key for `_template`: the pathname. Same-page query/state changes
 *  reuse the template (the `match`-driven structure is unchanged); only a
 *  pathname change re-derives. Client-only (reads `window.location`);
 *  callers are past the SSR `typeof document` guard. */
export function templateRouteKey(): string {
  return new URL(window.location.href).pathname
}

export function getTemplate(): ReactNode {
  return _template
}

export function getTemplateRoute(): string | null {
  return _templateRoute
}

export function setTemplate(template: ReactNode, route: string): void {
  _template = template
  _templateRoute = route
}

// ─── Frame URLs ───────────────────────────────────────────────────

/**
 * Cached frame URLs on the client, keyed by the frame's dotted path
 * (`"cart"` or `"products.list"`). Updated on every
 * `useNavigation(path).navigate(url)` call so `currentEntry.url` can
 * return a synchronous value without a server round-trip. The server
 * session is authoritative — this is a UX cache.
 */
const _frameUrls = new Map<string, string>()

export function getFrameUrl(key: string): string | undefined {
  return _frameUrls.get(key)
}

export function setFrameUrl(key: string, url: string): void {
  _frameUrls.set(key, url)
}

export function hasFrameUrl(key: string): boolean {
  return _frameUrls.has(key)
}
