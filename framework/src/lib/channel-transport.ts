/**
 * The channel transport seam — the byte/message plumbing under the
 * channel's two roles, pluggable behind one interface so the channel
 * SEMANTICS (frames, delivery seqs, acks, the connection-session
 * mirror — [[channel-protocol]], [[channel-client]]) stay
 * transport-agnostic while the pipe swaps.
 *
 *   - **downstream** — `open(statement, signal)` hands back a byte
 *     stream of the `\xFF`-marker wire the splitter
 *     ([[fp-trailer-split]]) already parses; the browser entry reads it.
 *   - **upstream** — `send(envelope)` delivers one coalesced envelope;
 *     the boolean is the whole contract ("the server will see it"). The
 *     client transport ([[channel-client]]) owns reliability above this
 *     (the retransmit buffer + the downstream `applied` marker), so a
 *     transport that can't answer per-message returns `true`.
 *   - **close** — release whatever the transport holds.
 *
 * The default is the FETCH transport — two discrete POSTs (`/__parton/
 * live` held open for downstream, `/__parton/channel` fire-and-forget
 * for upstream), the shape the whole protocol grew up on. A full-duplex
 * transport (WebSocket, WebTransport) folds both roles onto one
 * connection behind the same interface; it carries the SAME marker
 * bytes (an OPAQUE TUNNEL — no reframing), so only this module changes.
 */

import {
	ATTACH_ENDPOINT,
	type AttachStatement,
	CHANNEL_ENDPOINT,
	type ChannelEnvelope,
} from "./channel-protocol.ts";
import { NavigationError } from "../runtime/navigation-error.ts";

/**
 * The pluggable seam. One transport instance owns whatever connection
 * state its plumbing needs (a full-duplex transport's `send` reuses the
 * socket `open` established); the fetch transport is stateless.
 */
export interface ChannelTransport {
	/**
	 * Open the downstream: state the attach and hand back the held
	 * segmented byte stream. Throws `NavigationError` (network / http)
	 * on a failed establishment and `AbortError` untouched (a normal
	 * supersede, never a degrade signal). `signal` is the fire's abort:
	 * the fetch transport never wires it to the request itself (aborting
	 * the fetch tears a partially-committed Flight tree) — the caller
	 * passes it to the splitter, which aborts cooperatively at a segment
	 * boundary.
	 */
	open(
		statement: AttachStatement,
		signal?: AbortSignal,
	): Promise<{ body: ReadableStream<Uint8Array> }>;
	/** Deliver one envelope upstream. `true` = the server will see it. */
	send(envelope: ChannelEnvelope): Promise<boolean>;
	/** Release the transport's held connection (a no-op for fetch — its
	 *  attach fetch tears via the splitter, its envelopes are discrete). */
	close(): void;
}

/**
 * The fetch transport — the default, HTTP/1.1+. `open` POSTs the attach
 * statement to `/__parton/live` and hands back the held response body;
 * `send` POSTs one envelope to `/__parton/channel` fire-and-forget
 * (`keepalive: true`, so an in-flight envelope survives a page unload)
 * and reads the `204`. `close` is a no-op: each attach is its own
 * fetch (torn cooperatively via the caller's splitter signal) and every
 * envelope is a discrete request, so there is no held socket to release.
 *
 * `fetch` is referenced at CALL time, never captured at module load, so
 * a test's `vi.stubGlobal("fetch", …)` still observes these requests.
 */
export const fetchTransport: ChannelTransport = {
	async open(statement) {
		// The signal is deliberately NOT passed to `fetch`. Aborting the
		// fetch errors `response.body` mid-read, tearing a
		// partially-committed Flight tree; the caller passes the signal to
		// `splitSegments` instead, which aborts at a SEGMENT BOUNDARY.
		let response: Response;
		try {
			response = await fetch(ATTACH_ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(statement),
			});
		} catch (err) {
			// AbortError stays untouched — a normal lifecycle signal, not a
			// failure. Everything else maps to a typed NavigationError so
			// consumers branch on `kind` without string matching.
			if (err instanceof Error && err.name === "AbortError") throw err;
			throw new NavigationError({
				kind: "network",
				url: ATTACH_ENDPOINT,
				cause: err,
			});
		}
		if (!response.ok || !response.body) {
			throw new NavigationError({
				kind: "http",
				url: ATTACH_ENDPOINT,
				status: response.status,
			});
		}
		return { body: response.body };
	},
	async send(envelope) {
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
	},
	close() {},
};

let currentTransport: ChannelTransport = fetchTransport;

/** The transport the channel currently uses — the fetch transport by
 *  default; `setChannelTransport` swaps it before the first attach. */
export function getChannelTransport(): ChannelTransport {
	return currentTransport;
}

/** Install a transport. Default stays fetch until something opts in
 *  (the WebSocket selection at boot). Passing no argument restores the
 *  default — the test reset hook. */
export function setChannelTransport(transport?: ChannelTransport): void {
	currentTransport = transport ?? fetchTransport;
}
