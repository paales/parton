/**
 * Server-side render-output caching.
 *
 * `<Cache>` wraps a spec's body with the spec's `varyResult` as the
 * cache-key surface. On miss it renders the body to Flight bytes,
 * strips every inner-parton boundary to an `<i hidden data-partial-id>`
 * placeholder (`flight-graph.stripHoles`), and stores the lean
 * scaffolding. On hit it streams the scaffolding back and splices a
 * freshly-rendered parton at each placeholder (`flight-graph.spliceHoles`)
 * — so the cached frame is byte-replayed (Suspense pacing intact) while
 * its dynamic holes re-render live per request.
 *
 * Cache is an internal detail of `parton(...)` when the spec sets
 * `cache={…}`. Authors don't render `<Cache>` directly.
 *
 * ── One path ──────────────────────────────────────────────────────────
 *
 * There's a single store + replay path. A region with no inner partons
 * strips to zero holes; `spliceHoles` then degenerates to passing the
 * stored bytes straight through (the streaming-preservation case). A
 * region with inner partons gets each one spliced live. No decode /
 * `resolveLazies` / re-encode round-trip — the rewrite is row-level, so
 * inner Suspense never flattens.
 *
 * ── Error recovery ────────────────────────────────────────────────────
 *
 * The byte cache is also the error-recovery substrate
 * (`docs/reference/errors.md`). A parton's async body is a promise;
 * its rejection is observed HERE, at the source, before Flight folds
 * it into an error row — so classification works on the real error
 * object (framework sentinels pass through untouched) and the retry
 * boundary is armed synchronously with the failure, inside the render,
 * before the segment driver's post-drain wheel sync reads the
 * snapshot's wake-hint box.
 *
 *  - A failed miss NEVER stores (an entry must always be a good
 *    render), and when a last-known-good entry exists for the same
 *    (id, variant) axis, its bytes are served in place of the error —
 *    wrapped in `<PartonStaleProvider>` so the UI has an explicit
 *    staleness marker (`usePartonStale()`).
 *  - The failure writes `nextRetryAt` (capped exponential backoff)
 *    into the render's live wake-hint box — the errored snapshot
 *    declares its own retry boundary, exactly the `expires()` shape,
 *    so live connections re-attempt via the ordinary deadline wheel
 *    and request-driven renders re-attempt once the window elapses.
 *    Within the window, misses serve last-known-good without touching
 *    the failing loader.
 *  - A successful attempt stores, updates the last-known-good index,
 *    and clears the failure record — recovery needs no extra path.
 */

import type { ReactNode } from "react"
import { createFromReadableStream, renderToReadableStream } from "./flight-runtime.ts"
import { spliceHoles, stripHoles, type HoleRef, type SpliceMeta } from "./flight-graph.ts"
import { hash } from "./hash.ts"
import { stableStringify } from "./stable-stringify.ts"
import type { WakeHints } from "./current-parton.ts"
import { partialFromSnapshot } from "./partial.tsx"
import { ParentContext, type PartialCtx } from "./partial-context.ts"
import { getScope } from "../runtime/context.ts"
import { isExpectedRenderError } from "../runtime/errors.ts"
import { lookupPartial, registerPartial, type PartialSnapshot } from "./partial-registry.ts"
import type { CacheOptions } from "./cache-options.ts"
import { PartonStaleProvider } from "./partial-error-boundary.tsx"
import { getServerContext } from "./server-context.ts"

// ─── Store ─────────────────────────────────────────────────────────────

/** An inner parton hole, enriched at store time with the snapshot the
 *  hit path needs: its `parentPath` / `frameChain` drive the fresh
 *  render, and re-registering the snapshot keeps the parton addressable
 *  for selector refetches even though its producer didn't run. */
interface StoredHole extends HoleRef {
  snapshot: PartialSnapshot
}

