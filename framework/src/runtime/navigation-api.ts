/**
 * Navigation API types — framework refinements on top of `lib.dom.d.ts`.
 *
 * lib.dom.d.ts already ships: `Navigation`, `NavigationResult`,
 * `NavigationNavigateOptions`, `NavigationReloadOptions`,
 * `NavigationHistoryEntry`, `NavigationType`, `NavigateEvent`, etc.
 * This module adds the framework-specific layer: the targeted-refetch
 * options, the URL-updater callback form, the per-frame state shape,
 * and two views of the navigation handle:
 *
 *   - `FrameworkNavigation` — the public, React-hook-shaped handle
 *     `useNavigation()` returns. Its `navigate()` / `reload()` are
 *     **hooks** (call during render) that return a `[fire, isPending,
 *     error]` tuple. The companion `<NavigationErrorBubbler>` lifts
 *     the error to the nearest React error boundary.
 *   - `ImperativeNavigation` — the internal handle returned by
 *     `_windowNav()` / `_frame()` for non-render call sites (class
 *     components, module-scope code, `useActivate` subscribers). Its
 *     `navigate(target, options)` / `reload(options)` are plain async
 *     methods returning `Promise<NavigationHistoryEntry>`.
 *
 * Access the browser's `navigation` global via `getNavigation()`.
 */

import type { NavigationError } from "./navigation-error.ts"

// ─── Framework state shapes ───────────────────────────────────────

/**
 * State shape the framework persists on each navigation entry.
 *
 *   __frames        — per-frame URL snapshot (for browser back/forward
 *                     diffing and cold-load rehydration)
 *   __frameHistory  — per-frame back/forward stack LOCAL TO THIS ENTRY.
 *                     `past[last]` is the most recent URL you'd return
 *                     to via `frame.back()`; `future[0]` is where
 *                     `frame.forward()` advances to. Kept per-entry so
 *                     browser-level navigation doesn't pollute frame
 *                     history and vice versa — see `docs/frames-navigation.md`
 *                     §"Two history axes".
 *   __frameState    — per-frame user-provided state bag (namespaced so
 *                     multiple frames on one entry can't collide)
 *
 * User state from `useNavigation().navigate()[0](url, { state })` merges
 * onto the top level alongside these framework fields.
 */
export interface FrameEntryState {
  readonly __frames?: Record<string, { url: string }>
  readonly __frameHistory?: Record<string, { past: string[]; future: string[] }>
  readonly __frameState?: Record<string, Record<string, unknown>>
  readonly [userKey: string]: unknown
}

/**
 * Framework-scoped history entry — the standard
 * `NavigationHistoryEntry` with a narrower `getState()` return type.
 * Lets consumers read frame snapshots without `as` casts.
 */
export interface FrameNavigationHistoryEntry extends Omit<NavigationHistoryEntry, "getState"> {
  getState(): FrameEntryState | null
}

// ─── Framework navigate/reload extensions ─────────────────────────

/**
 * Input accepted by the navigate fire function.
 *
 *   navigate("/products")                       // string
 *   navigate(new URL(...))                      // URL instance
 *   navigate(url => { url.searchParams.set("q", q); return url })  // updater
 *
 * The updater receives an absolute `URL` — `new URL(window.location.href)`
 * for the window handle, or the frame URL synthesized against
 * `window.location.origin` for a frame handle. Mutate in place and
 * return the same instance, construct a new one, or return a string
 * (resolved against the same base). Returning a cross-origin URL
 * from a frame handle throws; from the window handle it goes through
 * the browser's normal cross-origin navigation behavior.
 */
export type NavigateTarget = string | URL | ((current: URL) => URL | string)

