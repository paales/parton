/**
 * Client partial cache walks: recognizing partial wrappers and
 * placeholders in a streamed tree, harvesting the `(id, matchKey)`
 * pairs they carry, filling the client cache from a streamed payload,
 * and substituting cached subtrees back into a rendered tree.
 *
 * The mutable maps these walks fill live in
 * `partial-client-state.ts`; every function here either takes the
 * cache as a parameter or goes through that module's accessors.
 */

import { cloneElement, isValidElement, type ReactElement, type ReactNode, Suspense } from "react"
import { contentSlotConfirmed, contentSlotStored } from "./cull-park.ts"
import type { FpUpdatesPayload } from "./fp-trailer-marker.ts"
import {
  _addLiveTreeIds,
  _applyFpUpdates,
  _dropVariantFingerprints,
  _evictTornVariant,
  _nextStoreSeq,
  _runWithStoreSeq,
  _setLiveCatchupAnchor,
  _slotStoreSeqOf,
  cacheLookup,
  cacheStore,
  getCurrentPagePartials,
  notifyLaneCommit,
  notifyLaneCommitCoalesced,
  type PartialCache,
  registerClientPartial,
  touchClientPartial,
} from "./partial-client-state.ts"

/**
 * Return true if the node looks like the outermost wrapper a
 * `<Partial>` renders — a keyed `<Suspense>` (partial with fallback)
 * or a keyed `<PartialErrorBoundary>` (partial without fallback).
 *
 * We can't reliably compare `node.type` against the PartialErrorBoundary
 * class identity — in SSR the class reference can differ from the
 * one this module imports (different module graphs across the RSC /
 * SSR boundary). Instead we detect by the `partialId` prop the Partial
 * component always sets on its wrapper. For the Suspense branch, the
 * key is the partial id and Suspense wraps a PartialErrorBoundary that
 * also carries `partialId` — we detect via `type === Suspense`.
 */
export function isPartialWrapper(node: ReactElement): boolean {
  if (node.key == null) return false
  if (node.type === Suspense) return true
  const props = node.props as { partialId?: unknown }
  return typeof props?.partialId === "string"
}

/**
 * Extract the partial id from a wrapper node.
 *
 * Prefer the `partialId` prop over `node.key`. Flight combines the
 * outer `.map()` key with a client-component's own `key` into a
 * composite string like "page-1,page-1" when a `<Partial>` is
 * produced inside a `.map()`. The `partialId` prop stays clean and
 * is always the source of truth.
 *
 * Suspense (a React built-in) doesn't get double-keyed and doesn't
 * carry `partialId` itself — but its child is the PartialErrorBoundary
 * that does. Fall back to the Suspense `key` (which stays clean) or
 * peek at the direct child's `partialId`.
 */
export function getPartialId(node: ReactElement): string | null {
  const props = node.props as { partialId?: unknown; children?: unknown }
  if (typeof props.partialId === "string") return props.partialId
  if (node.type === Suspense) {
    const child = props.children
    if (isValidElement(child)) {
      const cp = (child as ReactElement).props as { partialId?: unknown }
      if (typeof cp.partialId === "string") return cp.partialId
    }
    if (node.key != null) return String(node.key)
  }
  return null
}

/**
 * Extract the structural fingerprint off a partial wrapper. Mirrors
 * `getPartialId` — direct `partialFingerprint` prop, or peek through a
 * Suspense wrapper to the PartialErrorBoundary child. Returns `null`
 * for wrappers that don't carry one (shouldn't happen in practice but
 * we bail rather than register a bogus value).
 */
export function getPartialFingerprint(node: ReactElement): string | null {
  const props = node.props as {
    partialFingerprint?: unknown
    children?: unknown
  }
  if (typeof props.partialFingerprint === "string") return props.partialFingerprint
  if (node.type === Suspense) {
    const child = props.children
    if (isValidElement(child)) {
      const cp = (child as ReactElement).props as {
        partialFingerprint?: unknown
      }
      if (typeof cp.partialFingerprint === "string") return cp.partialFingerprint
    }
  }
  return null
}

/**
 * A placeholder is the `<i data-partial hidden>` marker the server
 * emits for a partial it fp-skipped — the client keeps its cached
 * entry for that region.
 *
 * IMPORTANT: cached partials are pushed as-is with NO traversal of their
 * own children. The Suspense boundaries inside cached partials have lazy
 * refs (from the RSC Flight stream) as `props.children`; any `React.Children.*`
 * helper on those thenables causes React to resolve them during reconcile
 * instead of showing a fallback on remount, which breaks progressive
 * streaming on refetch. See notes/archive/STREAMING_DEBUG_NOTES.md §7-8.
 */
export function isPlaceholder(child: ReactElement): boolean {
  return child.type === "i" && (child.props as any)["data-partial"] === true
}

/** A `defer: "stream"` stub's placeholder marker — its content is IN
 *  FLIGHT on the parton's own follow-up lane. The suspend-while-empty
 *  behavior lives in the `<PendingSlot>` client component the server
 *  wraps AROUND this marker (see `pending-slot.tsx`) — the wire form
 *  itself gates, so the raw-reveal TOCTOU (a settling row committed
 *  natively, no substitution pass) can never reveal a boundary with
 *  visually-empty content. The walks treat the marker like any other
 *  placeholder: inert on a miss, substituted when the slot fills. */
export function isPendingPlaceholder(child: ReactElement): boolean {
  return (child.props as any)["data-partial-pending"] === true
}

/** A `defer: "stream"` STUB wrapper — a boundary whose content is the
 *  `<PendingSlot>` gate around a pending-marked placeholder (the real
 *  body is in flight on the parton's own follow-up lane). The chain
 *  from the wrapper is shallow and fixed by the emission:
 *  PEB > [Suspense(spec fallback)] > PendingSlot > `<i pending>`. The
 *  harvest must leave a stub's slot EMPTY: storing the stub would
 *  make the PendingSlot gate see an occupied slot and reveal the
 *  empty marker; an empty slot keeps the gate suspended (the ambient
 *  fallback holds) until the REAL body stores — which also keeps fp
 *  advertisement honest (no fp without held content). */
function isStubWrapper(node: ReactElement): boolean {
  let el: unknown = (node.props as { children?: unknown }).children
  for (let depth = 0; depth < 4 && isValidElement(el); depth++) {
    if (isPendingPlaceholder(el as ReactElement)) return true
    el = ((el as ReactElement).props as { children?: unknown }).children
  }
  return false
}

