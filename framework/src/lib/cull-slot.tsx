"use client"

/**
 * The two Activity slots of a cullable keepalive parton — the client
 * half of cull-to-park.
 *
 * The server emits every cullable keepalive parton as a stable pair
 * (see `emitCullPair` in `partial.tsx`):
 *
 *   <CullSlot slot="content">  — the in-view body (cache variant mk)
 *   <CullSlot slot="skeleton"> — the culled body (cache variant mk~cull)
 *
 * Each slot renders `<Activity>` around its children; a culling flip
 * is a MODE change on the two Activities, so the content subtree
 * PARKS when the parton leaves view (fiber alive, DOM kept, effects
 * unmounted) and RESTORES in place when it returns — client state
 * survives the round trip.
 *
 * Mode comes from the visibility controller's live report
 * (`cull-park.ts`, via useSyncExternalStore) with the server-computed
 * `culled` prop as the pre-report fallback — the report IS the
 * display state, so a flip shows instantly while the controller's
 * reload revalidates in the background. Two refinements:
 *
 *   - the content slot stays visible until a skeleton actually
 *     exists to hold the parton's space (first-ever cull-out: the
 *     skeleton bytes are still in flight, and hiding the content
 *     with nothing behind it would collapse the layout);
 *   - the content Activity is keyed by the slot's GENERATION
 *     (`cull-park.ts`): an fp-matched return restores the parked
 *     fiber in place (generation unchanged, same cached element —
 *     React bails out), while fresh returning bytes (fp moved while
 *     parked) bump it and REMOUNT — the parked copy is dropped, per
 *     drop-on-drift semantics.
 *
 * SSR renders modes purely from the `culled` prop — no report, no
 * cache — which matches the client's pre-report first render, so
 * hydration sees one shape.
 */

import React, { Activity, type ReactNode } from "react"
import { culledKey } from "./cull-key.ts"
import {
	contentGeneration,
	cullStateSnapshot,
	reportedVisibility,
	subscribeCullState,
} from "./cull-park.ts"
import { cacheLookup, getCurrentPagePartials } from "./partial-client-state.ts"

interface CullSlotProps {
	/** The parton's effective id — the visibility controller's key. */
	id: string
	/** BASE matchKey of the variant this pair belongs to. The skeleton
	 *  slot's cache entry lives under `culledKey(matchKey)`. */
	matchKey: string
	slot: "content" | "skeleton"
	/** Server-computed culled state of the render that produced this
	 *  element — the pre-report fallback only; a live report wins. */
	culled: boolean
	children?: ReactNode
}

const noopSubscribe = () => () => {}

export function CullSlot({ id, matchKey, slot, culled, children }: CullSlotProps): ReactNode {
	// Subscribe to reported-visibility flips + generation bumps for this
	// id. The snapshot string is per-id, so unrelated flips don't
	// re-render this slot. Server snapshot: no report (fall to `culled`).
	React.useSyncExternalStore(
		subscribeCullState,
		() => cullStateSnapshot(id),
		() => "u|0",
	)
	// Hydration gate for the cache-availability adjustments below. The
	// HYDRATION render must reproduce the SSR modes exactly — the walk
	// may not have cached a still-streaming slot yet, and adjusting an
	// Activity's mode against the server-rendered state mid-hydration
	// crashes React's hydration pass. useSyncExternalStore returns the
	// server snapshot during hydration and re-renders with the client
	// one right after mount, which is exactly the boundary needed.
	const hydrated = React.useSyncExternalStore(
		noopSubscribe,
		() => true,
		() => false,
	)
	const isServer = typeof document === "undefined"
	const reported = isServer ? undefined : reportedVisibility(id)
	const out = reported === undefined ? culled : !reported

	// One slot must ALWAYS be showing something real: the pair hosts the
	// parton's space reservation AND its viewport observer (a hidden
	// Activity unmounts effects), so a state whose cache entry hasn't
	// arrived yet keeps the OTHER slot visible until it does. Both
	// availability checks read the live cache — every commit that stores
	// a slot re-renders the pair, so they re-run exactly when they can
	// change. On the server (and during hydration) the emission itself
	// is the availability of the state it carries.
	const cache = hydrated ? getCurrentPagePartials() : null
	const hasContent = cache != null && cacheLookup(cache, id, matchKey) != null
	const hasSkeleton = cache != null && cacheLookup(cache, id, culledKey(matchKey)) != null

	if (slot === "skeleton") {
		// Visible while culled, and ALSO while in view with no content to
		// show yet (the flip's bytes still in flight — without this the
		// pair renders nothing at all: no reservation, no observer, and a
		// parton nothing observes can never report itself again).
		const show = hydrated ? out || !hasContent : out
		return <Activity mode={show ? "visible" : "hidden"}>{children}</Activity>
	}

	// Content slot. Hide only when a skeleton exists to hold the space —
	// the first-ever cull-out has no skeleton bytes yet, and hiding the
	// content with nothing behind it would collapse the layout.
	const hidden = out && (!hydrated || hasSkeleton)
	const generation = hydrated ? contentGeneration(id) : 0
	return (
		<Activity key={generation} mode={hidden ? "hidden" : "visible"}>
			{children}
		</Activity>
	)
}
