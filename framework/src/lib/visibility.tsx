"use client"

/**
 * Read-tracked view culling — the client half of `visible()`.
 *
 * A parton that reads `visible()` ([[server-hooks]]) is CULLABLE: its
 * fingerprint folds its viewport state, so it re-renders when it enters or
 * leaves the viewport. The server marks such a boundary `cullable`; on the
 * client the boundary wraps its rendered children in a `<Fragment ref>`
 * and observes them with an IntersectionObserver via React 19.3's
 * `FragmentInstance.observeUsing` — no wrapper element, no `data-*` id
 * stamping. The boundary already knows its own id, so it reports
 * `{ id, inView }` straight from its closure.
 *
 * Reports funnel into a module-level controller (mirroring the refetch
 * batch / partial cache — client state lives at module scope, not in
 * context). The controller coalesces a frame's worth of reports,
 * mirrors each flip into the cull-park display state (`cull-park.ts` —
 * the parton's Activity slots flip immediately; see `cull-slot.tsx`),
 * and SELF-REFETCHES the partons whose visibility changed, by id,
 * carrying the full visible set as `?visible=` so each re-rendered
 * parton's `visible()` reads its own bit. The refetch is stamped
 * `cullFlip` (`?__cullFlip=1` on the wire) — the explicit signal that
 * its targets are culling REVALIDATIONS, so the server may fp-skip
 * them: a placeholder confirms the parked copy (restore, no bytes),
 * fresh bytes replace it. fp-skip prunes the rest. Refetches
 * serialize: one in flight, re-firing with the latest set when it
 * changes.
 *
 * A cullable parton's observer lives in whichever of its two slots is
 * currently visible (a hidden Activity unmounts its effects), so a
 * flip HANDS OFF observation between slots within one React effect
 * flush. "The parton left the page" is therefore refcounted with a
 * post-flush sweep (`registerCullObserver`), never inferred from a
 * single effect cleanup.
 */

import React, { useEffect, useRef } from "react"
import { registerCullObserver, reportCullState } from "./cull-park.ts"
import type { VisibleOptions } from "./current-parton.ts"
import { enqueueRefetch } from "./refetch.ts"

/** How far beyond the viewport a parton counts as "in view" — the runway,
 *  so a parton fills before it's literally on screen. Expressed as an
 *  IntersectionObserver `rootMargin`. */
const RUNWAY = "600px 0px"

/** Max flipped ids per culling reload. A fast scroll across a large
 *  cullable field (the website's chunk world) can flip hundreds of
 *  partons in one coalesced flush; unbatched, the `?partials=` list
 *  alone would blow the server's request-line limit. Remaining flips
 *  stay in `changed` and ride the next serialized flush. */
const FLUSH_BATCH = 48

/** The subset of `FragmentInstance` (React 19.3) this module uses. The
 *  installed react-dom exposes these; `@types/react` may not type a
 *  Fragment `ref` yet, so we shape it locally and cast at the ref site. */
interface FragmentInstance {
	observeUsing(observer: IntersectionObserver): void
	unobserveUsing(observer: IntersectionObserver): void
	getClientRects(): DOMRect[]
}

// ─── Controller (module-level client state) ───────────────────────────

/** ids currently within the runway-expanded viewport. */
const inView = new Set<string>()
/** ids whose in/out state changed since the last flush — the refetch set. */
let changed = new Set<string>()
let rafScheduled = false
let inFlight = false

/** Report a cullable parton's viewport state. Idempotent per state; only a
 *  real flip schedules a refetch. Every flip also updates the cull-park
 *  display state, so the parton's Activity slots swap immediately —
 *  the scheduled refetch is the revalidation, not the swap. */
export function reportVisible(id: string, isInView: boolean): void {
	if (inView.has(id) === isInView) return
	if (isInView) inView.add(id)
	else inView.delete(id)
	changed.add(id)
	reportCullState(id, isInView)
	schedule()
}

/** Every observer of a cullable parton released past a commit flush.
 *  Drop it from the live set so `?visible=` doesn't carry a stale id.
 *  `changed` is deliberately NOT touched: a pending flip must still
 *  revalidate. Observer teardown is not a page-departure signal — an
 *  Activity flip can unmount one slot's observer in an earlier render
 *  pass than it mounts the other's, so the count passes through zero
 *  while the parton is very much on the page; cancelling its pending
 *  flip here would strand a restored subtree unrevalidated. A truly
 *  departed id costs at most one harmless extra reload target, and
 *  the hygiene self-heals: a re-mounting observer's initial
 *  IntersectionObserver callback re-reports the id. Page-membership
 *  teardown for the cull-park state rides the merge layer's prune
 *  instead (see `cull-park.ts`). */