/**
 * Id for a placeholder `<i>`. Prefer the `data-partial-id` prop, which
 * is stable, over `node.key`, which Flight can composite with an outer
 * `.map()` key into `"outer,inner"` for dynamic Partials.
 */
export function getPlaceholderId(node: ReactElement): string | null {
  const props = node.props as { ["data-partial-id"]?: unknown }
  if (typeof props["data-partial-id"] === "string") {
    return props["data-partial-id"]
  }
  return node.key != null ? String(node.key) : null
}

/**
 * MatchKey of a placeholder `<i>`. matchKey identifies the rendered
 * variant (cache slot under id) — read from `data-partial-match`. The
 * value is a 16-char hex hash of stableStringify(matchParams); specs
 * without `match` resolve to a constant matchKey.
 */
export function getPlaceholderMatchKey(node: ReactElement): string | null {
  const props = node.props as { ["data-partial-match"]?: unknown }
  if (typeof props["data-partial-match"] === "string") {
    return props["data-partial-match"]
  }
  return null
}

/**
 * MatchKey off a partial wrapper. Mirrors `getPartialFingerprint`:
 * read `partialMatchKey` directly, or peek through a Suspense wrapper
 * to its PartialErrorBoundary child.
 */
export function getPartialMatchKey(node: ReactElement): string | null {
  const props = node.props as {
    partialMatchKey?: unknown
    children?: unknown
  }
  if (typeof props.partialMatchKey === "string") return props.partialMatchKey
  if (node.type === Suspense) {
    const child = props.children
    if (isValidElement(child)) {
      const cp = (child as ReactElement).props as {
        partialMatchKey?: unknown
      }
      if (typeof cp.partialMatchKey === "string") return cp.partialMatchKey
    }
  }
  return null
}

export function addSeen(out: Map<string, Set<string>>, id: string, matchKey: string): void {
  let inner = out.get(id)
  if (!inner) {
    inner = new Set()
    out.set(id, inner)
  }
  inner.add(matchKey)
}

/**
 * Collect every (id, matchKey) pair reachable inside a node — wrapper
 * OR placeholder. Read-only walk: doesn't mutate the client maps.
 * Used by the streaming-mode prune to expand `seen` with nested
 * variants that live inside cached wrappers — when the server
 * fp-skips an outer partial, the new tree carries only its top-level
 * placeholder, so the nested (id, matchKey) pairs backing the
 * rendered region need to be harvested from the cache itself or the
 * prune deletes them out from under the next render.
 *
 * Wrappers without a `partialMatchKey` prop (legacy fixtures, missing
 * server-side wire) fall back to the empty string so they're still
 * tracked as a single-variant cache entry under `(id, "")`.
 *
 * `stats.pending` counts the deferred nodes the harvest could NOT see
 * through (a cached wrapper whose content is still streaming — a
 * progressive lane commit mid-body). A prune fed a pending-blocked
 * harvest would delete every nested variant hiding behind the chunk
 * out from under the displayed tree (fuzz class F11) — the caller must
 * DEFER the prune when `pending > 0` (over-retention, never blanking;
 * the next fully-harvestable commit prunes).
 */
export function harvestPartialIds(
  node: ReactNode,
  out: Map<string, Set<string>>,
  stats?: { pending: number },
): void {
  if (node == null || typeof node === "boolean") return
  if (typeof node === "string" || typeof node === "number") return
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      harvestPartialIds(node[i] as ReactNode, out, stats)
    }
    return
  }
  const unwrapped = unwrapLazy(node)
  if (unwrapped !== node) {
    // Errored OR pending lazy — can't descend; skip (pending counted:
    // nested variants may hide behind the chunk).
    if (unwrapped === LAZY_PENDING && stats) stats.pending++
    if (unwrapped == null || unwrapped === LAZY_PENDING) return
    harvestPartialIds(unwrapped as ReactNode, out, stats)
    return
  }
  if (!isValidElement(node)) return

  if (isPartialWrapper(node)) {
    const id = getPartialId(node)
    if (id) addSeen(out, id, getPartialMatchKey(node) ?? "")
    const inner = (node.props as { children?: ReactNode })?.children
    if (inner != null) harvestPartialIds(inner, out, stats)
    return
  }
  if (isPlaceholder(node)) {
    const id = getPlaceholderId(node)
    if (id) addSeen(out, id, getPlaceholderMatchKey(node) ?? "")
    return
  }
  const inner = (node.props as { children?: ReactNode })?.children
  if (inner != null) harvestPartialIds(inner, out, stats)
}

/**
 * Collect the (id, matchKey) pairs a cached subtree references through
 * bare PLACEHOLDERS — the slots its rendered form depends on from
 * OUTSIDE itself (`substituteNested` fills them at template render).
 * Wrappers reached inline are self-carried content, not references,
 * so they are descended but not collected. `stats.pending` counts
 * deferred nodes the walk could not see through — a caller deciding
 * composition honesty must treat those as "references unknown".
 */
function collectPlaceholderRefs(
  node: ReactNode,
  out: Map<string, Set<string>>,
  stats: { pending: number },
): void {
  if (node == null || typeof node === "boolean") return
  if (typeof node === "string" || typeof node === "number") return
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      collectPlaceholderRefs(node[i] as ReactNode, out, stats)
    }
    return
  }
  const unwrapped = unwrapLazy(node)
  if (unwrapped !== node) {
    if (unwrapped === LAZY_PENDING) stats.pending++
    if (unwrapped == null || unwrapped === LAZY_PENDING) return
    collectPlaceholderRefs(unwrapped as ReactNode, out, stats)
    return
  }
  if (!isValidElement(node)) return
  if (isPlaceholder(node)) {
    const id = getPlaceholderId(node)
    if (id) addSeen(out, id, getPlaceholderMatchKey(node) ?? "")
    return
  }
  const inner = (node.props as { children?: ReactNode })?.children
  if (inner != null) collectPlaceholderRefs(inner, out, stats)
}

