/**
 * ChannelClient — the window-navigation transport. The claims:
 *
 *   1. `_channelNavigate` reserves the navigation point at STATEMENT
 *      time (`envelopeSeq + 1` — the next envelope), ships exactly one
 *      url frame per flush (newest statement wins pre-flush), and
 *      returns milestones; with no connection or a degraded page it
 *      returns null — the caller's discrete-GET cue;
 *   2. the url producer is RELIABLE class: its frames buffer per
 *      envelope, the downstream `applied` marker prunes them, and an
 *      unpruned survivor retransmits at the next establishment with
 *      its original seq;
 *   3. the attach subsumes the URL timeline: navigation point resets,
 *      buffered url frames retire, the pending statement drops;
 *   4. the as-of guard (`_channelDeliveryCommittable`) drops
 *      deliveries rendered before the navigation point; the server
 *      url-push gate (`_serverUrlPushApplies`) is client-wins in both
 *      directions;
 *   5. milestones wire to the covering segment: commit resolves
 *      `streaming` (and decides the commit mode), settle resolves
 *      `finished` — for every record the segment covers;
 *   6. a connection loss with pending navigations falls back to ONE
 *      discrete fire for the latest statement's URL, chaining every
 *      record's milestones; the refetch dispatcher routes batches over
 *      the channel when attached and keeps the discrete path (with its
 *      issue-seq claim) otherwise.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	_channelDeliveryCommittable,
	_channelEstablished,
	_channelNavAvailable,
	_channelNavigate,
	_channelNavPoint,
	_channelNavPrefersTransition,
	_channelNavSegmentCommitted,
	_channelNavSegmentSettled,
	_channelNavSubsumedByAttach,
	_channelStatedWindowUrl,
	_channelWireEntry,
	_laneDeliveryCommitted,
	_resetChannelClient,
	_serverUrlPushApplies,
	scheduleChannelFlush,
} from "../channel-client.ts"
import type { ChannelEnvelope } from "../channel-protocol.ts"
import { _getLiveConnectionId } from "../partial-client-state.ts"
import { enqueueRefetch } from "../refetch.ts"

let rafQueue: FrameRequestCallback[] = []
function raf(): void {
	const queue = rafQueue
	rafQueue = []
	for (const cb of queue) cb(0)
}

let fetchCalls: Array<{ url: string; init: RequestInit }> = []
let fetchResults: Array<{ status: number } | Error> = []
async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve()
}

function sentEnvelopes(): ChannelEnvelope[] {
	return fetchCalls.map(
		(c) => JSON.parse(String(c.init.body)) as ChannelEnvelope,
	)
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

async function flushOnce(): Promise<void> {
	scheduleChannelFlush()
	raf()
	await settle()
}

/** Track a promise's settlement without consuming rejections. */
function probe(p: Promise<void>): { done: () => boolean; failed: () => boolean } {
	let done = false
	let failed = false
	p.then(
		() => {
			done = true
		},
		() => {
			failed = true
		},
	)
	return { done: () => done, failed: () => failed }
}

interface CapturedFire {
	url: URL
	claimCommit?: () => boolean
}

let discreteFires: CapturedFire[]

beforeEach(() => {
	_resetChannelClient()
	rafQueue = []
	fetchCalls = []
	fetchResults = []
	discreteFires = []
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		rafQueue.push(cb)
		return rafQueue.length
	})
	vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
		fetchCalls.push({ url, init })
		const result = fetchResults.shift() ?? { status: 204 }
		if (result instanceof Error) return Promise.reject(result)
		return Promise.resolve(result as Response)
	})
	;(window as unknown as Record<string, unknown>).__rsc_partial_refetch = (
		url: string,
		_signal?: AbortSignal,
		claimCommit?: () => boolean,
	) => {
		discreteFires.push({ url: new URL(url), claimCommit })
		return { streaming: Promise.resolve(), finished: Promise.resolve() }
	}
})

afterEach(() => {
	_resetChannelClient()
	delete (window as unknown as Record<string, unknown>).__rsc_partial_refetch
	vi.unstubAllGlobals()
})

