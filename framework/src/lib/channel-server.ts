/**
 * The server half of the WebSocket transport — a full-duplex channel
 * over ONE socket, behind the same channel semantics the fetch endpoints
 * serve. An OPAQUE TUNNEL: the SAME `\xFF`-marker downstream byte stream
 * the fetch attach serves rides down as binary messages, and the SAME
 * JSON attach/envelopes ride up as text messages — no reframing, so the
 * whole protocol above (`driveSegmentedResponse`, the connection
 * session, `applyEnvelopeToSession`) is reused UNCHANGED.
 *
 * `driveChannelSocket` is transport-adapter-agnostic: it drives an
 * abstract [[ChannelSocket]], which a Vite plugin ([[vite/channel-server]])
 * adapts from a `ws` WebSocket for dev/preview, and which the render
 * side wires with a `renderSegment` closure (`createChannelServer` in
 * the RSC entry supplies the whole-tree `<Root/>` render). The socket is
 * inherently bound (one connection per socket), so envelopes only prove
 * they name THIS socket's session under the attach's scope + cookie
 * (`_resolveBoundSession`) — the origin check lives at the upgrade
 * handshake, not per-message. This module carries no RSC-render
 * dependency, so its testable core imports without one.
 */

import { runWithRequestAsync } from "../runtime/context.ts";
import { HEADER_RSC_RENDER } from "../runtime/request.tsx";
import {
	type AttachStatement,
	type ChannelEnvelope,
	decodeAttachStatement,
	decodeChannelEnvelope,
} from "./channel-protocol.ts";
import {
	_resolveBoundSession,
	applyEnvelopeToSession,
	bindAttachStatement,
} from "./connection-session.ts";
import {
	driveSegmentedResponse,
	type SegmentedResponseDemand,
} from "./segmented-response.ts";

/**
 * Buffered bytes past which the driver's downstream enqueues park until
 * a queued send flushes (`onDrain`) — the WebSocket mirror of the fetch
 * response stream's `desiredSize` pull-gate.
 */
const SOCKET_HIGH_WATER_MARK = 1 << 20; // 1 MB

/**
 * The transport-adapter seam. A Vite plugin (or any host) implements
 * this over its socket library; `driveChannelSocket` speaks only to it.
 * The downstream carries binary marker bytes (`send`); the upstream
 * carries text (attach + envelopes, `onMessage`). Backpressure is the
 * two real signals: `bufferedAmount` (how much is queued) and `onDrain`
 * (a queued send actually flushed) — no timers.
 */
export interface ChannelSocket {
	/** Write one downstream binary frame — the segment/lane marker bytes. */
	send(bytes: Uint8Array): void;
	/** Bytes queued but not yet flushed to the network
	 *  (`WebSocket.bufferedAmount`) — the backpressure level. */
	readonly bufferedAmount: number;
	/** Close the socket (winds the drive down). */
	close(): void;
	/** Register the upstream text handler: the attach statement (first
	 *  message) then channel envelopes. */
	onMessage(handler: (data: string) => void): void;
	/** Register the close handler — the client is gone (tab close,
	 *  network drop), the drive's teardown signal. */
	onClose(handler: () => void): void;
	/** Register a flush signal: a previously-queued `send` reached the
	 *  network, so a parked enqueue may resume. */
	onDrain(handler: () => void): void;
}

/**
 * Drive one channel connection over a socket. The attach is the FIRST
 * upstream message (mirrors the fetch attach's POST body); envelopes
 * follow on the same socket. On the attach, binds the statement and runs
 * `driveSegmentedResponse` UNCHANGED — its `enqueue` writes down the
 * socket, its `demand` reads socket backpressure. Each subsequent
 * envelope applies through the SAME `applyEnvelopeToSession` switch the
 * fetch endpoint uses, in a request scope carrying the upgrade's cookies
 * (so a frame-url's session write lands where the client's cookie
 * resolves). Resolves when the connection ends.
 *
 * `request` is the upgrade request — its headers (the `Cookie`) supply
 * the scope + session identity binding; its URL supplies the origin the
 * attach's stated URL is validated against. `renderSegment` produces one
 * segment's Flight stream (fp-trailer-wrapped), the same closure the
 * fetch attach passes to `createSegmentedResponse`.
 */
