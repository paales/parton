/**
 * Server context — values threaded parent→child through React's Flight
 * render tree, readable during any Server Component's render.
 *
 * One channel, every consumer. Context rides an `AsyncLocalStorage` the Flight
 * patch enters per component (`partonStorage`; see `.yarn/patches/` and
 * `docs/internals/server-context.md`) — the SAME store the reader uses, so the
 * carrier follows post-`await` continuations as reliably as a read does. The
 * unit in the store is a per-render FRAME `{ ctx, settle?, parton? }`, where
 * `ctx` is the immutable map this subtree reads and `settle` the nearest
 * enclosing parton's settlement scope. Each context is one keyed entry — every
 * `createServerContext` value, and the framework's own parton parent
 * ([[partial-context]]).
 *
 * A provider scopes its descendants by returning a `PARTON_CTX` MARKER
 * (`{ $$typeof, _ctx, _node, _scope }`): the Flight patch's
 * `renderModelDestructive` renders `_node` inside
 * `partonStorage.run({ ctx: _ctx, settle: _scope ?? inherited }, …)`. Because the
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

/**
 * A subtree settlement scope — the refcount of unfinished Flight tasks in
 * one parton's subtree, threaded through the same per-render ALS frames the
 * context map rides (`frame.settle`, `task.settleScope`, the marker's
 * `_scope`). The patch owns the counting: `createTask` increments `pending`
 * on the scope AND every ancestor (`parent` chain — a task belongs to all
 * enclosing partons), each task's terminal transition (completed, errored,
 * aborted, halted, stream-closed) decrements the same chain, and the scope
 * whose count crosses zero fires `onSettled` exactly once (`settled` latch).
 * See `scripts/patch-plugin-rsc-server-context.mjs` and
 * `docs/archive/task-settle.md`.
 */
export interface SettleScope {
  readonly parent: SettleScope | null
  pending: number
  settled: boolean
  readonly onSettled: (() => void) | null
}

/** The scope with its framework-side callback list. The patch never touches
 *  `_cbs`; it only counts and calls `onSettled`. */
interface InternalSettleScope extends SettleScope {
  readonly _cbs: Array<() => void>
  readonly toJSON: () => null
}

/** The per-render frame in the parton ALS, as far as server context cares:
 *  `ctx` is the immutable context map this subtree reads, `settle` the
 *  nearest enclosing parton's settlement scope. */
interface RenderFrame {
  ctx?: ReadonlyMap<symbol, unknown> | null
  settle?: InternalSettleScope | null
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
 *
 * `_settle` is framework-internal: a parton hands its own settlement scope to
 * its `ParentContext` provider so the outlined subtree task (and every task
 * under it) counts into that parton. User providers never pass it — their
 * subtrees inherit the ambient scope.
 */
export interface ServerContext<T> {
  (props: { value: T; children?: ReactNode; _settle?: SettleScope | null }): ReactNode
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
  const Provider = ({
    value,
    children,
    _settle,
  }: {
    value: T
    children?: ReactNode
    _settle?: SettleScope | null
  }): ReactNode => {
    const frame = sharedInternals?.__partonStorage?.getStore()
    const next = new Map(frame?.ctx ?? null)
    next.set(id, value)
    return {
      $$typeof: PARTON_CTX,
      _ctx: next,
      _node: children,
      _scope: _settle ?? null,
    } as unknown as ReactNode
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

// ─── Subtree settlement ────────────────────────────────────────────────

/**
 * Open a settlement scope for the parton whose render is on the current
 * frame. Framework-internal: `partial.tsx` calls this once per full parton
 * render, before invoking `Render`, and hands the returned scope to the
 * parton's `ParentContext` provider (`_settle`), whose marker seeds it into
 * the outlined subtree task.
 *
 * The scope's `parent` is the frame's inherited scope (the nearest enclosing
 * parton), so the patch's chain-walk counts each task into every enclosing
 * parton. The call also stamps the scope onto the CURRENT frame — that is
 * what `_onPartonSettled` reads, and the render frame's continuations (an
 * async `Render`'s post-`await` code included) all see it.
 *
 * Callback dispatch is microtask-deferred: `onSettled` is invoked
 * synchronously by the patch at the zero-crossing — inside the Flight
 * scheduler's stack — so the framework defers each registered callback with
 * `queueMicrotask` to keep arbitrary consumer code (and its throws) out of
 * `retryTask` / the abort sweep.
 */
export function _openPartonSettleScope(): SettleScope {
  const frame = sharedInternals?.__partonStorage?.getStore()
  const cbs: Array<() => void> = []
  const scope: InternalSettleScope = {
    parent: frame?.settle ?? null,
    pending: 0,
    settled: false,
    onSettled: () => {
      for (const cb of cbs) queueMicrotask(cb)
    },
    _cbs: cbs,
    // The scope rides the provider's `_settle` prop, and dev-build
    // Flight captures raw element props into debug-info rows — where a
    // function-bearing object serializes as an `$E` row that a
    // server-side decode (the byte cache's replay) cannot resolve.
    // The scope is render-machinery, not data: its wire form is null.
    toJSON: () => null,
  }
  if (frame) frame.settle = scope
  return scope
}

/**
 * Register a callback that fires once the NEAREST enclosing parton's subtree
 * has settled — every Flight task in it reached a terminal state (completed,
 * errored, or aborted), including tasks of nested partons. Call during a
 * parton's render (the parton's own `Render`, or any plain server component
 * under it).
 *
 * Fires exactly once per scope, on a microtask. Registration after the scope
 * already settled fires the callback on the next microtask. A parton whose
 * render never reaches its `ParentContext` marker (it threw before returning,
 * or was fp-skipped/deferred — no full render) never observes settlement:
 * the scope counts nothing and the callback is dropped with it.
 */
export function _onPartonSettled(cb: () => void): void {
  const scope = sharedInternals?.__partonStorage?.getStore()?.settle
  if (!scope)
    throw new Error(
      "_onPartonSettled() must be called during a parton's render — no settlement scope on the rendering frame.",
    )
  if (scope.settled) queueMicrotask(cb)
  else scope._cbs.push(cb)
}