/**
 * Superset of the browser's `NavigationNavigateOptions` with the
 * framework's targeted-refetch + commit knobs.
 *
 * ── `history` default differs between handles ─────────────────────
 * `"auto"` (the inherited default when `history` is omitted) resolves
 * differently for the window handle vs. a frame handle:
 *
 *   - Window handle: browser default (push for a URL change, replace
 *     when pathname+search are identical). Unchanged.
 *   - Frame handle: patch the current window entry via
 *     `updateCurrentEntry` (no new browser entry) and push onto the
 *     frame's per-entry `__frameHistory[name].past` array. Browser
 *     back/forward stays attached to real page navigations; frame
 *     back/forward lives on its own axis via `frame.back()`.
 *
 * Explicit `"push"` / `"replace"` on either handle use the browser's
 * `nav.navigate()` path — for a frame, this means a new/replaced
 * browser entry AND a push on the per-frame stack. See the decision
 * matrix in `docs/frames-navigation.md` §"Two history axes".
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
  disableTransition?: boolean
  /**
   * CSS-style selector naming the Partials to refetch. Space-separated
   * (or array) list of tokens; each token starts with `#` (unique) or
   * `.` (shared). Union semantics across all tokens:
   *
   *   selector: "#cart"            — just #cart
   *   selector: ".price"           — every Partial with .price
   *   selector: "#cart .price"     — #cart AND every .price
   *   selector: ["#cart", ".price"] — array form, same meaning
   *
   * When set alongside a navigate, the URL is updated but only the
   * matching Partials are re-rendered — the page-level intercept is
   * skipped. Ignored on frame handles (frame navigation always
   * refetches the whole frame subtree).
   */
  selector?: string | string[]
  /**
   * Update the URL without triggering ANY refetch. Useful for
   * bookmarkability-only URL sync (infinite scroll's `?pages=`) where
   * no server work needs to happen. If `selector` is also set,
   * `silent` wins and the refetch is skipped. Ignored on frame
   * handles (frame navigation always refetches the frame).
   */
  silent?: boolean
  /**
   * Per-partial JSX-style props to send with the refetch. Keyed by
   * partial id (selector token without the leading `#`). On the
   * server, these override the snapshot-replayed props in
   * `partialFromSnapshot` so a deep partial-refetch can carry fresh
   * call-site values without re-running the parent wrapper.
   *
   *   navigate(url, {
   *     selector: "#slow",
   *     props: { slow: { flavor: "chocolate" } },
   *   })
   *
   * `<WhenStored>` uses the same wire format under the hood.
   */
  props?: Record<string, Record<string, unknown>>
  /**
   * Cookies to write client-side BEFORE the refetch fetch is issued.
   * Each key is set via `document.cookie = "name=value; path=/; …"`,
   * so the new value travels with the upcoming request and any
   * subsequent navigation. Use this for sticky preferences (theme,
   * editor on/off) where the cookie is the source of truth and a
   * server action would just round-trip the same string.
   *
   * Pass an empty string to delete a cookie (max-age=0). Defaults
   * applied per cookie: `path=/`, `samesite=lax`, `max-age=31536000`
   * (one year) — pass a `; max-age=0` suffix in the value to override.
   *
   * `cookies` lives on `navigate` only — not on `reload`. With
   * `history: "auto"` (the default), `navigate(currentUrl, {cookies})`
   * resolves to `replace` because the URL is unchanged, so it's the
   * canonical "refetch with new cookies" call; `navigate(newUrl,
   * {cookies})` resolves to `push` and carries the cookie into the
   * navigation. Frame handles also write to `document.cookie` (a
   * global write — there's no per-frame cookie scoping today).
   */
  cookies?: Record<string, string>
}

/**
 * Superset of the browser's `NavigationReloadOptions` with the
 * framework's targeted-refetch knobs. `reload({ selector: "#cart" })`
 * refetches a single Partial; `reload({ selector: ".price" })` refetches
 * every Partial carrying the `.price` label.
 *
 * No `cookies` here — cookie writes live on `navigate` only (see
 * `FrameworkNavigateOptions.cookies`). To refetch with new cookies,
 * call `navigate(currentUrl, {cookies, selector?})`; with
 * `history: "auto"` the URL-unchanged case resolves to a replace,
 * which is functionally the same refetch as `reload()` plus the
 * cookie write.
 */
export interface FrameworkReloadOptions extends NavigationReloadOptions {
  selector?: string | string[]
  disableTransition?: boolean
  /** See `FrameworkNavigateOptions.props`. */
  props?: Record<string, Record<string, unknown>>
}

// ─── Fire functions + status tuple ────────────────────────────────

/** Reload fire function — returned in the first slot of the tuple. */
export type Reload = (
  options?: FrameworkReloadOptions,
) => Promise<NavigationHistoryEntry>

