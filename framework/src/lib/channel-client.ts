/**
 * ChannelClient — the client transport for the channel's upstream role
 * ([[channel-protocol]]; design: docs/notes/channel-design.md). One
 * module owning everything between a producer's statement and the
 * envelope on the wire:
 *
 *   - **Envelope assembly + seq.** Each flush collects at most one
 *     frame per registered producer, wraps them in one
 *     `{connection, seq, frames}` envelope, and POSTs it fire-and-
 *     forget (`keepalive: true`, so an in-flight envelope survives a
 *     page unload). `seq` is per-connection monotonic, restarting at
 *     establishment.
 *   - **Coalescing + serialization.** Flushes coalesce per animation
 *     frame and serialize — one envelope in flight; a flush requested
 *     mid-flight re-fires when it lands. Producers therefore batch
 *     naturally: everything stated within one frame rides one POST.
 *   - **The fallback signal.** A non-`204` answer (connection gone,
 *     attach-binding mismatch) or a network failure clears the
 *     published connection id and hands each carried frame back to
 *     its producer (`deliveryFailed`) — the producer re-owns the
 *     statements and delivers them via its own discrete fallback. A
 *     flush with NO connection open calls `collect(null)`: the
 *     producer's cue to deliver via that fallback directly.
 *   - **Connection lifecycle.** The heartbeat establishes the
 *     connection id here when its live fire's subscription is proven
 *     open, and closes it when the connection settles;
 *     `<html data-parton-live>` rides the same two moments (the
 *     liveness marker specs and tooling wait on). Establishment
 *     listeners let producers arm connection-scoped work (the
 *     visibility controller's full-set sync).
 *   - **Detach.** `pagehide` sends a final `detach` frame via a
 *     keepalive fetch — the explicit close. Best-effort by nature;
 *     the server's keepalive timeout remains the backstop.
 *   - **Delivery acks.** The transport tracks the delivery seqs the
 *     stream's emissions carry (`seq` entries) and the seqs the merge
 *     layer COMMITS (the browser entry's lane/segment commit hooks),
 *     and acks the highest contiguously committed value upstream via
 *     an internal producer. The ack is a PASSENGER, never a driver:
 *     a watermark advance marks the producer dirty and any envelope
 *     other frames justify carries the current value for free —
 *     except the connection's FIRST committed delivery (the prompt
 *     duplex proof the degrade machinery times) and the unacked count
 *     crossing `ACK_FLUSH_THRESHOLD`, which request the same
 *     rAF-coalesced flush every statement rides (no timers).
 *   - **The reliable class + retransmit.** Frames from producers
 *     declaring `reliable: true` are buffered per envelope (with the
 *     envelope's seq) until the downstream `applied` marker covers
 *     them, and retransmitted — original seqs, in order, ahead of new
 *     flushes — when the next connection establishes. The envelope seq
 *     is PAGE-LIFETIME monotonic for exactly this reason. The url
 *     producer is the first reliable-class source (visible/detach
 *     statements re-seed; acks are connection-scoped and cumulative;
 *     telemetry is LOSSY — dropped, never redelivered) — though in
 *     practice its buffered frames retire at the next ATTACH rather
 *     than retransmit (the attach's own request line restates the
 *     URL — see the navigation section below).
 *   - **Degrade.** A connection that commits deliveries but cannot get
 *     its FIRST ack through (the envelope carrying it fails — blocked
 *     `/__parton/*` POSTs, ad-blockers) proves the duplex broken. The
 *     transport marks the PAGE degraded — sticky for the page
 *     lifetime — and the heartbeat stops holding live attaches,
 *     falling back to periodic discrete reloads (`_channelIsDegraded`).
 */

import {
	CHANNEL_ENDPOINT,
	type ChannelEnvelope,
	type ChannelFrame,
	UNACKED_DELIVERY_WINDOW,
	type UrlFrame,
} from "./channel-protocol.ts";
import {
	TAG_CONNECTION_ID,
	TAG_DELIVERY_SEQ,
	TAG_UPSTREAM_APPLIED,
} from "./fp-trailer-marker.ts";
import {
	_getLiveConnectionId,
	_setLiveConnectionId,
} from "./partial-client-state.ts";

/** A source of upstream frames (the visibility controller is the
 *  first). Registered once at module scope; consulted on every
 *  envelope flush. */
