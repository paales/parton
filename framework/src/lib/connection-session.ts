/**
 * Connection-session state — per-live-connection server state, keyed by
 * the explicit connection id (`?__conn=`) the client's heartbeat mints
 * for each `?live=1` stream it opens.
 *
 * A live connection is long-lived (the segment driver parks it between
 * wakes), and some request dimensions move WHILE it is open. The first
 * such dimension is the viewport-visibility set behind the `visible()`
 * hook: the client reports flips as fire-and-forget POSTs to
 * [[visibility-protocol]]'s endpoint, the report updates the session's
 * `visible` set, and the segment driver treats the flipped ids like an
 * invalidation wake — rendering them as lanes on the EXISTING stream.
 * The session's set IS part of the connection's request state:
 * `visible()` and the fingerprint fold's store-and-reread both read it
 * (session first, `?visible=` URL param as the no-session fallback), so
 * the read stays request-reproducible — every re-evaluation during one
 * wake agrees on the same set, and every change to the set arrives with
 * an explicit wake naming the ids it flipped.
 *
 * Lifecycle: the segment driver opens the session when it starts
 * driving a `?live=1&__conn=` response (seeding `visible` from the
 * request's `?visible=` param, so the whole-tree first segment already
 * renders against the client's measured set) and closes it when the
 * drive loop exits (keepalive elapsed, client abort). A report for an
 * unknown id returns `false` → the endpoint answers `404`, the explicit
 * "this connection is gone" signal the client controller falls back on.
 */

import {
	isVisibilityReport,
	type VisibilityReport,
} from "./visibility-protocol.ts";

/**
 * One pending flip — a report's statement about a single id, queued
 * until the segment driver drains it. A flip resolves against ITS OWN
 * report's testimony, never against a later report's `visible`
 * snapshot: mid-scroll bursts legitimately dip the snapshot (old
 * chunks exit before new skeletons mount and testify), the client
 * reports each flip exactly once, and resolving an earlier in-flip
 * against a later dip would drop it forever. Only an explicit later
 * statement about the SAME id replaces a pending one.
 */
export interface PendingFlip {
	/** The report's statement: `true` when the id was in THAT report's
	 *  `visible` snapshot (an in-flip — the driver lanes it), `false`
	 *  when it wasn't (an out-flip — the session-set update the report
	 *  already applied is its entire server-side effect). */
	readonly inView: boolean;
	/** Seq of the report that made the statement. A newer statement
	 *  about the same id replaces a pending one; a stale one (an older
	 *  report landing late) is discarded — the last statement about an
	 *  id wins, ordered by seq. */
	readonly seq: number;
	/** The client's cached tokens (`id:matchKey:fp`) for the id as of
	 *  the report — its ACTUAL holdings, which the driver swaps into
	 *  the connection's cached override before the flip's lane renders
	 *  (see the report protocol's `cached` field). `undefined` when the
	 *  report made no holdings statement (the override stays as
	 *  promoted). Consumed with the flip; a flip that defers past its
	 *  report drops its tokens (they would be stale by the time the
	 *  deferred lane runs). */
	readonly cached?: readonly string[];
}

export interface ConnectionSession {
	readonly id: string;
	/** The connection's current visible set. `null` until the request's
	 *  `?visible=` seed or the first report — the pre-measurement state,
	 *  in which reads fall back to the request URL (absent → `undefined`,
	 *  the `visible()` cold token). Replaced wholesale per report — and
	 *  by the driver when it consumes an in-flip statement the latest
	 *  snapshot dipped below (the lane ships the in-state, so the
	 *  connection's knowledge for that id is "in view"). Always replaced,
	 *  never mutated in place, so a render that grabbed the reference
	 *  mid-report keeps a consistent view. */
	visible: ReadonlySet<string> | null;
	/** Last applied report seq — the stale-report gate for `visible`. */
	lastSeq: number;
	/** Flipped ids awaiting a lane render, each carrying its report's
	 *  statement. The driver drains via `takeConnectionFlips`. Insertion
	 *  order is delivery order — reports send in-view flips first, so
	 *  lanes for the visible world start before stale cull-outs'. */
	readonly pendingFlips: Map<string, PendingFlip>;
	/** The segment driver's visibility wake arm: a report notifies every
	 *  registered listener. The driver registers one per park and
	 *  removes it when the park ends (the wake-arm release invariant —
	 *  a long-idle connection holds at most one entry here). A report
	 *  landing while the driver is busy has no listener to fire; its
	 *  ids sit in `pendingFlips`, which the driver's wait-entry check
	 *  consumes before the next park — no report vanishes. */
	readonly flipWakes: Set<() => void>;
}

