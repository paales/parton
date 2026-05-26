/**
 * Cell — typed, identity-keyed slot of server-authoritative state.
 *
 * The primitive is one constructor: `localCell({id, shape, vary,
 * initial, write})`. It declares
 *   - an `id` (the wire identifier),
 *   - a `shape` (runtime validator for client writes),
 *   - an optional `vary` callback (request → storage partition key),
 *   - an `initial` default value,
 *   - an optional `write` server-side canonicalisation.
 *
 * "local" names the storage backend — every cell here is backed by the
 * active `CellStorage` adapter (default: JSON file at
 * `cms/data/cells.json`). Future implementors (`gqlCell`, etc.) sit
 * alongside as separate constructors carrying their own loaders — see
 * `docs/notes/cells-as-resolvers.md`.
 *
 * Reading: a parton's `schema` option declares cell handles. The
 * framework runs each cell's `vary` against the request scope, looks
 * up the storage slot, and passes the resolved value to Render as a
 * `ResolvedCell<T>` (`{id, value, set}`).
 *
 * Writing: `cell.set(v)` is a server-action reference. Server-side it
 * runs the action directly; client-side it's a Flight-serialized
 * server reference that re-runs against the action's request scope.
 *
 * See `docs/reference/cells.md` for the user-facing surface.
 */

import {
  __cellWrite as _cellWriteAction,
  __scopedCellWrite as _scopedCellWriteAction,
} from "../runtime/cell-actions.ts"
import { getCellStorage } from "../runtime/cell-storage.ts"
import { getRequest, getScope, parseCookies } from "../runtime/context.ts"
import { createSessionReadSurface } from "../runtime/session.ts"
import { hash } from "./hash.ts"
import { stableStringify } from "./stable-stringify.ts"
import { buildTimeScope } from "./time.ts"
import type { VaryScope } from "./partial.tsx"
import type { SessionId } from "../runtime/session.ts"

// ─── Public types ─────────────────────────────────────────────────────

/**
 * Sync request scope a cell's `vary` callback sees. Same shape as a
 * parton's `VaryScope` minus `instanceId` (cells aren't per-placement)
 * and with the narrower `SessionId`.
 */
export type CellVaryScope = Omit<VaryScope, "instanceId" | "session"> & {
  session: SessionId
}

/** Shape declaration accepted by `localCell({shape: ...})`. */
export type CellShapeSpec =
  | "string"
  | "number"
  | "boolean"
  | { enum: readonly string[] }

/** Runtime shape descriptor stored on the handle — drives validation. */
export type CellShape =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "enum"; values: readonly string[] }

/** Map a `CellShapeSpec` to its runtime value type. */
export type ValueOfShape<S> =
  S extends "string" ? string :
  S extends "number" ? number :
  S extends "boolean" ? boolean :
  S extends { enum: readonly (infer V)[] } ? V :
  never

/**
 * Module-scope cell handle. Constructed once via `localCell({...})` and
 * held as a module export. Carries the static decisions (id, shape,
 * vary, defaultValue) plus the bound `set` server-action ref — the
 * same `set` reference flows into `ResolvedCell` and across Flight to
 * client components, so client and server invocations land in the same
 * handler.
 */
