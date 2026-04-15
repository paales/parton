interface NavigationDestination {
  readonly url: string;
  readonly key: string | null;
  readonly id: string | null;
  readonly index: number;
  readonly sameDocument: boolean;
  getState(): unknown;
}

interface NavigateEvent extends Event {
  readonly navigationType: "push" | "replace" | "reload" | "traverse";
  readonly canIntercept: boolean;
  readonly userInitiated: boolean;
  readonly hashChange: boolean;
  readonly destination: NavigationDestination;
  readonly signal: AbortSignal;
  readonly formData: FormData | null;
  readonly formMethod: string | null;
  readonly downloadRequest: string | null;
  readonly info: unknown;
  readonly hasUAVisualTransition: boolean;
  intercept(options?: {
    handler?: () => Promise<void> | void;
    focusReset?: "after-transition" | "manual";
    scroll?: "after-transition" | "manual";
  }): void;
  scroll(): void;
}

interface NavigationEventMap {
  navigate: NavigateEvent;
  navigatesuccess: Event;
  navigateerror: ErrorEvent;
  currententrychange: Event;
}

interface Navigation extends EventTarget {
  readonly currentEntry: NavigationHistoryEntry | null;
  readonly transition: unknown;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  entries(): NavigationHistoryEntry[];
  navigate(
    url: string,
    options?: { state?: unknown; info?: unknown; history?: "auto" | "push" | "replace" },
  ): { committed: Promise<NavigationHistoryEntry>; finished: Promise<NavigationHistoryEntry> };
  reload(options?: { state?: unknown; info?: unknown }): {
    committed: Promise<NavigationHistoryEntry>;
    finished: Promise<NavigationHistoryEntry>;
  };
  traverseTo(key: string): {
    committed: Promise<NavigationHistoryEntry>;
    finished: Promise<NavigationHistoryEntry>;
  };
  back(): { committed: Promise<NavigationHistoryEntry>; finished: Promise<NavigationHistoryEntry> };
  forward(): {
    committed: Promise<NavigationHistoryEntry>;
    finished: Promise<NavigationHistoryEntry>;
  };
  updateCurrentEntry(options: { state: unknown }): void;
  addEventListener<K extends keyof NavigationEventMap>(
    type: K,
    listener: (this: Navigation, ev: NavigationEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof NavigationEventMap>(
    type: K,
    listener: (this: Navigation, ev: NavigationEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
}

interface NavigationHistoryEntry extends EventTarget {
  readonly url: string | null;
  readonly key: string;
  readonly id: string;
  readonly index: number;
  readonly sameDocument: boolean;
  getState(): unknown;
}

declare var navigation: Navigation;

interface Window {
  readonly navigation: Navigation;
}