/** Navigate fire function — returned in the first slot of the tuple. */
export type Navigate = (
  target: NavigateTarget,
  options?: FrameworkNavigateOptions,
) => Promise<NavigationHistoryEntry>

/**
 * Tuple returned by `useNavigation().reload()` (and the equivalent
 * `.navigate()` shape with `Navigate` in the first slot).
 *
 *   const [reload, isPending, error] = useNavigation().reload()
 *
 *   - `reload`    — call with no args for a whole-page reload, or
 *     with `{ selector }` for a targeted refetch. Returns a Promise
 *     that resolves to the resulting entry or rejects with
 *     `NavigationError` (network / http / decode) or `AbortError`
 *     (newer navigation superseded — silent in pending/error).
 *   - `isPending` — `true` from the call site until the promise
 *     settles. AbortError still clears pending.
 *   - `error`     — the last `NavigationError`, or `null`. Cleared
 *     on the next fire. The bundled `<NavigationErrorBubbler>` also
 *     publishes this error to the nearest React error boundary, so
 *     hosts can either bubble or render their own UI from the third
 *     slot (third slot wins if both are present — the calling
 *     component renders before the Bubbler re-renders).
 */
export type ReloadStatus = readonly [Reload, boolean, NavigationError | null]
export type NavigateStatus = readonly [Navigate, boolean, NavigationError | null]

// ─── FrameworkNavigation (public, React-hook-shaped) ──────────────

/**
 * Typed view of the `Navigation` global with the framework's
 * extensions — what `useNavigation()` returns.
 *
 *   - `currentEntry` / `entries()` return `FrameNavigationHistoryEntry`
 *     so callers can read `__frames` / user state without casts.
 *   - `name` identifies the handle's scope (`null` for the window
 *     handle, the frame name for a frame handle). Framework-only —
 *     not on the browser `Navigation` interface.
 *   - `navigate()` is a **React hook** (call during render). Returns
 *     `[navigate, isPending, error]`. The `navigate` fn accepts a
 *     string / URL / URL-updater and the same options bag as the
 *     imperative form (selector, silent, disableTransition, …).
 *   - `reload()` is the same shape: `[reload, isPending, error]`.
 *     `reload()` with no args reloads the whole page; with
 *     `{ selector }` it's a targeted refetch.
 *
 * The handle returned by `useNavigation()` is memoized — calling
 * `.reload()` / `.navigate()` repeatedly across renders runs the
 * inner hooks consistently. Each call site is one hook invocation;
 * multiple buttons in the same component each need their own
 * `.reload()` call.
 */
export interface FrameworkNavigation extends Omit<
  Navigation,
  "currentEntry" | "entries" | "navigate" | "reload"
> {
  readonly currentEntry: FrameNavigationHistoryEntry | null
  entries(): FrameNavigationHistoryEntry[]
  /**
   * Frame name this handle is bound to, or `null` for the
   * window-scoped handle. Framework-only — not on `Navigation`.
   */
  readonly name: string | null
  navigate(): NavigateStatus
  reload(): ReloadStatus
}

// ─── ImperativeNavigation (internal, non-React call sites) ────────

/**
 * Plain-function navigation handle for framework-internal code that
 * runs outside React render — class component methods, module
 * initialization, callbacks subscribed via `useActivate`. Returned
 * by `_windowNav()` and `_frame()`.
 *
 * `navigate(target, options)` / `reload(options)` return a single
 * `Promise<NavigationHistoryEntry>` — there is no `committed` /
 * `finished` split (the imperative path waits for both internally).
 * The promise rejects with `NavigationError` on failure or
 * `AbortError` on supersede.
 *
 * App code should always reach navigation through `useNavigation()`.
 * This shape is `@internal` and not re-exported through the public
 * barrel.
 */
export interface ImperativeNavigation extends Omit<
  Navigation,
  "currentEntry" | "entries" | "navigate" | "reload"
> {
  readonly currentEntry: FrameNavigationHistoryEntry | null
  entries(): FrameNavigationHistoryEntry[]
  readonly name: string | null
  navigate(
    target: NavigateTarget,
    options?: FrameworkNavigateOptions,
  ): Promise<NavigationHistoryEntry>
  reload(options?: FrameworkReloadOptions): Promise<NavigationHistoryEntry>
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
  const nav = (globalThis as { navigation?: Navigation }).navigation
  return nav ?? null
}
