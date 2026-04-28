/**
 * Partial snapshot registry — split into two layers along the
 * **what's stable across routes vs. what isn't** seam.
 *
 * ── Two-layer storage ─────────────────────────────────────────────
 *
 * Per-id **identity** (global, route-independent): everything that
 * follows from a Partial's declaration in code — its selector tokens,
 * cache options, frame path, parent chain, cmsId, tracked-accessor
 * manifest. Stable per id by stance: two declarations of `#cart` with
 * structurally different shapes is misuse, not a feature to support.
 *
 * Per-(route, id) **content** (route-keyed): the JSX that captures the
 * Partial's rendered children, with closures bound to that render's
 * inputs. `<ProductHero sku="abc"/>` registered on `/p/abc` can't be
 * replayed on `/p/def`, so this layer stays route-scoped.
 *
 * The public `PartialSnapshot` type is the union — every caller still
 * sees one fact-bag per id-on-route. Reads combine identity + content;
 * writes decompose the snapshot into the two stores.
 *
 * ── Why split ────────────────────────────────────────────────────
 *
 * The client `_cache` is keyed by partial id alone (no route). Server-
 * side a route-keyed registry meant the same Partial appearing on two
 * routes had two separate manifest entries. First-render-on-route-B
 * for an id whose body has URL deps would see `stored = null` (B's
 * route bucket was empty) — and if the client's cached fp from route A
 * happened to match B's structural-only fp, the fp-skip path
 * registered an empty manifest and poisoned the next render with a
 * bogus hoisting violation. Carrying identity globally eliminates the
 * mismatch by construction.
 *
 * ── Per-request transactional view ───────────────────────────────
 *
 * Both layers expose a per-request ALS context with `pendingWrites`
 * (ALS-isolated buffers) so concurrent requests on the same route
 * can't observe each other's mid-render state. Commit at end of
 * render atomically merges pendingWrites into the canonical layers.
 *
 *   - **streaming commit** — content for this route is replaced
 *     wholesale; ids that didn't re-register on this route disappear
 *     from `content[route].live`. Identity for those ids has its
 *     manifest baseline rotated (live → baseline) so the next render
 *     compares against a stable point-in-time view, not a moving
 *     target. Identity for OTHER ids (not in this route) is untouched.
 *   - **cache commit** — content overlays onto `content[route].live`,
 *     identity entries get their `liveManifest` updated for any
 *     newly-discovered keys. Manifest *baselines* are NOT rotated by
 *     cache commits, mirroring master's permissive behavior so the
 *     conditional-read-after-early-return idiom (e.g. `<SearchArea>`
 *     reading `url:q` only when `?search=` is set) keeps working.
 *
 * ── Scoping ─────────────────────────────────────────────────────────
 * Keyed by `getScope()` — Playwright workers > 1 get isolated maps so
 * snapshots registered by worker A don't resolve for worker B.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import type { ReactNode } from "react"
import { _deferRegistryCommit, _setRegistryCommit, getScope } from "../framework/context.ts"
import type { CacheOptions } from "./cache-options.ts"

// ─── Public snapshot shape (caller-facing) ─────────────────────────

export interface PartialSnapshot {
  /** Content JSX as it appeared inside `<Partial>` at capture time. */
  content: ReactNode
  /** The fallback prop on the Partial (for Suspense wrapping). */
  fallback: ReactNode
  /** The errorWith prop on the Partial (for ErrorBoundary fallback). */
  errorWith: ReactNode | undefined
  /** `#`-token names from the Partial's selector (without the `#` prefix).
   *  Used to resolve `?partials=X` refetches against dynamic Partials
   *  that the bootstrap walk can't see. A Partial's effective id is
   *  derived from these (single token → that name; multiple → sorted-join). */
  uniqueTokens: string[]
  /** `.`-token names from the Partial's selector (without the `.` prefix).
   *  Used to resolve `?tags=X` refetches with union semantics. */
  sharedTokens: string[]
  /** Cache options if the Partial declared `cache={…}`. Stored so
   *  cache-mode refetches re-apply the same cache semantics. */
  cache?: CacheOptions
  /** Canonical frame path if the Partial declared `frame="…"` — the
   *  dotted join of every enclosing `frame` ancestor plus this local
   *  name. Two `<Partial frame="list">`s under different parent
   *  frames thus resolve to distinct paths (`"products.list"` vs
   *  `"blog.list"`), which the session store, navigation state, and
   *  `?__frame=` wire param all key off. Empty array means the
   *  Partial doesn't open a frame.
   *
   *  Per-id identity. Same id appearing on multiple routes must have
   *  the same frame path (otherwise it's a structural misuse). */
  framePath: readonly string[]
  /** The author-provided `frameUrl` fallback. Session overrides it
   *  when present; kept here as the cold-session default. */
  frameUrl?: string
  /** Outer-first chain of ancestor partial ids, captured from the
   *  Partial's `parent` prop. `[]` for top-level Partials. Per-id
   *  identity — same Partial declared in different ancestor chains
   *  on different routes is misuse. */
  parentPath: readonly string[]
  /** Stable storage key for CMS-authored content, from the Partial's
   *  `cmsId` prop. Per-id identity. */
  cmsId?: string
  /** Tracked-accessor read pattern. The body's reads are determined
   *  by the component function — same on every route — so this is
   *  per-id identity, not per-(route, id). For the snapshot returned
   *  by `getPreviousRouteSnapshots`, this is the BASELINE manifest
   *  (rotated only at streaming-mode commits) — what a body sees as
   *  `manifestScope.stored`. For `lookupPartial` / `getRouteSnapshots`
   *  this is the LIVE manifest (updated on every commit). */
  manifest?: ReadonlySet<string>
}

