/**
 * Convergence fuzzer v2 — the seeded walk drives the REAL client merge
 * layer instead of a model of it. Design note:
 * `docs/notes/convergence-fuzzing.md` (§v2).
 *
 * Each step renders the fixture through the real server (a real
 * request scope: `?cached=` manifest built from the client's own
 * advertised fingerprints, the connection-session visible set, cell
 * writes through request scopes), encodes to real Flight bytes,
 * decodes with the real Flight client, and commits through the real
 * merge functions:
 *
 *   - whole-tree steps run the same walk `PartialsClient` runs in the
 *     browser (`cacheFromStreamingChildren` → `deriveTemplate` /
 *     `setTemplate` → nested-harvest frontier expansion →
 *     `pruneToLive`) — the walks, template ops and state modules are
 *     the real ones; the ~30-line orchestration is transcribed from
 *     `partial-client.tsx` (kept in lockstep by hand — React's render
 *     lifecycle itself stays out);
 *   - lane steps re-render one parton from its registry snapshot
 *     (`partialFromSnapshot` under a lane-shaped partial state, the
 *     production lane pipeline) and commit through the REAL
 *     `_commitPartonLane` / `_commitPartonLaneProgressive`, with the
 *     real `_applyFpUpdates` for the lane's fp trailer.
 *
 * Interleaving is a fuzz dimension, causally: a delivery may WITHHOLD
 * tail Flight rows at commit time (the decoded chunks are genuinely
 * pending — the settlement re-walk machinery arms for real), and the
 * held remainder + the response's fp trailer become an ordered event
 * the walk releases later — trailer-before-settlement or after, both
 * orders reachable from the seed. Quiescence is the re-walks' own
 * completion signal (`_settleLaneRewalksForTest`), never a timer.
 *
 * Oracles at the end of every trial (after a forced settle):
 *
 *   1. CONVERGENCE — `renderTemplate(template, cache)` over the real
 *      client state must equal a fresh cold render of the final URL +
 *      scope + visibility set (state / stamp / matchKey per parton).
 *   2. ADVERTISE HONESTY — every advertised `id:matchKey:fp` token is
 *      restorable (content slot present), and a fresh server render
 *      presented with the FULL advertised manifest must neither
 *      confirm content the client cannot restore or holds stale
 *      (ghost / stale confirm), nor re-render full-price a leaf whose
 *      client copy is provably current (the e728964 class).
 */

import type { ReactElement, ReactNode } from "react"
import { isValidElement } from "react"
import {
  _captureCommitHandle,
  _setConnectionSession,
  runWithRequestAsync,
} from "../runtime/context.ts"
import type { FpUpdatesPayload } from "../lib/fp-trailer-marker.ts"
import { splitAtFpTrailer } from "../lib/fp-trailer-split.ts"
import { _recomputeSubtreeWarmFp, wrapStreamWithFpTrailer } from "../lib/fp-trailer.ts"
import {
  _commitPartonLane,
  _commitPartonLaneProgressive,
  _laneCommitGenerationForTest,
  _settleLaneRewalksForTest,
  addSeen,
  cacheFromStreamingChildren,
  getPartialId,
  getPartialMatchKey,
  getPlaceholderId,
  harvestPartialIds,
  isPartialWrapper,
  isPlaceholder,
  type LazyWalkStats,
} from "../lib/partial-cache.ts"
import {
  _addLiveTreeIds,
  _applyFpUpdates,
  _nextStoreSeq,
  _runWithStoreSeq,
  cacheLookup,
  getAllCachedPartialTokens,
  getCachedPartialIds,
  getCurrentPagePartials,
  pruneToLive,
  setTemplate,
  getTemplate,
} from "../lib/partial-client-state.ts"
import { deriveTemplate, renderTemplate } from "../lib/partial-template.tsx"
import { computeRouteKey, parseCachedTokens, partialFromSnapshot } from "../lib/partial.tsx"
import { enterRequestRegistry, lookupPartial } from "../lib/partial-registry.ts"
import { runWithPartialState } from "../lib/partial-request-state.ts"
import { consumePayload, renderServerToFlight } from "./rsc-server.ts"
import { extractPartonView } from "./fuzz-wire.ts"
import { mulberry32, pick, type Mismatch } from "./fuzz-harness.ts"

export interface SequenceResultV2 {
  seed: number
  actions: FuzzActionV2[]
  mismatches: Mismatch[]
  /** A driver/harness failure (crash, decode error) — also a finding,
   *  classified separately from oracle mismatches. */
  failure: string | null
  finalUrl: string
  visible: string[]
  /** The trial's server scope — post-trial debug renders can re-enter
   *  it (`_debugRenderTree`). */
  scope: string
}

// ─── Fixture + action surface ────────────────────────────────────────

export interface FuzzFixtureV2 {
  /** The page the whole-tree renders serve. */
  page: () => ReactNode
  /** Every parton id under oracle comparison. */
  universeIds: readonly string[]
  /** Ids that carry a `cull` gate — the flip-action candidates. */
  cullableIds: readonly string[]
  /** Cullable ids in view at attach time. */
  initialVisible: readonly string[]
  /** parton id → its enclosing PARTON id, for display cascading. */
  parentOf: Readonly<Record<string, string | undefined>>
  /** Wrapper ids whose fp may legitimately drift after lane-only
   *  descendant updates (over-fetch, never stale) — exempt from the
   *  honesty oracle's full-price check; stamps still compare. */
  foldDriftAllowed: ReadonlySet<string>
  /** Navigation universe. Index 0 is the attach URL. */
  urls: readonly string[]
  /** Labels (= parton ids in this fixture) the refetch action forces. */
  refetchLabels: readonly string[]
  /** Cell writes through a real request scope. */
  writes: ReadonlyArray<{
    name: string
    apply: (scope: string, url: string, value: number) => Promise<void>
  }>
}

