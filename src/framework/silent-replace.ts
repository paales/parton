/**
 * Replace the current URL without triggering an RSC refetch.
 *
 * Sets a module-level flag that the navigation listener in
 * entry.browser.tsx checks on the next `navigate` event; if set, the
 * listener skips the intercept (URL updates, no server round-trip).
 * We use a flag rather than `event.info` because `history.replaceState`
 * fires a `navigate` event without an `info` payload.
 *
 * Use for updates driven by client-only state — infinite scroll's
 * `?pages=` and URL-mode search's `?q=` are the canonical callers.
 */
let _silentUntil = 0;

export function silentReplace(url: URL | string): void {
  _silentUntil = performance.now() + 50;
  history.replaceState(history.state, "", url.toString());
}

export function consumeSilentFlag(): boolean {
  if (performance.now() <= _silentUntil) {
    _silentUntil = 0;
    return true;
  }
  return false;
}
