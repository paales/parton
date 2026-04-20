/**
 * Request context for server components and server actions.
 *
 * Uses AsyncLocalStorage to make the incoming request (cookies, headers)
 * available anywhere during a render or action, and to collect
 * Set-Cookie headers for the response.
 *
 * Tracked accessors (`getCookie`, `getHeader`, `getSearchParam`,
 * `getPathname`) additionally push their `(kind, name)` into a
 * per-Partial *access manifest* held in a second ALS slot. A cached
 * Partial uses that manifest as its cache key surface — so the author
 * doesn't have to re-declare which cookies/headers/URL params their
 * content depends on. See `notes/AUTO_TRACKED_CACHE_KEYS.md`.
 *
 * ── Frame scoping (2026-04-21) ─────────────────────────────────────
 * Accessors also consult a per-request **frame cache** — a mutable
 * `{ current: Request | null }` cell created by `React.cache()`,
 * following the pattern of https://github.com/zhangyu1818/react-server-only-context.
 * `<Partial frame="…">`'s `FrameWrapper` mutates the cell before
 * rendering children; accessors read it. The cell is a per-request
 * singleton, so sibling frames mutate sequentially as React walks
 * their subtrees depth-first.
 *
 * Discipline: accessors must be called BEFORE any `await` in a
 * server component body (the same rule as `HoistingViolationError`
 * for cache manifest keys). After an await the cell may have been
 * mutated by a sibling frame.
 *
 * We dropped the Flight render+decode round-trip that previously
 * contained the scope — it killed progressive streaming inside
 * frames, which is load-bearing for slow async content. The cache
 * pattern preserves streaming at the cost of the hoisting
 * discipline (which we already enforce).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { cache } from "react";

interface FrameworkControl {
  notFound?: boolean;
  redirect?: { url: string; status: number };
}

interface RequestStore {
  request: Request;
  cookies: string[];
  /**
   * Populated by `Root`'s framework-sentinel catch branch. Read by
   * the RSC entry after rendering to pick the right HTTP status /
   * `Location` header / payload marker.
   */
  control?: FrameworkControl;
}

const requestContext = new AsyncLocalStorage<RequestStore>();

/**
 * Per-Partial cache access manifest. Opened by `<Cache>` at the top of
 * its body, closes when Cache returns. Nested Partials open their own
 * manifest (ALS scopes stack naturally), so reads inside an inner
 * Partial are attributed to that Partial, not the outer one.
 *
 * Outside a Cache scope (inside a non-cached Partial body, a server
 * action, etc.), accessor calls no-op for tracking purposes. The
 * underlying read still happens normally — tracking is only a
 * side-effect.
 *
 * Scope holds both `current` (being filled during this render) and
 * `stored` (from a previous render, or null on first render). If
 * `stored` is set and an accessor reads a key NOT in `stored`, we
 * throw immediately — that's a hoisting violation (the Partial's key
 * surface changed). Missing keys (stored has X, current doesn't touch
 * X) are detected post-render by `<Cache>` and treated as a soft
 * failure (log + preserve the old entry).
 */
export interface ManifestScope {
  current: Set<string>;
  stored: ReadonlySet<string> | null;
  partialId: string;
}

const manifestContext = new AsyncLocalStorage<ManifestScope>();

// ─── Frame scope (React.cache mutation cell) ──────────────────────

/**
 * Per-frame scope seen by descendant server components rendered
 * inside a `<Partial frame="name">`. Accessors call `frameRequest()`
 * which reads the cell; falls back to the ALS request when no
 * frame is active.
 *
 * Frames can't use React Context for scoping because React's RSC
 * build (`react.react-server.js`) deliberately excludes
 * `createContext` — server components can't create their own
 * providers. `React.cache` gives us a per-request-singleton object
 * we can mutate during render; descendants see the mutation if
 * they read accessors at the top of their body (before any await).
 */
export interface FrameScope {
  /** Synthetic Request this frame's accessors resolve against. */
  request: Request;
  /** Frame name — debugging. */
  name: string;
}

/**
 * React.cache memoizes this function per request. The mutable cell
 * it returns is shared by every reader in the same render pass;
 * `FrameWrapper` writes to `current` before rendering children,
 * accessors read it.
 */
const frameScopeCell = cache((): { current: FrameScope | null } => ({
  current: null,
}));

/**
 * Called by `FrameWrapper` before rendering a framed subtree. The
 * cell is mutated in place; descendants reading accessors pick up
 * the new value.
 */
