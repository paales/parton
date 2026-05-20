"use client"

/**
 * Client-side cell API: a microtask-batched coalescer + the `useCell`
 * hook that converts a server-constructed `ResolvedCell` into a
 * client-side object with an **optimistic-aware `value`** and a
 * **batched `set`**.
 *
 * Why a hook and not direct mutation of the resolved cell:
 *
 *   `ResolvedCell` is built server-side in `buildResolvedCell` and
 *   crosses Flight into client components. Its `set` field is the
 *   cell's bound server-action ref (`__cellWrite.bind(null, id)`) —
 *   Flight serialises that natively. A bound **client** function ref
 *   in the same slot is NOT serialisable: Flight rejects it with
 *   `"Functions cannot be passed directly to Client Components"`.
 *   The Render function is a server component, so we can't reshape
 *   `set` there either. The conversion to a client-side cell with a
 *   batched setter has to happen inside a client component — and the
 *   one place a client component can run logic per cell is a hook.
 *
 *   `useCell(serverCell): ClientCell` is that conversion.
 *
 * `value` returned by `useCell` is the **latest local-set value while
 * writes are queued or in flight**, falling back to the server-
 * authoritative value when everything has settled. So binding a
 * controlled input to `cell.value` works directly:
 *
 *     const name = useCell(props.cardName)
 *     <input value={name.value} onChange={(e) => name.set(e.target.value)} />
 *
 * No local `useState`, no `useEffect`-based adoption. The framework
 * holds the optimistic value internally and clears it when the last
 * pending write for the cell drains; the next render uses the
 * server-authoritative value automatically (which is the reconcile
 * moment when the server normalised differently from the client's
 * sent value).
 *
 * `serverValue` is always the server-authoritative snapshot (same as
 * `props.cardName.value`) — exposed for cases that explicitly need the
 * non-optimistic view side-by-side with `value`.
 *
 * Batching + ordering: every `.set(v)` enqueues; a microtask flushes
 * the queue as one `__cellWriteBatch` POST. At most one POST in flight
 * at a time — subsequent enqueues during in-flight accumulate and
 * flush as the next batch when the current resolves. Writes always
 * hit the server in strict send-order. Sequential by design; hybrid
 * logical clocks for parallel writes are future work.
 */

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ChangeEvent,
  type RefObject,
} from "react"
import { __cellWriteBatch } from "../runtime/cell-actions.ts"
import type { ResolvedCell } from "./cell.ts"

interface QueuedWrite {
  id: string
  value: unknown
  partition: { vary?: Record<string, unknown> } | undefined
  resolve: () => void
  reject: (err: unknown) => void
}

let queue: QueuedWrite[] = []
let flushScheduled = false
let inflight = false

/** Latest value sent for each cell — i.e. the optimistic view. Set by
 *  `enqueue`, cleared when the last pending write for the cell drains.
 *  `useCell` reads this to surface optimistic `value`. */
const latestSentByCell = new Map<string, unknown>()
/** Per-cell-id pending count: queued + in-flight writes for the cell. */
const pendingByCell = new Map<string, number>()
/** Per-cell-id monotonic version. Bumped whenever `latestSentByCell`
 *  changes for the id (set, cleared) — so `useCell` subscribers
 *  re-render at the right moments. Keyed by id so an unrelated cell's
 *  activity doesn't trigger spurious renders. */
const cellVersion = new Map<string, number>()
const subscribers = new Set<() => void>()

function notifySubscribers(): void {
  for (const cb of subscribers) cb()
}

function bumpVersion(id: string): void {
  cellVersion.set(id, (cellVersion.get(id) ?? 0) + 1)
  notifySubscribers()
}

function incrementPending(id: string, value: unknown): void {
  pendingByCell.set(id, (pendingByCell.get(id) ?? 0) + 1)
  latestSentByCell.set(id, value)
  bumpVersion(id)
}

