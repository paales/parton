/**
 * Page-interactive marker — the explicit "safe to interact" signal.
 *
 * The browser entry calls `markPageInteractive()` from the same
 * effect that attaches the Navigation API `navigate` listener, i.e.
 * once BOTH are true:
 *
 *   1. React's first hydration commit has flushed. Effects run
 *      bottom-up, and the entry's `BrowserRoot` is the tree root, so
 *      by the time its effect runs every client component committed
 *      so far has its handlers attached and React's selective-
 *      hydration replay covers later-streaming Suspense content.
 *   2. The framework's navigate interception is live — link clicks
 *      from here on are intercepted client-side instead of falling
 *      through to full document loads.
 *
 * The marker is written to the DOM (`<html data-parton-interactive>`)
 * so out-of-process observers — Playwright specs, devtools — can wait
 * on the real signal instead of guessing from timing or sniffing
 * React internals. It is set once per document lifetime and never
 * removed: both conditions are monotonic for a given document.
 */
export function markPageInteractive(): void {
  document.documentElement.setAttribute("data-parton-interactive", "")
}