export interface ChannelProducer {
	/** Contribute at most one frame to the envelope being assembled.
	 *  `connection` is the open connection's id, or `null` when none is
	 *  established — the producer's cue to deliver its pending
	 *  statements via its own discrete fallback instead (and return
	 *  `null`). Called only when an envelope can actually fire (never
	 *  while one is in flight), so the frame's content is always the
	 *  producer's latest state. */
	collect(connection: string | null): ChannelFrame | null;
	/** The envelope carrying this producer's frame was not applied —
	 *  connection gone (`404`-equivalent) or the POST never reached the
	 *  server. The transport has already cleared the published id; the
	 *  producer re-owns the frame's statements and delivers them via
	 *  its fallback. Never called for a `reliable` producer's frames —
	 *  the transport's retransmit buffer owns their redelivery. */
	deliveryFailed(frame: ChannelFrame): void;
	/** Declares this producer's frames RELIABLE-class: they must reach
	 *  the server even across a torn connection, so the transport
	 *  buffers them (keyed by envelope seq) until the downstream
	 *  `applied` marker proves application, and retransmits survivors
	 *  at the next establishment. Application idempotence is the frame
	 *  kind's own contract (seq-ordered statement semantics). Absent /
	 *  false: loss-tolerant — a failed envelope hands the frame back
	 *  via `deliveryFailed`. */
	reliable?: boolean;
}

const producers = new Set<ChannelProducer>();
const establishListeners = new Set<(connection: string) => void>();

export function registerChannelProducer(producer: ChannelProducer): void {
	producers.add(producer);
}

/** Run `cb` with the connection id every time a live connection is
 *  established — producers arm connection-scoped work here (e.g. the
 *  visibility controller's full-set sync at first measurement). */
export function onChannelEstablished(cb: (connection: string) => void): void {
	establishListeners.add(cb);
}

// PAGE-LIFETIME monotonic envelope seq — never restarted at
// establishment, so retransmitted reliable envelopes keep their
// original seqs across reattaches and the server's `applied` marker
// names one unambiguous timeline (seeded per attach from
// `_channelAppliedWatermark`).
let envelopeSeq = 0;
let rafScheduled = false;
let inFlight = false;
let reflushPending = false;

// ─── Delivery tracking (per established connection) ─────────────────
//
// Delivery seqs are PER-CONNECTION: the server mints them at emission
// and the client records them at COMMIT — the merge-layer moment the
// bytes become the page (a decoded-but-dropped payload is never
// recorded, so its seq stalls the watermark and the server never
// treats it as held). The ack is cumulative: the highest CONTIGUOUSLY
// committed seq. Lanes commit concurrently across partons, so commits
// can land out of order — the out-of-order set fills the gaps until
// the contiguous frontier catches up.

/** One delivery announcement off the wire: the per-connection seq plus
 *  the navigation point it was rendered as-of (the consumed url-frame
 *  envelope seq; `0` = the attach's own request state). */
export interface WireDelivery {
	seq: number;
	asOf: number;
}

/** Per-parton FIFO of lane deliveries read off the wire (`seq`
 *  entries precede their lane's `muxend`). Successive lanes for one
 *  parton commit in arrival order (the browser entry chains them), so
 *  the queue head always names the delivery of the payload being
 *  committed. */
const pendingLaneSeqs = new Map<string, WireDelivery[]>();
/** Highest contiguously committed delivery seq — the ack value. */
let deliveredWatermark = 0;
/** Committed seqs past a gap in the contiguous frontier. */
const deliveredOutOfOrder = new Set<number>();
/** The watermark value last carried on a collected ack frame. */
let lastAckCollected = 0;
/** Unacked-commit count at which the transport DRIVES a flush for the
 *  ack's own sake — half the server's backpressure window, so a client
 *  under sustained lane traffic acks once per threshold crossing and
 *  the window always keeps 2× headroom. Below the threshold the ack is
 *  a PASSENGER: the watermark rides whatever envelope other statements
 *  justify, because every envelope costs the browser's full Cookie
 *  header (~3.5–4.5KB under a commerce cookie jar — [[channel]]'s cost
 *  section) and no consumer of the ack needs per-commit resolution:
 *  the mirror's hot layer is the OPTIMISTIC skip-set, and the window
 *  only needs freeing well before it fills. */
const ACK_FLUSH_THRESHOLD = UNACKED_DELIVERY_WINDOW / 2;
/** An ack frame for the CURRENT connection has been delivered (its
 *  envelope answered 204). Until it has, an ack-carrying envelope's
 *  failure means the connection never acked once — the degrade
 *  signal. */
let ackDeliveredOnConnection = false;

// ─── Reliable-class buffer + upstream watermark ──────────────────────

/** Reliable frames awaiting the server's `applied` marker, keyed by
 *  the envelope seq that carried them (ascending). Only frames from
 *  `reliable: true` producers enter; loss-tolerant co-riders of the
 *  same envelope self-heal and must not replay. */
let retransmitBuffer: Array<{ seq: number; frames: ChannelFrame[] }> = [];
/** Highest upstream envelope seq the server has stated applied (the
 *  downstream `applied` marker) — what prunes the buffer and what the
 *  next attach statement presents as its `applied` watermark. */
let appliedWatermark = 0;
/** Establishment found survivors in the buffer — the next flush sends
 *  them (original seqs, in order) before collecting producers. */
let retransmitPending = false;

// ─── Degrade (page-lifetime) ─────────────────────────────────────────

/** The duplex is proven broken for this page: a connection committed
 *  deliveries but the envelope carrying its FIRST ack failed (blocked
 *  POST path, connection-gone race). Sticky for the page lifetime —
 *  the heartbeat reads it and degrades to periodic discrete reloads
 *  instead of holding lanes-first live attaches whose window can
 *  never free. */