// ─── Internal storage shapes ──────────────────────────────────────

/** Per-(route, id) facts. Closure-bearing JSX that can't be replayed
 *  across routes. */
interface PartialContent {
  content: ReactNode
  fallback: ReactNode
  errorWith: ReactNode | undefined
}

/** Per-id facts. Stable across routes (by the
 *  "two-declarations-with-different-shapes-is-misuse" stance). */
interface PartialIdentity {
  uniqueTokens: string[]
  sharedTokens: string[]
  cache?: CacheOptions
  framePath: readonly string[]
  frameUrl?: string
  parentPath: readonly string[]
  cmsId?: string
  /** Latest captured tracked-accessor read pattern. Updated on every
   *  commit (streaming or cache). Frozen-by-value to avoid aliasing
   *  any request's still-mutating manifestScope. */
  liveManifest?: ReadonlySet<string>
  /** Snapshot of `liveManifest` rotated at streaming-mode commits.
   *  What `getPreviousRouteSnapshots` returns as `snap.manifest`, and
   *  what bodies see as `manifestScope.stored`. Cache-mode commits
   *  do NOT rotate this — preserves master's permissive behavior so
   *  conditional-read-after-early-return Partials don't throw
   *  retroactively. */
  baselineManifest?: ReadonlySet<string>
}

interface ContentRoute {
  /** Latest content for ids on this route. Streaming commits replace
   *  wholesale; cache commits overlay. */
  live: Map<string, PartialContent>
  /** Snapshot of `live` taken AT a streaming entry, before this
   *  render's pendingWrites are applied. Read by
   *  `getPreviousRouteSnapshots` to reconstitute baseline-era
   *  PartialSnapshots for descendant-fold + body's `previousSnap`
   *  lookup. */
  baseline: Map<string, PartialContent>
}

interface ScopeStore {
  identity: Map<string, PartialIdentity>
  content: Map<string, ContentRoute>
}

// ─── Module-global canonical state ────────────────────────────────

const canonical = new Map<string, ScopeStore>()

function scopeStore(scope: string): ScopeStore {
  let store = canonical.get(scope)
  if (!store) {
    store = { identity: new Map(), content: new Map() }
    canonical.set(scope, store)
  }
  return store
}

function contentRoute(scope: string, route: string): ContentRoute {
  const store = scopeStore(scope)
  let cr = store.content.get(route)
  if (!cr) {
    cr = { live: new Map(), baseline: new Map() }
    store.content.set(route, cr)
  }
  return cr
}

// ─── Decompose / combine ──────────────────────────────────────────

function decomposeSnapshot(snap: PartialSnapshot): {
  identity: PartialIdentity
  content: PartialContent
} {
  return {
    identity: {
      uniqueTokens: snap.uniqueTokens,
      sharedTokens: snap.sharedTokens,
      cache: snap.cache,
      framePath: snap.framePath,
      frameUrl: snap.frameUrl,
      parentPath: snap.parentPath,
      cmsId: snap.cmsId,
      liveManifest: snap.manifest,
    },
    content: {
      content: snap.content,
      fallback: snap.fallback,
      errorWith: snap.errorWith,
    },
  }
}