interface Entry {
  /** Stripped scaffolding bytes (holes are inert placeholders). */
  bytes: Uint8Array
  /** Inner partons to splice live on a hit, in document order. */
  holes: StoredHole[]
  /** Renumber/dedup facts the splice needs without rebuffering. */
  meta: SpliceMeta
  /** Fresh/stale windows: the `maxAge` / `staleWhileRevalidate`
   *  timestamps CLAMPED to the body's declared `expires()` /
   *  `staleUntil()` boundaries at store time — the byte-cache
   *  counterpart of fp-skip's TTL gate. A body that declares its
   *  output stops being fresh at T never has its bytes replayed past
   *  T; `maxAge` only bounds how long an undeclared entry lingers. */
  expiresAt: number
  staleUntil: number
}

interface CacheStore {
  get(key: string): Promise<Entry | undefined>
  set(key: string, entry: Entry): Promise<void>
  delete(key: string): Promise<void>
  clear(): Promise<void>
  stats(): Promise<{ size: number; keys: string[] }>
}

class MemoryCacheStore implements CacheStore {
  private readonly map = new Map<string, Entry>()
  private readonly maxEntries: number

  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries
  }

  async get(key: string): Promise<Entry | undefined> {
    const entry = this.map.get(key)
    if (entry !== undefined) {
      this.map.delete(key)
      this.map.set(key, entry)
    }
    return entry
  }

  async set(key: string, entry: Entry): Promise<void> {
    this.map.set(key, entry)
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }

  async clear(): Promise<void> {
    this.map.clear()
  }

  async stats(): Promise<{ size: number; keys: string[] }> {
    return { size: this.map.size, keys: [...this.map.keys()] }
  }
}

// ─── Error-recovery state ──────────────────────────────────────────────

/** One consecutive-failure streak for an (id, variant) axis. Created on
 *  the first failed attempt, escalated on each subsequent one, deleted
 *  by the first successful store. */
interface FailureRecord {
  /** Consecutive failed attempts (≥ 1). */
  attempts: number
  /** Epoch ms of the streak's first failure. */
  since: number
  /** No re-attempt before this boundary; misses inside the window
   *  serve last-known-good without running the loader. Also written
   *  into the failing render's wake-hint box so the deadline wheel
   *  re-lanes the parton at the boundary. */
  nextRetryAt: number
  /** The most recent failure — what `onPartonError` reports. */
  lastError: unknown
}

/** Capped exponential backoff for re-attempts after a failed render. */
interface RetrySchedule {
  baseMs: number
  capMs: number
}

const DEFAULT_RETRY_SCHEDULE: RetrySchedule = { baseMs: 1_000, capMs: 16_000 }
let retrySchedule = DEFAULT_RETRY_SCHEDULE

/** Test-only: override (or reset, with no argument) the retry
 *  schedule so backoff behavior is assertable in millisecond tests. */
export function _setErrorRetrySchedule(schedule?: RetrySchedule): void {
  retrySchedule = schedule ?? DEFAULT_RETRY_SCHEDULE
}

/** The last-known-good index is the recovery safety net, not the
 *  serving store — bound it independently of the store's LRU so a
 *  wide axis space (e.g. the website world's chunks) can't grow it
 *  unbounded. Entries are shared object references with the store;
 *  eviction here only drops the recovery pointer. */
const LAST_GOOD_MAX = 1024

interface ScopeState {
  store: CacheStore
  refreshing: Set<string>
  inFlightMiss: Map<string, Attempt>
  /** axis (`id:varyHash`) → newest successfully stored entry. Written
   *  on every store; consulted only when a fresh render fails. */
  lastGood: Map<string, Entry>
  /** axis → outstanding consecutive-failure streak. */
  failures: Map<string, FailureRecord>
}

const scopes = new Map<string, ScopeState>()

function state(scope: string = getScope()): ScopeState {
  let s = scopes.get(scope)
  if (!s) {
    s = {
      store: new MemoryCacheStore(),
      refreshing: new Set(),
      inFlightMiss: new Map(),
      lastGood: new Map(),
      failures: new Map(),
    }
    scopes.set(scope, s)
  }
  return s
}