let degraded = false;

/** Whether the channel is page-degraded — the heartbeat's cue to fire
 *  discrete reloads (GET-shaped, capped `?cached=`) instead of live
 *  attaches. */
export function _channelIsDegraded(): boolean {
	return degraded;
}

/** The upstream-applied watermark last heard from the server — the
 *  attach statement's `applied` field (see [[channel-protocol]]). */
export function _channelAppliedWatermark(): number {
	return appliedWatermark;
}

// ─── Window navigation over the channel ──────────────────────────────
//
// A window navigation or batched selector refetch on an ATTACHED,
// non-degraded page is a `url` frame: the client states its URL (with
// any one-shot `?partials=` overlay), the server's driver answers with
// a payload segment in stream order, and the caller's milestones
// resolve at that segment's commit/settle — never at a fetch lifecycle,
// because there is no fetch. The pieces:
//
//   - **The navigation point.** `navPoint` is the envelope seq the next
//     url frame ships with, reserved AT STATEMENT TIME (`envelopeSeq +
//     1` — flushes serialize, so the reservation is exact) because the
//     client's URL advances at click time, ahead of the stream: from
//     this instant, any delivery rendered as-of an older navigation
//     must not commit. The as-of guard (`_channelDeliveryCommittable`)
//     is the pageUrlKey stale-commit guard generalized into the
//     protocol; the discrete GET path keeps the pageUrlKey twin.
//   - **The producer.** RELIABLE class: url frames ride the retransmit
//     buffer until the `applied` marker covers them. One pending frame,
//     newest-wins — a statement superseded before its flush was a
//     navigation the client already navigated past, and the covering
//     segment for the newest statement resolves every older fire's
//     milestones too (their content IS the newest URL's render).
//   - **The attach subsumes.** The attach's own request line states the
//     URL, so an attach fire retires the navigation point, drops
//     buffered url frames, and re-owns any still-pending records — a
//     fresh connection opens with as-of 0 on both sides.
//   - **Falling back.** No connection at statement or flush time, a
//     failed envelope, or the stream closing under pending records
//     hands the LATEST statement to the discrete GET transport
//     (`window.__rsc_partial_refetch`) and chains every pending
//     record's milestones onto that fire — first interaction never
//     waits on attach, and a torn channel never strands a navigation.

interface PendingNavRecord {
	/** The navigation point this record's statement set — a committed
	 *  segment rendered as-of ≥ this resolves the record. */
	navSeq: number;
	/** The stated URL (path + search, may carry a `?partials=` overlay)
	 *  — what the discrete fallback re-fires. */
	url: string;
	/** The caller's commit-mode wish (`streaming: true` = progressive /
	 *  raw). A covering segment commits in transition mode when any
	 *  covered record asked for it. */
	streaming: boolean;
	streamingResolved: boolean;
	settled: boolean;
	resolveStreaming: () => void;
	rejectStreaming: (err: unknown) => void;
	resolveFinished: () => void;
	rejectFinished: (err: unknown) => void;
}

let navPoint = 0;
let statedWindowUrl: string | null = null;
let pendingNavFrame: UrlFrame | null = null;
let pendingNavRecords: PendingNavRecord[] = [];
/** One-shot claim the navigate-event listener sets when it routes a
 *  window navigation through the channel — the heartbeat's deferred
 *  abort check consumes it and keeps the stream (the navigation rides
 *  it; tearing it would strand the nav segment). Explicit
 *  producer-written signal, set synchronously during the event
 *  dispatch, read in the same task's microtask. */
let windowNavClaim = false;
/** The heartbeat's registered live-stream aborter — the escape hatch a
 *  claimed-then-unroutable navigation pulls (`_channelAbortLiveStream`)
 *  so the stream reopens on the now-current URL instead of idling on
 *  the old one for the keepalive. */
let liveStreamAbort: (() => void) | null = null;

/** Whether window navigations / selector refetches ride the channel
 *  right now: a connection is established and the page is not
 *  degraded. Consulted by the navigate-event listener (the claim), the
 *  refetch dispatcher, and the browser entry's routing. */
export function _channelNavAvailable(): boolean {
	return !degraded && _getLiveConnectionId() !== null;
}

/** The client's navigation point — the envelope seq of its latest url
 *  statement on the open connection (`0` = none since attach). */
export function _channelNavPoint(): number {
	return navPoint;
}

/** The URL of the latest channel url statement (path + search), or
 *  `null` when the attach's own URL is the connection's last word —
 *  the live stream's expected-page identity moves with it. */
export function _channelStatedWindowUrl(): string | null {
	return statedWindowUrl;
}

export function _channelClaimWindowNav(): void {
	windowNavClaim = true;
}

export function _channelConsumeWindowNavClaim(): boolean {
	const claimed = windowNavClaim;
	windowNavClaim = false;
	return claimed;
}