/**
 * Walk a cached element tree and substitute any nested partial wrappers
 * with the current cache entry for that (id, matchKey) variant.
 *
 * `skipKey` is `${id}|${matchKey}` so the recursion can't loop on a
 * wrapper that contains a placeholder pointing to itself (any
 * fp-skipped partial caches a wrapper that contains its own
 * placeholder). The outer id alone isn't enough — two siblings under
 * the same PartialBoundary can share an id but differ on matchKey
 * (hidden Activity sibling for a parked variant), and the inner one
 * must still resolve when the outer references the same id.
 *
 * Wrapper-rooted sub-walks are MEMOIZED — see `substituteWrapper`.
 * The walk runs on every template re-render (once per lane flush
 * quantum under streaming), and without the memo it re-traverses the
 * full cached-wrapper spine each commit only to rebuild identical
 * output; the memo turns an all-clean walk into O(deps) map reads and
 * a dirty commit into a rebuild of just the dirty id's spine path.
 */
export function substituteNested(node: ReactNode, cache: PartialCache, skipKey: string): ReactNode {
  if (node == null || typeof node === "boolean") return node
  if (typeof node === "string" || typeof node === "number") return node
  if (Array.isArray(node)) {
    let changed = false
    const mapped = node.map((c) => {
      const s = substituteNested(c, cache, skipKey)
      if (s !== c) changed = true
      return s
    })
    return changed ? mapped : node
  }

  // Flight lazy refs appear as children of cached client-component
  // boundaries (e.g. `<PartialErrorBoundary>{lazyRef}</PartialErrorBoundary>`
  // where the server was still streaming when the cache was
  // populated). By the time a refetch lands they've been resolved —
  // unwrap so we can descend into the nested tree and find keyed
  // partials to swap. Pending / errored lazies leave the original
  // node in place so React's native Suspense resolves them later.
  const unwrapped = unwrapLazy(node)
  if (unwrapped !== node) {
    if (unwrapped === LAZY_PENDING) {
      // A pending lazy resolves WITHOUT a cache write, so no dep can
      // witness it — poison every enclosing wrapper memo (the walk
      // after resolution descends further and can produce different
      // output). Fulfilled/errored lazies are terminal states and need
      // no poison: they unwrap to the same value forever.
      if (_substituteRecorder) _substituteRecorder.sawPending = true
      return node
    }
    if (unwrapped == null) return node
    return substituteNested(unwrapped as ReactNode, cache, skipKey)
  }

  if (!isValidElement(node)) return node

  // Placeholder: substitute from cache. Id + matchKey come from the
  // `data-partial-id` + `data-partial-match` props (stable), not the
  // key (Flight composites).
  //
  // Recurse into the cached wrapper. A wrapper produced by a
  // cache-mode refetch can carry INTERNAL placeholders for partials
  // whose fp matched (no fresh content emitted server-side). Those
  // inner placeholders need to be substituted with the next cache
  // entries — without the recursion the inner placeholders survive
  // into the rendered tree as `<i hidden>` markers and the partial's
  // descendant content is empty in the DOM. This was the
  // "consecutive moves blank the preview" bug (issue #1, 2026-04-25):
  // move 2's cms-demo-root wrapper held 6 Fragments-with-placeholder
  // children, and the substitution stopped at the wrapper without
  // unfolding those nested placeholders against the cache entries
  // populated by move 1.
  if (isPlaceholder(node)) {
    const id = getPlaceholderId(node)
    const mk = getPlaceholderMatchKey(node) ?? ""
    const key = `${id ?? ""}|${mk}`
    if (id && key !== skipKey) {
      const fresh = substituteLookup(cache, id, mk)
      return fresh ? substituteNested(fresh, cache, key) : node
    }
  }

  if (isPartialWrapper(node)) return substituteWrapper(node, cache, skipKey)

  return substituteIntoChildren(node, cache, skipKey)
}

// ─── substituteNested memoization ───────────────────────────────────
//
// `substituteNested` is pure over (node, cacheLookup results, skipKey),
// modulo Flight lazy state:
//
//   - Element structure and props are immutable after creation; the
//     only mutation a cached subtree ever sees is a lazy's payload
//     settling. Fulfilled and errored payloads are terminal, so a walk
//     that saw NO pending lazy unwraps identically forever.
//   - Every other input the walk reads is a `cacheLookup` — recorded,
//     per walked wrapper, as (id, matchKey) → the exact node the
//     lookup returned. A memo is valid iff every recorded lookup
//     still returns the identical node. Identity — not a write
//     counter — is the real signal: it also invalidates on deletes
//     (`pruneToLive`, pool-cap eviction, `_destroyId`) that no store
//     hook would see, and a re-store of the SAME node (a progressive
//     re-walk of one payload) correctly keeps memos valid.
//
// Memo points are partial WRAPPERS (the cache's unit): entries live in
// a WeakMap keyed by the wrapper element, sub-keyed by skipKey (the
// same wrapper walks under its own key when substituted from cache and
// under the enclosing walk's key when reached inline with an unchanged
// slot). Entries die with their wrapper — a slot overwrite drops the
// old element and its memo together; no explicit invalidation needed.
//
// A hit returns the previous walk's RESULT element unchanged, which is
// exactly what the unmemoized walk returns when nothing changed — so
// React's bail-out behavior is untouched; the memo only removes the
// traversal that discovered "nothing changed".

interface SubstituteDep {
  id: string
  mk: string
  /** What `cacheLookup(id, mk)` returned when the walk ran (undefined
   *  for a miss — a later fill must invalidate too). */
  value: ReactNode | undefined
}

interface SubstituteMemoEntry {
  result: ReactNode
  deps: Map<string, SubstituteDep>
}

const _substituteMemo = new WeakMap<object, Map<string, SubstituteMemoEntry>>()

/** Dep recorder for the wrapper memo currently being built. Wrapper
 *  walks nest; each pushes its own recorder and folds its deps into
 *  the parent's on completion (and on a hit, folds the hit entry's
 *  deps), so ancestors carry their subtrees' deps transitively. */
interface SubstituteRecorder {
  deps: Map<string, SubstituteDep>
  sawPending: boolean
}

let _substituteRecorder: SubstituteRecorder | null = null

/** `cacheLookup`, recorded into the active wrapper memo's dep set.
 *  Every lookup `substituteNested` makes goes through here. */
function substituteLookup(cache: PartialCache, id: string, mk: string): ReactNode | undefined {
  const value = cacheLookup(cache, id, mk)
  _substituteRecorder?.deps.set(`${id}|${mk}`, { id, mk, value })
  return value
}

function substituteMemoValid(entry: SubstituteMemoEntry, cache: PartialCache): boolean {
  for (const dep of entry.deps.values()) {
    if (cacheLookup(cache, dep.id, dep.mk) !== dep.value) return false
  }
  return true
}