export interface Cell<T> {
  readonly __cell: true
  readonly id: string
  readonly shape: CellShape
  readonly defaultValue: T
  /** Vary callback. Runs against the request scope; the hashed output
   *  is the storage partition key. Omitted in user opts → single-slot
   *  cell. */
  readonly vary: (scope: CellVaryScope) => Record<string, unknown>
  /**
   * Mutation surface. Server-side: invokes the action synchronously
   * against the current request scope. Client-side: Flight-serialized
   * server reference; partition resolves from the action's request
   * scope on the server.
   *
   * Optional `opts.vary` overrides the cell's own vary callback —
   * useful for cross-context mutations (action fired from /cart
   * updating notes for a product not in the URL).
   */
  set(value: T, opts?: { vary?: Record<string, unknown> }): Promise<void>
  /**
   * Synchronous server-side read of the current stored value. Reads
   * the cell's storage at `(getScope(), id, partitionKey)` where the
   * partition key is computed from the cell's own `vary` callback
   * against the active request scope.
   *
   * Must be called inside a request context (vary / render / action
   * body). Returns `defaultValue` on storage miss.
   */
  peek(): T
  /** Internal — coerces / validates an incoming value into T. Throws
   *  on shape mismatch. */
  validate(value: unknown): T
  /** Internal — server-side write-pipeline transform. Runs after
   *  `validate` and before storage on every write. `undefined` when
   *  the cell didn't declare a `write` option. */
  write?(value: T): T
}

/**
 * Resolved cell — the per-render view a parton's `schema` produces.
 * Carries the resolved `.value` plus the same bound `set` action
 * reference as the source `Cell<T>`. This is what Render receives and
 * what crosses Flight to client components.
 *
 * `partition` is set for scoped cells (declared inline in
 * `schema({localCell})`) — it's the parton's vary output (possibly
 * narrowed by the descriptor's `vary` callback) used as the storage
 * partition. Carried on the wire so the client batcher can include
 * it in `__cellWriteBatch` entries; the resolved cell's `set` already
 * has partition baked at resolution time for non-batched direct
 * calls. Module-scope cells leave this undefined; their partition
 * resolves from the action's request scope at write time.
 */
export interface ResolvedCell<T> {
  readonly __cell: true
  readonly id: string
  readonly value: T
  readonly partition?: Record<string, unknown>
  set(value: T, opts?: { vary?: Record<string, unknown> }): Promise<void>
}

// ─── Cell registry (module-scope state) ───────────────────────────────

const cellRegistry = new Map<string, Cell<unknown>>()

export function getCellById(id: string): Cell<unknown> | undefined {
  return cellRegistry.get(id)
}

/** Type predicate — works on both module handles and resolved cells. */
export function isCellHandle(value: unknown): value is Cell<unknown> | ResolvedCell<unknown> {
  return typeof value === "object" && value !== null && (value as { __cell?: boolean }).__cell === true
}

export function isModuleCell(value: unknown): value is Cell<unknown> {
  return isCellHandle(value) && typeof (value as Cell<unknown>).vary === "function"
}

/** Compute the partition key for a cell against a request scope. */
export function computeCellPartitionKey(cell: Cell<unknown>, scope: CellVaryScope): string {
  const out = cell.vary(scope)
  return hash(stableStringify(out))
}

// ─── Shared validator / shape plumbing ────────────────────────────────

function shapeFromSpec(spec: CellShapeSpec): CellShape {
  if (spec === "string") return { kind: "string" }
  if (spec === "number") return { kind: "number" }
  if (spec === "boolean") return { kind: "boolean" }
  return { kind: "enum", values: spec.enum }
}

function makeValidator<T>(id: string, shape: CellShape): (v: unknown) => T {
  switch (shape.kind) {
    case "string":
      return ((v: unknown): T => {
        if (typeof v !== "string") {
          throw new TypeError(`cell ${id}: expected string, got ${typeof v}`)
        }
        return v as T
      })
    case "number":
      return ((v: unknown): T => {
        if (typeof v !== "number" || Number.isNaN(v)) {
          throw new TypeError(`cell ${id}: expected number, got ${typeof v}`)
        }
        return v as T
      })
    case "boolean":
      return ((v: unknown): T => {
        if (typeof v !== "boolean") {
          throw new TypeError(`cell ${id}: expected boolean, got ${typeof v}`)
        }
        return v as T
      })
    case "enum": {
      const allowed: ReadonlySet<string> = new Set(shape.values)
      const values = shape.values
      return ((v: unknown): T => {
        if (typeof v !== "string" || !allowed.has(v)) {
          throw new TypeError(
            `cell ${id}: expected one of ${values.join(", ")}, got ${String(v)}`,
          )
        }
        return v as T
      })
    }
  }
}

