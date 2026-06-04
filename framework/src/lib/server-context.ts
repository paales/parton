/**
 * Server context — values threaded parent→child through React's Flight
 * render tree, readable during any Server Component's render.
 *
 * One channel, every consumer. A single immutable map flows down the task
 * graph (patched into `createTask`; see `.yarn/patches/` and
 * `docs/internals/server-context.md`). Each context is one keyed entry —
 * every `createServerContext` value, and the framework's own parton parent
 * (which rides this channel as a reserved entry; see [[partial-context]]).
 *
 * Reads ride an `AsyncLocalStorage` the patch enters per component
 * (`partonStorage.run(task, …)`, mirroring React's dev `componentStorage`).
 * Because an ALS store follows the JS engine's post-`await` continuation, a
 * read is valid ANYWHERE in a render — before or after awaits — and sibling
 * renders stay isolated. This module knows nothing about `PartialCtx`; it is
 * the generic primitive, and consumers live elsewhere.
 */

import React from "react"
import type { ReactNode } from "react"

/** A Flight Task, as far as server context cares: the inherited map and the
 *  map it scopes for its descendants. The patch threads both at `createTask`. */
interface ServerTask {
  /** Map inherited from the parent task — what this component reads. */
  serverContext?: ReadonlyMap<symbol, unknown>
  /** Map this task scopes for its descendants — what its children inherit. */
  serverChildContext?: ReadonlyMap<symbol, unknown>
}

const sharedInternals = (
  React as unknown as {
    __SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: {
      __partonStorage?: { getStore(): ServerTask | undefined }
    }
  }
).__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE

/**
 * A server context handle. Created at module scope by `createServerContext`.
 * The value is BOTH the provider component (`<Ctx value={…}>…</Ctx>`) and the
 * handle passed to `getServerContext`.
 */
export interface ServerContext<T> {
  (props: { value: T; children?: ReactNode }): Promise<ReactNode>
  readonly _id: symbol
  readonly _default: T
}

/**
 * Create a server context with a default value. Define it at module scope,
 * place its provider anywhere in the server tree, and read it from any
 * descendant's render with `getServerContext`:
 *
 *     const Theme = createServerContext<"light" | "dark">("light")
 *     // …
 *     <Theme value="dark">
 *       <Page />          // getServerContext(Theme) → "dark" anywhere inside
 *     </Theme>
 */
export function createServerContext<T>(defaultValue: T): ServerContext<T> {
  const id = Symbol("serverContext")
  const Provider = async ({
    value,
    children,
  }: {
    value: T
    children?: ReactNode
  }): Promise<ReactNode> => {
    // Yield once so this provider renders in its own (outlined) task before
    // overlaying — a sibling sharing the parent task then never inherits the
    // overlay. Copying the existing map threads every other context through
    // untouched; the captured task object is stable across the yield.
    const task = sharedInternals?.__partonStorage?.getStore()
    await null
    if (task) {
      const next = new Map(task.serverChildContext ?? task.serverContext)
      next.set(id, value)
      task.serverChildContext = next
    }
    return children
  }
  return Object.assign(Provider, { _id: id, _default: defaultValue })
}

/**
 * Read the current value of `context` — the nearest enclosing provider's
 * value on this branch, or the context's default. Call inside a Server
 * Component's render (anywhere — before or after awaits).
 *
 * Reads the task's child map first, then its inherited map: a provider's
 * direct (un-outlined) child renders in the provider's OWN task, where the
 * scoped value lives on `serverChildContext`; an outlined descendant gets it
 * as its inherited `serverContext`. The only writer is a provider, which
 * overlays then returns its children without reading — so a read never
 * returns the reader's own overlay.
 */
export function getServerContext<T>(context: ServerContext<T>): T {
  const task = sharedInternals?.__partonStorage?.getStore()
  const map = task?.serverChildContext ?? task?.serverContext
  return map && map.has(context._id) ? (map.get(context._id) as T) : context._default
}