/** The wrapper-node arm of `substituteNested`, memoized per
 *  (wrapper element, skipKey). See the block comment above. */
function substituteWrapper(node: ReactElement, cache: PartialCache, skipKey: string): ReactNode {
  const bySkip = _substituteMemo.get(node)
  const entry = bySkip?.get(skipKey)
  const parent = _substituteRecorder
  if (entry && substituteMemoValid(entry, cache)) {
    if (parent) for (const [k, d] of entry.deps) parent.deps.set(k, d)
    return entry.result
  }
  const rec: SubstituteRecorder = { deps: new Map(), sawPending: false }
  _substituteRecorder = rec
  let result: ReactNode
  try {
    result = substituteWrapperUncached(node, cache, skipKey)
  } finally {
    _substituteRecorder = parent
  }
  if (rec.sawPending) {
    // NEVER memoize a walk that saw a pending lazy — it resolves
    // without a cache write, so no dep would ever invalidate the
    // entry. Any stale entry under this key is already invalid
    // (that's why we walked); drop it rather than re-validate it
    // every commit.
    bySkip?.delete(skipKey)
  } else {
    let m = _substituteMemo.get(node)
    if (!m) {
      m = new Map()
      _substituteMemo.set(node, m)
    }
    m.set(skipKey, { result, deps: rec.deps })
  }
  if (parent) {
    for (const [k, d] of rec.deps) parent.deps.set(k, d)
    if (rec.sawPending) parent.sawPending = true
  }
  return result
}

function substituteWrapperUncached(
  node: ReactElement,
  cache: PartialCache,
  skipKey: string,
): ReactNode {
  // Partial-shape wrapper: if there's a fresh cache entry for the
  // same (id, matchKey) variant, use it. If the cache entry is the
  // same wrapper we're looking at (i.e. the wrapper itself wasn't
  // replaced this round), descend INTO its children so any descendant
  // Partial that DID get a fresh cache entry still gets swapped.
  // Without this descent, a refetch targeting a deeply-nested partial
  // lands a fresh entry but the surrounding ancestor wrappers keep
  // their old children references — so the new content never reaches
  // the rendered tree.
  const id = getPartialId(node)
  const mk = getPartialMatchKey(node) ?? ""
  const key = `${id ?? ""}|${mk}`
  if (id && key !== skipKey) {
    const fresh = substituteLookup(cache, id, mk)
    if (fresh && fresh !== node) {
      return substituteNested(fresh, cache, key)
    }
    // Wrapper unchanged — keep descending so nested partials whose
    // cache entries DID change still get substituted.
  }
  return substituteIntoChildren(node, cache, skipKey)
}

function substituteIntoChildren(
  node: ReactElement,
  cache: PartialCache,
  skipKey: string,
): ReactNode {
  const children = (node.props as any).children
  if (children == null) return node
  const newChildren = substituteNested(children, cache, skipKey)
  if (newChildren === children) return node
  // Spread arrays as variadic — see the matching comment in
  // cache.tsx#resolveLazies. Flight-decoded children are arrays
  // even for static JSX siblings, and a bare `cloneElement(node,
  // {}, arr)` triggers React's "unique key" warning.
  return Array.isArray(newChildren)
    ? cloneElement(node, {}, ...newChildren)
    : cloneElement(node, {}, newChildren)
}

const LAZY_SYMBOL_STR = "Symbol(react.lazy)"

/** Sentinel returned by `unwrapLazy` when the deferred node is pending —
 *  distinct from `null` (which signaled "unwrap failed, drop the node").
 *  Callers who recognise this keep the original node in place so React's
 *  native Suspense machinery resolves it; callers who don't recognise it
 *  fall back to the legacy "drop" behaviour. */
export const LAZY_PENDING = Symbol("partial-client.lazyPending")

/**
 * Unwrap a deferred Flight node at the tree level — BOTH deferred
 * forms the wire produces:
 *
 *   - a React lazy (`$L<row>` — nested chunks of a streaming decode);
 *   - a raw thenable (`$@<row>` — an outlined promise row). This is
 *     how every ASYNC Render body crosses the wire: `partial.tsx`
 *     wraps `spec.Render(renderProps)`'s returned Promise directly as
 *     the `<PartialErrorBoundary>`'s children, so the whole body —
 *     including any nested partial wrappers and fp-skip placeholders —
 *     sits behind the promise. A walk that can't see through it leaves
 *     everything inside outside the merge layer's reach: nested cache
 *     entries never land, and a hole committed inside the promise
 *     mounts through React's native thenable resolution where
 *     `substituteNested` can never heal it.
 *
 * Returns the resolved value when fulfilled; `LAZY_PENDING` while the
 * underlying chunk is in flight; `null` on rejection (treated as
 * opaque — React's error boundary owns it).
 *
 * The pending sentinel matters for streaming hydration: the cache-walk
 * (`cacheFromStreamingChildren`) and the template-derive
 * (`deriveTemplate`) both encounter deferred nodes while chunks are
 * still arriving. Treating pending the same as "drop" silently
 * loses the partial wrapper inside — the cache never gets
 * an entry, the template emits a bare placeholder, and `renderTemplate`
 * leaves an empty `<i hidden>` in the DOM. Returning a distinct
 * sentinel lets each caller decide: skip caching this round (the
 * node is re-walked when its chunk settles) but keep it in the
 * rendered output so React resolves it natively.
 */
export function unwrapLazy(node: unknown): unknown {
  if (node == null || typeof node !== "object") return node
  const n = node as any
  if (typeof n.$$typeof === "symbol") {
    if (n.$$typeof.toString() !== LAZY_SYMBOL_STR) return node
    const payload = n._payload
    if (payload && payload._status === 1) return payload._result
    try {
      const init = n._init
      if (typeof init === "function") {
        const result = init(payload)
        // init returned synchronously — fulfilled.
        return result
      }
    } catch (e) {
      // A thenable throw is React's "pending" signal for lazy refs.
      // Anything else is an error we treat as opaque.
      if (e && typeof e === "object" && typeof (e as PromiseLike<unknown>).then === "function") {
        return LAZY_PENDING
      }
    }
    return null
  }
  if (typeof n.then === "function") return unwrapThenable(n as InstrumentedThenable)
  return node
}