function combineLive(identity: PartialIdentity, content: PartialContent): PartialSnapshot {
  return {
    content: content.content,
    fallback: content.fallback,
    errorWith: content.errorWith,
    uniqueTokens: identity.uniqueTokens,
    sharedTokens: identity.sharedTokens,
    cache: identity.cache,
    framePath: identity.framePath,
    frameUrl: identity.frameUrl,
    parentPath: identity.parentPath,
    cmsId: identity.cmsId,
    manifest: identity.liveManifest,
  }
}

function combineBaseline(identity: PartialIdentity, content: PartialContent): PartialSnapshot {
  return {
    content: content.content,
    fallback: content.fallback,
    errorWith: content.errorWith,
    uniqueTokens: identity.uniqueTokens,
    sharedTokens: identity.sharedTokens,
    cache: identity.cache,
    framePath: identity.framePath,
    frameUrl: identity.frameUrl,
    parentPath: identity.parentPath,
    cmsId: identity.cmsId,
    manifest: identity.baselineManifest,
  }
}

function freezeManifestSet(m: ReadonlySet<string> | undefined): ReadonlySet<string> | undefined {
  if (m === undefined) return undefined
  return new Set(m)
}

// ─── Per-request registry context (ALS) ─────────────────────────────────

export type RegistryMode = "streaming" | "cache"

interface RequestIdentityWrite {
  identity: PartialIdentity
  /** True iff this id had no liveManifest in the canonical baseline
   *  view at request entry — drives the streaming-commit decision
   *  about whether to seed `baselineManifest` for this id (so the
   *  next render's `stored` reflects this render's discovery rather
   *  than a stale empty value). */
  baselineSeen: boolean
}

export interface RequestRegistry {
  scope: string
  /** Pathname this context is bound to. Set by `<PartialRoot>` when
   *  it opens the context. */
  route: string
  /** Streaming or cache mode. Decides commit semantics. */
  mode: RegistryMode
  /** Frozen view of identity (id → baseline-era PartialIdentity) at
   *  context entry. Reads stay stable for the duration of this
   *  request. */
  identityPreview: ReadonlyMap<string, PartialIdentity>
  /** Frozen view of content[route].baseline at context entry. */
  contentPreview: ReadonlyMap<string, PartialContent>
  /** Identity writes accumulated during this render, keyed by id. */
  pendingIdentity: Map<string, RequestIdentityWrite>
  /** Content writes accumulated during this render, keyed by id. */
  pendingContent: Map<string, PartialContent>
  /** Ids invalidated by the manifest-scope `onViolation` self-recovery
   *  hook. Excluded from canonical at commit. */
  invalidations: Set<string>
  committed: boolean
  deferred: boolean
}

const registryAls = new AsyncLocalStorage<RequestRegistry>()

const EMPTY_IDENTITY_VIEW: ReadonlyMap<string, PartialIdentity> = new Map()
const EMPTY_CONTENT_VIEW: ReadonlyMap<string, PartialContent> = new Map()

function snapshotIdentityPreview(scope: string): ReadonlyMap<string, PartialIdentity> {
  const store = canonical.get(scope)
  if (!store || store.identity.size === 0) return EMPTY_IDENTITY_VIEW
  // Return a baseline-flavored identity map: each entry has
  // `liveManifest` set to its `baselineManifest` so combineLive +
  // combineBaseline both produce the baseline-era view that
  // master's `previousScopes` returned. Other identity fields are
  // route-stable; copy as-is.
  const out = new Map<string, PartialIdentity>()
  for (const [id, ident] of store.identity) {
    out.set(id, {
      ...ident,
      // Both flavors collapse to baseline for the preview.
      liveManifest: ident.baselineManifest,
    })
  }
  return out
}

function snapshotContentPreview(scope: string, route: string): ReadonlyMap<string, PartialContent> {
  const cr = canonical.get(scope)?.content.get(route)
  if (!cr || cr.baseline.size === 0) return EMPTY_CONTENT_VIEW
  return new Map(cr.baseline)
}