describe("the navigation point + the url frame", () => {
	it("reserves the next envelope seq at statement time and ships one url frame", async () => {
		_channelEstablished("c1")
		expect(_channelNavPoint()).toBe(0)
		const routed = _channelNavigate({ url: "/b?x=1", intent: "push" })
		expect(routed).not.toBeNull()
		// The point advances at CLICK time — before any flush — so a
		// pre-navigation delivery landing in the reservation window is
		// already droppable.
		expect(_channelNavPoint()).toBe(1)
		expect(_channelStatedWindowUrl()).toBe("/b?x=1")
		raf()
		await settle()
		expect(sentEnvelopes()).toHaveLength(1)
		expect(sentEnvelopes()[0].seq).toBe(1)
		expect(sentEnvelopes()[0].frames).toContainEqual({
			kind: "url",
			url: "/b?x=1",
			intent: "push",
		})
	})

	it("newest statement wins pre-flush — one frame ships, both records ride it", async () => {
		_channelEstablished("c1")
		const first = _channelNavigate({ url: "/b", intent: "push" })
		const second = _channelNavigate({ url: "/c", intent: "push" })
		if (!first || !second) throw new Error("expected channel routing")
		expect(_channelNavPoint()).toBe(1)
		raf()
		await settle()
		const urlFrames = sentEnvelopes()[0].frames.filter((f) => f.kind === "url")
		expect(urlFrames).toEqual([{ kind: "url", url: "/c", intent: "push" }])

		// The covering segment (as-of the shared navigation point)
		// resolves BOTH fires — its content is the newest URL's render.
		const p1 = probe(first.finished)
		const p2 = probe(second.finished)
		_channelNavSegmentCommitted(1)
		_channelNavSegmentSettled(1)
		await settle()
		expect(p1.done()).toBe(true)
		expect(p2.done()).toBe(true)
	})

	it("returns null with no connection — first interaction never waits on attach", () => {
		expect(_channelNavAvailable()).toBe(false)
		expect(_channelNavigate({ url: "/b", intent: "push" })).toBeNull()
	})

	it("returns null on a degraded page — the discrete path with its own guards", async () => {
		_channelEstablished("c1")
		// The connection's FIRST ack fails to deliver — the sticky page
		// degrade (the transport proved the duplex broken).
		_channelWireEntry("seq", enc("p\n1 0"))
		_laneDeliveryCommitted("p")
		fetchResults.push(new Error("blocked"))
		await flushOnce()
		expect(_channelNavAvailable()).toBe(false)
		expect(_channelNavigate({ url: "/b", intent: "push" })).toBeNull()
	})
})

describe("reliable class + the attach subsume", () => {
	it("buffers the url frame, prunes on applied, retransmits an unpruned survivor", async () => {
		_channelEstablished("c1")
		_channelNavigate({ url: "/b", intent: "push", record: false })
		await flushOnce()
		expect(sentEnvelopes()).toHaveLength(1)

		// No applied marker heard — the survivor retransmits at the next
		// establishment with its ORIGINAL page-lifetime seq.
		_channelEstablished("c2")
		raf()
		await settle()
		expect(sentEnvelopes()).toHaveLength(2)
		expect(sentEnvelopes()[1]).toMatchObject({ connection: "c2", seq: 1 })
		expect(sentEnvelopes()[1].frames).toEqual([
			{ kind: "url", url: "/b", intent: "push" },
		])

		// The applied marker covers it — nothing left to retransmit.
		_channelWireEntry("applied", enc("1"))
		_channelEstablished("c3")
		raf()
		await settle()
		expect(sentEnvelopes()).toHaveLength(2)
	})

	it("the attach subsumes: navigation point resets, buffered url frames retire", async () => {
		_channelEstablished("c1")
		_channelNavigate({ url: "/b", intent: "push", record: false })
		await flushOnce()
		expect(_channelNavPoint()).toBe(1)

		_channelNavSubsumedByAttach()
		expect(_channelNavPoint()).toBe(0)
		expect(_channelStatedWindowUrl()).toBeNull()

		// Establishment after the attach: no retransmit — the attach's
		// own request line already stated the URL.
		_channelEstablished("c2")
		raf()
		await settle()
		expect(sentEnvelopes()).toHaveLength(1)
	})
})

describe("the as-of guards", () => {
	it("drops deliveries rendered before the navigation point", () => {
		_channelEstablished("c1")
		expect(_channelDeliveryCommittable(0)).toBe(true)
		_channelNavigate({ url: "/b", intent: "push", record: false })
		expect(_channelDeliveryCommittable(0)).toBe(false)
		expect(_channelDeliveryCommittable(1)).toBe(true)
	})

	it("server url pushes are client-wins in both directions", () => {
		_channelEstablished("c1")
		// No navigation stated: every push applies (an uncorrelated
		// caller applies unconditionally).
		expect(_serverUrlPushApplies(undefined)).toBe(true)
		expect(_serverUrlPushApplies(0)).toBe(true)
		_channelNavigate({ url: "/b", intent: "push", record: false })
		// Rendered before the client's statement → a stale suggestion.
		expect(_serverUrlPushApplies(0)).toBe(false)
		// Rendered as-of (or after) it → the server saw the navigation;
		// its push stands.
		expect(_serverUrlPushApplies(1)).toBe(true)
	})
})