function hashParts(...parts: unknown[]): string {
  return hash(stableStringify(parts))
}

// ─── Observability ─────────────────────────────────────────────────────

/** One failed render attempt, as reported to `onPartonError`. Emitted
 *  once per ATTEMPT (never for backoff-window serves that skip the
 *  loader). `error` is the body's real rejection value — sentinels and
 *  render cancellations never produce an event. */
export interface PartonErrorEvent {
  partonId: string
  error: unknown
  /** Consecutive failed attempts including this one. */
  attempts: number
  /** True when last-known-good bytes were served in place of the
   *  error; false when the error card surfaced (no servable entry). */
  servedStale: boolean
  /** Epoch ms of the next scheduled attempt. */
  retryAt: number
}

const errorHandlers = new Set<(event: PartonErrorEvent) => void>()

/**
 * Register an observability handler for failed parton renders. Returns
 * the unregister function. With no handlers registered, the framework
 * logs one concise line per attempt to `console.error` (the raw error
 * + stack is separately logged under a digest by the Flight render's
 * `onError` reporter).
 */
export function onPartonError(handler: (event: PartonErrorEvent) => void): () => void {
  errorHandlers.add(handler)
  return () => errorHandlers.delete(handler)
}

function emitPartonError(event: PartonErrorEvent): void {
  if (errorHandlers.size === 0) {
    console.error(
      `[parton] render failed for "${event.partonId}" (attempt ${event.attempts}, ` +
        `${event.servedStale ? "serving last-known-good" : "no last-known-good — error card"}, ` +
        `retry at ${new Date(event.retryAt).toISOString()}):`,
      event.error,
    )
    return
  }
  for (const handler of errorHandlers) {
    try {
      handler(event)
    } catch (err) {
      console.error("[parton] onPartonError handler threw:", err)
    }
  }
}

// ─── Failure bookkeeping ───────────────────────────────────────────────

/** Fold a retry boundary into the render's live wake-hint box — the
 *  same earliest-wins fold `expires()` uses, so wake consumers (the
 *  deadline wheel, the fp-skip TTL gate) treat the retry boundary
 *  exactly like a declared freshness boundary. */
function armRetry(wakeHints: WakeHints | undefined, at: number): void {
  if (!wakeHints) return
  wakeHints.expiresAt = wakeHints.expiresAt === undefined ? at : Math.min(wakeHints.expiresAt, at)
}

/** Escalate (or open) the axis's failure streak and arm the retry
 *  boundary. Called synchronously with the body's rejection. */
function recordFailure(
  st: ScopeState,
  axis: string,
  error: unknown,
  wakeHints: WakeHints | undefined,
): FailureRecord {
  const now = Date.now()
  const prior = st.failures.get(axis)
  const attempts = (prior?.attempts ?? 0) + 1
  const delay = Math.min(retrySchedule.baseMs * 2 ** (attempts - 1), retrySchedule.capMs)
  const record: FailureRecord = {
    attempts,
    since: prior?.since ?? now,
    nextRetryAt: now + delay,
    lastError: error,
  }
  st.failures.set(axis, record)
  armRetry(wakeHints, record.nextRetryAt)
  return record
}

function setLastGood(st: ScopeState, axis: string, entry: Entry): void {
  st.lastGood.delete(axis)
  st.lastGood.set(axis, entry)
  while (st.lastGood.size > LAST_GOOD_MAX) {
    const oldest = st.lastGood.keys().next().value
    if (oldest === undefined) break
    st.lastGood.delete(oldest)
  }
}

/** The axis's last-known-good entry, iff `staleIfError` still allows
 *  serving it: `false` opts out entirely; a number bounds the window
 *  past the entry's ordinary stale boundary; omitted = unbounded. */