/** Per-delivery interleaving plan — part of the ACTION so a shrunk
 *  repro carries its own schedule. */
export interface DeliveryPlan {
  /** Flight rows withheld from the tail at first commit (0 = full
   *  delivery). A held delivery leaves genuinely pending chunks in the
   *  committed tree and becomes a queued release event. */
  hold: number
  /** Order of the two release events of a held delivery: the fp
   *  trailer apply vs the withheld rows' settlement (+ re-walks). */
  order: "trailer-first" | "settle-first"
  /** Commit this action's lane set in reverse order (rival orderings). */
  reverse?: boolean
}

export type FuzzActionV2 =
  | { kind: "navigate"; url: string; delivery: DeliveryPlan }
  | { kind: "write"; cell: number; value: number; delivery: DeliveryPlan }
  | { kind: "flip"; ids: string[]; delivery: DeliveryPlan }
  | { kind: "refetch"; label: string; delivery: DeliveryPlan }
  /** Release the OLDEST held delivery (bytes + trailer, per its plan). */
  | { kind: "release" }
  /** Release everything held and drain the settlement re-walks. */
  | { kind: "settle" }

export function generateSequenceV2(
  seed: number,
  length: number,
  fixture: FuzzFixtureV2,
): FuzzActionV2[] {
  const rand = mulberry32(seed)
  const actions: FuzzActionV2[] = []
  let writeCounter = 0
  const delivery = (): DeliveryPlan => {
    const hold = rand() < 0.55 ? 0 : 1 + Math.floor(rand() * 3)
    const order = rand() < 0.5 ? ("trailer-first" as const) : ("settle-first" as const)
    const reverse = rand() < 0.5
    return { hold, order, reverse }
  }
  for (let i = 0; i < length; i++) {
    const r = rand()
    if (r < 0.16) {
      actions.push({ kind: "navigate", url: pick(rand, fixture.urls), delivery: delivery() })
    } else if (r < 0.42) {
      actions.push({
        kind: "write",
        cell: Math.floor(rand() * fixture.writes.length),
        value: ++writeCounter,
        delivery: delivery(),
      })
    } else if (r < 0.62) {
      const count = rand() < 0.7 ? 1 : 2
      const ids = new Set<string>()
      for (let k = 0; k < count; k++) ids.add(pick(rand, fixture.cullableIds))
      actions.push({ kind: "flip", ids: [...ids], delivery: delivery() })
    } else if (r < 0.76) {
      actions.push({
        kind: "refetch",
        label: pick(rand, fixture.refetchLabels),
        delivery: delivery(),
      })
    } else if (r < 0.88) {
      actions.push({ kind: "release" })
    } else {
      actions.push({ kind: "settle" })
    }
  }
  return actions
}

// ─── Server-side render helpers (real request scopes) ────────────────

interface RenderedDoc {
  /** Flight body text, trailer markers stripped (row lines only). */
  text: string
  /** The response's cold→warm heal map (whole map, last-wins). */
  trailer: FpUpdatesPayload | null
}

async function renderTree(
  scope: string,
  url: string,
  page: () => ReactNode,
  opts: { visible: readonly string[]; cached: readonly string[] },
): Promise<RenderedDoc> {
  const sep = url.includes("?") ? "&" : "?"
  const full = opts.cached.length > 0 ? `${url}${sep}cached=${opts.cached.join(",")}` : url
  const request = new Request(`http://localhost${full}`, { headers: { "x-test-scope": scope } })
  const { result } = await runWithRequestAsync(request, async () => {
    _setConnectionSession({ visible: new Set(opts.visible), ackedFps: new Map() })
    const wrapped = wrapStreamWithFpTrailer(renderServerToFlight(page()), _captureCommitHandle(), {
      incremental: false,
    })
    const { mainStream, trailer } = splitAtFpTrailer(wrapped)
    // Draining forces the lazy Flight render to completion INSIDE the
    // request scope, so the registry commit sees every registration.
    const text = await new Response(mainStream).text()
    const map = (await trailer.catch(() => null)) as FpUpdatesPayload | null
    return { text, trailer: map }
  })
  return result
}

/** Re-render ONE parton from its registry snapshot — the production
 *  lane pipeline (`pumpLane`'s render shape): lane-scoped partial
 *  state carrying the client's advertised manifest so the fp-skip
 *  verdict is decided by the real claim, `flushScopeId` so the trailer
 *  heals only this render's subtree. Returns `null` when the id has no
 *  snapshot on the current route (match-missed / never rendered). */
async function renderLane(
  scope: string,
  url: string,
  id: string,
  opts: { visible: readonly string[]; cached: readonly string[]; force: boolean },
): Promise<RenderedDoc | null> {
  const request = new Request(`http://localhost${url}`, { headers: { "x-test-scope": scope } })
  const { result } = await runWithRequestAsync(request, async () => {
    _setConnectionSession({ visible: new Set(opts.visible), ackedFps: new Map() })
    enterRequestRegistry(computeRouteKey(request.url), "cache")
    const snap = lookupPartial(id)
    if (!snap) return null
    const parsed = parseCachedTokens(opts.cached.join(","))
    return runWithPartialState(
      {
        requestedIds: null,
        isPartialRefetch: true,
        cachedFingerprints: parsed.fingerprints,
        cachedMatchKeys: parsed.matchKeys,
        ackedFingerprints: null,
        explicitIds: opts.force ? new Set([id]) : new Set<string>(),
        seenIds: new Set<string>(),
      },
      async () => {
        const wrapped = wrapStreamWithFpTrailer(
          renderServerToFlight(partialFromSnapshot(id, snap)),
          _captureCommitHandle(),
          { incremental: false, flushScopeId: id },
        )
        const { mainStream, trailer } = splitAtFpTrailer(wrapped)
        const text = await new Response(mainStream).text()
        const map = (await trailer.catch(() => null)) as FpUpdatesPayload | null
        return { text, trailer: map }
      },
    )
  })
  return result
}

