/**
 * Spec snapshot registry — simplified for the define-step API.
 *
 * Each spec self-registers a `PartialComponent` at module-scope (in
 * `partial.tsx`). At render time the spec emits a `<PartialBoundary>`
 * that calls `registerPartial` with the per-(route, id) facts it
 * needs to support refetches:
 *
 *   - selector tokens for `?partials=` / `?tags=` resolution
 *   - frame path / frameUrl / parentPath for snapshot reconstruction
 *   - varyResult — the spec's dependency surface for THIS render
 *
 * Cache-mode refetches look up the spec component by id (held in
 * `partial.tsx`'s `componentById` map) and render it fresh — there's
 * no captured JSX with closures to replay.
 *
 * Per-request transactional view: pendingWrites isolated per ALS
 * context, atomic commit at end of render.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import type { ReactNode } from "react"
import { _deferRegistryCommit, _setRegistryCommit, getScope } from "../framework/context.ts"
import type { CacheOptions } from "./cache-options.ts"

export interface PartialSnapshot {
  /** Spec catalog type tag (so cache-mode lookup can find the spec
   *  Component when the effective id was per-instance, e.g. slot
   *  blocks rendered with a cmsId override). */
  type: string
  fallback: ReactNode
  errorWith: ReactNode | undefined
  uniqueTokens: string[]
  sharedTokens: string[]
  cache?: CacheOptions
  framePath: readonly string[]
  frameUrl?: string
  parentPath: readonly string[]
  cmsId?: string
  /** The spec's vary result this render — used as cache-key surface
   *  and folded into descendant fp computations. */
  varyResult: unknown
}

interface ContentRoute {
  live: Map<string, PartialSnapshot>
}

interface ScopeStore {
  routes: Map<string, ContentRoute>
}

const canonical = new Map<string, ScopeStore>()

function scopeStore(scope: string): ScopeStore {
  let s = canonical.get(scope)
  if (!s) {
    s = { routes: new Map() }
    canonical.set(scope, s)
  }
  return s
}

function contentRoute(scope: string, route: string): ContentRoute {
  const store = scopeStore(scope)
  let cr = store.routes.get(route)
  if (!cr) {
    cr = { live: new Map() }
    store.routes.set(route, cr)
  }
  return cr
}

// ─── Per-request registry context (ALS) ─────────────────────────────────

export type RegistryMode = "streaming" | "cache"

export interface RequestRegistry {
  scope: string
  route: string
  mode: RegistryMode
  pendingWrites: Map<string, PartialSnapshot>
  invalidations: Set<string>
  committed: boolean
  deferred: boolean
}

const registryAls = new AsyncLocalStorage<RequestRegistry>()

export function enterRequestRegistry(route: string, mode: RegistryMode): RequestRegistry {
  const scope = getScope()
  const ctx: RequestRegistry = {
    scope,
    route,
    mode,
    pendingWrites: new Map(),
    invalidations: new Set(),
    committed: false,
    deferred: false,
  }
  registryAls.enterWith(ctx)
  _setRegistryCommit(() => commitRequestRegistry(ctx))
  return ctx
}

export function getActiveRegistry(): RequestRegistry | null {
  return registryAls.getStore() ?? null
}

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
    ctx.pendingWrites.set(id, snapshot)
    return
  }
  const scope = ctx?.scope ?? getScope()
  contentRoute(scope, route).live.set(id, snapshot)
}

export function lookupPartial(route: string, id: string): PartialSnapshot | undefined {
  const ctx = registryAls.getStore()
  if (ctx && ctx.route === route) {
    if (ctx.invalidations.has(id)) return undefined
    const pending = ctx.pendingWrites.get(id)
    if (pending) return pending
    return canonical.get(ctx.scope)?.routes.get(route)?.live.get(id)
  }
  const scope = ctx?.scope ?? getScope()
  return canonical.get(scope)?.routes.get(route)?.live.get(id)
}

export function getRouteSnapshots(route: string): Map<string, PartialSnapshot> | undefined {
  const ctx = registryAls.getStore()
  if (ctx && ctx.route === route) {
    const live = canonical.get(ctx.scope)?.routes.get(route)?.live
    const haveLive = live && live.size > 0
    if (!haveLive && ctx.pendingWrites.size === 0) return undefined
    const merged = new Map<string, PartialSnapshot>()
    if (live) for (const [id, snap] of live) merged.set(id, snap)
    for (const id of ctx.invalidations) merged.delete(id)
    for (const [id, snap] of ctx.pendingWrites) merged.set(id, snap)
    return merged.size > 0 ? merged : undefined
  }
  const scope = ctx?.scope ?? getScope()
  const live = canonical.get(scope)?.routes.get(route)?.live
  if (!live || live.size === 0) return undefined
  return new Map(live)
}

/** Snapshots from the previous render (for descendant lookups during
 *  fingerprint computation). With the new design the previous render's
 *  vary results are still useful — but right now we just return the
 *  current snapshot map. Kept for back-compat with cache.tsx. */
export function getPreviousRouteSnapshots(
  route: string,
): Map<string, PartialSnapshot> | undefined {
  return getRouteSnapshots(route)
}

export function invalidateSnapshot(route: string, id: string): void {
  const ctx = registryAls.getStore()
  if (ctx && ctx.route === route) {
    ctx.pendingWrites.delete(id)
    ctx.invalidations.add(id)
    return
  }
  const scope = ctx?.scope ?? getScope()
  canonical.get(scope)?.routes.get(route)?.live.delete(id)
}

export function commitRequestRegistry(ctx: RequestRegistry): void {
  if (ctx.committed) return
  ctx.committed = true
  const cr = contentRoute(ctx.scope, ctx.route)
  if (ctx.mode === "streaming") {
    cr.live = new Map()
    for (const [id, snap] of ctx.pendingWrites) {
      if (ctx.invalidations.has(id)) continue
      cr.live.set(id, snap)
    }
  } else {
    for (const id of ctx.invalidations) cr.live.delete(id)
    for (const [id, snap] of ctx.pendingWrites) cr.live.set(id, snap)
  }
}

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
    for (const [route, cr] of store.routes) {
      byRoute[route] = [...cr.live.keys()]
      partials += cr.live.size
    }
  }
  return { routes: store?.routes.size ?? 0, partials, byRoute }
}

if (import.meta.hot) {
  import.meta.hot.on("vite:beforeUpdate", () => clearRegistry())
  import.meta.hot.on("vite:beforeFullReload", () => clearRegistry())
}