function errorServableEntry(
  st: ScopeState,
  axis: string,
  options: CacheOptions,
  now: number,
): Entry | undefined {
  if (options.staleIfError === false) return undefined
  const entry = st.lastGood.get(axis)
  if (!entry) return undefined
  if (typeof options.staleIfError === "number") {
    if (now > entry.staleUntil + options.staleIfError * 1000) return undefined
  }
  return entry
}

// ─── Body observation ──────────────────────────────────────────────────

/**
 * Observe the spec body's rejection at the source. `children` is the
 * promise `spec.Render(...)` returned (partial.tsx creates the element
 * before wrapping it in `<Cache>`), so a handler attached here sees
 * the REAL error object — brand intact, no Flight round-trip — and
 * runs BEFORE the Flight runtime's own rejection handler (it attaches
 * later, when the render reaches the node). That ordering is what
 * makes the failure record + retry-boundary write land strictly before
 * the error row is even encoded, hence before any post-drain wheel
 * sync reads the snapshot's box.
 *
 * Attached on EVERY cacheImpl path (hits included — the body runs
 * every render, and on a pure hit its rejection would otherwise be an
 * unhandled-rejection crash); `armRecovery` scopes the failure
 * bookkeeping to paths that actually attempt a store.
 *
 * Scope: this observes the parton's own body — the loader-failure
 * contract. A descendant server component's throw inside the returned
 * JSX settles the body cleanly and is not captured (it surfaces as the
 * boundary card, as today).
 */
interface ObservedBody {
  /** Resolves to the rejection value, or `undefined` on clean settle.
   *  Never rejects. Settled by the time the body's Flight stream has
   *  closed (the root row is the body's serialization). */
  outcome: Promise<unknown>
  /** Route an (unexpected) rejection into `fire` — immediately if the
   *  body already rejected, else synchronously at rejection time. At
   *  most one fire per observed body. */
  armRecovery(fire: (error: unknown) => void): void
}

function observeBody(children: ReactNode): ObservedBody {
  const thenable =
    children !== null &&
    typeof children === "object" &&
    typeof (children as PromiseLike<ReactNode>).then === "function"
      ? (children as PromiseLike<ReactNode>)
      : null
  if (!thenable) {
    return { outcome: Promise.resolve(undefined), armRecovery: () => {} }
  }
  let fire: ((error: unknown) => void) | null = null
  let fired = false
  let rejection: { error: unknown } | null = null
  const outcome = Promise.resolve(thenable).then(
    () => undefined,
    (error: unknown) => {
      rejection = { error }
      if (fire && !fired && !isExpectedRenderError(error)) {
        fired = true
        fire(error)
      }
      return error
    },
  )
  return {
    outcome,
    armRecovery(f) {
      fire = f
      if (rejection && !fired && !isExpectedRenderError(rejection.error)) {
        fired = true
        f(rejection.error)
      }
    },
  }
}

// ─── Stream helpers ─────────────────────────────────────────────────────

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * Dev-only. Emits stored bytes in fixed-size chunks separated by
 * `perChunkMs`. Feeds the splice's scaffold stream slowly so the hit
 * path acts as a throttled source — the same shape a `<RemoteFrame>`
 * sees from a slow cross-origin Flight payload, and what the
 * `/cache-streaming-demo` page exercises end-to-end.
 */
function slowBytesToStream(
  bytes: Uint8Array,
  perChunkMs: number,
  chunkBytes: number,
): ReadableStream<Uint8Array> {
  let offset = 0
  const total = bytes.byteLength
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= total) {
        controller.close()
        return
      }
      const end = Math.min(offset + chunkBytes, total)
      controller.enqueue(bytes.subarray(offset, end))
      offset = end
      await new Promise((r) => setTimeout(r, perChunkMs))
    },
  })
}

// ─── Hole render / replay ────────────────────────────────────────────────

/** Enrich the byte-level holes with their registry snapshot, captured
 *  while the producing render is still warm. A hole whose spec didn't
 *  register (shouldn't happen for a rendered parton) is dropped — its
 *  placeholder then stays inert on replay. */