/**
 * Open a request-scoped registry context bound to `route` in `mode`.
 * Called by `<PartialRoot>` once it has resolved the request.
 *
 * Streaming entries rotate the per-route `content.baseline := live`
 * so this render's `previousView` captures whatever's been registered
 * since the last streaming render of this route. Cache entries skip
 * that rotation; their bodies see the older streaming-baseline.
 */
export function enterRequestRegistry(route: string, mode: RegistryMode): RequestRegistry {
  const scope = getScope()
  if (mode === "streaming") {
    // Snapshot live → baseline for this route's content. Per-id
    // identity baselines are rotated lazily at streaming COMMIT (so
    // we're only rotating ids that this streaming render is
    // responsible for, not every id seen in the previous canonical).
    const cr = contentRoute(scope, route)
    cr.baseline = new Map(cr.live)
  }
  const ctx: RequestRegistry = {
    scope,
    route,
    mode,
    identityPreview: snapshotIdentityPreview(scope),
    contentPreview: snapshotContentPreview(scope, route),
    pendingIdentity: new Map(),
    pendingContent: new Map(),
    invalidations: new Set(),
    committed: false,
    deferred: false,
  }
  registryAls.enterWith(ctx)
  _setRegistryCommit(() => commitRequestRegistry(ctx))
  return ctx
}

/** Read the active request registry, if one has been opened. */
export function getActiveRegistry(): RequestRegistry | null {
  return registryAls.getStore() ?? null
}

/**
 * Mark the active context as deferring its commit to a downstream
 * trigger (typically a stream-flush hook). `runWithRequestAsync`'s
 * fallback auto-commit checks this flag and skips the commit.
 *
 * Idempotent. No-op when no context is active.
 */
export function deferRequestRegistryCommit(): void {
  const ctx = registryAls.getStore()
  if (ctx) ctx.deferred = true
  _deferRegistryCommit()
}

// ─── Public registry API ────────────────────────────────────────────────

export function registerPartial(route: string, id: string, snapshot: PartialSnapshot): void {
  const ctx = registryAls.getStore()
  if (ctx && ctx.route === route) {
    ctx.invalidations.delete(id)
    const { identity, content } = decomposeSnapshot(snapshot)
    // Was this id known in the streaming baseline at request entry?
    // Drives whether streaming commit should seed `baselineManifest`
    // (first-time-seen ids) or only update `liveManifest` (already
    // had a baseline from a prior streaming render).
    const baselineSeen = ctx.identityPreview.has(id)
    ctx.pendingIdentity.set(id, { identity, baselineSeen })
    ctx.pendingContent.set(id, content)
    return
  }
  // Outside a request context (or wrong route): write directly to
  // canonical with frozen manifests. Test fixtures hit this path.
  const scope = ctx?.scope ?? getScope()
  const { identity, content } = decomposeSnapshot(snapshot)
  const store = scopeStore(scope)
  const existing = store.identity.get(id)
  store.identity.set(id, {
    ...identity,
    liveManifest: freezeManifestSet(identity.liveManifest),
    // Direct writes (no streaming context) seed both layers
    // identically — there's nothing to roll back.
    baselineManifest:
      identity.liveManifest !== undefined
        ? freezeManifestSet(identity.liveManifest)
        : existing?.baselineManifest,
  })
  contentRoute(scope, route).live.set(id, content)
}

export function lookupPartial(route: string, id: string): PartialSnapshot | undefined {
  const ctx = registryAls.getStore()
  if (ctx && ctx.route === route) {
    if (ctx.invalidations.has(id)) return undefined
    const pendingIdent = ctx.pendingIdentity.get(id)?.identity
    const pendingCont = ctx.pendingContent.get(id)
    const liveContent = pendingCont ?? canonical.get(ctx.scope)?.content.get(route)?.live.get(id)
    if (!liveContent) return undefined
    const liveIdent = pendingIdent ?? canonical.get(ctx.scope)?.identity.get(id)
    if (!liveIdent) return undefined
    return combineLive(liveIdent, liveContent)
  }
  const scope = ctx?.scope ?? getScope()
  const store = canonical.get(scope)
  const cont = store?.content.get(route)?.live.get(id)
  if (!cont) return undefined
  const ident = store?.identity.get(id)
  if (!ident) return undefined
  return combineLive(ident, cont)
}

/**
 * Live view: every id with content registered on this route, combined
 * with that id's current identity. Used by selector resolution and
 * the editor tree pane.
 */
