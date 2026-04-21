/**
 * Navigation API types for the pieces TypeScript 5.9's `lib.dom.d.ts`
 * doesn't ship yet, plus framework-specific refinements.
 *
 * Already in lib.dom.d.ts, re-used from there (don't redeclare):
 *   - `NavigationType`
 *   - `NavigationHistoryEntry` + `NavigationHistoryEntryEventMap`
 *   - `NavigationActivation`
 *
 * Missing (declared here): `Navigation`, `NavigateEvent`,
 * `NavigationDestination`, `NavigationTransition`,
 * `NavigationCurrentEntryChangeEvent`.
 *
 * Everything is a regular module export — no ambient declarations,
 * no global pollution. Access the browser's `navigation` global via
 * `getNavigation()`.
 */

export interface NavigationResult {
  readonly committed: Promise<NavigationHistoryEntry>;
  readonly finished: Promise<NavigationHistoryEntry>;
}

export interface NavigationNavigateOptions {
  state?: unknown;
  info?: unknown;
  history?: "auto" | "push" | "replace";
}

export interface NavigationReloadOptions {
  state?: unknown;
  info?: unknown;
}

export interface NavigationUpdateCurrentEntryOptions {
  state: unknown;
}

export interface NavigationInterceptOptions {
  handler?: () => Promise<void> | void;
  focusReset?: "after-transition" | "manual";
  scroll?: "after-transition" | "manual";
}

export interface NavigationDestination {
  readonly url: string;
  readonly key: string | null;
  readonly id: string | null;
  readonly index: number;
  readonly sameDocument: boolean;
  getState(): unknown;
}

export interface NavigationTransition {
  readonly navigationType: NavigationType;
  readonly from: NavigationHistoryEntry;
  readonly finished: Promise<void>;
}

export interface NavigationCurrentEntryChangeEvent extends Event {
  readonly navigationType: NavigationType | null;
  readonly from: NavigationHistoryEntry;
}

export interface NavigateEvent extends Event {
  readonly navigationType: NavigationType;
  readonly destination: NavigationDestination;
  readonly canIntercept: boolean;
  readonly userInitiated: boolean;
  readonly hashChange: boolean;
  readonly signal: AbortSignal;
  readonly formData: FormData | null;
  readonly formMethod: string | null;
  readonly downloadRequest: string | null;
  readonly info: unknown;
  readonly hasUAVisualTransition: boolean;
  readonly sourceElement: Element | null;
  intercept(options?: NavigationInterceptOptions): void;
  scroll(): void;
}

export interface NavigationEventMap {
  navigate: NavigateEvent;
  navigatesuccess: Event;
  navigateerror: ErrorEvent;
  currententrychange: NavigationCurrentEntryChangeEvent;
}

export interface Navigation extends EventTarget {
  readonly activation: NavigationActivation | null;
  readonly currentEntry: NavigationHistoryEntry | null;
  readonly transition: NavigationTransition | null;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;

  entries(): NavigationHistoryEntry[];
  navigate(url: string, options?: NavigationNavigateOptions): NavigationResult;
  reload(options?: NavigationReloadOptions): NavigationResult;
  traverseTo(key: string): NavigationResult;
  back(options?: { info?: unknown }): NavigationResult;
  forward(options?: { info?: unknown }): NavigationResult;
  updateCurrentEntry(options: NavigationUpdateCurrentEntryOptions): void;

  addEventListener<K extends keyof NavigationEventMap>(
    type: K,
    listener: (this: Navigation, ev: NavigationEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof NavigationEventMap>(
    type: K,
    listener: (this: Navigation, ev: NavigationEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

// ─── Framework refinements ────────────────────────────────────────

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
export interface FrameNavigationHistoryEntry
  extends Omit<NavigationHistoryEntry, "getState"> {
  getState(): FrameEntryState | null;
}

/**
 * Typed view of the `Navigation` global: same shape, but `currentEntry`
 * / `entries()` return `FrameNavigationHistoryEntry`.
 */
export interface FrameworkNavigation
  extends Omit<Navigation, "currentEntry" | "entries"> {
  readonly currentEntry: FrameNavigationHistoryEntry | null;
  entries(): FrameNavigationHistoryEntry[];
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
export function getNavigation(): FrameworkNavigation | null {
  const nav = (globalThis as { navigation?: Navigation }).navigation;
  return (nav as FrameworkNavigation | undefined) ?? null;
}
