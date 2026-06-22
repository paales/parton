/**
 * Server context — values threaded parent→child through React's Flight
 * render tree, readable during any Server Component's render.
 *
 * One channel, every consumer. Context rides an `AsyncLocalStorage` the Flight
 * patch enters per component (`partonStorage`; see `.yarn/patches/` and
 * `docs/internals/server-context.md`) — the SAME store the reader uses, so the
 * carrier follows post-`await` continuations as reliably as a read does. The
 * unit in the store is a per-render FRAME `{ ctx, parton? }`, where `ctx` is the
 * immutable map this subtree reads. Each context is one keyed entry — every
 * `createServerContext` value, and the framework's own parton parent
 * ([[partial-context]]).
 *
 * A provider scopes its descendants by returning a `PARTON_CTX` MARKER
 * (`{ $$typeof, _ctx, _node }`): the Flight patch's `renderModelDestructive`
 * renders `_node` inside `partonStorage.run({ ctx: _ctx }, …)`. Because the
 * marker lives in the model, it re-establishes the overlay every time the
 * subtree is walked — including React's deferred serialization pass — instead
 * of relying on a render-time scope that wouldn't survive it. Nothing mutates a
 * shared slot, so a read is valid ANYWHERE in a render (before or after awaits)
 * and sibling subtrees stay isolated. This module knows nothing about
 * `PartialCtx`; it is the generic primitive, and consumers live elsewhere.
 */

import React from "react"
import type { ReactNode } from "react"

/** Sentinel shared with the Flight patch (`Symbol.for`, same key both sides):
 *  a provider's return value carries it so `renderModelDestructive` re-scopes
 *  the subtree. */
const PARTON_CTX = Symbol.for("parton.serverContext")

/** The per-render frame in the parton ALS, as far as server context cares:
 *  `ctx` is the immutable context map this subtree reads. */
interface RenderFrame {
  ctx?: ReadonlyMap<symbol, unknown> | null
}

const sharedInternals = (
  React as unknown as {
    __SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: {
      __partonStorage?: { getStore(): RenderFrame | undefined }
    }
  }
).__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE

/**
 * A server context handle. Created at module scope by `createServerContext`.
 * The value is BOTH the provider component (`<Ctx value={…}>…</Ctx>`) and the
 * handle passed to `getServerContext`.
 */
export interface ServerContext<T> {
  (props: { value: T; children?: ReactNode }): ReactNode
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
  // Synchronous: overlay this context onto a fresh copy of the inherited map
  // (every other context threads through untouched, nothing shared is mutated)
  // and hand it to the patch as a marker wrapping the children. The patch
  // renders `_node` inside `run({ ctx: _ctx })`, so the overlay reaches the
  // descendants on every walk — render AND serialization.
  const Provider = ({ value, children }: { value: T; children?: ReactNode }): ReactNode => {
    const frame = sharedInternals?.__partonStorage?.getStore()
    const next = new Map(frame?.ctx ?? null)
    next.set(id, value)
    return { $$typeof: PARTON_CTX, _ctx: next, _node: children } as unknown as ReactNode
  }
  return Object.assign(Provider, { _id: id, _default: defaultValue })
}

/**
 * Read the current value of `context` — the nearest enclosing provider's
 * value on this branch, or the context's default. Call inside a Server
 * Component's render (anywhere — before or after awaits).
 *
 * Reads the rendering frame's immutable `ctx`. A provider never reads its own
 * overlay: it writes `childCtx` and the patch renders the children in a fresh
 * frame whose `ctx` is that overlay, so only descendants see it.
 */
export function getServerContext<T>(context: ServerContext<T>): T {
  const frame = sharedInternals?.__partonStorage?.getStore()
  const map = frame?.ctx
  return map && map.has(context._id) ? (map.get(context._id) as T) : context._default
}