// ─── Client-side controlled decode ───────────────────────────────────

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Pure failure detection — a hang is a finding, not a wait. Same env
 *  override contract as v1 (`FUZZ_WATCHDOG_MS` keeps watchdog-class
 *  shrinks tractable on long local runs). */
const WATCHDOG_MS = Number(process.env.FUZZ_WATCHDOG_MS ?? 20_000)

interface ControlledDecode {
  root: ReactNode
  /** Enqueue the withheld rows and close the decode stream, or `null`
   *  when the delivery was complete at decode time. */
  releaseRest: (() => void) | null
  /** Error the decode stream — the withheld rows never arrive and the
   *  pending chunks REJECT (a navigation tearing an open lane). */
  tear: () => void
}

/**
 * Decode a Flight document through the REAL Flight client from a
 * harness-controlled stream, withholding the last `hold` rows. The
 * root promise is fed until it resolves (a withheld row the root model
 * references directly blocks the root — feeding forward is bounded by
 * the row count), so a "held" delivery always yields a committed-able
 * root with genuinely pending chunks behind it.
 */
async function decodeWithHold(text: string, hold: number): Promise<ControlledDecode> {
  const lines = text.split("\n").filter((l) => l.length > 0)
  const total = lines.length
  const enc = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  const rootP = consumePayload<ReactNode>(stream)
  let settled = false
  let rootVal: ReactNode = null
  let rootErr: unknown = null
  void rootP.then(
    (v) => {
      settled = true
      rootVal = v
    },
    (e) => {
      settled = true
      rootErr = e
    },
  )
  const enqueue = (i: number): void => controller.enqueue(enc.encode(lines[i] + "\n"))
  const close = (): void => {
    try {
      controller.close()
    } catch {
      /* already closed */
    }
  }
  let cut = Math.max(1, total - Math.max(0, hold))
  for (let i = 0; i < cut; i++) enqueue(i)
  if (cut >= total) close()
  // Feed until the decoder yields a root. Fixed spin policy (three
  // microtask/macrotask turns per row) keeps the schedule a pure
  // function of the byte content.
  while (!settled) {
    for (let spins = 0; spins < 3 && !settled; spins++) await tick()
    if (settled) break
    if (cut < total) {
      enqueue(cut)
      cut++
      if (cut >= total) close()
    } else {
      await rootP.catch(() => {})
      break
    }
  }
  if (rootErr !== null) throw rootErr
  const tear = (): void => {
    try {
      controller.error(new Error("fuzz v2: navigation tore this delivery"))
    } catch {
      /* already closed */
    }
  }
  if (cut >= total) return { root: rootVal, releaseRest: null, tear }
  let released = false
  const startRest = cut
  return {
    root: rootVal,
    releaseRest: () => {
      if (released) return
      released = true
      for (let i = startRest; i < total; i++) enqueue(i)
      close()
    },
    tear: () => {
      if (released) return
      released = true
      tear()
    },
  }
}

async function decodeAll(text: string): Promise<ReactNode> {
  const decoded = await decodeWithHold(text, 0)
  return decoded.root
}

// ─── The whole-tree commit (PartialsClient's browser path) ───────────

interface WholeTreeState {
  lastPayload: ReactNode
  complete: boolean
  /** The payload's store-seq batch (see `_runWithStoreSeq`) — re-walk
   *  passes of the same payload write under it, mirroring
   *  `PartialsClient`'s `_walkStoreSeq`. */
  storeSeq: number
}

/**
 * One pass of the walk `PartialsClient` runs per payload render —
 * transcribed from `partial-client.tsx` (the real functions throughout;
 * the component's React wiring is the only thing not executed). An
 * incomplete pass (pending Flight chunks) leaves the stored template
 * and prune untouched, exactly like the component's pending branch; the
 * caller re-runs the pass when the held rows land, mirroring
 * `scheduleRewalkOnResolve` → re-render (superseded payloads skipped).
 */