/** A thenable carrying its own settlement record — the Flight client's
 *  chunk protocol (`ReactPromise.status`/`.value`/`.reason`), which is
 *  also the instrumentation React's `use()` writes onto plain
 *  thenables. The status field is the real signal the walks read; no
 *  shape is guessed. */
interface InstrumentedThenable extends PromiseLike<unknown> {
  status?: string
  value?: unknown
  reason?: unknown
}

function noop(): void {}

/**
 * The thenable arm of `unwrapLazy`: read the node's own settlement.
 *
 *   - `"fulfilled"` → the resolved value (`.value` is only meaningful
 *     in this state — a pending Flight chunk repurposes the field for
 *     its listener list).
 *   - `"rejected"` → `null` (opaque, same as an errored lazy).
 *   - `"resolved_model"` / `"resolved_module"` → the chunk's bytes are
 *     already here but the model is uninitialized; the Flight client
 *     initializes SYNCHRONOUSLY inside `.then()` (the same forcing
 *     `unwrapLazy` does via a lazy's `_init`), so subscribe and
 *     re-read.
 *   - no status at all (a plain thenable) → instrument it exactly as
 *     React's `use()` does, so its eventual settlement is readable by
 *     the re-walk its capture schedules.
 *   - anything else (`"pending"`, `"blocked"`, `"cyclic"`, `"halted"`)
 *     → `LAZY_PENDING`.
 */
function unwrapThenable(t: InstrumentedThenable): unknown {
  switch (t.status) {
    case "fulfilled":
      return t.value
    case "rejected":
      return null
    case "resolved_model":
    case "resolved_module": {
      t.then(noop, noop)
      // `.then` initialized the chunk synchronously — re-read the record.
      const settled = t.status as string
      if (settled === "fulfilled") return t.value
      if (settled === "rejected") return null
      return LAZY_PENDING
    }
    case undefined: {
      t.status = "pending"
      t.then(
        (value) => {
          if (t.status === "pending") {
            t.status = "fulfilled"
            t.value = value
          }
        },
        (reason) => {
          if (t.status === "pending") {
            t.status = "rejected"
            t.reason = reason
          }
        },
      )
      // A custom thenable may settle synchronously inside `then`.
      if ((t.status as string) === "fulfilled") return t.value
      if ((t.status as string) === "rejected") return null
      return LAZY_PENDING
    }
    default:
      return LAZY_PENDING
  }
}

/** The awaitable behind a node `unwrapLazy` classified `LAZY_PENDING`:
 *  a pending thenable IS its own settlement signal; a pending lazy's
 *  is its `_payload` chunk. */
function pendingAwaitable(node: unknown): PromiseLike<unknown> | null {
  const n = node as { then?: unknown; _payload?: unknown }
  if (typeof n.then === "function") return node as PromiseLike<unknown>
  const payload = n._payload
  if (payload != null && typeof (payload as PromiseLike<unknown>).then === "function") {
    return payload as PromiseLike<unknown>
  }
  return null
}

/**
 * Sentinel mutable used by `cacheFromStreamingChildren` to report
 * whether the walk encountered any pending Flight lazies. PartialsClient's
 * streaming-mode path uses this to decide: if any lazy is still in flight,
 * skip the template/derive/substitute machinery and return `children`
 * directly so the rendered tree matches the SSR HTML exactly. The cache
 * walk that DID complete is still safe to keep (any wrappers that were
 * walked are cached).
 *
 * `thenables` collects each pending node's settlement signal — a
 * pending lazy's underlying Flight chunk, a pending outlined-promise
 * row itself — so the caller can re-walk THIS payload the moment its
 * rows land (`PartialsClient`'s `scheduleRewalkOnResolve`, the lane
 * commits' re-walk) instead of hoping a later render re-walks it.
 * Without that, a payload superseded before any re-render loses its
 * still-streaming wrappers permanently — the bytes arrived but never
 * reached the cache.
 */
export interface LazyWalkStats {
  pending: number
  thenables?: PromiseLike<unknown>[]
  /** The walk stored content into a cache slot that held NOTHING — a
   *  skeleton's first fill (a flip-in's content, a fresh instance).
   *  Lane commits read this to exempt the notify from the flush
   *  quantum: first content is paint-blocking (the user is looking at
   *  the skeleton it replaces), while a refresh of content already
   *  showing can always wait for the frame. */
  firstFill?: boolean
}

/**
 * Walk the streamed children tree and cache partial contents by id.
 *
 * Partials are recognized by their outermost wrapper shape (see
 * `isPartialWrapper`): a keyed `<Suspense>` or keyed
 * `<PartialErrorBoundary>`. The key is the partial id.
 *
 * We cache the wrapper AND descend into its children looking for
 * NESTED partial wrappers. Nested partials need their own top-level
 * entries so that after a parent-only refetch (which emits a
 * placeholder for the nested partial inside the parent's new
 * content), the client can still find the nested partial's content
 * by id — otherwise `substituteNested` produces an empty hole.
 *
 * Why we can descend safely: during streaming, inner async content
 * arrives as Flight lazies (`$L`) and outlined promise rows (`$@` —
 * an async Render body's children). Walking past one forces its
 * initialization — which is fine because the chunk will resolve
 * eventually, and our walk of its contents just searches for
 * more partial wrappers (no side effects). `unwrapLazy` returns
 * `LAZY_PENDING` for in-flight chunks, so we stop cleanly (recording
 * the pending count + settlement signal into `stats`) when the bytes
 * aren't here yet.
 *
 * Placeholders (`<i data-partial hidden>`) are skipped — the
 * existing cache entry from a prior render is the thing we want.
 */