function enrichHoles(holes: HoleRef[]): StoredHole[] {
  const out: StoredHole[] = []
  for (const h of holes) {
    const snapshot = lookupPartial(h.partialId)
    if (!snapshot) continue
    out.push({ ...h, snapshot })
  }
  return out
}

/** Render one hole fresh to its own Flight stream. `partialFromSnapshot`
 *  reconstructs the parton from stored data exactly as an isolated
 *  partial-refetch does — right Component (via `type` fallback), parent
 *  from the snapshot (no live ancestor on a hit), props replay, and
 *  `__instanceId` so the re-render keeps its per-instance wire id. A spec
 *  absent from this process resolves to `null` → an inert seam. */
function renderHoleStream(hole: StoredHole): ReadableStream<Uint8Array> {
  return renderToReadableStream(partialFromSnapshot(hole.partialId, hole.snapshot))
}

async function replayEntry(entry: Entry, options: CacheOptions): Promise<ReactNode> {
  // Re-register every hole so `reload({selector})` + cache-mode reads
  // resolve it even though the cached spec's body was short-circuited.
  for (const hole of entry.holes) registerPartial(hole.partialId, hole.snapshot)

  const feed = options.__slowSource
    ? slowBytesToStream(
        entry.bytes,
        options.__slowSource.perChunkMs,
        options.__slowSource.chunkBytes ?? 64,
      )
    : bytesToStream(entry.bytes)
  const spliced = spliceHoles(feed, entry.holes, entry.meta, renderHoleStream)
  return await createFromReadableStream<ReactNode>(spliced)
}

/** A last-known-good replay, wrapped in the explicit staleness marker
 *  the client reads via `usePartonStale()`. The provider is zero-DOM,
 *  so the replayed markup stays byte-identical to the stored render. */
async function staleReplay(
  entry: Entry,
  failure: FailureRecord,
  options: CacheOptions,
): Promise<ReactNode> {
  const tree = await replayEntry(entry, options)
  return (
    <PartonStaleProvider
      stale={{ since: failure.since, attempts: failure.attempts, retryAt: failure.nextRetryAt }}
    >
      {tree}
    </PartonStaleProvider>
  )
}

// ─── Cache component ────────────────────────────────────────────────────

interface CacheProps {
  id: string
  fingerprint: string
  /** Store-time fingerprint. Called AFTER the body has rendered, so it
   *  folds the LIVE tracked-read set — an entry is never keyed
   *  dep-less unless the body truly reads nothing. The pre-render
   *  `fingerprint` (folding the prior dep record) stays the lookup
   *  key: a lookup either hits a deps-complete entry or misses into a
   *  fresh render, so a cold record over-fetches, never serves stale
   *  bytes keyed under different read values. */
  writeFingerprint: () => string
  options: CacheOptions
  /** vary result from the spec — IS the cache-key surface (minus
   *  `expiresAt` / `staleUntil` reserved keys, which the framework
   *  strips before feeding fp and cache lookups). */
  varyResult: unknown
  /** The render's live wake-hint box — `expires()` / `staleUntil()`
   *  write it while the body runs. Read at STORE time (the body has
   *  settled by then, so the hints are final) to clamp the entry's
   *  fresh/stale windows; never part of the key. The error-recovery
   *  path also WRITES it: a failed attempt folds its `nextRetryAt` in,
   *  so the errored snapshot declares its own retry boundary. */
  wakeHints?: WakeHints
  children: ReactNode
}

export async function Cache({
  id,
  fingerprint,
  writeFingerprint,
  options,
  varyResult,
  wakeHints,
  children,
}: CacheProps): Promise<ReactNode> {
  // Capture the cached parton's context synchronously here (the `<Cache>`
  // element is rendered inside the parton's body, so its ambient parent IS
  // the parton's child context). The isolated body renders are seeded with
  // it so their partons thread correctly.
  const bodyParent = getServerContext(ParentContext)
  return cacheImpl(
    id,
    fingerprint,
    writeFingerprint,
    options,
    varyResult,
    wakeHints,
    children,
    bodyParent,
  )
}