function constantVary(): Record<string, unknown> {
  return {}
}

function registerCell<T>(handle: Cell<T>): Cell<T> {
  // HMR overwrites in place. Storage is keyed by id, so values from
  // the prior registration are unaffected.
  cellRegistry.set(handle.id, handle as Cell<unknown>)
  return handle
}

/** Bind the generic `__cellWrite` server action to a specific cell
 *  id. The bound function is a stable server-action reference: it
 *  crosses Flight as a server-ref with the id baked in, so client
 *  invocations land in the same handler the server uses. */
function bindSetter(id: string): Cell<unknown>["set"] {
  return _cellWriteAction.bind(null, id) as unknown as Cell<unknown>["set"]
}

/** Per-cell `peek` — bound at construct time. Resolves scope and vary
 *  against the active ALS request context, so callers don't need to
 *  thread them through their own closures. */
function buildPeek<T>(
  id: string,
  validate: (v: unknown) => T,
  defaultValue: T,
  varyFn: (scope: CellVaryScope) => Record<string, unknown>,
): Cell<T>["peek"] {
  return () => {
    const varyOut = varyFn(buildCellVaryScopeFromRequest())
    const partitionKey = hash(stableStringify(varyOut))
    const stored = getCellStorage().read(getScope(), id, partitionKey)
    if (stored === undefined) return defaultValue
    try {
      return validate(stored)
    } catch {
      // Stored value drifted off-shape (manual edit, legacy data) —
      // surface the default rather than throwing inside a render.
      return defaultValue
    }
  }
}

function buildCellVaryScopeFromRequest(): CellVaryScope {
  const request = getRequest()
  const url = new URL(request.url)
  const search: Record<string, string> = {}
  for (const [k, v] of url.searchParams) search[k] = v
  const cookies = parseCookies(request)
  const headers: Record<string, string> = {}
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v
  return {
    url,
    pathname: url.pathname,
    search,
    cookies,
    headers,
    params: {},
    session: createSessionReadSurface(),
    time: buildTimeScope(),
  }
}

// ─── Module-scope localCell ───────────────────────────────────────────

/** Options for `localCell({...})`. */
export interface LocalCellOpts<S extends CellShapeSpec> {
  id: string
  shape: S
  initial: ValueOfShape<S>
  /** Sync callback `(scope) => Record<string, unknown>`. Output hashes
   *  into the storage partition key — pick what scopes the cell
   *  ("global" = `() => ({})`, "per-session" =
   *  `({session}) => ({sid: session.id})`, per-anything else via
   *  `params` / `cookies` / `headers`). Omit for a single-slot cell. */
  vary?: (scope: CellVaryScope) => Record<string, unknown>
  /** Server-side write-pipeline transform. Runs after `validate` and
   *  before storage on every write — the server's final say on the
   *  stored shape regardless of what the client sent (uppercase, trim,
   *  format, length cap, profanity filter). Throws roll back the
   *  batch. */
  write?: (value: ValueOfShape<S>) => ValueOfShape<S>
}

/**
 * Module-scope cell backed by local storage.
 *
 *     export const palette = localCell({
 *       id: "palette",
 *       shape: { enum: ["light", "dark"] as const },
 *       vary: ({session}) => ({sid: session.id}),
 *       initial: "dark",
 *     })
 */
export function localCell<S extends CellShapeSpec>(opts: LocalCellOpts<S>): Cell<ValueOfShape<S>> {
  type T = ValueOfShape<S>
  const shape = shapeFromSpec(opts.shape)
  const validate = makeValidator<T>(opts.id, shape)
  const varyFn = opts.vary ?? constantVary
  const handle: Cell<T> = {
    __cell: true,
    id: opts.id,
    shape,
    defaultValue: opts.initial,
    vary: varyFn,
    set: bindSetter(opts.id) as Cell<T>["set"],
    peek: buildPeek(opts.id, validate, opts.initial, varyFn),
    validate,
    write: opts.write,
  }
  return registerCell(handle)
}

