/**
 * The channel's upstream wire protocol — the envelope shape shared by
 * the client transport and the server's connection-session layer
 * ([[connection-session]]). Import-safe on
 * both sides: no server or DOM dependencies, just the endpoint path,
 * the envelope grammar, and its decoder.
 *
 * An envelope is one coalesced, fire-and-forget POST: the client
 * states facts about itself — viewport flips today; URL moves, commit
 * acks, and telemetry are reserved kinds (see
 * `docs/notes/channel-design.md`) — addressed to the OPEN live
 * connection by its explicit id. The server answers `204` with no body — every rendered consequence of a
 * frame travels down the live stream as lane segments, never on this
 * response. Frames are loss-tolerant for now: no retransmit buffer, no
 * delivery acks; a lost envelope's statements are re-established by
 * the next heartbeat fire's seed.
 */

/** POST target for channel envelopes. Framework-owned, handled by
 *  `createRscHandler` before any app routing — inside a lightweight
 *  request scope (see [[connection-session]]'s `handleChannelPost`). */
export const CHANNEL_ENDPOINT = "/__parton/channel";

/**
 * A viewport-visibility statement — the culling controller's report as
 * a channel frame. Statement semantics live with the connection
 * session ([[connection-session]]): each `changed` id's DIRECTION is
 * its presence in this frame's `visible` snapshot (present = in-flip,
 * absent = out-flip); the flip resolves against its own frame's
 * statement, never a later frame's snapshot. Ordered viewport-first
 * (in-view flips before cull-outs) so the visible world's lanes lead.
 */
export interface VisibleFrame {
	kind: "visible";
	/** Parton ids whose in/out state flipped since the last statement. */
	changed: string[];
	/** The complete visible set as of this frame. Replaces the
	 *  connection's set wholesale (no incremental merge). */
	visible: string[];
	/** The client's CURRENT cached tokens (`id:matchKey:fp`) for the
	 *  `changed` ids — its actual holdings at flip time, which the
	 *  driver swaps into the connection's cached override before a
	 *  direct flip's lane renders. An EMPTY array is a statement ("I
	 *  hold nothing"); an ABSENT field makes no holdings statement. */
	cached?: string[];
}

/**
 * Explicit close — the client is leaving (tab close, cross-origin
 * navigation), sent via a keepalive fetch on `pagehide`. Best-effort
 * by nature (an unload beacon can always be lost); the driver's
 * keepalive timeout remains the backstop. The driver wakes, exits its
 * drive loop, and closes the session.
 */
export interface DetachFrame {
	kind: "detach";
}

/** The frame kinds shipped today. The grammar is open: an envelope may
 *  carry kinds this build doesn't know (url / ack / telemetry land in
 *  later packages — `docs/notes/channel-design.md` § Wire shape), and
 *  the decoder SKIPS those rather than erroring, the same
 *  extensibility rule the downstream marker grammar follows. */
export type ChannelFrame = VisibleFrame | DetachFrame;

export interface ChannelEnvelope {
	/** The live connection this envelope addresses. An explicit token,
	 *  never inferred: an envelope for a connection the server doesn't
	 *  hold gets a `404`, the transport's fall-back-to-discrete
	 *  signal. */
	connection: string;
	/** Per-connection monotonic envelope sequence. The server applies a
	 *  `visible` frame's snapshot only from envelopes at or past the
	 *  last applied seq, so two in-flight POSTs can't commit an older
	 *  set over a newer one; per-id flip statements order by seq
	 *  independently (a stale envelope's flips still queue — see
	 *  [[connection-session]]). */
	seq: number;
	/** Frames, ordered within the envelope. */
	frames: ChannelFrame[];
}

/**
 * Decode a parsed JSON body into an envelope. Returns `null` when the
 * envelope itself — or any KNOWN-kind frame — is malformed (the
 * endpoint answers `400`: a protocol violation, not extensibility).
 * Frames of UNKNOWN kind are dropped from the result, not errors: the
 * grammar grows by adding kinds, and an old server must stay
 * indifferent to a newer client's frames.
 */
export function decodeChannelEnvelope(value: unknown): ChannelEnvelope | null {
	if (value === null || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (typeof v.connection !== "string" || v.connection.length === 0) return null;
	if (typeof v.seq !== "number" || !Number.isFinite(v.seq)) return null;
	if (!Array.isArray(v.frames)) return null;
	const frames: ChannelFrame[] = [];
	for (const raw of v.frames) {
		if (raw === null || typeof raw !== "object") return null;
		const f = raw as Record<string, unknown>;
		if (typeof f.kind !== "string") return null;
		if (f.kind === "visible") {
			if (!isStringArray(f.changed) || !isStringArray(f.visible)) return null;
			if (f.cached !== undefined && !isStringArray(f.cached)) return null;
			frames.push({
				kind: "visible",
				changed: f.changed,
				visible: f.visible,
				cached: f.cached,
			});
			continue;
		}
		if (f.kind === "detach") {
			frames.push({ kind: "detach" });
			continue;
		}
		// Unknown kind — skipped, never an error.
	}
	return { connection: v.connection, seq: v.seq, frames };
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((x) => typeof x === "string");
}