export function _registerLiveStreamAbort(abort: (() => void) | null): void {
	liveStreamAbort = abort;
}

export function _channelAbortLiveStream(): void {
	liveStreamAbort?.();
}

/** A server-initiated url push (a `url` trailer) applies only when the
 *  client hasn't navigated past the state the push was rendered as-of:
 *  client-wins-at-higher-envelope-seq. `asOf` is the delivery's wire
 *  as-of on the live stream, or the navigation point captured at issue
 *  time for a discrete response (the client-local as-of of a request
 *  it issued itself); `undefined` — a caller with no correlation —
 *  applies unconditionally. */
export function _serverUrlPushApplies(asOf: number | undefined): boolean {
	return asOf === undefined || asOf >= navPoint;
}

/** The as-of commit guard for seq'd deliveries on the live stream —
 *  the protocol form of the stale-commit decision: commit iff the
 *  delivery was rendered as-of the client's current navigation point
 *  or later. The twin pageUrlKey guard survives on the discrete GET
 *  path; both are reached through the browser entry's one guard seam. */
export function _channelDeliveryCommittable(asOf: number): boolean {
	return asOf >= navPoint;
}

/**
 * State a window navigation / selector refetch on the open channel.
 * Returns the fire's `{streaming, finished}` milestones, or `null`
 * when the channel can't carry it (pre-attach, degraded) — the
 * caller's cue to take the discrete GET path with its own guards. With
 * `record: false` the statement is fire-and-forget (a silent URL-only
 * sync — no milestones to keep).
 */
export function _channelNavigate(init: {
	url: string;
	intent: UrlFrame["intent"];
	streaming?: boolean;
	signal?: AbortSignal;
	record?: boolean;
}): { streaming: Promise<void>; finished: Promise<void> } | null {
	if (!_channelNavAvailable()) return null;
	// Reserve the statement's envelope seq: flushes serialize and only
	// collect-flushes mint, so the next envelope is exactly
	// `envelopeSeq + 1` — and the navigation point must advance NOW
	// (click time), before any flush, or a pre-nav delivery landing in
	// the reservation window would still commit.
	navPoint = envelopeSeq + 1;
	statedWindowUrl = init.url;
	pendingNavFrame = { kind: "url", url: init.url, intent: init.intent };
	scheduleChannelFlush();
	if (init.record === false) return { streaming: Promise.resolve(), finished: Promise.resolve() };
	let resolveStreaming!: () => void;
	let rejectStreaming!: (err: unknown) => void;
	let resolveFinished!: () => void;
	let rejectFinished!: (err: unknown) => void;
	const streaming = new Promise<void>((res, rej) => {
		resolveStreaming = res;
		rejectStreaming = rej;
	});
	const finished = new Promise<void>((res, rej) => {
		resolveFinished = res;
		rejectFinished = rej;
	});
	streaming.catch(() => {});
	finished.catch(() => {});
	const record: PendingNavRecord = {
		navSeq: navPoint,
		url: init.url,
		streaming: init.streaming === true,
		streamingResolved: false,
		settled: false,
		resolveStreaming,
		rejectStreaming,
		resolveFinished,
		rejectFinished,
	};
	pendingNavRecords.push(record);
	if (init.signal) {
		const onAbort = (): void => {
			if (record.settled) return;
			record.settled = true;
			pendingNavRecords = pendingNavRecords.filter((r) => r !== record);
			const err = new DOMException("navigation superseded", "AbortError");
			if (!record.streamingResolved) record.rejectStreaming(err);
			record.rejectFinished(err);
		};
		if (init.signal.aborted) onAbort();
		else init.signal.addEventListener("abort", onAbort, { once: true });
	}
	return { streaming, finished };
}

/** True when a covering commit (`asOf` ≥ some pending record's navSeq)
 *  should land as a TRANSITION commit — any covered caller asked for
 *  the atomic swap (`streaming: false`). No covered record → the live
 *  stream's default raw commit. */
export function _channelNavPrefersTransition(asOf: number): boolean {
	return pendingNavRecords.some(
		(r) => !r.settled && r.navSeq <= asOf && !r.streaming,
	);
}

/** A payload segment rendered as-of `asOf` COMMITTED on the live
 *  stream — resolve the `streaming` milestone of every record it
 *  covers (their content is this render). */
export function _channelNavSegmentCommitted(asOf: number): void {
	for (const record of pendingNavRecords) {
		if (record.settled || record.streamingResolved) continue;
		if (record.navSeq > asOf) continue;
		record.streamingResolved = true;
		record.resolveStreaming();
	}
}

/** A covering payload segment SETTLED (its trailers resolved — the
 *  render fully drained) — resolve `finished` and retire the records. */
export function _channelNavSegmentSettled(asOf: number): void {
	const remaining: PendingNavRecord[] = [];
	for (const record of pendingNavRecords) {
		if (record.settled) continue;
		if (record.navSeq > asOf) {
			remaining.push(record);
			continue;
		}
		record.settled = true;
		if (!record.streamingResolved) {
			record.streamingResolved = true;
			record.resolveStreaming();
		}
		record.resolveFinished();
	}
	pendingNavRecords = remaining;
}