export function cacheFromStreamingChildren(
  node: ReactNode,
  cache: PartialCache,
  seen?: Map<string, Set<string>>,
  stats?: LazyWalkStats,
): void {
  if (node == null || typeof node === "boolean") return
  if (typeof node === "string" || typeof node === "number") return
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      cacheFromStreamingChildren(node[i] as ReactNode, cache, seen, stats)
    }
    return
  }
  const unwrapped = unwrapLazy(node)
  if (unwrapped !== node) {
    if (unwrapped === LAZY_PENDING && stats) {
      stats.pending++
      // Capture the in-flight chunk so the caller can re-walk this
      // payload when the row lands (see LazyWalkStats).
      const awaitable = pendingAwaitable(node)
      if (awaitable != null) (stats.thenables ??= []).push(awaitable)
    }
    // Errored OR pending lazy — can't descend to find wrappers. The
    // template-derive keeps the lazy in place so React resolves it
    // through native Suspense; the resolve-time re-walk populates the
    // cache for whatever wrappers are inside.
    if (unwrapped == null || unwrapped === LAZY_PENDING) return
    cacheFromStreamingChildren(unwrapped as ReactNode, cache, seen, stats)
    return
  }
  if (!isValidElement(node)) return

  if (isPartialWrapper(node)) {
    const id = getPartialId(node)
    if (id) {
      const mk = getPartialMatchKey(node) ?? ""
      if (seen) addSeen(seen, id, mk)
      touchClientPartial(id)
      // A stream-defer STUB never stores: the slot stays empty (the
      // PendingSlot gate suspends on it) and no fp registers — the
      // client holds no content for the id until the follow-up
      // lane's real body lands.
      if (isStubWrapper(node)) return
      const outcome = cacheStore(cache, id, mk, node)
      if (outcome === "first" && stats) stats.firstFill = true
      // A STALE store (the out-of-order guard dropped it — the slot
      // holds a newer commit's content) must leave the slot's
      // bookkeeping alone: registering this wrapper's fp would
      // advertise bytes the slot does not hold (a torn superseded
      // payload's re-walk resurrecting a dead claim — the ghost-confirm
      // class), and the cull-park store signal belongs to the content
      // that actually landed.
      if (outcome !== "stale") {
        // A content store for a parton whose mounted content has been
        // parked since its bytes were minted is a RETURNING render —
        // the fp moved while parked, so the parked fiber must be
        // dropped, not reconciled into. The cull-park generation bump
        // does that (see `cull-pair.tsx`); ordinary live updates are
        // untouched. (Skeletons never store — they're client-rendered
        // from the pair, not cached wrappers.)
        contentSlotStored(id)
        // Populate the fingerprint map synchronously from the tree walk
        // rather than waiting for each `<PartialErrorBoundary>` to
        // commit on the client. The commit order is non-deterministic
        // across transitions (React may defer subtrees such as the
        // `<head>` wrapper), so a targeted refetch fired right after a
        // client could otherwise advertise a cached manifest that's missing
        // late-committing ids. The wrapper already carries the
        // fingerprint — just lift it off.
        const fp = getPartialFingerprint(node)
        if (fp) registerClientPartial(id, mk, fp)
      }
    }
    // Descend: nested partial wrappers need their own top-level cache
    // entries so subsequent parent-only refetches with inner
    // placeholders can fill the holes.
    const inner = (node.props as any)?.children
    if (inner != null) cacheFromStreamingChildren(inner, cache, seen, stats)
    return
  }
  if (isPlaceholder(node)) {
    // Placeholder means "server skipped this partial; client keeps
    // its existing cache entry." Don't overwrite — but DO mark the
    // (id, matchKey) pair as seen so the streaming-mode prune step
    // keeps the cache / fingerprint entries that back this placeholder.
    // Without this, a nested partial whose server confirmed an fp
    // match would be pruned out of the cache and the next
    // render's `substituteNested` call would leave the `<i hidden>`
    // placeholder in the DOM — blanking the partial's region until a
    // hard reload.
    const id = getPlaceholderId(node)
    if (id) {
      const mk = getPlaceholderMatchKey(node) ?? ""
      if (seen) addSeen(seen, id, mk)
      // The server still emits this id — refresh its recency so the
      // pool-cap FIFO never ages out an id that only ever fp-skips
      // (the page shell, long-stable chrome).
      touchClientPartial(id)
      // A CONFIRMATION placeholder (fp-skip verdict, `data-partial-confirm`
      // — see partial.tsx's placeholderFor) for a content slot: the
      // parked copy is provably current, so it counts as a live
      // instance again — later stores reconcile in place instead of
      // dropping the fiber.
      if ((node.props as Record<string, unknown>)["data-partial-confirm"] === true) {
        contentSlotConfirmed(id)
      }
    }
    return
  }

  const inner = (node.props as any)?.children
  if (inner != null) {
    cacheFromStreamingChildren(inner, cache, seen, stats)
  }
}

/**
 * True if any node in the tree is a still-pending Flight lazy — i.e. the
 * render is incomplete because a chunk is in flight. Used to defer the
 * cache-mode prune past a mid-stream render so live partials hidden
 * behind an unresolved lazy aren't evicted. Mirrors the lazy-stop rule
 * in `cacheFromStreamingChildren` / `substituteNested`.
 */
export function treeHasPendingLazy(node: ReactNode): boolean {
  if (node == null || typeof node === "boolean") return false
  if (typeof node === "string" || typeof node === "number") return false
  if (Array.isArray(node)) {
    return node.some((c) => treeHasPendingLazy(c as ReactNode))
  }
  const unwrapped = unwrapLazy(node)
  if (unwrapped !== node) {
    if (unwrapped === LAZY_PENDING) return true
    if (unwrapped == null) return false
    return treeHasPendingLazy(unwrapped as ReactNode)
  }
  if (!isValidElement(node)) return false
  return treeHasPendingLazy((node.props as { children?: ReactNode }).children)
}

/**
 * Commit one per-parton lane payload from a live connection: walk the
 * decoded subtree into the partial cache (the wrapper, its nested
 * partials, and their fingerprints), apply the lane's fp-trailer
 * updates, then notify subscribers so `PartialsClient` re-renders the
 * template and `substituteNested` swaps the fresh content in place.
 *
 * The walk is synchronous, so the cache write set (outer wrapper +
 * every nested entry) lands atomically before the notify — a template
 * re-render never observes a half-written commit. A fully-delivered
 * body (the lane closed at its `muxend`) can still hold rows whose
 * DECODE is not initialized yet — an outlined promise row blocked on
 * a client-module import, a chunk referencing a later-settling row —
 * so any walk that stops at a pending chunk schedules a RE-WALK of
 * this same payload for the moment the captured chunks settle,
 * generation-guarded (a newer commit for the parton supersedes it; a
 * late re-walk of an older body must never overwrite newer content).
 * A placeholder root (the lane's parton fp-skipped server-side) walks
 * to a no-op.
 *
 * The notify rides the lane flush quantum by default (one template
 * re-render per animation frame — see `notifyLaneCommitCoalesced`);
 * two classes notify immediately instead: `urgent` commits — lanes
 * servicing an in-flight user statement (first walk only; the
 * resolve-time re-walks are streaming arrival) — and FIRST FILLS (the
 * walk stored content into an empty slot: a flip-in's body replacing
 * the skeleton the user is looking at, a fresh instance's first
 * bytes). Either way the cache walk, live-tree fold and fp updates
 * run NOW: acks and loss reports key off those, so the quantum never
 * shifts anything observable server-side.
 */