// Survives dev-server module re-evaluation: a held live connection's
// driver keeps the store instance it opened its session in, while the
// visibility beacon endpoint resolves this module fresh per edit —
// both must address the SAME map, or every report answers `404`
// (forcing the reload fallback) until the heartbeat's next reopen and
// the driver's sessions leak in the abandoned instance. globalThis
// keying is inert in production: one evaluation per process.
const sessions = ((globalThis as Record<string, unknown>).__partonConnectionSessions ??=
	new Map<string, ConnectionSession>()) as Map<string, ConnectionSession>;

/** Open (register) a session for a live connection. Called by the
 *  segment driver before its first segment renders, so a report can
 *  land at any point of the connection's lifetime. */
export function _openConnectionSession(
	id: string,
	initialVisible: ReadonlySet<string> | null,
): ConnectionSession {
	const session: ConnectionSession = {
		id,
		visible: initialVisible,
		lastSeq: 0,
		pendingFlips: new Map(),
		flipWakes: new Set(),
	};
	sessions.set(id, session);
	return session;
}

/** Unregister a session — the drive loop exited; the stream is closed
 *  or closing. Reports for the id now return `false` (→ `404`). */
export function _closeConnectionSession(id: string): void {
	sessions.delete(id);
}

/**
 * Apply a visibility report to its connection. Returns `false` when no
 * session holds the id (connection closed / never opened) — the
 * caller's explicit fallback signal.
 *
 * `visible` replaces the session set only when the report is newer than
 * the last applied one (`seq` gate). `changed` ids queue into
 * `pendingFlips` carrying the report's OWN statement about each id —
 * its presence in THIS report's snapshot — because that statement, not
 * the latest set, is what the flip resolves against (see
 * [[PendingFlip]]). A superseded report's flips still queue (they still
 * need their lane render); per id, the statement with the highest seq
 * stands. Always notifies the flip wakes so a parked driver
 * re-evaluates.
 */
export function reportConnectionVisibility(
	id: string,
	seq: number,
	changed: readonly string[],
	visible: readonly string[],
	cached?: readonly string[],
): boolean {
	const session = sessions.get(id);
	if (!session) return false;
	const inView = new Set(visible);
	for (const c of changed) {
		const prior = session.pendingFlips.get(c);
		if (prior !== undefined && seq < prior.seq) continue;
		session.pendingFlips.set(c, {
			inView: inView.has(c),
			seq,
			// The client's holdings for this flip. An EMPTY list is a
			// statement ("I hold nothing for this id" — the flip's lane must
			// render rather than confirm a phantom copy); an ABSENT `cached`
			// makes no statement and leaves the override as promoted.
			cached:
				cached === undefined
					? undefined
					: cached.filter((t) => t.startsWith(`${c}:`)),
		});
	}
	if (seq > session.lastSeq) {
		session.lastSeq = seq;
		session.visible = new Set(visible);
	}
	for (const wake of [...session.flipWakes]) wake();
	return true;
}

/** Drain the session's pending flips — id → the statement it resolves
 *  against. A report landing right after the drain re-queues into
 *  `pendingFlips`, which the driver's wait-entry check consumes
 *  before its next park — no report vanishes into a consumed wake. */
export function takeConnectionFlips(
	session: ConnectionSession,
): Map<string, PendingFlip> {
	const flips = new Map(session.pendingFlips);
	session.pendingFlips.clear();
	return flips;
}

/**
 * The framework endpoint body for `POST /__parton/visible` — decode,
 * validate, apply. `204` (no body) on success: the flipped partons'
 * bytes travel down the live stream as lanes, never on this response.
 * `404` when the connection isn't open — the client controller's signal
 * to deliver the batch via the render-reload fallback. `400` on a
 * malformed body.
 */
export async function handleVisibilityReport(
	request: Request,
): Promise<Response> {
	let report: VisibilityReport;
	try {
		const body: unknown = await request.json();
		if (!isVisibilityReport(body))
			throw new Error("malformed visibility report");
		report = body;
	} catch {
		return new Response(null, { status: 400 });
	}
	const applied = reportConnectionVisibility(
		report.connection,
		report.seq,
		report.changed,
		report.visible,
		report.cached,
	);
	return new Response(null, { status: applied ? 204 : 404 });
}
