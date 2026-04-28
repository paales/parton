/**
 * Route pattern matching helper.
 *
 * Each page is now a `ReactCms.partial(Render, '/pattern')` spec; the
 * spec's own `match` skips render on miss. There's no more central
 * `pickRoute` walker — the page list is just a sequence of spec
 * components placed in JSX, only the matching one renders. This module
 * stays for tests / backward-compat shims.
 */

import { matchRoutePattern } from "./context.ts"

export type RouteParams = Record<string, string | undefined>

export function matchPath(pathname: string, pattern: string): RouteParams | null {
  return matchRoutePattern(pathname, pattern)
}