/**
 * The attach subsumes the URL timeline: its own request line IS the
 * client's URL statement, so buffered url frames retire (never
 * retransmitted — the frames' navigation is already the attach URL),
 * the navigation point resets (the new connection's deliveries open
 * as-of 0 on both sides), and any records a closing connection left
 * behind fall back to the discrete transport. Called by the browser
 * entry at attach fire, before the POST.
 */
export function _channelNavSubsumedByAttach(): void {
	navPoint = 0;
	statedWindowUrl = null;
	pendingNavFrame = null;
	if (retransmitBuffer.length > 0) {
		retransmitBuffer = retransmitBuffer
			.map((entry) => ({
				seq: entry.seq,
				frames: entry.frames.filter((f) => f.kind !== "url"),
			}))
			.filter((entry) => entry.frames.length > 0);
	}
	fallbackPendingNavs();
}

/** Hand every pending navigation to the discrete transport: one GET
 *  for the LATEST statement's URL (older fires' content is that URL's
 *  render — same rule the covering segment applies), all records'
 *  milestones chained onto it. The channel's leg is over for them:
 *  connection gone, or the stream closed before their segment. */
function fallbackPendingNavs(): void {
	if (pendingNavRecords.length === 0) return;
	const records = pendingNavRecords;
	pendingNavRecords = [];
	const latest = records[records.length - 1];
	const handler =
		typeof window !== "undefined"
			? (
					window as Window & {
						__rsc_partial_refetch?: (
							url: string,
						) => { streaming: Promise<void>; finished: Promise<void> };
					}
				).__rsc_partial_refetch
			: undefined;
	if (!handler) {
		// No transport (SSR, teardown) — settle as no-ops so callers
		// never hang.
		for (const r of records) {
			if (r.settled) continue;
			r.settled = true;
			if (!r.streamingResolved) r.resolveStreaming();
			r.resolveFinished();
		}
		return;
	}
	const url = new URL(latest.url, window.location.origin);
	const fire = handler(url.toString());
	fire.streaming.then(
		() => {
			for (const r of records) {
				if (r.settled || r.streamingResolved) continue;
				r.streamingResolved = true;
				r.resolveStreaming();
			}
		},
		(err) => {
			for (const r of records) {
				if (r.settled || r.streamingResolved) continue;
				r.streamingResolved = true;
				r.rejectStreaming(err);
			}
		},
	);
	fire.finished.then(
		() => {
			for (const r of records) {
				if (r.settled) continue;
				r.settled = true;
				r.resolveFinished();
			}
		},
		(err) => {
			for (const r of records) {
				if (r.settled) continue;
				r.settled = true;
				r.rejectFinished(err);
			}
		},
	);
}

/** The url producer — RELIABLE class (see the module header). One
 *  pending frame, newest-wins; `collect(null)` — the flush found no
 *  connection — is the cue to hand the pending navigation to the
 *  discrete fallback. */
const urlProducer: ChannelProducer = {
	reliable: true,
	collect(connection: string | null): ChannelFrame | null {
		if (pendingNavFrame === null) return null;
		if (connection === null) {
			pendingNavFrame = null;
			fallbackPendingNavs();
			return null;
		}
		const frame = pendingNavFrame;
		pendingNavFrame = null;
		return frame;
	},
	deliveryFailed(): void {
		// Reliable class — the retransmit buffer owns redelivery; the
		// pending-record fallback rides the connection-loss paths.
	},
};

/**
 * Wire-entry hook for the segmented-stream reader (`splitSegments`'
 * `onEntry`): the browser entry hands every trailer ENTRY here as it
 * is read. Three tags are the transport's:
 *
 *   - `conn` — the server-minted connection id, the establishment
 *     handshake. Receiving it proves the session is open (the driver
 *     mints ids only at session open), so producers can address the
 *     connection immediately, even while the first segment's render
 *     is still draining.
 *   - `seq` (lane form, `<parton-id>\n<seq>`) — a lane delivery's seq,
 *     queued per parton until the browser entry's commit hook consumes
 *     it. The segment form (no newline) is fetch-local — the browser
 *     entry parses it via `_segmentDeliverySeq` so a concurrent
 *     discrete fetch can never consume the live stream's pending seq.
 *   - `applied` — the server's cumulative upstream-applied watermark:
 *     prunes the reliable-envelope buffer and seeds the next attach.
 *
 * Entries of other tags pass through untouched — their consumers read
 * the segment's trailer map.
 */
