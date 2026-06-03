/**
 * Partial parent context — the value type, the root, and the framework's
 * consumer of the server-context primitive.
 *
 * A parton's `parent` is its ancestor id path + frame chain; it derives the
 * parton's own identity and scopes its descendants. The parton reads it from
 * server context and never as a prop: the parent rides the generic
 * server-context channel ([[server-context]] / `docs/internals/server-context.md`)
 * as one reserved entry. `getAmbientParent` / `setTaskChildContext` here are
 * just that entry's accessors — the parton parent is the framework's own
 * first consumer of `createServerContext`.
 */

import {
  captureCurrentTask,
  createServerContext,
  getServerContext,
  provideOnTask,
} from "./server-context.ts"

export { captureCurrentTask } from "./server-context.ts"

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

// ─── The parton parent as a server context ─────────────────────────────
//
// One reserved entry on the shared server-context channel. Defining it here
// (not in server-context.ts) keeps the primitive free of any PartialCtx
// knowledge: server-context owns the mechanism, this is a consumer.

const ParentContext = createServerContext<PartialCtx>(ROOT)

/** The ambient parton parent (ancestor id path + frame chain) for the
 *  currently-rendering parton. `ROOT` at the top of a render. */
export function getAmbientParent(): PartialCtx {
  return getServerContext(ParentContext)
}

/** Scope `ctx` as the parton parent for `task`'s descendants. Overlays only
 *  the reserved parent entry, so any user server contexts on the map thread
 *  through this parton to its children untouched. */
export function setTaskChildContext(
  task: ReturnType<typeof captureCurrentTask>,
  ctx: PartialCtx,
): void {
  provideOnTask(task, ParentContext, ctx)
}
