// @vitest-environment node
import { describe, expect, it } from "vitest"

import { _wakeLabelsOf } from "../segment-relevance.ts"
import type { PartialSnapshot } from "../partial-registry.ts"

/**
 * `_wakeLabelsOf` — the wake index's match surface for a snapshot.
 *
 * The regression this pins: a cell (or tag) resolved in a parton's
 * RENDER BODY through a cold `await` (a `remoteCell` network read) lands
 * its `cell:` / `tag:` selector in the live `deps` set only AFTER
 * `PartialBoundary` froze the snapshot's `labels` from the pre-body,
 * empty read set. The fp folds those post-await deps through
 * store-and-reread; the wake index must match them too — so
 * `_wakeLabelsOf` unions the frozen `labels` with the `cell:`/`tag:`
 * names in the live `deps`. Without it, a catch-up boot attach (which
 * skips the full re-render that would re-freeze the labels) leaves the
 * parton dark to invalidation — the `remoteCell` live-update bug.
 */

function snap(labels: string[], deps?: string[]): PartialSnapshot {
  return {
    type: "x",
    fallback: null,
    labels,
    framePath: [],
    parentFrameChain: [],
    parentPath: [],
    ...(deps !== undefined ? { deps: new Set(deps) } : {}),
  } as unknown as PartialSnapshot
}

describe("_wakeLabelsOf", () => {
  it("returns the frozen labels verbatim when deps carry no new cell/tag", () => {
    const s = snap(["cell:a"], ["cell:a?p=1", "cookie:sid", "search:q"])
    // `cell:a` already present; cookie/search are not invalidation labels.
    expect(_wakeLabelsOf(s)).toEqual(["cell:a"])
  })

  it("adds a BODY-resolved cell dep the frozen labels missed (the lag heal)", () => {
    // The cold-render case: labels froze empty, the cell landed in deps.
    const s = snap([], ["cell:remote.bid?p=abc"])
    expect(_wakeLabelsOf(s)).toEqual(["cell:remote.bid"])
  })

  it("adds a body tag dep as the bare name (matching PartialBoundary's grammar)", () => {
    const s = snap([], ["tag:live-b"])
    expect(_wakeLabelsOf(s)).toEqual(["live-b"])
  })

  it("unions frozen labels with post-await cell/tag deps, deduped", () => {
    const s = snap(["cell:a"], ["cell:a?p=1", "cell:b?p=2", "tag:t"])
    expect(new Set(_wakeLabelsOf(s))).toEqual(new Set(["cell:a", "cell:b", "t"]))
  })

  it("returns the frozen labels for a snapshot with no deps", () => {
    const s = snap(["cell:a", "t"])
    expect(_wakeLabelsOf(s)).toEqual(["cell:a", "t"])
  })
})