function walkWholeTree(root: ReactNode, route: string, st: WholeTreeState): LazyWalkStats {
  const cache = getCurrentPagePartials()
  if (st.lastPayload === root && st.complete) return { pending: 0 }
  if (st.lastPayload !== root) st.storeSeq = _nextStoreSeq()
  st.lastPayload = root
  st.complete = false
  const seen = new Map<string, Set<string>>()
  const stats: LazyWalkStats = { pending: 0, thenables: [] }
  _runWithStoreSeq(st.storeSeq, () => cacheFromStreamingChildren(root, cache, seen, stats))
  if (stats.pending > 0) return stats
  const derived = deriveTemplate(root)
  setTemplate(derived, route)
  // Frontier expansion — nested (id, matchKey) pairs reachable through
  // cached wrappers survive the prune (transcribed from PartialsClient).
  let frontier: Array<[string, string]> = []
  const harvestStats = { pending: 0 }
  for (const [id, mks] of seen) for (const mk of mks) frontier.push([id, mk])
  while (frontier.length > 0) {
    const next: Array<[string, string]> = []
    for (const [id, mk] of frontier) {
      const wrapper = cacheLookup(cache, id, mk)
      if (!wrapper) continue
      const inner = (wrapper as { props?: { children?: ReactNode } }).props?.children
      if (inner == null) continue
      const nested = new Map<string, Set<string>>()
      harvestPartialIds(inner, nested, harvestStats)
      for (const [nid, nmks] of nested) {
        for (const nmk of nmks) {
          const existing = seen.get(nid)
          if (!existing || !existing.has(nmk)) {
            addSeen(seen, nid, nmk)
            next.push([nid, nmk])
          }
        }
      }
    }
    frontier = next
  }
  // A pending-BLOCKED harvest defers the prune (F11) — mirror of
  // PartialsClient's guard: pruning what the harvest couldn't see
  // would blank the nested variants behind a mid-stream chunk.
  if (harvestStats.pending === 0) {
    pruneToLive(seen)
  } else {
    _addLiveTreeIds(seen.keys())
  }
  st.complete = true
  return stats
}

// ─── Held deliveries ─────────────────────────────────────────────────

interface HeldDelivery {
  kind: "lane" | "tree"
  id: string | null
  root: ReactNode
  releaseRest: () => void
  trailer: FpUpdatesPayload | null
  order: "trailer-first" | "settle-first"
  /** Error the delivery's decode stream — a navigation tear. */
  tear: () => void
  /** lane only — the commit's generation (scopes the settle await to
   *  exactly this delivery's re-walk chain; an EARLIER held delivery
   *  of the same parton may still be withholding its own bytes). */
  generation: number
  /** tree only — the route the payload rendered for. */
  route: string
  /** tree only — the first walk's captured pending chunks. */
  thenables: readonly PromiseLike<unknown>[]
}

// ─── The client-tree view (oracle side A) ────────────────────────────

interface ClientView {
  /** Non-parked wrapper sightings: id → matchKey. */
  wrappers: Map<string, string>
  /** Non-parked bare placeholder sightings (unhealed holes). */
  holes: Set<string>
  /** Displayed (non-parked, non-culled-context) stamps per id. */
  stamps: Map<string, string>
  /** CullPair sightings: id → the pair element was in the tree. */
  pairs: Set<string>
}

const STAMP_RE = /\[S\|([a-z0-9-]+)\|([^\]]*)\]/g

const isLazyNode = (n: unknown): n is { _payload?: unknown } =>
  typeof n === "object" &&
  n !== null &&
  typeof (n as { $$typeof?: symbol }).$$typeof === "symbol" &&
  String((n as { $$typeof?: symbol }).$$typeof) === "Symbol(react.lazy)"

const isThenable = (n: unknown): n is PromiseLike<unknown> =>
  typeof n === "object" && n !== null && typeof (n as PromiseLike<unknown>).then === "function"

/**
 * Await-based structural walk of the CLIENT's rendered tree (test-side
 * only — the merge layer under test never awaits): follow settling
 * thenables and lazies the way React's own render would, tracking
 * hidden context (`<Activity mode="hidden">` — parked variants) and
 * culled context (a CullPair whose id the harness's stated set culls).
 */
async function collectClientView(
  node: ReactNode,
  culls: (id: string) => boolean,
  out: ClientView,
  hidden: boolean,
): Promise<void> {
  if (node == null || typeof node === "boolean") return
  if (typeof node === "string" || typeof node === "number") {
    if (!hidden) {
      const s = String(node)
      STAMP_RE.lastIndex = 0
      for (let m = STAMP_RE.exec(s); m !== null; m = STAMP_RE.exec(s)) {
        out.stamps.set(m[1], m[2])
      }
    }
    return
  }
  if (Array.isArray(node)) {
    for (const c of node) await collectClientView(c as ReactNode, culls, out, hidden)
    return
  }
  if (isLazyNode(node)) {
    const payload = (node as { _payload?: unknown })._payload
    if (isThenable(payload)) {
      try {
        await collectClientView((await payload) as ReactNode, culls, out, hidden)
      } catch {
        /* errored lazy — opaque */
      }
    }
    return
  }
  if (isThenable(node)) {
    try {
      await collectClientView((await node) as ReactNode, culls, out, hidden)
    } catch {
      /* rejected chunk — opaque */
    }
    return
  }
  if (!isValidElement(node)) return
  const el = node as ReactElement
  const props = el.props as Record<string, unknown>
  // <Activity mode="hidden"> — parked context.
  if (typeof el.type === "symbol" && String(el.type) === "Symbol(react.activity)") {
    await collectClientView(
      props.children as ReactNode,
      culls,
      out,
      hidden || props.mode === "hidden",
    )
    return
  }
  // CullPair — content slot in `children`; display follows the STATED
  // set (the client's own statement has precedence over emission).
  if (typeof props.id === "string" && "culled" in props && "skel" in props) {
    if (!hidden) out.pairs.add(props.id)
    await collectClientView(props.children as ReactNode, culls, out, hidden || culls(props.id))
    return
  }
  if (isPlaceholder(el)) {
    const id = getPlaceholderId(el)
    if (id && !hidden) out.holes.add(id)
    return
  }
  if (isPartialWrapper(el)) {
    const id = getPartialId(el)
    if (id && !hidden && !out.wrappers.has(id)) {
      out.wrappers.set(id, getPartialMatchKey(el) ?? "")
    }
    await collectClientView(props.children as ReactNode, culls, out, hidden)
    return
  }
  if (props.children != null) {
    await collectClientView(props.children as ReactNode, culls, out, hidden)
  }
}