export function getRouteSnapshots(route: string): Map<string, PartialSnapshot> | undefined {
  const ctx = registryAls.getStore()
  if (ctx && ctx.route === route) {
    const liveContentMap = canonical.get(ctx.scope)?.content.get(route)?.live
    const haveLive = liveContentMap && liveContentMap.size > 0
    if (!haveLive && ctx.pendingContent.size === 0) return undefined
    const merged = new Map<string, PartialContent>()
    if (liveContentMap) {
      for (const [id, content] of liveContentMap) merged.set(id, content)
    }
    for (const id of ctx.invalidations) merged.delete(id)
    for (const [id, content] of ctx.pendingContent) merged.set(id, content)
    if (merged.size === 0) return undefined
    const result = new Map<string, PartialSnapshot>()
    const liveIdentMap = canonical.get(ctx.scope)?.identity
    for (const [id, content] of merged) {
      const ident = ctx.pendingIdentity.get(id)?.identity ?? liveIdentMap?.get(id)
      if (!ident) continue
      result.set(id, combineLive(ident, content))
    }
    return result.size > 0 ? result : undefined
  }
  const scope = ctx?.scope ?? getScope()
  const store = canonical.get(scope)
  const liveContentMap = store?.content.get(route)?.live
  if (!liveContentMap || liveContentMap.size === 0) return undefined
  const result = new Map<string, PartialSnapshot>()
  for (const [id, content] of liveContentMap) {
    const ident = store?.identity.get(id)
    if (!ident) continue
    result.set(id, combineLive(ident, content))
  }
  return result.size > 0 ? result : undefined
}

/**
 * Baseline view: snapshots as they were at the start of this
 * render (streaming) or the last streaming render (cache). Bodies
 * read this for `manifestScope.stored`; the descendant-manifest
 * fold reads it to capture transitive URL deps.
 */
export function getPreviousRouteSnapshots(route: string): Map<string, PartialSnapshot> | undefined {
  const ctx = registryAls.getStore()
  if (ctx && ctx.route === route) {
    if (ctx.contentPreview.size === 0) return undefined
    const result = new Map<string, PartialSnapshot>()
    for (const [id, content] of ctx.contentPreview) {
      const ident = ctx.identityPreview.get(id)
      if (!ident) continue
      // identityPreview already collapses liveManifest →
      // baselineManifest, so combineLive returns the baseline view.
      result.set(id, combineLive(ident, content))
    }
    return result.size > 0 ? result : undefined
  }
  const scope = ctx?.scope ?? getScope()
  const store = canonical.get(scope)
  const cr = store?.content.get(route)
  if (!cr || cr.baseline.size === 0) return undefined
  const result = new Map<string, PartialSnapshot>()
  for (const [id, content] of cr.baseline) {
    const ident = store?.identity.get(id)
    if (!ident) continue
    result.set(id, combineBaseline(ident, content))
  }
  return result.size > 0 ? result : undefined
}

/**
 * Drop a Partial's snapshot from this request's view. Called by the
 * manifest-scope `onViolation` hook when `recordAccess` throws — the
 * bad manifest captured before the throw must not survive into the
 * next render's `stored` baseline. Inside a request context: removes
 * from pendingWrites and records an invalidation. Outside: drops
 * from canonical directly.
 */
export function invalidateSnapshot(route: string, partialId: string): void {
  const ctx = registryAls.getStore()
  if (ctx && ctx.route === route) {
    ctx.pendingIdentity.delete(partialId)
    ctx.pendingContent.delete(partialId)
    ctx.invalidations.add(partialId)
    return
  }
  const scope = ctx?.scope ?? getScope()
  const store = canonical.get(scope)
  if (!store) return
  store.identity.delete(partialId)
  for (const cr of store.content.values()) {
    cr.live.delete(partialId)
    cr.baseline.delete(partialId)
  }
}

/**
 * Atomically merge this request's pendingWrites into the canonical
 * stores. Idempotent.
 *
 * Streaming commit (this render produced the full tree for `route`):
 *   - content[route].live ← pendingContent (replace; ids that didn't
 *     re-register on this route are dropped).
 *   - identity[id].liveManifest ← pendingIdentity[id].liveManifest
 *     (frozen-by-value).
 *   - identity[id].baselineManifest ← pendingIdentity[id].liveManifest
 *     (rotation: each rendered id's baseline catches up to live, so
 *     the next render's `stored` reflects what this render saw).
 *
 * Cache commit (only some ids re-rendered):
 *   - content[route].live overlaid with pendingContent.
 *   - identity[id].liveManifest updated.
 *   - identity[id].baselineManifest UNTOUCHED — preserves master's
 *     permissive behavior so conditional-read-after-early-return
 *     bodies don't throw retroactively.
 */
