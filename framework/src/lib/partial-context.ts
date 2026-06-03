/**
 * Partial parent context — the value type and constructors.
 *
 * A parton's `parent` is its ancestor id path + frame chain; it derives
 * the parton's own identity and scopes its descendants. The parton reads
 * it from server context (the ambient parton, threaded through React's
 * Flight task graph — see [[server-context]] / `docs/internals/server-context.md`)
 * and never as a prop. This module just defines the shape (`PartialCtx`),
 * the root, and the child-derivation helper.
 */

export interface PartialCtx {
  /** Effective ids of ancestor Partials, outer-first. */
  readonly path: readonly string[]
  /** Local frame names from ancestors that opened a frame, outer-first.
   *  Joined with `.` for canonical session / wire keys. */
  readonly frameChain: readonly string[]
}

const EMPTY: readonly string[] = Object.freeze([]) as readonly string[]

export const ROOT: PartialCtx = Object.freeze({
  path: EMPTY,
  frameChain: EMPTY,
})

/** Build the child context a spec scopes its descendants under. Frame
 *  scope opening lives on `<Frame>`, not on partial specs — `parent`'s
 *  `frameChain` flows through unchanged. */
export function _childContext(parent: PartialCtx, selfId: string): PartialCtx {
  const path = Object.freeze([...parent.path, selfId]) as readonly string[]
  return { path, frameChain: parent.frameChain }
}

export function _joinFrameChain(chain: readonly string[]): string {
  return chain.join(".")
}