// ─── Resolved-cell construction ───────────────────────────────────────

/**
 * Build a per-render `ResolvedCell<T>` view from a module handle and
 * its resolved value. Used by the partial render path (`schema`
 * resolution) — the resolved view is what Render receives and what
 * crosses Flight to client components.
 *
 * For module-scope cells: omit `partition`. The cell's `set` is the
 * module-scope bound action (`__cellWrite.bind(null, id)`) — partition
 * resolves from the action invocation's request scope.
 *
 * For scoped cells: pass `partition` (the parton's vary output, or the
 * descriptor's vary-narrowed subset). The cell's `set` becomes
 * `__scopedCellWrite.bind(null, id, partition)` — partition baked at
 * resolution time so client calls land on the right partition
 * regardless of URL changes between render and call.
 */
export function buildResolvedCell<T>(
  handle: Cell<T>,
  value: T,
  partition?: Record<string, unknown>,
): ResolvedCell<T> {
  if (partition !== undefined) {
    return {
      __cell: true,
      id: handle.id,
      value,
      partition,
      set: _scopedCellWriteAction.bind(null, handle.id, partition) as ResolvedCell<T>["set"],
    }
  }
  return {
    __cell: true,
    id: handle.id,
    value,
    set: handle.set,
  }
}

/** Test-only — wipe the registry between tests so cells from prior
 *  runs don't leak. Production HMR overwrites in place; this is the
 *  full reset path. */
export function _clearCellRegistry(): void {
  cellRegistry.clear()
}

// ─── Scoped cell descriptors ──────────────────────────────────────────
//
// A scoped cell is declared inline inside a parton's `schema` callback,
// not as a module-scope export. It has no author-supplied `id`; the
// framework derives `<partonId>/<schemaKey>` when the schema's return
// record is processed. Its `vary` callback receives the parton's
// resolved vary output — partition can NARROW the parton's dependency
// surface but not expand beyond it.

/**
 * Descriptor returned by the schema-callback `localCell(...)` factory.
 * Carries everything needed to finalize into a `Cell<T>` once the
 * framework knows the schema key and the owning parton id.
 *
 * `varyFn` is optional. When omitted, the partition key is computed
 * from the parton's full vary output (the cell partitions on every
 * dimension the parton depends on). When provided, the function
 * receives the parton's vary output and returns a subset — narrowing
 * the partition.
 */
export interface ScopedCellDescriptor<T> {
  readonly __scopedCellDescriptor: true
  readonly shape: CellShape
  readonly defaultValue: T
  readonly varyFn?: (partonVary: never) => Record<string, unknown>
  readonly write?: (value: T) => T
  readonly validate: (value: unknown) => T
}

/** Type predicate for descriptors. Distinct from `isModuleCell` because
 *  descriptors don't carry their own `id` or registered `vary` — they
 *  need finalization. */
export function isScopedCellDescriptor(
  value: unknown,
): value is ScopedCellDescriptor<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __scopedCellDescriptor?: boolean }).__scopedCellDescriptor === true
  )
}

/** Options for `schema({localCell}) => ({ x: localCell({...}) })`. */
export interface ScopedLocalCellOpts<S extends CellShapeSpec, PV> {
  shape: S
  initial: ValueOfShape<S>
  /** Optional partition narrower. Receives the parton's resolved vary
   *  output; returns a subset object that hashes into the cell's
   *  partition key. Omit to partition on the entire parton vary
   *  output. */
  vary?: (partonVary: PV) => Record<string, unknown>
  /** Server-side write-pipeline transform. Same semantic as module-scope
   *  cells. Runs after `validate`, before storage. */
  write?: (value: ValueOfShape<S>) => ValueOfShape<S>
}