/** The stamp inside ONE cached content slot (any context — parked
 *  content included; used by the honesty oracle's confirm checks). */
async function stampOfCached(node: ReactNode, id: string): Promise<string | null> {
  const out: ClientView = {
    wrappers: new Map(),
    holes: new Set(),
    stamps: new Map(),
    pairs: new Set(),
  }
  await collectClientView(node, () => false, out, false)
  return out.stamps.get(id) ?? null
}

// ─── The cold oracle (oracle side B) ─────────────────────────────────

type ColdState =
  | { state: "content"; stamp: string | null; matchKey: string | null }
  | { state: "culled" }
  | { state: "absent" }

function coldStates(text: string, universeIds: readonly string[]): Map<string, ColdState> {
  const ex = extractPartonView(text)
  const states = new Map<string, ColdState>()
  for (const id of universeIds) {
    if (ex.pairs.get(id) === true) {
      states.set(id, { state: "culled" })
      continue
    }
    const fresh = ex.observations.find((o) => !o.parked && o.id === id && o.kind === "fresh")
    if (fresh !== undefined) {
      states.set(id, {
        state: "content",
        stamp: ex.stamps.get(id) ?? null,
        matchKey: fresh.matchKey,
      })
      continue
    }
    const holed = ex.observations.find((o) => !o.parked && o.id === id)
    if (holed !== undefined) {
      // A cold render is presented no manifest, so a non-parked hole is
      // an oracle anomaly — surface it as content-with-nothing.
      states.set(id, { state: "content", stamp: null, matchKey: holed.matchKey })
      continue
    }
    states.set(id, { state: "absent" })
  }
  return states
}

// ─── The runner ──────────────────────────────────────────────────────

let scopeCounter = 0