export function _commitPartonLane(
  node: ReactNode,
  fpUpdates: FpUpdatesPayload | null,
  partonId?: string,
  opts?: { urgent?: boolean },
): void {
  // A full-body commit supersedes any in-flight re-walks for the same
  // parton — a late re-walk of an older body must never overwrite
  // this newer content.
  let generation: number | undefined
  if (partonId !== undefined) {
    generation = (_laneCommitGeneration.get(partonId) ?? 0) + 1
    _laneCommitGeneration.set(partonId, generation)
  }
  // One store-seq batch per commit: the walk below AND every
  // settlement re-walk of this same payload write under it, so a late
  // re-walk can never clobber a slot a newer commit wrote (the
  // out-of-order guard in `cacheStore` — fuzz class F9).
  const storeSeq = _nextStoreSeq()
  const seen = new Map<string, Set<string>>()
  const stats: LazyWalkStats = { pending: 0, thenables: [] }
  _runWithStoreSeq(storeSeq, () =>
    cacheFromStreamingChildren(node, getCurrentPagePartials(), seen, stats),
  )
  // The committed subtree is part of the DISPLAYED tree the moment the
  // notify's transition re-renders the template — its ids join the
  // pool-cap eviction exemption (`_liveTreeIds`), which payload commits
  // alone would only refresh at the next whole-tree walk. Without the
  // fold, every lane commit's own fp registration could evict the
  // content a sibling lane just delivered.
  _addLiveTreeIds(seen.keys())
  if (fpUpdates) _applyFpUpdates(fpUpdates)
  if (opts?.urgent === true || stats.firstFill === true) notifyLaneCommit()
  else notifyLaneCommitCoalesced()
  // The supersede guard is what makes a re-walk safe; a caller that
  // named no parton gets exactly the one walk.
  if (partonId !== undefined && generation !== undefined) {
    scheduleLaneRewalk(partonId, generation, storeSeq, node, stats)
  }
}

/** Per-parton lane commit generation — the supersede guard for the
 *  lane commits' resolve-time re-walks. */
const _laneCommitGeneration = new Map<string, number>()

/** In-flight settlement re-walk hops (hop promise → its commit's
 *  (parton id, generation), one entry per scheduled hop of
 *  `scheduleLaneRewalk`). The map is the re-walks' own completion
 *  signal — the v2 convergence fuzzer drains it at its settle points
 *  instead of guessing with timers (quiescence from causality). */
const _outstandingLaneRewalks = new Map<Promise<void>, { id: string; gen: number }>()

/** TEST-ONLY: the current lane-commit generation for a parton — pair
 *  with `_settleLaneRewalksForTest(id, gen)` to await exactly one
 *  commit's re-walk chain. */
export function _laneCommitGenerationForTest(partonId: string): number {
  return _laneCommitGeneration.get(partonId) ?? 0
}

/** TEST-ONLY: resolve once every currently-scheduled settlement
 *  re-walk (and any hop it chains) has run. Scope with `partonId` (+
 *  optionally `generation`) to await exactly one commit's chain — a
 *  harness deliberately holding OTHER deliveries' bytes must not await
 *  hops that cannot settle yet. */
export async function _settleLaneRewalksForTest(
  partonId?: string,
  generation?: number,
): Promise<void> {
  const pending = (): Promise<void>[] => {
    const out: Promise<void>[] = []
    for (const [hop, tag] of _outstandingLaneRewalks) {
      if (partonId !== undefined && tag.id !== partonId) continue
      if (generation !== undefined && tag.gen !== generation) continue
      out.push(hop)
    }
    return out
  }
  for (let hops = pending(); hops.length > 0; hops = pending()) {
    await Promise.all(hops)
  }
}

/** TEST-ONLY: reset the lane-commit supersede generations between
 *  fuzz trials (module-level state, same rationale as
 *  `_resetClientStateForTest`). Outstanding re-walk hops are dropped
 *  from the tracking set too — a prior trial's held decode may never
 *  settle, and its hop is moot (the generation reset no-ops it). */
export function _resetLaneCommitStateForTest(): void {
  _laneCommitGeneration.clear()
  _outstandingLaneRewalks.clear()
}

/**
 * Re-walk a committed lane payload each time its captured pending
 * chunks settle, until the walk completes or a newer commit for the
 * parton supersedes it. Each re-walk is streaming arrival and rides
 * the lane flush quantum unless it surfaces a FIRST FILL (a
 * late-resolving row carrying a slot's first content —
 * paint-blocking, same as the commit's own exemption). Lane walks
 * always run outside React's render lifecycle — the same class of
 * walk the commit does at drain, repeated per settlement.
 */