function reportGone(id: string): void {
	inView.delete(id)
}

function schedule(): void {
	if (rafScheduled || typeof requestAnimationFrame === "undefined") return
	rafScheduled = true
	requestAnimationFrame(() => {
		rafScheduled = false
		void flush()
	})
}

async function flush(): Promise<void> {
	// Serialize: one refetch in flight. Newer flips accumulate in `changed`
	// and fire when it lands (the `finally` re-checks).
	if (inFlight || changed.size === 0) return
	// Culling is a POST-SETTLE operation. A refetch fired while a page
	// navigation is still committing supersedes it and tears the route swap —
	// the old route stays visible and the new one never lands (the IO fires as
	// the new route's cold partons mount, i.e. mid-navigation). Defer until the
	// in-flight navigation finishes, then re-flush. `navigation.transition` is
	// the real signal (non-null only while a navigation is committing), so this
	// doesn't guess.
	const transition = (
		window as unknown as { navigation?: { transition?: { finished: Promise<unknown> } | null } }
	).navigation?.transition
	if (transition) {
		transition.finished.then(schedule, schedule)
		return
	}
	const all = [...changed]
	const targets = all.slice(0, FLUSH_BATCH)
	changed = new Set(all.slice(FLUSH_BATCH))
	// Targets flipping INTO view restore their parked content
	// optimistically; this reload is their revalidation. Its response
	// settles each target through the commit walk — fresh bytes drop
	// the parked fiber, a confirmation placeholder re-arms it as a
	// live instance (see `contentSlotStored` / `contentSlotConfirmed`).
	inFlight = true
	try {
		await enqueueRefetch({
			labels: targets,
			streaming: false,
			live: false,
			cullFlip: true,
			params: { visible: [...inView].join(",") },
		}).finished
	} catch {
		// AbortError on supersede / NavigationError on a racing nav — both
		// benign here; the next flush re-fires with the current set.
	} finally {
		inFlight = false
		if (changed.size > 0) schedule()
	}
}

// ─── Boundary observer ────────────────────────────────────────────────

/**
 * Wraps a cullable parton's children in a `<Fragment ref>` and observes
 * their viewport intersection, reporting to the controller under the
 * parton's own id. Rendered by `PartialErrorBoundary` only when the server
 * marked the parton cullable; non-cullable partons render their children
 * bare (no Fragment, no observer, zero cost).
 *
 * The Fragment is transparent (no DOM) and renders identically on server
 * and client, so it doesn't shift the hydrated tree; the ref attaches and
 * the observer starts only on the client, in an effect.
 */
export function VisibilityObserver({
	id,
	options,
	children,
}: {
	id: string
	options?: VisibleOptions
	children: React.ReactNode
}): React.ReactNode {
	const ref = useRef<FragmentInstance | null>(null)
	const rootMargin = options?.rootMargin ?? RUNWAY
	useEffect(() => {
		const inst = ref.current
		if (!inst || typeof inst.observeUsing !== "function") return
		// This slot now observes the parton. A culling flip hands the
		// observation to the parton's other slot in the same effect
		// flush; the refcount + sweep distinguishes that handoff from
		// the parton actually leaving the page.
		const release = registerCullObserver(id, reportGone)
		// An IO callback batch contains only the nodes whose intersection
		// CHANGED — with many observed children (a fragment of chunk
		// subtrees), one leaving node must not read as "the whole parton
		// left". Track per-node state and report the aggregate.
		const nodeState = new Map<Element, boolean>()
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) nodeState.set(e.target, e.isIntersecting)
				for (const el of [...nodeState.keys()]) {
					if (!el.isConnected) nodeState.delete(el)
				}
				reportVisible(id, [...nodeState.values()].some(Boolean))
			},
			{ rootMargin },
		)
		inst.observeUsing(io)
		return () => {
			try {
				inst.unobserveUsing(io)
			} catch {
				// unobserve after the fragment's nodes already left the tree
			}
			io.disconnect()
			release()
		}
	}, [id, rootMargin])
	// `ref` on a Fragment yields a FragmentInstance (React 19.3). Built via
	// `createElement` so the ref prop isn't gated by the JSX intrinsic types
	// (the installed react-dom supports it even where `@types/react` doesn't).
	return React.createElement(React.Fragment, { ref } as never, children)
}