export async function runSequenceV2(
  fixture: FuzzFixtureV2,
  seed: number,
  actions: FuzzActionV2[],
  isolate: () => void,
  debug?: (msg: string) => void,
): Promise<SequenceResultV2> {
  isolate()
  const scope = `fuzz2-${seed}-${++scopeCounter}`
  let currentUrl = fixture.urls[0]
  const statedVisible = new Set(fixture.initialVisible)
  /** Ids present on the current route per the last whole-tree render —
   *  the lane fan-out set (the client-side equivalent of the wake
   *  registry's route scoping). */
  let liveIds = new Set<string>()
  const held: HeldDelivery[] = []
  const treeState: WholeTreeState = { lastPayload: null, complete: false, storeSeq: 0 }

  const result: SequenceResultV2 = {
    seed,
    actions,
    mismatches: [],
    failure: null,
    finalUrl: currentUrl,
    visible: [],
    scope,
  }

  const culls = (id: string): boolean => fixture.cullableIds.includes(id) && !statedVisible.has(id)

  const displayedCulled = (id: string): boolean => {
    if (culls(id)) return true
    for (let p = fixture.parentOf[id]; p !== undefined; p = fixture.parentOf[p]) {
      if (culls(p)) return true
    }
    return false
  }

  const visibleList = (): string[] => [...statedVisible]

  const deriveLiveIds = (text: string): Set<string> => {
    const ex = extractPartonView(text)
    const ids = new Set<string>()
    for (const obs of ex.observations) if (!obs.parked) ids.add(obs.id)
    for (const [id] of ex.pairs) ids.add(id)
    return ids
  }

  const releaseHeld = async (h: HeldDelivery): Promise<void> => {
    debug?.(`release held ${h.kind}:${h.id ?? "<tree>"} order=${h.order}`)
    if (h.order === "trailer-first" && h.trailer) _applyFpUpdates(h.trailer)
    h.releaseRest()
    debug?.(`released rest ${h.kind}:${h.id ?? "<tree>"}`)
    if (h.kind === "lane") {
      // The REAL settlement re-walks consume the released rows; their
      // completion is the drain signal — scoped to exactly THIS
      // delivery's chain (other deliveries may still be held).
      await _settleLaneRewalksForTest(h.id ?? undefined, h.generation)
    } else {
      // Mirror `scheduleRewalkOnResolve` → re-render → re-walk: wait
      // for the captured chunks, then re-run the payload walk — unless
      // a newer payload superseded this one.
      await Promise.allSettled(h.thenables.map((t) => Promise.resolve(t)))
      debug?.(`tree hold thenables settled`)
      if (treeState.lastPayload === h.root && !treeState.complete) {
        // Bounded: every release loop settles strictly more chunks.
        for (let pass = 0; pass < 32; pass++) {
          treeState.complete = false
          const stats = walkWholeTree(h.root, h.route, treeState)
          if (stats.pending === 0) break
          await Promise.allSettled((stats.thenables ?? []).map((t) => Promise.resolve(t)))
        }
      }
    }
    if (h.order === "settle-first" && h.trailer) _applyFpUpdates(h.trailer)
    debug?.(`release done ${h.kind}:${h.id ?? "<tree>"}`)
  }

  const releaseAll = async (): Promise<void> => {
    while (held.length > 0) {
      const h = held.shift()!
      await releaseHeld(h)
    }
    await _settleLaneRewalksForTest()
  }

  const commitTree = async (doc: RenderedDoc, url: string, plan: DeliveryPlan): Promise<void> => {
    debug?.(`commitTree ${url} hold=${plan.hold}`)
    const route = new URL(url, "http://localhost").pathname
    liveIds = deriveLiveIds(doc.text)
    if (plan.hold === 0) {
      const root = await decodeAll(doc.text)
      const stats = walkWholeTree(root, route, treeState)
      // Full bytes: pending chunks (if any) settle without further
      // input — drain and re-walk to completion, then apply the
      // trailer (the standard order: walk first, trailer after).
      if (stats.pending > 0) {
        held.push({
          kind: "tree",
          id: null,
          root,
          releaseRest: () => {},
          tear: () => {},
          trailer: doc.trailer,
          order: "settle-first",
          generation: 0,
          route,
          thenables: stats.thenables ?? [],
        })
        await releaseHeld(held.pop()!)
        return
      }
      if (doc.trailer) _applyFpUpdates(doc.trailer)
      return
    }
    const { root, releaseRest, tear } = await decodeWithHold(doc.text, plan.hold)
    const stats = walkWholeTree(root, route, treeState)
    if (releaseRest === null || stats.pending === 0) {
      // The hold collapsed (all rows needed for the root) or the walk
      // completed regardless — release and finish as a full delivery.
      releaseRest?.()
      if (doc.trailer) _applyFpUpdates(doc.trailer)
      return
    }
    held.push({
      kind: "tree",
      id: null,
      root,
      releaseRest,
      tear,
      trailer: doc.trailer,
      order: plan.order,
      generation: 0,
      route,
      thenables: stats.thenables ?? [],
    })
  }

  const commitLane = async (id: string, doc: RenderedDoc, plan: DeliveryPlan): Promise<void> => {
    debug?.(
      `commitLane ${id} hold=${plan.hold} rows=${doc.text.split("\n").filter((l) => l.length > 0).length}`,
    )
    if (plan.hold === 0) {
      const root = await decodeAll(doc.text)
      _commitPartonLane(root, doc.trailer, id)
      await _settleLaneRewalksForTest(id, _laneCommitGenerationForTest(id))
      return
    }
    const { root, releaseRest, tear } = await decodeWithHold(doc.text, plan.hold)
    debug?.(`commitLane ${id} decoded held=${releaseRest !== null}`)
    if (releaseRest === null) {
      _commitPartonLane(root, doc.trailer, id)
      await _settleLaneRewalksForTest(id, _laneCommitGenerationForTest(id))
      return
    }
    // Held delivery — the producer/progressive contract: commit at
    // root-ready, trailer at body close (its order vs the settlement
    // re-walks is the seeded dimension).
    _commitPartonLaneProgressive(id, root)
    debug?.(`commitLane ${id} progressive committed`)
    held.push({
      kind: "lane",
      id,
      root,
      releaseRest,
      tear,
      trailer: doc.trailer,
      order: plan.order,
      generation: _laneCommitGenerationForTest(id),
      route: "",
      thenables: [],
    })
  }

  const laneTargets = (): string[] =>
    fixture.universeIds.filter((id) => liveIds.has(id) && !displayedCulled(id))

  const runLanes = async (ids: string[], plan: DeliveryPlan, force: boolean): Promise<void> => {
    const ordered = plan.reverse === true ? [...ids].reverse() : ids
    for (const id of ordered) {
      debug?.(`lane ${id} render start`)
      const doc = await renderLane(scope, currentUrl, id, {
        visible: visibleList(),
        cached: getCachedPartialIds(),
        force,
      })
      debug?.(`lane ${id} rendered ${doc === null ? "<no snapshot>" : `${doc.text.length}b`}`)
      if (doc === null) continue
      await commitLane(id, doc, plan)
      debug?.(`lane ${id} committed`)
    }
  }

  try {
    const walk = async (): Promise<void> => {
      // Attach — the boot whole-tree render (always a full delivery).
      const attach = await renderTree(scope, currentUrl, fixture.page, {
        visible: visibleList(),
        cached: [],
      })
      await commitTree(attach, currentUrl, { hold: 0, order: "settle-first" })

      for (const action of actions) {
        debug?.(`action ${JSON.stringify(action)}`)
        switch (action.kind) {
          case "navigate": {
            // The real protocol: a whole-page navigation TEARS the
            // region's open lanes — a held lane's remaining rows never
            // arrive (its chunks reject; the settlement re-walk runs
            // against the rejections and stores nothing new) and its
            // trailer never applies. A held TREE payload stays: the
            // new payload supersedes it (`treeState.lastPayload`
            // moves on).
            for (let i = held.length - 1; i >= 0; i--) {
              if (held[i].kind !== "lane") continue
              const [torn] = held.splice(i, 1)
              debug?.(`nav tear held lane:${torn.id}`)
              torn.tear()
              await _settleLaneRewalksForTest(torn.id ?? undefined, torn.generation)
            }
            currentUrl = action.url
            const doc = await renderTree(scope, currentUrl, fixture.page, {
              visible: visibleList(),
              cached: getCachedPartialIds(),
            })
            await commitTree(doc, currentUrl, action.delivery)
            break
          }
          case "write": {
            const w = fixture.writes[action.cell % fixture.writes.length]
            await w.apply(scope, currentUrl, action.value)
            // Fan out to every live, displayed parton — the fp-skip
            // verdict (a real one, against the client's real manifest)
            // decides who ships bytes and who confirms.
            await runLanes(laneTargets(), action.delivery, false)
            break
          }
          case "flip": {
            const flippedIn: string[] = []
            for (const id of action.ids) {
              if (statedVisible.has(id)) statedVisible.delete(id)
              else {
                statedVisible.add(id)
                flippedIn.push(id)
              }
            }
            // An out-flip ships no lane; an in-flip lanes the parton —
            // the verdict against the advertised tokens either confirms
            // the retained copy or replaces it.
            await runLanes(
              flippedIn.filter((id) => liveIds.has(id)),
              action.delivery,
              false,
            )
            break
          }
          case "refetch": {
            if (liveIds.has(action.label) && !displayedCulled(action.label)) {
              await runLanes([action.label], action.delivery, true)
            }
            break
          }
          case "release": {
            const h = held.shift()
            if (h !== undefined) await releaseHeld(h)
            break
          }
          case "settle": {
            await releaseAll()
            break
          }
        }
      }
      await releaseAll()

      result.finalUrl = currentUrl
      result.visible = visibleList().sort()

      // ── Oracle 1: convergence — the real client tree vs a cold render.
      const cold = await renderTree(scope, currentUrl, fixture.page, {
        visible: visibleList(),
        cached: [],
      })
      const want = coldStates(cold.text, fixture.universeIds)
      const view: ClientView = {
        wrappers: new Map(),
        holes: new Set(),
        stamps: new Map(),
        pairs: new Set(),
      }
      const rendered = renderTemplate(getTemplate(), getCurrentPagePartials())
      await collectClientView(rendered, culls, view, false)

      const displayedState = (id: string): "content" | "culled" | "absent" => {
        const observed = view.wrappers.has(id) || view.holes.has(id) || view.pairs.has(id)
        if (!observed) return "absent"
        for (let p = fixture.parentOf[id]; p !== undefined; p = fixture.parentOf[p]) {
          const pObserved = view.wrappers.has(p) || view.pairs.has(p)
          if (!pObserved || culls(p)) return "absent"
        }
        return culls(id) ? "culled" : "content"
      }

      const mismatches: Mismatch[] = []
      for (const id of fixture.universeIds) {
        const w = want.get(id) ?? { state: "absent" as const }
        const got = displayedState(id)
        if (w.state !== got) {
          mismatches.push({ id, field: "state", expected: w.state, actual: got })
          continue
        }
        if (w.state !== "content") continue
        const gotStamp = view.stamps.get(id) ?? null
        if ((w.stamp ?? "") !== (gotStamp ?? "")) {
          mismatches.push({
            id,
            field: "stamp",
            expected: w.stamp ?? "<none>",
            actual: gotStamp ?? "<none>",
          })
        }
        const gotMk = view.wrappers.get(id) ?? null
        if (w.matchKey !== null && gotMk !== null && w.matchKey !== gotMk) {
          mismatches.push({ id, field: "matchKey", expected: w.matchKey, actual: gotMk })
        }
      }

      // ── Oracle 2: advertise honesty.
      // (a) Restorability — every advertised token has a content slot.
      const cache = getCurrentPagePartials()
      const tokens = getAllCachedPartialTokens()
      for (const token of tokens) {
        const parsed = parseCachedTokens(token)
        for (const [id, mks] of parsed.matchKeys) {
          for (const mk of mks) {
            if (!cache.get(id)?.has(mk)) {
              mismatches.push({
                id,
                field: "fp",
                expected: "advertised fp backed by restorable content",
                actual: `token ${token} with no content slot`,
              })
            }
          }
        }
      }
      // (b) Skip parity + confirm honesty — present the FULL manifest.
      if (tokens.length > 0) {
        const honesty = await renderTree(scope, currentUrl, fixture.page, {
          visible: visibleList(),
          cached: tokens,
        })
        const ex = extractPartonView(honesty.text)
        for (const obs of ex.observations) {
          if (obs.parked) continue
          if (!fixture.universeIds.includes(obs.id)) continue
          if (displayedCulled(obs.id)) continue // culled content is allowed stale until its flip-in revalidates
          const w = want.get(obs.id)
          if (obs.kind === "hole" || obs.kind === "confirm") {
            const mk = obs.matchKey ?? ""
            const content = cacheLookup(cache, obs.id, mk)
            if (content === undefined) {
              mismatches.push({
                id: obs.id,
                field: "state",
                expected: "confirmed content restorable client-side",
                actual: `ghost ${obs.kind} @${mk} (no cached content)`,
              })
              continue
            }
            if (w?.state === "content" && w.matchKey === mk && w.stamp !== null) {
              const stamp = await stampOfCached(content, obs.id)
              if (stamp !== w.stamp) {
                mismatches.push({
                  id: obs.id,
                  field: "stamp",
                  expected: `${w.stamp} (server confirmed the client copy)`,
                  actual: `${stamp ?? "<none>"} (stale confirm)`,
                })
              }
            }
          }
        }
      }
      // (c) Warm skip parity — the connection flavor. A held
      // connection's lane verdict compares the WARM recompute
      // (`_recomputeSubtreeWarmFp`); the trailer heals exist precisely
      // to keep the client's manifest carrying it. A current-content
      // leaf that advertises SOMETHING for its variant but not the
      // warm fp would re-render full price on every connection nav —
      // the e728964 class (a wiped alias) and the F10 class (an alias
      // dropped because its anchor registered late). An EMPTY variant
      // advertisement is allowed — deliberate de-advertisement (the
      // torn-delivery drop) heals by over-fetch, never stale.
      // Discrete-nav parity (the emitted-fp flavor) is intentionally
      // NOT asserted: body reads lag one render, so the visit after a
      // bucket's cold record legitimately re-renders (the documented
      // cold-record over-fetch).
      const warmById = await warmRecomputeFps(scope, currentUrl, visibleList(), fixture.universeIds)
      for (const id of fixture.universeIds) {
        if (fixture.foldDriftAllowed.has(id)) continue
        if (displayedCulled(id)) continue
        const w = want.get(id)
        if (w?.state !== "content" || w.stamp === null || w.matchKey === null) continue
        const content = cacheLookup(cache, id, w.matchKey)
        if (content === undefined) continue
        const stamp = await stampOfCached(content, id)
        if (stamp !== w.stamp) continue // stale copy — convergence's finding, not parity's
        const advertised = tokens.filter((t) => t.startsWith(`${id}:${w.matchKey}:`))
        if (advertised.length === 0) continue
        const warm = warmById.get(id)
        if (warm == null) continue
        if (!advertised.some((t) => t.endsWith(`:${warm}`))) {
          mismatches.push({
            id,
            field: "fp",
            expected: `warm fp ${warm} among the advertised set (connection skip parity)`,
            actual: `advertised [${advertised.map((t) => t.split(":")[2]).join(",")}] — full price on every connection nav`,
          })
        }
      }
      result.mismatches = mismatches
    }
    // Watchdog — a deadlocked schedule (a harness bug or a real
    // merge-layer hang) surfaces as a per-trial failure with the
    // schedule attached instead of wedging the whole run.
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<never>((_, reject) => {
      watchdogTimer = setTimeout(
        () =>
          reject(
            new Error(
              `fuzz v2 watchdog: no progress in ${WATCHDOG_MS}ms ` +
                `(url=${currentUrl} held=${held.length})`,
            ),
          ),
        WATCHDOG_MS,
      )
    })
    try {
      await Promise.race([walk(), guard])
    } finally {
      clearTimeout(watchdogTimer)
    }
  } catch (err) {
    result.failure = err instanceof Error ? (err.stack ?? err.message) : String(err)
  } finally {
    // Never leave a controlled decode stream open across trials.
    for (const h of held) {
      try {
        h.releaseRest()
      } catch {
        /* torn */
      }
    }
    held.length = 0
  }
  return result
}