async function cacheImpl(
  id: string,
  fingerprint: string,
  writeFingerprint: () => string,
  options: CacheOptions,
  varyResult: unknown,
  wakeHints: WakeHints | undefined,
  children: ReactNode,
  bodyParent: PartialCtx,
): Promise<ReactNode> {
  const st = state()
  const { store, refreshing, inFlightMiss } = st

  // Observe the body promise on every path — see `observeBody`. On a
  // pure hit the body's output is discarded, but its rejection must
  // still be handled (and must not clobber anything).
  const body = observeBody(children)

  // The fingerprint already folds vary + schema + props + invalidation +
  // descendant deps, so it carries the cache-key surface; `varyResult` is
  // appended for legibility / a stable explicit axis.
  const varyHash = hashParts(varyResult)
  const baseKey = `${id}:${fingerprint}`
  const key = `${baseKey}:${varyHash}`
  // The recovery axis: the placement's identity WITHOUT the fp — a
  // failure re-render usually arrives under the same key (TTL miss),
  // but a dep change moves the fp, and last-known-good must still be
  // findable for the variant.
  const axis = `${id}:${varyHash}`
  // Store-time key — evaluated lazily, once the body's tracked reads
  // have all landed. On a warm record it equals `key`.
  const storeKeyOf = () => `${id}:${writeFingerprint()}:${varyHash}`
  const now = Date.now()

  // ── Hit path ──
  const existing = await store.get(key)
  if (existing && (existing.expiresAt > now || existing.staleUntil > now)) {
    if (existing.expiresAt <= now && !refreshing.has(key)) {
      refreshing.add(key)
      void refreshEntry(st, axis, storeKeyOf, body, children, options, wakeHints, bodyParent)
        .catch((err) => console.error(`[cache] SWR refresh failed for ${key}:`, err))
        .finally(() => refreshing.delete(key))
    }
    return replayEntry(existing, options)
  }

  // ── Miss path ──
  const lkg = errorServableEntry(st, axis, options, now)
  const outstanding = st.failures.get(axis)

  // Backoff gate: an outstanding failure inside its retry window
  // serves last-known-good WITHOUT re-running the failing loader. The
  // retry boundary re-arms on this render's box so the wheel stays
  // scheduled; no `onPartonError` event — nothing was attempted.
  if (outstanding && now < outstanding.nextRetryAt && lkg) {
    armRetry(wakeHints, outstanding.nextRetryAt)
    return staleReplay(lkg, outstanding, options)
  }

  let attempt = inFlightMiss.get(baseKey)
  const instigator = !attempt
  if (!attempt) {
    attempt = attemptRender(st, axis, storeKeyOf, body, children, options, wakeHints, bodyParent)
    inFlightMiss.set(baseKey, attempt)
    void attempt.settled.finally(() => inFlightMiss.delete(baseKey))
  }

  if (lkg) {
    // Guarded attempt: a last-known-good exists, so hold this response
    // until the LOADER settles — a failure then serves the good bytes
    // instead of streaming an error card the client would have to live
    // with. The gate is the parton's own body promise, not the stream
    // drain: once the loader resolves, the tree is released and inner
    // Suspense streams as usual (a descendant throw is outside the
    // recovery contract and surfaces as the boundary card, exactly as
    // on the no-LKG path).
    const failure = await attempt.loaderFailure
    if (failure !== undefined) {
      const record = st.failures.get(axis) ?? recordFailure(st, axis, failure, wakeHints)
      armRetry(wakeHints, record.nextRetryAt)
      if (instigator) {
        emitPartonError({
          partonId: id,
          error: failure,
          attempts: record.attempts,
          servedStale: true,
          retryAt: record.nextRetryAt,
        })
      }
      return staleReplay(lkg, record, options)
    }
    return attempt.liveTree
  }

  // No last-known-good: stream the attempt as-is. A failure surfaces
  // as the boundary's error card — the bounded first-visit state — and
  // the rejection observer has already recorded the failure + armed
  // the retry boundary by the time the error row hits the wire, so a
  // live connection re-attempts on schedule and a later success
  // replaces the card (the boundary clears on the new emission).
  if (instigator) {
    void attempt.settled.then((result) => {
      if (result.failure === undefined) return
      const record = st.failures.get(axis)
      if (!record) return
      emitPartonError({
        partonId: id,
        error: result.failure,
        attempts: record.attempts,
        servedStale: false,
        retryAt: record.nextRetryAt,
      })
    })
  }
  return attempt.liveTree
}

