import React, { act, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { beforeEach, describe, expect, it } from "vitest"
import { PartialsClient } from "../partial-client.tsx"
import { PartialErrorBoundary } from "../partial-error-boundary.tsx"

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Deterministic reproduction of the "content behind the search
 * disappears" bug — at the client-merge layer, no network, no timing.
 *
 * A cache-mode commit (a targeted refetch — e.g. a search keystroke)
 * bounds the client cache to what its rendered tree harvests, so an
 * evicted/superseded variant stops being advertised in `?cached=`. But
 * a substituted cache wrapper can still carry an in-flight Flight lazy
 * (a slow descendant — the search stages — hadn't resolved when the
 * wrapper was last cached). The partials BEHIND that lazy are still
 * live but aren't materialised in the rendered tree, so the harvest
 * misses them. Pruning then evicts their cache + advertised-fp entries,
 * and the next render's fp-skip placeholder has nothing to substitute —
 * the region (the page list behind the dialog) blanks until a full
 * re-render restores it.
 *
 * The fix guards the cache-mode prune on a COMPLETE render, the same
 * way the streaming-mode path only prunes in its non-pending branch.
 * Here the pending chunk is a never-resolving `React.lazy`, so the
 * mid-stream state is forced every run.
 */

// A fresh server-rendered partial: a keyed `<PartialErrorBoundary>`
// carrying its id, the way `partial.tsx` emits one.
function fresh(id: string, content: ReactNode): ReactNode {
  return (
    <PartialErrorBoundary key={id} partialId={id} partialFingerprint={`fp_${id}`} partialMatchKey="">
      {content}
    </PartialErrorBoundary>
  )
}

// An fp-skip: the bare placeholder the server emits when the client
// already advertised this partial's fp.
function placeholder(id: string): ReactNode {
  return <i key={`${id}|`} hidden data-partial data-partial-id={id} data-partial-match="" />
}

// A deferred Flight chunk that never arrives — a pending lazy, exactly
// what `unwrapLazy` classifies as `LAZY_PENDING`.
const pendingChunk = React.lazy(
  () => new Promise<{ default: React.ComponentType }>(() => {}),
) as unknown as ReactNode

function commit(mode: "streaming" | "cache", body: ReactNode): string {
  const container = document.createElement("div")
  const root = createRoot(container)
  act(() => {
    root.render(
      <PartialsClient mode={mode}>
        <main>{body}</main>
      </PartialsClient>,
    )
  })
  const html = container.innerHTML
  act(() => root.unmount())
  return html
}

beforeEach(() => {
  window.history.pushState({}, "", "/")
  // Reset the module-level cache + template: an empty streaming render
  // prunes every prior (id, matchKey) entry.
  commit("streaming", null)
})

describe("cache-mode prune behind a pending lazy", () => {
  it("does not evict a partial hidden behind a still-pending lazy", () => {
    // 1. Complete render: a `wrapper` partial containing an `inner`
    //    partial. Both are cached; `_template` records the wrapper
    //    placeholder; `inner` is reachable by descending into the
    //    cached wrapper.
    commit(
      "streaming",
      fresh("wrapper", [fresh("inner", <div key="i" data-testid="inner-content" />)]),
    )

    // 2. A mid-stream streaming segment re-renders `wrapper`, but its
    //    body chunk is still in flight (the never-resolving lazy). The
    //    cached wrapper is now TRUNCATED — `inner` sits behind a pending
    //    lazy. This is the pending branch: it doesn't prune, so `inner`
    //    survives here.
    commit("streaming", fresh("wrapper", pendingChunk))

    // 3. A cache-mode refetch (a search keystroke) commits while that
    //    lazy is still pending. Its rendered tree substitutes the
    //    truncated wrapper, hiding `inner` behind the lazy, so the
    //    harvest can't see `inner`. The prune must NOT evict it.
    commit("cache", fresh("refetched", <div key="r" />))

    // 4. The wrapper resolves and the server now fp-skips the unchanged
    //    `inner` (a bare placeholder). If `inner` survived step 3 it
    //    substitutes from cache; if it was wrongly evicted the
    //    placeholder stays empty — the blanked region.
    const html = commit("cache", fresh("wrapper", [placeholder("inner")]))

    expect(
      html,
      "inner was pruned while hidden behind a pending lazy and could not be substituted",
    ).toContain('data-testid="inner-content"')
  })
})