export function _channelWireEntry(tag: string, body: Uint8Array): void {
	if (tag === TAG_DELIVERY_SEQ) {
		const text = new TextDecoder().decode(body);
		const nl = text.indexOf("\n");
		if (nl < 0) return; // segment form — fetch-local, see above
		const partonId = text.slice(0, nl);
		const delivery = parseDeliveryBody(text.slice(nl + 1));
		if (delivery === null) return;
		let queue = pendingLaneSeqs.get(partonId);
		if (!queue) {
			queue = [];
			pendingLaneSeqs.set(partonId, queue);
		}
		queue.push(delivery);
		return;
	}
	if (tag === TAG_UPSTREAM_APPLIED) {
		const applied = Number(new TextDecoder().decode(body));
		if (!Number.isFinite(applied) || applied <= appliedWatermark) return;
		appliedWatermark = applied;
		if (retransmitBuffer.length > 0) {
			retransmitBuffer = retransmitBuffer.filter((e) => e.seq > applied);
		}
		return;
	}
	if (tag !== TAG_CONNECTION_ID) return;
	_channelEstablished(new TextDecoder().decode(body));
}

/** Parse a `<seq> <asof>` delivery body. `null` when malformed. */
function parseDeliveryBody(text: string): WireDelivery | null {
	const sp = text.indexOf(" ");
	const seq = Number(sp < 0 ? text : text.slice(0, sp));
	if (!Number.isFinite(seq)) return null;
	const asOf = sp < 0 ? 0 : Number(text.slice(sp + 1));
	return { seq, asOf: Number.isFinite(asOf) ? asOf : 0 };
}

/** Parse a payload segment's delivery off a wire entry — the segment
 *  form of the `seq` tag (`<seq> <asof>`, no parton-id prefix). `null`
 *  for every other entry. The browser entry keeps the value FETCH-LOCAL
 *  and records it via `_segmentDeliveryCommitted` when the segment's
 *  payload commits (or consumes it via the stale-drop paths). */
export function _segmentDelivery(
	tag: string,
	body: Uint8Array,
): WireDelivery | null {
	if (tag !== TAG_DELIVERY_SEQ) return null;
	const text = new TextDecoder().decode(body);
	if (text.includes("\n")) return null; // lane form — queued above
	return parseDeliveryBody(text);
}

/** Record a committed delivery. A contiguous-frontier advance leaves
 *  the ack producer dirty and nothing more — a PASSENGER: any flush
 *  other frames justify (visibility statements, detach, future kinds)
 *  collects the current watermark for free. Exactly two advances drive
 *  a flush of their own, on the normal rAF-coalesced path (no timers):
 *  the connection's FIRST committed delivery — the prompt duplex proof
 *  both sides' degrade machinery times — and the unacked count
 *  crossing `ACK_FLUSH_THRESHOLD`. */
function commitDelivery(seq: number): void {
	if (seq <= deliveredWatermark) return;
	if (seq === deliveredWatermark + 1) {
		deliveredWatermark = seq;
		while (deliveredOutOfOrder.delete(deliveredWatermark + 1)) {
			deliveredWatermark += 1;
		}
		if (
			lastAckCollected === 0 ||
			deliveredWatermark - lastAckCollected >= ACK_FLUSH_THRESHOLD
		) {
			scheduleChannelFlush();
		}
		return;
	}
	deliveredOutOfOrder.add(seq);
}

/** A payload segment on the live stream committed — record the seq its
 *  `seq` entry announced (the browser entry held it fetch-locally). */
export function _segmentDeliveryCommitted(seq: number): void {
	commitDelivery(seq);
}

/** Peek the delivery the NEXT commit for `partonId` would consume —
 *  the merge layer's as-of guard reads it after a lane's decode (the
 *  `seq` entry precedes the lane's `muxend`, so it is queued by then).
 *  `null` when the lane carried no delivery (no session). */
export function _lanePendingDelivery(partonId: string): WireDelivery | null {
	return pendingLaneSeqs.get(partonId)?.[0] ?? null;
}

/** A lane payload for `partonId` committed — consume the queue head
 *  minted when its `seq` entry was read. No-op when no seq is queued
 *  (a stream without deliveries: no session, or an older server). */
export function _laneDeliveryCommitted(partonId: string): void {
	const delivery = consumeLaneDelivery(partonId);
	if (delivery !== null) commitDelivery(delivery.seq);
}

/** A lane payload for `partonId` was decoded but NOT committed (stale
 *  page guard on a DYING stream, torn decode). Consume the queue head
 *  WITHOUT recording: attribution for later lanes stays aligned, and
 *  the watermark stalls at the dropped seq — the server never treats
 *  the drop as held. Only for streams whose life ends with the drop;
 *  a drop on a CONTINUING stream is the as-of drop below. */
export function _laneDeliveryDropped(partonId: string): void {
	consumeLaneDelivery(partonId);
}

/** A lane payload for `partonId` was dropped by the AS-OF guard — it
 *  predates the client's navigation point on a stream that lives on.
 *  Consume the queue head and count the delivery PROCESSED: the
 *  watermark advances (a permanent gap would wedge the window and
 *  force a reconnect on every raced navigation), and the server's fold
 *  gate — the same asOf-vs-navSeq comparison — keeps the processed
 *  drop out of the acked mirror. */
export function _laneDeliveryDroppedStale(partonId: string): void {
	const delivery = consumeLaneDelivery(partonId);
	if (delivery !== null) commitDelivery(delivery.seq);
}