// ─── Miss attempt ───────────────────────────────────────────────────────

interface AttemptResult {
  /** The body's rejection when the attempt FAILED (unexpected error —
   *  recovery engages). `undefined` for a clean store AND for
   *  pass-through outcomes (sentinels, render cancellation), which are
   *  not failures: nothing stores, nothing retries, the bytes carry
   *  the control flow as always. */
  failure: unknown | undefined
}

interface Attempt {
  /** Decoded live tree — streams immediately (inner Suspense stays
   *  lazy), exactly like an uncached render. */
  liveTree: Promise<ReactNode>
  /** The recovery decision, available as soon as the parton's OWN body
   *  promise settles — before inner Suspense resolves, so a serve
   *  gated on it still streams. Resolves to the loader's rejection
   *  value on failure, `undefined` on a clean settle or a pass-through
   *  outcome (sentinels, render cancellation). Never rejects. */
  loaderFailure: Promise<unknown | undefined>
  /** Resolves once the body's stream fully settled and the store
   *  decision was made. Never rejects. */
  settled: Promise<AttemptResult>
}

/**
 * One rendered miss attempt: render the body to Flight bytes, tee into
 * a streaming user branch and a buffered storage branch, and decide at
 * settle time — store on success (updating last-known-good + clearing
 * the failure streak), store NOTHING on any body rejection. An entry
 * is always a good render; error rows never enter the cache (a stored
 * error would byte-replay as a cached error card, and a sentinel's
 * control-channel side effect can't ride a replay).
 */
function attemptRender(
  st: ScopeState,
  axis: string,
  storeKeyOf: () => string,
  body: ObservedBody,
  children: ReactNode,
  options: CacheOptions,
  wakeHints: WakeHints | undefined,
  bodyParent: PartialCtx,
): Attempt {
  // Arm BEFORE the render stream is created: the observer's handler is
  // attached ahead of the Flight runtime's, so on rejection the
  // failure record + retry boundary land synchronously, mid-render.
  body.armRecovery((error) => recordFailure(st, axis, error, wakeHints))

  const stream = renderToReadableStream(
    <ParentContext value={bodyParent}>{children}</ParentContext>,
  )
  const [userBranch, storageBranch] = stream.tee()

  const settled = (async (): Promise<AttemptResult> => {
    let rawBytes: Uint8Array
    try {
      rawBytes = await readAll(storageBranch)
    } catch (err) {
      // The render stream itself tore (an abort mid-flight). Nothing
      // to store, nothing to retry — the response this render fed is
      // being wound down.
      return { failure: isExpectedRenderError(err) ? undefined : err }
    }
    // Settled by stream close — the root row IS the body's serialization.
    const bodyError = await body.outcome
    if (bodyError !== undefined) {
      return { failure: isExpectedRenderError(bodyError) ? undefined : bodyError }
    }
    try {
      const { bytes, holes, meta } = stripHoles(rawBytes)
      const entry = freshEntry(bytes, enrichHoles(holes), meta, options, wakeHints, Date.now())
      await st.store.set(storeKeyOf(), entry)
      setLastGood(st, axis, entry)
      st.failures.delete(axis)
    } catch (err) {
      // Storage machinery failure — the RENDER succeeded, so the user
      // branch stays servable; only this entry's persistence is lost.
      console.error(`[cache] storage finalize failed for ${storeKeyOf()}:`, err)
    }
    return { failure: undefined }
  })()

  // User branch: decode immediately. Inner Suspense stays lazy so the
  // client paints fallbacks while async work resolves — the cold
  // render streams exactly like an uncached one.
  const liveTree = createFromReadableStream<ReactNode>(userBranch)
  const loaderFailure = body.outcome.then((error) =>
    error !== undefined && !isExpectedRenderError(error) ? error : undefined,
  )
  return { liveTree, loaderFailure, settled }
}