export function setCurrentFrameScope(scope: FrameScope | null): void {
  frameScopeCell().current = scope;
}

/** Current frame scope, or `null` if no frame is active. */
export function getCurrentFrameScope(): FrameScope | null {
  return frameScopeCell().current;
}

function frameRequest(): Request | null {
  return frameScopeCell().current?.request ?? null;
}

export function runWithRequest<T>(
  request: Request,
  fn: () => T,
): { result: T; cookies: string[] } {
  const store: RequestStore = { request, cookies: [] };
  const result = requestContext.run(store, fn);
  return { result, cookies: store.cookies };
}

export async function runWithRequestAsync<T>(
  request: Request,
  fn: () => Promise<T>,
): Promise<{ result: T; cookies: string[] }> {
  const store: RequestStore = { request, cookies: [] };
  const result = await requestContext.run(store, fn);
  return { result, cookies: store.cookies };
}

function getStore(): RequestStore {
  const store = requestContext.getStore();
  if (!store)
    throw new Error(
      "No request context — are you inside a server component or action?",
    );
  return store;
}

export function getRequest(): Request {
  return getStore().request;
}

export function setRequest(request: Request): void {
  getStore().request = request;
}

// ─── Manifest tracking ─────────────────────────────────────────────────

export function runWithCacheManifest<T>(
  scope: ManifestScope,
  fn: () => Promise<T>,
): Promise<T> {
  return manifestContext.run(scope, fn);
}

export function getCurrentCacheManifest(): ManifestScope | undefined {
  return manifestContext.getStore();
}

export class HoistingViolationError extends Error {
  readonly partialId: string;
  readonly newKey: string;
  readonly previousKeys: string[];
  constructor(partialId: string, newKey: string, previousKeys: string[]) {
    super(
      `Partial "${partialId}" read "${newKey}" on this render, but its previous ` +
        `renders didn't read it. Request accessors (getCookie / getHeader / ` +
        `getSearchParam / getRoute) must be called unconditionally at the ` +
        `top of the component body, like React hooks. Move the read above ` +
        `any conditional branching, or — if the input genuinely shouldn't ` +
        `participate in the cache key — pass it through cache.vary instead. ` +
        `(previous keys: [${previousKeys.join(", ")}])`,
    );
    this.name = "HoistingViolationError";
    this.partialId = partialId;
    this.newKey = newKey;
    this.previousKeys = previousKeys;
  }
}

function trackAccess(kind: string, name: string): void {
  const scope = manifestContext.getStore();
  if (!scope) return;
  const key = `${kind}:${name}`;
  if (scope.current.has(key)) return;
  if (scope.stored !== null && !scope.stored.has(key)) {
    throw new HoistingViolationError(scope.partialId, key, [...scope.stored].sort());
  }
  scope.current.add(key);
}

/**
 * Given a manifest (from a prior render), resolve each tracked key
 * against the current request and return a values map. Used by
 * `<Cache>` to derive a cache key before running the Partial body on
 * subsequent requests.
 *
 * `request` defaults to the top-level ALS request. Callers inside a
 * frame (e.g. `<Cache>` when it sits inside a `<Partial frame=…>`)
 * pass the frame's Request so URL/pathname keys resolve against the
 * frame's URL instead of the page's.
 *
 * Does NOT participate in tracking — we're reading on behalf of the
 * cache layer, not the user's component.
 */
export function resolveManifest(
  manifest: Set<string>,
  request?: Request,
): Record<string, string> {
  const store = getStore();
  const effectiveRequest = request ?? store.request;
  const url = new URL(effectiveRequest.url);
  const values: Record<string, string> = {};
  for (const spec of manifest) {
    const colonIdx = spec.indexOf(":");
    if (colonIdx < 0) continue;
    const kind = spec.slice(0, colonIdx);
    const name = spec.slice(colonIdx + 1);
    switch (kind) {
      case "cookie":
        values[spec] = readCookieFromRequest(effectiveRequest, name) ?? "";
        break;
      case "header":
        values[spec] = effectiveRequest.headers.get(name) ?? "";
        break;
      case "url":
        values[spec] = url.searchParams.get(name) ?? "";
        break;
      case "pathname": {
        const matched = matchRoutePattern(url.pathname, name);
        if (!matched) {
          values[spec] = "";
          break;
        }
        // Stable serialization: sort keys so manifest hashing is
        // deterministic regardless of JS object property order.
        const sorted: Record<string, string> = {};
        for (const k of Object.keys(matched).sort()) sorted[k] = matched[k];
        values[spec] = JSON.stringify(sorted);
        break;
      }
      default:
        values[spec] = "";
    }
  }
  return values;
}