function consumeLaneDelivery(partonId: string): WireDelivery | null {
	const queue = pendingLaneSeqs.get(partonId);
	const delivery = queue?.shift() ?? null;
	if (queue !== undefined && queue.length === 0) pendingLaneSeqs.delete(partonId);
	return delivery;
}

/** A payload segment was dropped by the as-of guard (or arrived torn
 *  under a supersede) on a continuing stream — consume its delivery as
 *  PROCESSED so the watermark stays contiguous; the server's fold gate
 *  keeps it out of the acked mirror. */
export function _segmentDeliveryDroppedStale(seq: number): void {
	commitDelivery(seq);
}

/** The transport's own ack producer — cumulative committed delivery
 *  seq, contributed whenever the watermark advanced past the last
 *  collected value. A passenger on whatever envelope flushes (the two
 *  advances that drive one live at `commitDelivery`). Loss-tolerant: a
 *  lost ack is subsumed by the next one; a failed FIRST ack is the
 *  degrade signal (handled in `flush`, which sees the whole envelope's
 *  fate). */
const ackProducer: ChannelProducer = {
	collect(connection: string | null): ChannelFrame | null {
		if (connection === null) return null;
		if (deliveredWatermark <= lastAckCollected) return null;
		lastAckCollected = deliveredWatermark;
		return { kind: "ack", delivered: deliveredWatermark };
	},
	deliveryFailed(): void {
		// Per-connection ack state resets at the next establishment; the
		// degrade decision lives in the flush's failure path.
	},
};

/**
 * Publish an established live connection. Called from the wire entry
 * above when the stream's `conn` handshake arrives; from here
 * producers address the connection with envelopes. Sets the
 * `data-parton-live` liveness marker and resets the per-connection
 * DELIVERY tracking (delivery seqs restart with the session; the
 * acked mirror layer resets with the connection — the attach manifest
 * is the durable evidence). The ENVELOPE seq is page-lifetime and
 * deliberately not reset — retransmitted reliable envelopes keep
 * their original seqs; establishment is their natural retransmit
 * point.
 */
export function _channelEstablished(connection: string): void {
	pendingLaneSeqs.clear();
	deliveredOutOfOrder.clear();
	deliveredWatermark = 0;
	lastAckCollected = 0;
	ackDeliveredOnConnection = false;
	retransmitPending = retransmitBuffer.length > 0;
	_setLiveConnectionId(connection);
	if (typeof document !== "undefined") {
		// Presence-only: the marker says "a live push channel is
		// established", never WHICH connection — the id is the envelope
		// credential and stays out of the DOM.
		document.documentElement.setAttribute("data-parton-live", "");
	}
	for (const cb of [...establishListeners]) cb(connection);
	if (retransmitPending) scheduleChannelFlush();
}

/** The live connection settled (keepalive elapsed, abort, error) —
 *  clear the published id and the liveness marker, and hand any
 *  navigation records the stream never answered to the discrete
 *  transport (their segment can no longer arrive). The heartbeat
 *  calls this when its fire's `finished` settles; fires are strictly
 *  sequential, so the settling connection's id is the current one. */
export function _channelConnectionClosed(): void {
	if (typeof document !== "undefined") {
		document.documentElement.removeAttribute("data-parton-live");
	}
	_setLiveConnectionId(null);
	fallbackPendingNavs();
}

/** Request an envelope flush. Coalesced per animation frame (the
 *  producers' statement cadence) and inert during SSR — same guard
 *  the visibility controller's dispatch always had. */
export function scheduleChannelFlush(): void {
	if (rafScheduled || typeof requestAnimationFrame === "undefined") return;
	rafScheduled = true;
	requestAnimationFrame(() => {
		rafScheduled = false;
		void flush();
	});
}

