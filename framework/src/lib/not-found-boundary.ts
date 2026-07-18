/**
 * The declared 404 boundary — the app-level statement "URLs not
 * covered by a declared `match` pattern are 404 here".
 *
 * The match registry alone can never make that call: an app built of
 * bare, matchless partons (the website's tile world) renders real
 * content at EVERY pathname, so "no registered pattern covers this
 * URL" is not a 404 signal — it's an app semantic. The declaration is
 * the explicit signal: `createRscHandler({ unmatched: "not-found" })`
 * flags it at entry-construction time (module eval, before any request
 * arrives), and only then may the entry short-circuit an unmatched
 * plain document GET ahead of the whole-tree render, and only then
 * does `PartialRoot` mount the framework's `NotFoundFallback` for the
 * render paths the entry never sees (a soft navigation on a held
 * connection).
 *
 * Process-global, like the match registry it qualifies: spec identity
 * and match gates are define-time module state, and so is this.
 */

let declared = false

/** Record the app's declaration. Called by `createRscHandler` when the
 *  config carries `unmatched: "not-found"` — never by app code. */
export function _declareNotFoundBoundary(): void {
  declared = true
}

/** True once the app has declared its 404 boundary. */
export function hasNotFoundBoundary(): boolean {
  return declared
}

/** Test-only: clear the declaration between cases that exercise both
 *  the declared and undeclared shapes in one process. */
export function _resetNotFoundBoundary(): void {
  declared = false
}