/**
 * Match a URL pathname against a pattern with `:name` segments.
 *
 *   matchRoutePattern("/p/bulbasaur", "/p/:slug") → { slug: "bulbasaur" }
 *   matchRoutePattern("/p/x/reviews/2", "/p/:slug/reviews/:page")
 *     → { slug: "x", page: "2" }
 *   matchRoutePattern("/other", "/p/:slug") → null
 *
 * Segment semantics:
 *   - Static segments must match literally.
 *   - `:name` matches any single non-slash segment; value decoded.
 *   - Length must match (no optional or wildcard segments for now).
 *   - Leading / trailing slashes are normalized.
 *
 * Kept as a stand-alone helper (not the `URLPattern`-based `matchPath`
 * from `router.ts`) because this one is small, allocation-light, and
 * runs inside `resolveManifest` on every cache key build.
 */
export function matchRoutePattern(
  pathname: string,
  pattern: string,
): Record<string, string> | null {
  const pathSegs = pathname.split("/").filter(Boolean);
  const patSegs = pattern.split("/").filter(Boolean);
  if (pathSegs.length !== patSegs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patSegs.length; i++) {
    const pat = patSegs[i];
    const seg = pathSegs[i];
    if (pat.startsWith(":")) {
      params[pat.slice(1)] = decodeURIComponent(seg);
    } else if (pat !== seg) {
      return null;
    }
  }
  return params;
}

// ─── Tracked accessors ─────────────────────────────────────────────────

/**
 * Read a cookie from a Request, considering any Set-Cookies added
 * during this request's ALS scope (server actions that fired earlier
 * in the chain).
 *
 * The Set-Cookie accumulator is always page-scoped (cookies live on
 * the response, not per-frame), so it's read from the ALS store
 * regardless of whether `request` is the page request or a frame's.
 */
function readCookieFromRequest(request: Request, name: string): string | undefined {
  const store = getStore();
  for (let i = store.cookies.length - 1; i >= 0; i--) {
    const match = store.cookies[i].match(new RegExp(`^${name}=([^;]*)`));
    if (match) return match[1];
  }
  const header = request.headers.get("cookie") ?? "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1];
}

/**
 * Return the Request tracked accessors should read from: the current
 * frame's Request if we're inside a `<Partial frame=…>`, otherwise
 * the top-level page Request.
 */
function currentRequest(): Request {
  return frameRequest() ?? getStore().request;
}

export function getCookie(name: string): string | undefined {
  trackAccess("cookie", name);
  return readCookieFromRequest(currentRequest(), name);
}

export function getHeader(name: string): string | null {
  trackAccess("header", name.toLowerCase());
  return currentRequest().headers.get(name);
}

export function getSearchParam(name: string): string | null {
  trackAccess("url", name);
  return new URL(currentRequest().url).searchParams.get(name);
}

/**
 * Match the current request's pathname against a pattern with `:name`
 * segments and return the extracted params (or `null` if no match).
 *
 *   const { slug } = getPathname("/p/:slug") ?? {};
 *
 * Tracked as a `<Partial cache>` manifest key. The PATTERN (not the
 * extracted values) is what gets recorded — resolution re-runs on
 * every cache-key build, so two requests with different matched
 * values hash to different entries. Authors who want a single Partial
 * snapshot to serve every `/p/:slug` URL should prefer this accessor
 * over closure-capturing props.
 *
 * Pattern grammar: static segments + `:name` capture. Matches segment
 * count exactly; no wildcards / optional segments yet.
 *
 * (This is the only pathname accessor the framework ships — there's
 * no zero-arg "give me the raw pathname" form. Making a pattern
 * required steers authors away from caches that key on the full URL,
 * which blows up registry storage on high-cardinality routes.)
 */
export function getPathname(
  pattern: string,
): Record<string, string> | null {
  trackAccess("pathname", pattern);
  return matchRoutePattern(
    new URL(currentRequest().url).pathname,
    pattern,
  );
}

export function setFrameworkControl(patch: FrameworkControl): void {
  const store = getStore();
  store.control = { ...store.control, ...patch };
}

export function getFrameworkControl(): FrameworkControl | undefined {
  return getStore().control;
}

export function setCookie(
  name: string,
  value: string,
  maxAge = 60 * 60 * 24 * 30,
): void {
  const store = getStore();
  store.cookies.push(
    `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax`,
  );
}
