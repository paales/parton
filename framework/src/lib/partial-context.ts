/**
 * Partial parent context — explicit threading.
 *
 * `<Spec>` components receive `parent: PartialCtx` as a prop and pass a
 * derived child context to their `render` function as `parent`.
 *
 * No ALS / React.cache cell here — every parent/descendant edge flows
 * through props. The `capturePartialContext()` getter and the render-
 * tree-tracking cell from the previous design are gone; if a component
 * needs ancestor context it accepts it as a prop.
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

/** Build the child context a spec passes to its render fn. Frame
 *  scope opening lives on `<Frame>`, not on partial specs — `parent`'s
 *  `frameChain` flows through unchanged. */
export function _childContext(parent: PartialCtx, selfId: string): PartialCtx {
  const path = Object.freeze([...parent.path, selfId]) as readonly string[]
  return { path, frameChain: parent.frameChain }
}

export function _joinFrameChain(chain: readonly string[]): string {
  return chain.join(".")
}
