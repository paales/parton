import { getPathname } from "./context.ts"

export type RouteParams = Record<string, string | undefined>

/**
 * Top-level route match. Tracked: records the pattern in the
 * surrounding `<Partial>`'s manifestScope (and in any wrapping
 * `<Cache>`'s access manifest), so routing decisions automatically
 * participate in fingerprint computation and cache key derivation.
 *
 * Pattern grammar (`matchRoutePattern` in `framework/context.ts`):
 *
 *   - Static segments must match literally.
 *   - `:name` matches any single non-slash segment; value decoded.
 *   - `*` (final segment only) matches zero or more remaining
 *     segments, captured as `*` in the returned params.
 *
 *   matchPath("/p/:slug")            // /p/bulbasaur → {slug: "bulbasaur"}
 *   matchPath("/magento/*")          // /magento/foo/bar → {*: "foo/bar"}
 *   matchPath("/*")                  // /anything → {*: "anything"}
 *   matchPath("/")                   // /anything → null (segment count)
 *
 * The pattern lives in the manifest, NOT the matched values — so
 * 50k product slugs all share the same pattern key, the cache key
 * varies via the resolved match against the current request.
 */
export function matchPath(pattern: string): RouteParams | null {
  return getPathname(pattern)
}

/**
 * Walk a pattern → handler list; invoke the first handler whose
 * pattern matches.
 *
 * Reads EVERY pattern up-front via `matchPath` (tracked) before
 * dispatching, so the surrounding `<Partial>`'s manifest captures
 * the union of all routing patterns regardless of which one
 * matched on this render. That keeps the manifest stable across
 * navigations: navigating from `/cache-demo` to `/pokemon/1` reads
 * the same set of pathname patterns either way, just with different
 * resolved values, so the fp differs without tripping the hoisting
 * check.
 */
export function pickRoute<T>(routes: Array<[string, (params: RouteParams) => T]>): T | null {
  // Phase 1: probe every pattern. Records each in the manifest.
  const matched: Array<[(params: RouteParams) => T, RouteParams] | null> = routes.map(
    ([pattern, handler]) => {
      const params = matchPath(pattern)
      return params !== null ? [handler, params] : null
    },
  )
  // Phase 2: dispatch first match.
  for (const m of matched) {
    if (m !== null) return m[0](m[1])
  }
  return null
}