/**
 * Factory bag passed as `{localCell}` into a parton's `schema`
 * callback. Mirrors the module-scope `localCell` surface but the
 * options omit `id` (auto-derived from the schema key) and the `vary`
 * callback narrows the parton's vary output instead of taking a
 * request scope.
 *
 * Generic `PV` carries the parton's vary output type so the cell's
 * `vary` callback parameter is typed correctly without manual
 * generics.
 */
export interface ScopedCellFactories<PV> {
  localCell<S extends CellShapeSpec>(
    opts: ScopedLocalCellOpts<S, PV>,
  ): ScopedCellDescriptor<ValueOfShape<S>>
}

/**
 * Build the `{localCell}` factory bag for a parton's `schema` callback.
 *
 * The validator inside the descriptor bakes in a placeholder id
 * ("scoped-cell"); finalization replaces it with `<partonId>/
 * <schemaKey>` before registration. The placeholder only surfaces in
 * error messages thrown from a descriptor's `validate` before
 * finalization, which shouldn't happen in normal flow.
 */
export function makeScopedCellFactories<PV>(): ScopedCellFactories<PV> {
  return {
    localCell<S extends CellShapeSpec>(
      opts: ScopedLocalCellOpts<S, PV>,
    ): ScopedCellDescriptor<ValueOfShape<S>> {
      type T = ValueOfShape<S>
      const shape = shapeFromSpec(opts.shape)
      return {
        __scopedCellDescriptor: true,
        shape,
        defaultValue: opts.initial,
        varyFn: opts.vary as ((pv: never) => Record<string, unknown>) | undefined,
        write: opts.write,
        validate: makeValidator<T>("scoped-cell", shape),
      }
    },
  }
}

/**
 * Finalize a scoped descriptor into a `Cell<T>` handle keyed by
 * compound id `<partonId>/<schemaKey>`. Registered into the cell
 * registry so `__cellWrite` / `__cellWriteBatch` can look it up by
 * id (same path module-scope cells use). Subsequent renders re-run
 * the schema callback, producing fresh descriptors that re-finalize
 * and overwrite the registry entry — idempotent, matches HMR overwrite
 * semantics.
 *
 * The finalized cell's `vary` callback is a no-op stub: scoped cells'
 * partition is resolved against the parton's vary output (not request
 * scope), so the runtime threads the parton vary through to the
 * descriptor's `varyFn` directly. The Cell handle's own `vary` is
 * `() => ({})` to keep module-scope-style API consistent, but it's
 * never the partition source for scoped cells.
 */
export function finalizeScopedCell<T>(
  descriptor: ScopedCellDescriptor<T>,
  partonId: string,
  schemaKey: string,
): Cell<T> {
  const id = `${partonId}/${schemaKey}`
  const validate = makeValidator<T>(id, descriptor.shape)
  const handle: Cell<T> = {
    __cell: true,
    id,
    shape: descriptor.shape,
    defaultValue: descriptor.defaultValue,
    vary: () => ({}),
    set: bindSetter(id) as Cell<T>["set"],
    peek: () => {
      // peek doesn't make sense for scoped cells outside their owning
      // parton's render path — the partition depends on the parton's
      // vary, which isn't reachable from a bare module context. If a
      // caller really needs sync read, they should route through an
      // action.
      return descriptor.defaultValue
    },
    validate,
    write: descriptor.write,
  }
  cellRegistry.set(id, handle as Cell<unknown>)
  return handle
}

/**
 * Compute the storage partition key for a scoped cell given the
 * parton's resolved vary output. The descriptor's `varyFn` narrows
 * the partition surface if provided; otherwise the parton's full vary
 * output is the partition.
 */
export function computeScopedCellPartitionKey(
  descriptor: ScopedCellDescriptor<unknown>,
  partonVary: Record<string, unknown> | null | undefined,
): string {
  const base = partonVary ?? {}
  const out = descriptor.varyFn
    ? descriptor.varyFn(base as never)
    : base
  return hash(stableStringify(out))
}
