/**
 * Visibility priming — the controller's baseline is the DISPLAY state.
 *
 * `CullPair` primes the controller on mount with its emission's
 * server-computed `culled` prop, and the controller overlays any live
 * report for the id — the same precedence the pair's own display uses
 * (`reported ?? culled`). The overlay is what keeps a RESTORED parked
 * subtree honest: its pairs re-mount from emissions minted BEFORE
 * their cull-outs, so the raw prop says "in" while the display shows
 * the skeleton. A baseline primed from the raw prop would swallow the
 * observer's first real measurement (a genuine in-flip against the
 * showing skeleton) as a no-delta duplicate — no dispatch, no lane,
 * and nothing ever revives the subtree.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { _resetCullPark, reportCullState, reportedVisibility } from "../cull-park.ts"
import { _primeVisible, reportVisible } from "../visibility.tsx"

beforeEach(() => {
	_resetCullPark()
})

describe("visibility priming", () => {
	it("a prime honors the live report overlay — the observer's real flip stays a delta", () => {
		// The id's display state is OUT per its live report (its cull-out
		// already happened and swapped the pair to the skeleton)…
		reportCullState("prime-overlay", false)
		// …and a restored emission minted before that cull-out re-mounts,
		// priming with its stale culled:false prop.
		_primeVisible("prime-overlay", true)
		// The baseline followed the DISPLAYED state (out), so the
		// observer's genuine "in view" measurement is a delta: it
		// dispatches and swaps the display.
		reportVisible("prime-overlay", true)
		expect(reportedVisibility("prime-overlay")).toBe(true)
	})

	it("a prime with no report overlay follows the emission's state", () => {
		// Boot shape: no live report yet — the emission's state IS the
		// display, and a first measurement that agrees with it is a
		// no-op (no flip dispatched, display untouched).
		_primeVisible("prime-cold", true)
		reportVisible("prime-cold", true)
		expect(reportedVisibility("prime-cold")).toBeUndefined()
	})
})