export function commitRequestRegistry(ctx: RequestRegistry): void {
  if (ctx.committed) return
  ctx.committed = true

  const store = scopeStore(ctx.scope)
  const cr = contentRoute(ctx.scope, ctx.route)

  // Apply identity writes — manifests frozen by value.
  //
  // Strict rotation: BOTH live and baseline catch up to the captured
  // manifest on every commit (streaming or cache). Bodies on
  // subsequent renders see the latest dependency surface as
  // `manifestScope.stored`, so a body that adds a new tracked-
  // accessor read mid-flight (the conditional-read-after-early-
  // return idiom) trips a `HoistingViolationError` on the very
  // next render — not silently waits for a later streaming render
  // to surface the regression.
  //
  // Page-level reads must run inside a `<Partial>` body to attribute
  // correctly. Page handlers wired through `pickRoute` are wrapped
  // in `<Partial selector="#page">` (see `src/app/root.tsx`) so their
  // top-level reads land on `#page`'s manifestScope rather than
  // drifting onto the LAST sibling Partial that ran (typically a
  // nav-link inside `<AppNav/>`).
  //
  // The undefined fall-throughs handle fp-skip register paths
  // (`manifest: stored ?? undefined`): no body ran this render, so
  // there's no fresh manifest to commit; preserve whatever identity
  // already had.
  for (const [id, write] of ctx.pendingIdentity) {
    if (ctx.invalidations.has(id)) continue
    const existing = store.identity.get(id)
    const frozenLive = freezeManifestSet(write.identity.liveManifest)
    const nextLive = frozenLive ?? existing?.liveManifest
    const nextBaseline = frozenLive ?? existing?.baselineManifest
    store.identity.set(id, {
      uniqueTokens: write.identity.uniqueTokens,
      sharedTokens: write.identity.sharedTokens,
      cache: write.identity.cache,
      framePath: write.identity.framePath,
      frameUrl: write.identity.frameUrl,
      parentPath: write.identity.parentPath,
      cmsId: write.identity.cmsId,
      liveManifest: nextLive,
      baselineManifest: nextBaseline,
    })
  }

  // Apply content writes for this route.
  if (ctx.mode === "streaming") {
    cr.live = new Map()
    for (const [id, content] of ctx.pendingContent) {
      if (ctx.invalidations.has(id)) continue
      cr.live.set(id, content)
    }
  } else {
    for (const id of ctx.invalidations) cr.live.delete(id)
    for (const [id, content] of ctx.pendingContent) {
      cr.live.set(id, content)
    }
  }

  // Identity-only invalidations (no pending write but in invalidations
  // set) — drop the identity entry too. Rare path; surfaces when a
  // body throws a HoistingViolationError before re-registering.
  for (const id of ctx.invalidations) {
    if (!ctx.pendingIdentity.has(id)) {
      store.identity.delete(id)
    }
  }
}

/**
 * Clear registry entries. No argument (or `"all"`): every scope is
 * wiped — used by HMR dispose hooks. Pass a scope to target a single
 * worker's entries.
 */
export function clearRegistry(scope?: string | "all"): void {
  if (scope === undefined || scope === "all") {
    canonical.clear()
    return
  }
  canonical.delete(scope)
}

export function _registryStats(): {
  routes: number
  partials: number
  byRoute: Record<string, string[]>
} {
  const byRoute: Record<string, string[]> = {}
  let partials = 0
  const store = canonical.get(getScope())
  if (store) {
    for (const [route, cr] of store.content) {
      byRoute[route] = [...cr.live.keys()]
      partials += cr.live.size
    }
  }
  return { routes: store?.content.size ?? 0, partials, byRoute }
}

// HMR: snapshotted React elements reference component functions whose
// module identities change across edits. Clear everything (all scopes)
// on update to prevent stale references from being re-rendered.
if (import.meta.hot) {
  import.meta.hot.on("vite:beforeUpdate", () => clearRegistry())
  import.meta.hot.on("vite:beforeFullReload", () => clearRegistry())
}