/** The WARM candidate fps a held connection's lane verdict would
 *  compare, per parton — `_recomputeSubtreeWarmFp` under a request
 *  scope for the given URL + visibility (the state the trial ended
 *  in). Snapshots come from the cold oracle render, which committed
 *  fresh records for everything live at the final state. */
async function warmRecomputeFps(
  scope: string,
  url: string,
  visible: readonly string[],
  ids: readonly string[],
): Promise<Map<string, string | null>> {
  const request = new Request(`http://localhost${url}`, { headers: { "x-test-scope": scope } })
  const { result } = await runWithRequestAsync(request, async () => {
    _setConnectionSession({ visible: new Set(visible), ackedFps: new Map() })
    const routeKey = computeRouteKey(request.url)
    const out = new Map<string, string | null>()
    for (const id of ids) out.set(id, _recomputeSubtreeWarmFp(scope, routeKey, id, request))
    return out
  })
  return result
}

/** Debug helper: re-render a trial's final state with an arbitrary
 *  manifest, in the trial's own scope. */
export async function _debugRenderTree(
  r: SequenceResultV2,
  fixture: FuzzFixtureV2,
  cached: readonly string[],
): Promise<RenderedDoc> {
  return renderTree(r.scope, r.finalUrl, fixture.page, { visible: r.visible, cached })
}