function scheduleLaneRewalk(
  partonId: string,
  generation: number,
  storeSeq: number,
  node: ReactNode,
  stats: LazyWalkStats,
): void {
  const thenables = stats.thenables ?? []
  if (stats.pending === 0 || thenables.length === 0) return
  const hop = Promise.allSettled(thenables.map((t) => Promise.resolve(t))).then((settled) => {
    // A REJECTED chunk means the body TORE mid-stream (a navigation
    // ended the region over this progressive commit) — the stored
    // subtrees hold pending-forever holes, and their fps describe the
    // FULL body the server rendered. Every variant whose slot THIS
    // payload still owns (the slot's store seq is this batch's) is
    // EVICTED — see `_evictTornVariant` for why keeping either half is
    // a ghost-confirm / content-shadowing hazard. A later CONFIRM
    // commit bumps the generation without replacing the slot, so the
    // supersede guard below must NOT gate this.
    if (settled.some((r) => r.status === "rejected")) {
      const torn = new Map<string, Set<string>>()
      const tornStats: LazyWalkStats = { pending: 0, thenables: [] }
      _runWithStoreSeq(storeSeq, () =>
        cacheFromStreamingChildren(node, getCurrentPagePartials(), torn, tornStats),
      )
      const evicted = new Map<string, Set<string>>()
      for (const [id, mks] of torn) {
        for (const mk of mks) {
          if (_slotStoreSeqOf(id, mk) === storeSeq) {
            _evictTornVariant(id, mk)
            addSeen(evicted, id, mk)
          }
        }
      }
      // Composition honesty: a cached wrapper whose content references
      // an evicted variant through a PLACEHOLDER can no longer restore
      // the composition its fp describes — a confirm against it would
      // leave an unbacked hole with no delta left to heal it. Drop the
      // claim (fps only; the content stays displayable); a slot whose
      // content is itself still streaming (pending — its references
      // unknowable) is dropped conservatively too. Over-fetch, never
      // a standing blank.
      if (evicted.size > 0) {
        const cache = getCurrentPagePartials()
        for (const [refId, byMk] of cache) {
          for (const [refMk, refNode] of byMk) {
            if (evicted.get(refId)?.has(refMk)) continue
            const refs = new Map<string, Set<string>>()
            const refStats = { pending: 0 }
            collectPlaceholderRefs(refNode, refs, refStats)
            let referencesEvicted = refStats.pending > 0
            if (!referencesEvicted) {
              for (const [eid, emks] of evicted) {
                const seenMks = refs.get(eid)
                if (seenMks !== undefined && [...emks].some((m) => seenMks.has(m))) {
                  referencesEvicted = true
                  break
                }
              }
            }
            if (referencesEvicted) _dropVariantFingerprints(refId, refMk)
          }
        }
      }
      notifyLaneCommitCoalesced()
      return
    }
    if (_laneCommitGeneration.get(partonId) !== generation) return
    const seen = new Map<string, Set<string>>()
    const next: LazyWalkStats = { pending: 0, thenables: [] }
    // The commit's own batch seq — a slot a newer commit wrote since
    // this payload's first walk stays untouched (out-of-order guard).
    _runWithStoreSeq(storeSeq, () =>
      cacheFromStreamingChildren(node, getCurrentPagePartials(), seen, next),
    )
    // Same live-tree fold as the commit — each re-walk may surface
    // newly-resolved ids.
    _addLiveTreeIds(seen.keys())
    if (next.firstFill === true) notifyLaneCommit()
    else notifyLaneCommitCoalesced()
    scheduleLaneRewalk(partonId, generation, storeSeq, node, next)
  })
  // Track the hop for `_settleLaneRewalksForTest` — a chained hop
  // registers itself inside this one's body, before this entry clears.
  _outstandingLaneRewalks.set(hop, { id: partonId, gen: generation })
  void hop.then(
    () => _outstandingLaneRewalks.delete(hop),
    () => _outstandingLaneRewalks.delete(hop),
  )
}

/**
 * Commit a PRODUCER lane payload progressively: the body is still
 * streaming (its `muxend` comes only at producer resolve), so the
 * first walk stops at the producer's pending rows, commits what has
 * resolved (the template substitutes the wrapper; React suspends on
 * the pending rows — the producer's Suspense fallback), and the
 * commit's re-walk scheduling picks up each settlement. This is the
 * same commit `_commitPartonLane` runs — the producer body is just
 * the case where the pending set is guaranteed non-empty at first
 * walk; the trailer's fp updates are applied by the caller when the
 * body closes.
 */
export function _commitPartonLaneProgressive(
  partonId: string,
  node: ReactNode,
  opts?: { urgent?: boolean },
): void {
  _commitPartonLane(node, null, partonId, opts)
}

/**
 * Apply the `<!--fp-trailer:JSON-->` comment the server appends after
 * `</html>` (see `wrapSsrStreamWithFpTrailer` in `lib/fp-trailer.ts`).
 *
 * The HTML parser places the comment as a `Document` child (alongside
 * `documentElement`) or, in some browsers, as a `documentElement`
 * child. We scan both lists and apply any update map we find.
 *
 * The hydration entry calls this at startup, but on a streaming HTML
 * response the parser may not have reached the trailing comment yet —
 * `document.readyState` is `"interactive"` (DOMContentLoaded fired)
 * but the after-html comments are still in flight. In that case we
 * defer to the `load` event, which only fires once the parser has
 * fully consumed the response body (including the trailing comment).
 *
 * Calling once on startup AND again on `load` is safe: registration
 * is set-additive, so re-applying the same map is a no-op. Calling
 * on startup catches the common case (non-streaming response that
 * arrives complete); the `load` listener covers the streaming case
 * where the comment lands late.
 */
function tryApplyTrailerNow(): boolean {
  const tag = "fp-trailer:"
  const anchorTag = "live-anchor:"
  const candidates: Node[] = []
  for (const c of document.childNodes) candidates.push(c)
  if (document.documentElement) {
    for (const c of document.documentElement.childNodes) candidates.push(c)
  }
  let applied = false
  for (const node of candidates) {
    if (node.nodeType !== 8 /* COMMENT_NODE */) continue
    const text = (node as Comment).data
    if (text.startsWith(anchorTag)) {
      // The document's registry anchor — the heartbeat's first live
      // fire presents it so the connection opens straight into lanes.
      try {
        const anchor = JSON.parse(text.slice(anchorTag.length)) as {
          epoch: string
          ts: number
        }
        if (typeof anchor.epoch === "string" && typeof anchor.ts === "number") {
          _setLiveCatchupAnchor(anchor)
        }
      } catch {
        // Malformed anchor — the live boot falls back to a full render.
      }
      continue
    }
    if (!text.startsWith(tag)) continue
    try {
      const json = text.slice(tag.length).replace(/-\\-/g, "--")
      const updates = JSON.parse(json) as FpUpdatesPayload
      _applyFpUpdates(updates)
      applied = true
    } catch {
      // Malformed trailer — cold fps stay; the next render heals.
    }
  }
  return applied
}

export function _applyFpTrailerFromDocument(): void {
  if (tryApplyTrailerNow()) return
  if (typeof window === "undefined") return
  // Streaming HTML: the trailing comment may not have been parsed
  // into the DOM yet. The parser is fully done at the `load` event,
  // so retry there. DOMContentLoaded fires earlier — for some browsers
  // BEFORE post-`</html>` comments are committed — so we wait for
  // `load`, which is guaranteed to fire after the entire response has
  // been consumed.
  //
  // If `load` already fired (this code runs late on a slow-hydration
  // path), one more synchronous attempt picks up the comment that
  // landed between our two scans.
  if (document.readyState === "complete") {
    tryApplyTrailerNow()
    return
  }
  window.addEventListener("load", () => tryApplyTrailerNow(), { once: true })
}