export async function driveChannelSocket(
	socket: ChannelSocket,
	request: Request,
	renderSegment: () => ReadableStream<Uint8Array>,
): Promise<void> {
	const origin = new URL(request.url).origin;

	// Downstream backpressure — the WebSocket twin of the response
	// stream's pull-gate. Enqueues park while the socket's buffer sits
	// past the high-water mark; a flushed send (`onDrain`) releases the
	// parked pumps. A close winds the drive down: `cancelled` surfaces at
	// the next lane enqueue (mirroring the fetch stream's `cancel()`), so
	// a mid-lane torn socket stops promptly and a fully-parked one is
	// reaped by the keepalive backstop or a `detach` frame — parity with
	// the fetch transport.
	let drainWaiters: Array<() => void> = [];
	const releaseDrain = (): void => {
		const waiters = drainWaiters;
		drainWaiters = [];
		for (const resolve of waiters) resolve();
	};
	socket.onDrain(releaseDrain);
	const demand: SegmentedResponseDemand = {
		cancelled: false,
		pulled: () =>
			demand.cancelled
				? Promise.resolve()
				: new Promise<void>((resolve) => drainWaiters.push(resolve)),
	};
	// `driveSegmentedResponse` touches only `enqueue` + `desiredSize`
	// (never `close`/`error` — those are the fetch stream wrapper's job),
	// so a minimal shim stands in for the response controller.
	const controller = {
		enqueue(bytes: Uint8Array): void {
			socket.send(bytes);
		},
		get desiredSize(): number | null {
			return demand.cancelled
				? null
				: SOCKET_HIGH_WATER_MARK - socket.bufferedAmount;
		},
	} as unknown as ReadableStreamDefaultController<Uint8Array>;

	let resolveDone!: () => void;
	const done = new Promise<void>((resolve) => {
		resolveDone = resolve;
	});

	socket.onClose(() => {
		demand.cancelled = true;
		releaseDrain();
	});

	let attached = false;
	socket.onMessage((data) => {
		if (!attached) {
			attached = true;
			const statement = decodeStatement(data);
			if (statement === null || !sameOriginAttach(statement, origin)) {
				socket.close();
				resolveDone();
				return;
			}
			const stated = new URL(statement.url, origin);
			// The one-shot `__force` overlay never enters request state (the
			// driver reads it off the statement and lanes the targets after
			// the region opens) — mirror the attach endpoint's strip.
			stated.searchParams.delete("__force");
			const headers = new Headers(request.headers);
			headers.set(HEADER_RSC_RENDER, "1");
			const renderRequest = new Request(stated, { headers });
			void runWithRequestAsync(renderRequest, async () => {
				bindAttachStatement(statement);
				await driveSegmentedResponse(
					controller,
					renderSegment,
					undefined,
					demand,
				);
			}).then(resolveDone, resolveDone);
			return;
		}
		// A channel envelope — apply it through the shared switch in a
		// request scope carrying the upgrade's cookies. A malformed or
		// unbound envelope is dropped (a WebSocket has no per-message
		// response to answer 400/404 with; the client's retransmit buffer
		// + the keepalive backstop cover the loss).
		const envelope = decodeEnvelope(data);
		if (envelope === null) return;
		void runWithRequestAsync(request, async () => {
			const session = _resolveBoundSession(envelope.connection);
			if (session === null) return;
			applyEnvelopeToSession(session, envelope, request.url);
		});
	});

	await done;
}

function decodeStatement(data: string): AttachStatement | null {
	try {
		return decodeAttachStatement(JSON.parse(data));
	} catch {
		return null;
	}
}

function decodeEnvelope(data: string): ChannelEnvelope | null {
	try {
		return decodeChannelEnvelope(JSON.parse(data));
	} catch {
		return null;
	}
}

/** Same-origin gate for the attach's stated URL + any frame targets —
 *  the WebSocket twin of the attach endpoint's validation (the upgrade
 *  handshake already proved the socket's own origin). */
function sameOriginAttach(statement: AttachStatement, origin: string): boolean {
	try {
		if (new URL(statement.url, origin).origin !== origin) return false;
		for (const frame of statement.frames ?? []) {
			if (new URL(frame.url, origin).origin !== origin) return false;
		}
		return true;
	} catch {
		return false;
	}
}