/**
 * Stale-while-revalidate refresh. Re-encodes the SAME settled body
 * output (the body already ran for the hit render) — it never re-runs
 * the parton, so it can neither newly fail a loader nor recover one.
 * When THIS render's body rejected, the refresh keeps the stored entry
 * untouched: a good entry must never be overwritten with error rows.
 */
async function refreshEntry(
  st: ScopeState,
  axis: string,
  storeKeyOf: () => string,
  body: ObservedBody,
  children: ReactNode,
  options: CacheOptions,
  wakeHints: WakeHints | undefined,
  bodyParent: PartialCtx,
): Promise<void> {
  const rawBytes = await readAll(
    renderToReadableStream(<ParentContext value={bodyParent}>{children}</ParentContext>),
  )
  if ((await body.outcome) !== undefined) return
  const { bytes, holes, meta } = stripHoles(rawBytes)
  const entry = freshEntry(bytes, enrichHoles(holes), meta, options, wakeHints, Date.now())
  await st.store.set(storeKeyOf(), entry)
  setLastGood(st, axis, entry)
}

/** Entry timestamps: the option-derived windows clamped to the body's
 *  declared wake-hint boundaries. `expires()` alone (no `staleUntil()`)
 *  clamps BOTH windows to the boundary — an expired declaration is a
 *  hard miss, never stale-servable, because the SWR refresh re-encodes
 *  the same settled body output rather than re-running the parton. An
 *  infinite hint (`time().never`) is a no-op under `Math.min`. */
function freshEntry(
  bytes: Uint8Array,
  holes: StoredHole[],
  meta: SpliceMeta,
  options: CacheOptions,
  hints: WakeHints | undefined,
  now: number,
): Entry {
  const { maxAge, staleWhileRevalidate: swr } = options
  let expiresAt = maxAge != null ? now + maxAge * 1000 : Number.POSITIVE_INFINITY
  let staleUntil = swr != null && maxAge != null ? expiresAt + swr * 1000 : expiresAt
  const declaredExpires = hints?.expiresAt
  const declaredStale = hints?.staleUntil ?? declaredExpires
  if (declaredExpires !== undefined) expiresAt = Math.min(expiresAt, declaredExpires)
  if (declaredStale !== undefined) staleUntil = Math.min(staleUntil, declaredStale)
  return { bytes, holes, meta, expiresAt, staleUntil }
}

export function _cacheStats(): Promise<{ size: number; keys: string[] }> {
  return state().store.stats()
}

export async function _clearCache(scope?: string | "all"): Promise<void> {
  if (scope === undefined || scope === "all") {
    const all = [...scopes.values()]
    scopes.clear()
    await Promise.all(all.map((s) => s.store.clear()))
    return
  }
  const s = scopes.get(scope)
  if (!s) return
  scopes.delete(scope)
  await s.store.clear()
}

if (import.meta.hot) {
  // See partial-registry.ts — only clear on a true full reload.
  // `vite:beforeUpdate` fires for every incremental HMR update and
  // would wipe every scope's cache on each one, polluting parallel
  // tests.
  import.meta.hot.on("vite:beforeFullReload", () => {
    void _clearCache()
  })
}