async function flush(): Promise<void> {
	// Serialize: one envelope in flight. A flush requested meanwhile
	// re-fires when it lands (the `finally` below), so no statement is
	// stranded behind a consumed rAF.
	if (inFlight) {
		reflushPending = true;
		return;
	}
	const connection = _getLiveConnectionId();

	// Retransmit-first: a fresh establishment replays the reliable
	// buffer's survivors — original seqs, in order — before any new
	// envelope, so the server sees the page-lifetime seq timeline in
	// order. A failure mid-replay keeps the rest buffered for the next
	// establishment; the frames' producers are never handed back
	// (`reliable` — the buffer owns redelivery).
	if (retransmitPending && connection !== null) {
		inFlight = true;
		try {
			for (const entry of [...retransmitBuffer]) {
				if (_getLiveConnectionId() !== connection) return;
				const ok = await postEnvelope({
					connection,
					seq: entry.seq,
					frames: entry.frames,
				});
				if (!ok) {
					if (_getLiveConnectionId() === connection) _setLiveConnectionId(null);
					return;
				}
			}
			retransmitPending = false;
		} finally {
			inFlight = false;
			reflushPending = false;
		}
		// Collect whatever producers accumulated while replaying — on
		// failure too: the fallback cue (`collect(null)`) must reach
		// them, or statements strand until their next delta.
		scheduleChannelFlush();
		return;
	}

	const carried: Array<{ producer: ChannelProducer; frame: ChannelFrame }> = [];
	for (const producer of [...producers]) {
		const frame = producer.collect(connection);
		if (frame !== null) carried.push({ producer, frame });
	}
	if (connection === null || carried.length === 0) return;
	const carriesAck = carried.some((c) => c.frame.kind === "ack");
	inFlight = true;
	try {
		const seq = ++envelopeSeq;
		// Reliable frames enter the buffer BEFORE the POST — a failed (or
		// silently lost) envelope must leave them retransmittable. Only
		// the reliable frames: loss-tolerant co-riders self-heal and must
		// not replay.
		const reliableFrames = carried
			.filter((c) => c.producer.reliable === true)
			.map((c) => c.frame);
		if (reliableFrames.length > 0) {
			retransmitBuffer.push({ seq, frames: reliableFrames });
		}
		const delivered = await postEnvelope({
			connection,
			seq,
			frames: carried.map((c) => c.frame),
		});
		if (!delivered) {
			// The server's explicit "connection not open" signal (or the
			// POST never reached it). Clear the published id so producers'
			// re-owned statements — and everything after them, until the
			// heartbeat re-establishes — ride the discrete fallback.
			// Reliable frames stay in the buffer; their producers are not
			// handed back.
			if (_getLiveConnectionId() === connection) _setLiveConnectionId(null);
			for (const { producer, frame } of carried) {
				if (producer.reliable !== true) producer.deliveryFailed(frame);
			}
			// The envelope carried this connection's FIRST ack and it never
			// got through: the client committed deliveries the server will
			// never learn about — the duplex is broken (a blocked
			// `/__parton/*` POST path). Sticky page-lifetime degrade: the
			// heartbeat stops holding lanes-first live attaches and falls
			// back to periodic discrete reloads, so liveness never freezes
			// behind an unacked window.
			if (carriesAck && !ackDeliveredOnConnection) degraded = true;
			// Pending navigations can't reach the server on this connection
			// anymore — hand them to the discrete transport NOW, and abort
			// the held stream (it still renders the URL the page just left;
			// the heartbeat reopens on the current one).
			if (pendingNavRecords.length > 0) {
				fallbackPendingNavs();
				_channelAbortLiveStream();
			}
		} else if (carriesAck) {
			ackDeliveredOnConnection = true;
		}
	} finally {
		inFlight = false;
		if (reflushPending) {
			reflushPending = false;
			scheduleChannelFlush();
		}
	}
}

/** POST one envelope. `true` iff the server applied it (`204`);
 *  `false` on any other answer or a network failure. */
async function postEnvelope(envelope: ChannelEnvelope): Promise<boolean> {
	try {
		const res = await fetch(CHANNEL_ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(envelope),
			// Fire-and-forget: let an in-flight envelope survive a page unload.
			keepalive: true,
		});
		return res.status === 204;
	} catch {
		return false;
	}
}

/** Send the explicit close for the open connection (if any) and clear
 *  the published id — a bfcache restore re-establishes via the
 *  heartbeat's next fire. The keepalive fetch is the one transport
 *  that survives the unload in progress. */
function sendDetach(): void {
	const connection = _getLiveConnectionId();
	if (connection === null) return;
	_setLiveConnectionId(null);
	void postEnvelope({
		connection,
		seq: ++envelopeSeq,
		frames: [{ kind: "detach" }],
	});
}

if (typeof window !== "undefined") {
	// `pagehide` covers tab close, cross-origin navigation, and bfcache
	// entry — every way the page stops being able to consume the held
	// stream. Same-origin soft navigations never fire it.
	window.addEventListener("pagehide", sendDetach);
}

// The transport's own producers — the ack passenger and the url
// statement source — ride the same producer contract every external
// statement source uses.
registerChannelProducer(ackProducer);
registerChannelProducer(urlProducer);

/** Test-only: reset the transport's module state (seq, in-flight
 *  serialization, registrations, delivery tracking, buffer, degrade,
 *  navigation). */
export function _resetChannelClient(): void {
	producers.clear();
	registerChannelProducer(ackProducer);
	registerChannelProducer(urlProducer);
	establishListeners.clear();
	envelopeSeq = 0;
	rafScheduled = false;
	inFlight = false;
	reflushPending = false;
	pendingLaneSeqs.clear();
	deliveredOutOfOrder.clear();
	deliveredWatermark = 0;
	lastAckCollected = 0;
	ackDeliveredOnConnection = false;
	retransmitBuffer = [];
	appliedWatermark = 0;
	retransmitPending = false;
	degraded = false;
	navPoint = 0;
	statedWindowUrl = null;
	pendingNavFrame = null;
	pendingNavRecords = [];
	windowNavClaim = false;
	liveStreamAbort = null;
	_setLiveConnectionId(null);
}
