/**
 * Request context for server components and server actions.
 *
 * Minimal ALS surface — just the incoming Request and the outgoing
 * Set-Cookie accumulator. No tracked accessors; no per-Partial
 * manifest, frame-scope, or CMS-scope cells. Specs declare their
 * dependencies via `vary` (see `../lib/partial.tsx`); the request is
 * passed to vary explicitly, so no async-context propagation is needed
 * for dependency tracking.
 */

import { AsyncLocalStorage } from "node:async_hooks"

interface FrameworkControl {
  notFound?: boolean
  redirect?: { url: string; status: number }
}

interface RequestStore {
  request: Request
  cookies: string[]
  /** Per-request scope token. Production: `"default"`. Dev: honour
   *  `x-test-scope` header (Playwright workers stamp a per-worker
   *  value so process-wide state buckets don't collide). */
  scope: string
  control?: FrameworkControl
  /** Hook the partial-registry layer registers when it opens its
   *  per-request context. Auto-fires on `runWithRequestAsync` exit
   *  unless `deferRegistryCommit` was set. */
  commitRegistry?: () => void
  deferRegistryCommit?: boolean
}

const requestContext = new AsyncLocalStorage<RequestStore>()

const DEFAULT_SCOPE = "default"

function deriveScope(request: Request): string {
  if (import.meta.env?.DEV) {
    const h = request.headers.get("x-test-scope")
    if (h) return h
  }
  return DEFAULT_SCOPE
}

export function isTestMode(): boolean {
  return getStore().scope !== DEFAULT_SCOPE
}

export function runWithRequest<T>(request: Request, fn: () => T): { result: T; cookies: string[] } {
  const store: RequestStore = { request, cookies: [], scope: deriveScope(request) }
  const result = requestContext.run(store, fn)
  return { result, cookies: store.cookies }
}

export async function runWithRequestAsync<T>(
  request: Request,
  fn: () => Promise<T>,
): Promise<{ result: T; cookies: string[] }> {
  const store: RequestStore = { request, cookies: [], scope: deriveScope(request) }
  const result = await requestContext.run(store, fn)
  if (store.commitRegistry && !store.deferRegistryCommit) {
    store.commitRegistry()
  }
  return { result, cookies: store.cookies }
}

export function _setRegistryCommit(commit: () => void): void {
  getStore().commitRegistry = commit
}

export function _deferRegistryCommit(): void {
  const store = requestContext.getStore()
  if (store) store.deferRegistryCommit = true
}

export function _captureCommitHandle(): () => void {
  const store = requestContext.getStore()
  if (!store) return () => {}
  return () => {
    if (store.commitRegistry) store.commitRegistry()
  }
}

function getStore(): RequestStore {
  const store = requestContext.getStore()
  if (!store) throw new Error("No request context — are you inside a server component or action?")
  return store
}

export function getRequest(): Request {
  return getStore().request
}

export function setRequest(request: Request): void {
  getStore().request = request
}

export function getScope(): string {
  return requestContext.getStore()?.scope ?? DEFAULT_SCOPE
}

export function getDefaultScope(): string {
  return DEFAULT_SCOPE
}

/**
 * Match a URL pathname against a pattern with `:name` segments and
 * optional tail catch-all `*`. Returns extracted params or `null`.
 *
 *   matchRoutePattern("/p/x", "/p/:slug") → { slug: "x" }
 *   matchRoutePattern("/x/y", "/*")        → { "*": "x/y" }
 */
export function matchRoutePattern(
  pathname: string,
  pattern: string,
): Record<string, string> | null {
  const pathSegs = pathname.split("/").filter(Boolean)
  const patSegs = pattern.split("/").filter(Boolean)
  const params: Record<string, string> = {}
  for (let i = 0; i < patSegs.length; i++) {
    const pat = patSegs[i]
    if (pat === "*") {
      params["*"] = pathSegs.slice(i).map(decodeURIComponent).join("/")
      return params
    }
    if (i >= pathSegs.length) return null
    const seg = pathSegs[i]
    if (pat.startsWith(":")) {
      params[pat.slice(1)] = decodeURIComponent(seg)
    } else if (pat !== seg) {
      return null
    }
  }
  if (pathSegs.length !== patSegs.length) return null
  return params
}

// ─── Framework control channel (notFound / redirect sentinels) ─────────

export function setFrameworkControl(patch: FrameworkControl): void {
  const store = getStore()
  store.control = { ...store.control, ...patch }
}

export function getFrameworkControl(): FrameworkControl | undefined {
  return getStore().control
}

// ─── Cookies ─────────────────────────────────────────────────────────

/**
 * Read a cookie from the current request, considering any Set-Cookies
 * added during this request's ALS scope.
 *
 * @internal Avoid in spec render / vary callbacks — vary receives a
 * pre-parsed `cookies` map in its scope, which is the supported
 * surface. This function stays available for server actions and
 * framework internals (session lookup, CMS runtime) that legitimately
 * read cookies outside the vary scope.
 */
export function readCookie(name: string): string | undefined {
  const store = getStore()
  for (let i = store.cookies.length - 1; i >= 0; i--) {
    const match = store.cookies[i].match(new RegExp(`^${name}=([^;]*)`))
    if (match) return match[1]
  }
  const header = store.request.headers.get("cookie") ?? ""
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  return match?.[1]
}

/** @internal alias kept for session.ts back-compat. */
export const _readCookieUntracked = readCookie

/**
 * Parse the entire `Cookie` header from a request into a record.
 * Vary scope uses this to expose cookies declaratively.
 */
export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get("cookie") ?? ""
  const out: Record<string, string> = {}
  if (!header) return out
  for (const pair of header.split(";")) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const name = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    out[name] = value
  }
  return out
}

export function setCookie(name: string, value: string, maxAge = 60 * 60 * 24 * 30): void {
  const store = getStore()
  store.cookies.push(`${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax`)
}