// ─── Shrinking ───────────────────────────────────────────────────────

/**
 * Delta-debug a failing v2 action sequence to a locally-minimal repro —
 * same discipline as v1's `shrinkSequence` (chunk removal against the
 * original failure's signature, fresh isolation per candidate).
 */
export async function shrinkSequenceV2(
  fixture: FuzzFixtureV2,
  seed: number,
  actions: FuzzActionV2[],
  isolate: () => void,
  maxRuns = 200,
): Promise<{ actions: FuzzActionV2[]; result: SequenceResultV2; runs: number }> {
  let current = actions
  let best = await runSequenceV2(fixture, seed, current, isolate)
  let runs = 1

  const signatureOf = (r: SequenceResultV2): Set<string> => {
    const sig = new Set<string>()
    if (r.failure !== null) sig.add("failure")
    for (const m of r.mismatches) sig.add(`${m.id}.${m.field}`)
    return sig
  }
  const wanted = signatureOf(best)
  const fails = (r: SequenceResultV2): boolean => {
    for (const k of signatureOf(r)) if (wanted.has(k)) return true
    return false
  }
  if (wanted.size === 0) return { actions: current, result: best, runs }

  let chunk = Math.max(1, Math.floor(current.length / 2))
  while (runs < maxRuns) {
    let removedAny = false
    for (let start = 0; start + chunk <= current.length && runs < maxRuns; ) {
      const candidate = [...current.slice(0, start), ...current.slice(start + chunk)]
      if (candidate.length === 0) {
        start += chunk
        continue
      }
      const r = await runSequenceV2(fixture, seed, candidate, isolate)
      runs++
      if (fails(r)) {
        current = candidate
        best = r
        removedAny = true
      } else {
        start += chunk
      }
    }
    if (!removedAny) {
      if (chunk === 1) break
      chunk = Math.max(1, Math.floor(chunk / 2))
    }
  }
  return { actions: current, result: best, runs }
}

export function formatResultV2(r: SequenceResultV2): string {
  const lines: string[] = []
  lines.push(`seed=${r.seed} actions=${JSON.stringify(r.actions)}`)
  lines.push(`finalUrl=${r.finalUrl} visible=[${r.visible.join(",")}]`)
  if (r.failure !== null) lines.push(`FAILURE: ${r.failure}`)
  for (const m of r.mismatches) {
    lines.push(`MISMATCH ${m.id}.${m.field}: expected ${m.expected}, got ${m.actual}`)
  }
  return lines.join("\n")
}