function decrementPending(id: string): void {
  const c = pendingByCell.get(id) ?? 0
  if (c <= 1) {
    pendingByCell.delete(id)
    latestSentByCell.delete(id)
    bumpVersion(id)
  } else {
    pendingByCell.set(id, c - 1)
  }
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/**
 * Client-side cell view returned by `useCell`.
 *
 * - `value` — optimistic-aware. Latest local-set value while writes
 *   are queued or in flight; falls back to the server-authoritative
 *   value when everything has settled.
 * - `serverValue` — always the server snapshot, for cases that need
 *   the non-optimistic view side-by-side with `value`.
 * - `set(value, opts?)` — enqueues into the microtask-coalesced
 *   batcher; returns a promise that resolves when the batch it
 *   landed in commits.
 * - `input(opts?)` — spread onto a controlled `<input>`. Handles
 *   value binding, onChange → transform → set, and caret restoration
 *   via an internal ref + `useLayoutEffect`. The component never
 *   has to manage local state, refs, layout effects, or pending
 *   checks for input-driven cells.
 *
 * TODO(research): the `input()` shape parallels react-hook-form's
 * `register()` (https://react-hook-form.com/docs/useform/register) —
 * both return `{value/defaultValue, onChange, ref, …}` for spread
 * onto an `<input>`, both absorb the per-input glue (refs, change
 * handlers, validation/transform pipeline). RHF additionally covers
 * `onBlur`, validation rules, controlled/uncontrolled distinctions,
 * field arrays, and submit lifecycle. Worth comparing API surfaces
 * before extending `CellInputOpts` ad-hoc — a closer alignment would
 * make cells drop into RHF-style form patterns without translation.
 */
export interface ClientCell<T> {
  readonly value: T
  readonly serverValue: T
  readonly set: (
    value: T,
    opts?: { vary?: Record<string, unknown> },
  ) => Promise<void>
  readonly input: (opts?: CellInputOpts) => CellInputBindings
}

/** Options for `ClientCell.input()`. */
export interface CellInputOpts {
  /** Per-keystroke transform applied to the raw `event.target.value`.
   *  Returns the value to display (= what we send to `cell.set`) and
   *  the caret position to restore after React commits. Without this,
   *  the input is uncontrolled-by-author — value flows straight from
   *  keystrokes to `cell.set` with no client-side cleanup, and the
   *  server's `write` is the only place the value is canonicalised. */
  transform?: (
    raw: string,
    caret: number,
  ) => { value: string; caret: number }
  /** Fired after the local transform and after `cell.set` has been
   *  enqueued. Use for cross-cell triggers (e.g. firing a derived
   *  cell's `set` whenever this input changes — see the card-form
   *  demo's CVC stagger). */
  onCommit?: (value: string) => void
}

/** Shape returned by `ClientCell.input()` — spread onto an `<input>`. */
export interface CellInputBindings {
  value: string
  onChange: (e: ChangeEvent<HTMLInputElement>) => void
  ref: RefObject<HTMLInputElement | null>
}

export function useCell<T>(cell: ResolvedCell<T>): ClientCell<T> {
  const id = cell.id
  // Subscribe to per-cell-id version. The component re-renders when
  // the latest-sent value for THIS cell flips (added, removed). Other
  // cells' activity doesn't trigger a render here.
  useSyncExternalStore(
    subscribe,
    useCallback(() => cellVersion.get(id) ?? 0, [id]),
    () => 0,
  )
  const hasPending = latestSentByCell.has(id)
  const value = (hasPending ? latestSentByCell.get(id) : cell.value) as T
  const set = useCallback(
    (v: T, opts?: { vary?: Record<string, unknown> }) => enqueue(id, v, opts),
    [id],
  )

  // ── Input bindings: ref + caret-restore plumbing the input() method
  // hands back as part of `{...cell.input()}`. The author never sees
  // any of this; it's the per-cell hook's job.
  const inputRef = useRef<HTMLInputElement | null>(null)
  const pendingCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (pendingCaret.current == null || !inputRef.current) return
    const c = pendingCaret.current
    pendingCaret.current = null
    inputRef.current.setSelectionRange(c, c)
  }, [value])

  // The `input` closure captures `set` and the refs. It needs the
  // current `value` for its returned `value` field, but the onChange
  // and ref handles are stable.
  const onChange = useCallback(
    (
      e: ChangeEvent<HTMLInputElement>,
      transform: CellInputOpts["transform"],
      onCommit: CellInputOpts["onCommit"],
    ) => {
      const raw = e.target.value
      const caret = e.target.selectionStart ?? raw.length
      const t = transform ? transform(raw, caret) : { value: raw, caret }
      pendingCaret.current = t.caret
      void set(t.value as unknown as T)
      onCommit?.(t.value)
    },
    [set],
  )

  const input = useCallback(
    (opts?: CellInputOpts): CellInputBindings => ({
      value: value as unknown as string,
      ref: inputRef,
      onChange: (e) => onChange(e, opts?.transform, opts?.onCommit),
    }),
    [value, onChange],
  )

  return { value, serverValue: cell.value, set, input }
}

function enqueue(
  cellId: string,
  value: unknown,
  opts: { vary?: Record<string, unknown> } | undefined,
): Promise<void> {
  incrementPending(cellId, value)
  return new Promise<void>((resolve, reject) => {
    queue.push({ id: cellId, value, partition: opts, resolve, reject })
    if (inflight || flushScheduled) return
    flushScheduled = true
    queueMicrotask(flushQueue)
  })
}

/**
 * Drain the queue one batch at a time, serially. While a batch is
 * in flight (`inflight === true`), new enqueues just push into the
 * queue and don't schedule a parallel flush — they're picked up by
 * the while-loop below when the current POST resolves.
 *
 * The result: at most one `__cellWriteBatch` POST in flight at a
 * time. Writes hit the server in strict send-order regardless of
 * how variable the per-batch latency is. Cells can never observe an
 * out-of-order overwrite from this coalescer.
 */
async function flushQueue(): Promise<void> {
  if (inflight) return
  inflight = true
  flushScheduled = false
  try {
    while (queue.length > 0) {
      const batch = queue
      queue = []
      try {
        await __cellWriteBatch(
          batch.map((w) => ({
            id: w.id,
            value: w.value,
            ...(w.partition ? { partition: w.partition } : {}),
          })),
        )
        for (const w of batch) {
          decrementPending(w.id)
          w.resolve()
        }
      } catch (err) {
        for (const w of batch) {
          decrementPending(w.id)
          w.reject(err)
        }
      }
    }
  } finally {
    inflight = false
  }
}
