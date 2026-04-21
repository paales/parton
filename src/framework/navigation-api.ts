/**
 * Navigation API types — framework refinements on top of `lib.dom.d.ts`.
 *
 * lib.dom.d.ts already ships: `Navigation`, `NavigationResult`,
 * `NavigationNavigateOptions`, `NavigationReloadOptions`,
 * `NavigationHistoryEntry`, `NavigationType`, `NavigateEvent`, etc.
 * This module adds the framework-specific layer: the targeted-refetch
 * options, the URL-updater callback form, the per-frame state shape,
 * and a typed view of the global (`FrameworkNavigation`) that
 * `useNavigation()` returns.
 *
 * Access the browser's `navigation` global via `getNavigation()`.
 */

// ─── Framework state shapes ───────────────────────────────────────

/**
 * State shape the framework persists on each navigation entry.
 *
 *   __frames     — per-frame URL snapshot (for back/forward diffing)
 *   __frameState — per-frame user-provided state bag (namespaced so
 *                  multiple frames on one entry can't collide)
 *
 * User state from `useNavigation().navigate(url, { state })` merges
 * onto the top level alongside these framework fields.
 */
export interface FrameEntryState {
  readonly __frames?: Record<string, { url: string }>;
  readonly __frameState?: Record<string, Record<string, unknown>>;
  readonly [userKey: string]: unknown;
}

/**
 * Framework-scoped history entry — the standard
 * `NavigationHistoryEntry` with a narrower `getState()` return type.
 * Lets consumers read frame snapshots without `as` casts.
 */
export interface FrameNavigationHistoryEntry extends Omit<
  NavigationHistoryEntry,
  "getState"
> {
  getState(): FrameEntryState | null;
}

// ─── Framework navigate/reload extensions ─────────────────────────

/**
 * Input accepted by `FrameworkNavigation.navigate()`.
 *
 *   nav.navigate("/products")                       // string
 *   nav.navigate(new URL(...))                      // URL instance
 *   nav.navigate(url => { url.searchParams.set("q", q); return url })  // updater
 *
 * The updater receives an absolute `URL` — `new URL(window.location.href)`
 * for the window handle, or the frame URL synthesized against
 * `window.location.origin` for a frame handle. Mutate in place and
 * return the same instance, construct a new one, or return a string
 * (resolved against the same base). Returning a cross-origin URL
 * from a frame handle throws; from the window handle it goes through
 * the browser's normal cross-origin navigation behavior.
 */
export type NavigateTarget =
  | string
  | URL
  | ((current: URL) => URL | string);

/**
 * Superset of the browser's `NavigationNavigateOptions` with the
 * framework's targeted-refetch + commit knobs.
 */
export interface FrameworkNavigateOptions extends NavigationNavigateOptions {
  /**
   * Bypass the React transition wrapper on commit.
   *
   * Default (`false`): the client wraps the response commit in
   * `startTransition`, so React keeps the current UI visible until
   * the new content is fully ready. No Suspense fallback flash, no
   * per-chunk streaming — the whole refetch appears as one atomic
   * swap. Good for "just swap values" UX (cart badge, prices).
   *
   * `true`: commit without a transition. React shows Suspense
   * fallbacks for pending children and commits Flight chunks as
   * they arrive, giving per-row progressive streaming. Good for
   * search / filter results where per-row reveal improves perceived
   * latency.
   */
  disableTransition?: boolean;
  /**
   * Explicit partial ids to refetch. When set alongside a navigate,
   * the URL is updated but only these partials are re-rendered — the
   * page-level intercept is skipped. Stacks with `tags`: both lists
   * land on the refetch URL as `?partials=…&tags=…`, and the server
   * resolves their union. Ignored on frame handles.
   */
  ids?: string[];
  /**
   * Tags to refetch. Resolved server-side against the route-scoped
   * partial registry — matching partials are re-rendered, everything
   * else is served from the client cache via fingerprint-match
   * placeholders. Ignored on frame handles.
   */
  tags?: string[];
  /**
   * Update the URL without triggering ANY refetch. Useful for
   * bookmarkability-only URL sync (infinite scroll's `?pages=`) where
   * no server work needs to happen. If `ids` / `tags` are also set,
   * `silent` wins and the refetch is skipped. Ignored on frame
   * handles (frame navigation always refetches the frame).
   */
  silent?: boolean;
}

/**
 * Superset of the browser's `NavigationReloadOptions` with the
 * framework's targeted-refetch knobs. `reload({ ids })` / `reload({ tags })`
 * refetches just those partials without changing the URL.
 */
export interface FrameworkReloadOptions extends NavigationReloadOptions {
  ids?: string[];
  tags?: string[];
  disableTransition?: boolean;
}

/**
 * Handle-boundary `NavigationResult` with non-optional `committed` /
 * `finished`. TS 6's `lib.dom.d.ts` declares these optional (weaker
 * than the WHATWG spec), which would force every caller to null-check.
 * Our handle always fills both — composed from the underlying
 * browser result plus any framework-side work (targeted refetch,
 * frame dispatch) so callers can `await result.finished` unconditionally.
 */
export interface FrameworkNavigationResult {
  readonly committed: Promise<NavigationHistoryEntry>;
  readonly finished: Promise<NavigationHistoryEntry>;
}

// ─── FrameworkNavigation ──────────────────────────────────────────

/**
 * Typed view of the `Navigation` global with the framework's
 * extensions:
 *
 *   - `currentEntry` / `entries()` return `FrameNavigationHistoryEntry`
 *     so callers can read `__frames` / user state without casts.
 *   - `name` identifies the handle's scope (`null` for the window
 *     handle, the frame name for a frame handle). Framework-only —
 *     not on the browser `Navigation` interface.
 *   - `navigate(target, options)` accepts a URL-updater callback as
 *     well as the usual `string | URL`, and the options include
 *     `ids`/`tags`/`silent`/`disableTransition` for targeted refetch.
 *   - `reload(options)` accepts `ids`/`tags` for targeted refetch
 *     without a URL change.
 *
 * `useNavigation()` returns a `FrameworkNavigation`. The window handle
 * is a small proxy over `window.navigation`; a frame handle is a
 * proxy with frame-scoped overrides (per-frame URL, per-frame
 * `canGoBack`, refetch on `navigate`).
 */
export interface FrameworkNavigation extends Omit<
  Navigation,
  "currentEntry" | "entries" | "navigate" | "reload"
> {
  readonly currentEntry: FrameNavigationHistoryEntry | null;
  entries(): FrameNavigationHistoryEntry[];
  /**
   * Frame name this handle is bound to, or `null` for the
   * window-scoped handle. Framework-only — not on `Navigation`.
   */
  readonly name: string | null;
  navigate(
    target: NavigateTarget,
    options?: FrameworkNavigateOptions,
  ): FrameworkNavigationResult;
  reload(options?: FrameworkReloadOptions): FrameworkNavigationResult;
}

/**
 * Typed accessor for the browser's `navigation` global. Returns
 * `null` during SSR module evaluation or in test runtimes that
 * haven't shimmed the Navigation API.
 *
 *   const nav = getNavigation();
 *   if (!nav) return;
 *   nav.navigate("/foo", { info: { reason: "prefetch" } });
 */
export function getNavigation(): Navigation | null {
  const nav = (globalThis as { navigation?: Navigation }).navigation;
  return nav ?? null;
}