describe("milestones ride the covering segment", () => {
	it("commit resolves streaming (and decides the commit mode); settle resolves finished", async () => {
		_channelEstablished("c1")
		const routed = _channelNavigate({
			url: "/b",
			intent: "push",
			streaming: false,
		})
		if (!routed) throw new Error("expected channel routing")
		const streaming = probe(routed.streaming)
		const finished = probe(routed.finished)

		// A non-covering segment (as-of 0 — pre-navigation) is not ours.
		_channelNavSegmentCommitted(0)
		await settle()
		expect(streaming.done()).toBe(false)

		// The covering commit: an atomic-swap caller makes the segment a
		// transition commit.
		expect(_channelNavPrefersTransition(1)).toBe(true)
		_channelNavSegmentCommitted(1)
		await settle()
		expect(streaming.done()).toBe(true)
		expect(finished.done()).toBe(false)

		_channelNavSegmentSettled(1)
		await settle()
		expect(finished.done()).toBe(true)
		// Retired records no longer shape commit modes.
		expect(_channelNavPrefersTransition(1)).toBe(false)
	})

	it("a progressive caller leaves the live stream's raw commit in place", () => {
		_channelEstablished("c1")
		const routed = _channelNavigate({
			url: "/b",
			intent: "push",
			streaming: true,
		})
		if (!routed) throw new Error("expected channel routing")
		expect(_channelNavPrefersTransition(1)).toBe(false)
		_channelNavSegmentCommitted(1)
		_channelNavSegmentSettled(1)
	})

	it("an aborted signal rejects the record with AbortError", async () => {
		_channelEstablished("c1")
		const controller = new AbortController()
		const routed = _channelNavigate({
			url: "/b",
			intent: "push",
			signal: controller.signal,
		})
		if (!routed) throw new Error("expected channel routing")
		const finished = probe(routed.finished)
		controller.abort()
		await settle()
		expect(finished.failed()).toBe(true)
	})
})

describe("falling back to the discrete transport", () => {
	it("a failed url envelope hands the latest statement to ONE discrete fire and chains the records", async () => {
		_channelEstablished("c1")
		const first = _channelNavigate({ url: "/b", intent: "push" })
		const second = _channelNavigate({ url: "/c?q=1", intent: "push" })
		if (!first || !second) throw new Error("expected channel routing")
		const p1 = probe(first.finished)
		const p2 = probe(second.finished)
		fetchResults.push({ status: 404 })
		await flushOnce()
		expect(_getLiveConnectionId()).toBeNull()
		expect(discreteFires).toHaveLength(1)
		expect(discreteFires[0].url.pathname + discreteFires[0].url.search).toBe(
			"/c?q=1",
		)
		await settle()
		expect(p1.done()).toBe(true)
		expect(p2.done()).toBe(true)
	})

	it("routes a selector batch over the channel when attached; discrete (with the issue-seq claim) otherwise", async () => {
		// Attached: the batch becomes a url frame — the page URL with the
		// ?__force= overlay (whole-tree segment, forced targets), intent
		// silent; no discrete fire, no claim.
		_channelEstablished("c1")
		const fire = enqueueRefetch({
			labels: ["cart"],
			streaming: false,
			live: false,
		})
		await settle()
		expect(discreteFires).toHaveLength(0)
		raf()
		await settle()
		const urlFrames = sentEnvelopes()
			.flatMap((e) => e.frames)
			.filter((f) => f.kind === "url")
		expect(urlFrames).toHaveLength(1)
		if (urlFrames[0].kind !== "url") throw new Error("unreachable")
		const stated = new URL(urlFrames[0].url, "http://localhost")
		expect(stated.searchParams.get("__force")).toBe("cart")
		expect(urlFrames[0].intent).toBe("silent")
		// The milestones ride the covering segment.
		const finished = probe(fire.finished)
		_channelNavSegmentCommitted(_channelNavPoint())
		_channelNavSegmentSettled(_channelNavPoint())
		await settle()
		expect(finished.done()).toBe(true)

		// Unattached: the discrete GET path, WITH the monotonic issue-seq
		// claim — the surviving twin of the retired guards.
		_resetChannelClient()
		enqueueRefetch({ labels: ["cart"], streaming: false, live: false })
		await settle()
		expect(discreteFires).toHaveLength(1)
		expect(discreteFires[0].url.searchParams.get("partials")).toBe("cart")
		expect(discreteFires[0].claimCommit).toBeDefined()
	})
})
