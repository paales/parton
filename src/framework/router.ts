export type RouteParams = Record<string, string | undefined>;

export function matchPath(url: URL, pattern: string): RouteParams | null {
  const result = new URLPattern({ pathname: pattern }).exec({
    pathname: url.pathname,
  });
  return result ? (result.pathname.groups as RouteParams) : null;
}

export function pickRoute<T>(
  url: URL,
  routes: Array<[string, (params: RouteParams) => T]>,
): T | null {
  for (const [pattern, handler] of routes) {
    const params = matchPath(url, pattern);
    if (params !== null) return handler(params);
  }
  return null;
}
