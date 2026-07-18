/**
 * `scroller(Render, options)` — the windowed-collection constructor.
 *
 * A collection (catalog, feed, listing) rendered as an interval tree
 * of cullable partons over ITEM INDEX space — the 1D analogue of the
 * quadtree the demo world hand-rolls. The tree is pure PLACEMENT:
 * entity identity belongs to the items (their cells/keys), order and
 * windowing belong to the tree, and pagination is a *projection* over
 * the same source (an `anchor` URL param that seeds the cold render),
 * never a render unit.
 *
 *   - LEAF partons cover `leaf` consecutive items. A leaf's body
 *     resolves the source slice (`range({offset, limit})`) and hands
 *     the items to the author's Render — the layout renderer. Each
 *     item the Render places is expected to be (or contain) its own
 *     parton, so item content invalidates per entity across every
 *     collection that shows it.
 *   - LEVEL partons group `fanout` children each. A culled level's
 *     body never runs, so an off-screen region of any size costs one
 *     shell on the wire — windowing without a windowing library.
 *   - The SHELL (the author's `cull.skeleton` twin) renders the culled
 *     reservation client-side from `{o, n, h}`: per-item placeholders
 *     at leaf counts, one `h`-px block for deep regions.
 *
 * Existence is CULL-driven only. The URL never gates a segment's
 * existence (`match`-windowed load-more conflates "how much exists"
 * with the URL); the `anchor` param is the cold seed — which interval
 * paints full before any client measurement — and the bookmarkable
 * shadow the client silently mirrors scroll position into.
 *
 * Identity: a node is its interval. Specs are minted per level
 * (`<id>-l<k>`, Render-name identity for the leaf), placements carry
 * `{o, n}` props, so instance ids derive from the interval and stay
 * stable as the collection grows — a middle segment's props don't
 * change when `total` moves; only the clamped tail (and the root)
 * re-render. Growing past a capacity boundary (`leaf * fanout^k`)
 * re-parents the top of the tree and re-caches — rare by
 * construction (each crossing is a `fanout`× growth).
 *
 * See `docs/reference/scroller.md`.
 */

import React, { type ComponentType, type ReactNode } from "react"
import { _buildPartial, autoSpecId, type PartialOptions, type RenderArgs } from "./partial.tsx"
import { searchParam } from "./server-hooks.ts"
import { ScrollerAnchorSync } from "./scroller-client.tsx"

// ─── Source contract ───────────────────────────────────────────────────

/** One resolved window of the collection. `total` is the size of the
 *  WHOLE collection as of this resolve — every slice restates it, and
 *  the root's read of it is what re-shapes the tree when the
 *  collection grows. */
export interface ScrollerWindow<Item> {
  items: readonly Item[]
  total: number
}

/**
 * The source: one async function from a window request to items +
 * total. The scroller always asks in `leaf`-aligned slices
 * (`offset % leaf === 0`, `limit === leaf`), so a page-shaped backend
 * maps cleanly (`currentPage: offset / limit + 1`).
 *
 * Resolve your data through tracked reads (cells) inside — the read
 * IS the dependency: the leaf re-renders when its slice's cell
 * invalidates, the root when the collection's shape does. The
 * tracking invariant applies: no untracked nondeterminism.
 */
export type ScrollerRange<Item> = (window: {
  offset: number
  limit: number
}) => Promise<ScrollerWindow<Item>>

// ─── Author surfaces ───────────────────────────────────────────────────

/** What the author's Render (the layout renderer) receives: the
 *  resolved slice plus its placement. Render owns ALL markup — the
 *  list container, item placement (each item its own parton), empty
 *  states. */
export interface ScrollerSlice<Item> {
  items: readonly Item[]
  /** Index of `items[0]` in the collection. */
  offset: number
  /** Collection size as of this slice's resolve. */
  total: number
}

/** The shell's props — the culled reservation, client-rendered from
 *  serializable placement props (the skeleton contract). Terse keys:
 *  these ride the wire once per placement. */
export interface ScrollerShellProps {
  /** First item index this shell covers. */
  o: number
  /** Item count it must reserve space for. */
  n: number
  /** Server-computed px reservation (`estimate(n)`). Render one
   *  `h`-px block for deep regions (`n > leaf`); at leaf counts,
   *  per-item placeholders in the same layout the Render uses. */
  h: number
}

export interface ScrollerAnchor {
  /** URL search param carrying the anchored position (`?page=N`).
   *  Read via a tracked `searchParam()` in every segment's cull seed,
   *  so a moved anchor re-seeds exactly the segments it flips. */
  param: string
  /** Items per anchor step. Defaults to `leaf`. This is also the page
   *  size a derived pager (`?page=N` links over the same source)
   *  would use. */
  pageSize?: number
}

export interface ScrollerOptions<Item> {
  range: ScrollerRange<Item>
  /** The culled twin of Render — a CLIENT component (the cull
   *  skeleton). */
  shell: ComponentType<ScrollerShellProps>
  /** Px reservation for a culled region of `count` items. The one
   *  number the author must declare about geometry — everything else
   *  is measured or laid out by CSS. Runs server-side; shells receive
   *  the computed px (`h`), never the function. */
  estimate: (count: number) => number
  /** Items per leaf slice — also the `range` fetch size. Default 24. */
  leaf?: number
  /** Children per tree node. Default 4. */
  fanout?: number
  /** Base observer runway in px for leaves (how far beyond the
   *  viewport still materializes). Levels add `estimate(leaf)` per
   *  height so ancestors mount their children's observers before the
   *  children's own flip line — the staggered-runway rule from the
   *  demo world, in item units. Default 600. */
  rootMargin?: number
  /** Cold-seed + URL-mirror wiring. Omit for collections that always
   *  seed at the head. */
  anchor?: ScrollerAnchor
}

// ─── Geometry ──────────────────────────────────────────────────────────

/** Deepest level pool minted per scroller. Capacity at depth 8 with
 *  the defaults is 24·4⁸ ≈ 1.5M items — a backstop, not a target. */
const MAX_DEPTH = 8

/** Items covered by one node at height `k` (a leaf is height 0). */
function spanAt(leaf: number, fanout: number, k: number): number {
  return leaf * fanout ** k
}

/** Tree height needed to cover `total` items. Exported for tests. */
export function scrollerDepthFor(total: number, leaf: number, fanout: number): number {
  let depth = 0
  while (spanAt(leaf, fanout, depth) < total && depth < MAX_DEPTH) depth++
  return depth
}

// ─── The constructor ───────────────────────────────────────────────────

interface SegmentProps {
  o: number
  n: number
  h: number
}

export function scroller<Item>(
  Render: (slice: ScrollerSlice<Item> & RenderArgs) => ReactNode,
  opts: ScrollerOptions<Item>,
): ComponentType {
  const id = autoSpecId(Render)
  const leaf = opts.leaf ?? 24
  const fanout = opts.fanout ?? 4
  const baseMargin = opts.rootMargin ?? 600
  const anchor = opts.anchor
  const anchorStep = anchor ? (anchor.pageSize ?? leaf) : leaf

  if (leaf < 1 || fanout < 2) {
    throw new Error(`scroller "${id}": leaf must be ≥ 1 and fanout ≥ 2`)
  }

  /** The anchored item window: `?page=N` → [(N−1)·step, N·step). No
   *  anchor param configured (or absent on the URL) → the head. Runs
   *  inside a segment's tracking context (cull seeds), so the
   *  `searchParam` read records as that segment's dep. */
  function anchorWindow(): readonly [number, number] {
    if (!anchor) return [0, anchorStep]
    const n = Math.max(1, Number(searchParam(anchor.param)) || 1)
    return [(n - 1) * anchorStep, n * anchorStep]
  }

  /** Cold-seed verdict for interval [o, o+n): in view before any
   *  measurement iff it intersects the anchor window padded by one
   *  leaf each side — the same box-intersection rule at every level,
   *  so the cold tree is exactly the root-to-anchor spine. */
  function seedFor(o: number, n: number): boolean {
    const [lo, hi] = anchorWindow()
    return o < hi + leaf && o + n > Math.max(0, lo - leaf)
  }

  /** Wrap a node placement in the interval marker the anchor-sync
   *  client (and the pre-hydration deep-link script) navigate by.
   *  The wrapper belongs to the PARENT — it exists in every cull
   *  state, so a deep link can land inside a still-culled region. */
  function placeNode(Node: ComponentType<SegmentProps>, o: number, n: number): ReactNode {
    return (
      <div key={o} data-s={id} data-so={o} data-sn={n}>
        <Node o={o} n={n} h={opts.estimate(n)} />
      </div>
    )
  }

  const cullFor = (height: number) => ({
    rootMargin: `${baseMargin + height * Math.max(0, opts.estimate(leaf))}px 0px`,
    seed: ({ o, n }: { o: number; n: number }) => seedFor(o, n),
    skeleton: opts.shell,
  })

  // ── Leaf spec — resolves the slice, delegates layout to Render ──
  const LeafSpec = _buildPartial(
    Object.assign(
      async function ScrollerLeafRender({ o, n, children }: SegmentProps & RenderArgs) {
        const { items, total } = await opts.range({ offset: o, limit: leaf })
        return Render({ items: items.slice(0, n), offset: o, total, children })
      } as (props: SegmentProps & RenderArgs) => ReactNode,
      { displayName: id },
    ) as never,
    { cull: cullFor(0) } as PartialOptions<object>,
  ) as unknown as ComponentType<SegmentProps>

  // ── Level specs — pure structure: fanout children, clamped ──
  const levels: Array<ComponentType<SegmentProps>> = []
  for (let k = 1; k <= MAX_DEPTH; k++) {
    const childSpan = spanAt(leaf, fanout, k - 1)
    const Child = k === 1 ? LeafSpec : levels[k - 2]
    levels.push(
      _buildPartial(
        Object.assign(
          function ScrollerLevelRender({ o, n }: SegmentProps & RenderArgs) {
            const kids: ReactNode[] = []
            for (let i = 0; i < fanout; i++) {
              const co = o + i * childSpan
              if (co >= o + n) break
              kids.push(placeNode(Child, co, Math.min(childSpan, o + n - co)))
            }
            return <>{kids}</>
          } as (props: SegmentProps & RenderArgs) => ReactNode,
          { displayName: `${id}-l${k}` },
        ) as never,
        { cull: cullFor(k) } as PartialOptions<object>,
      ) as unknown as ComponentType<SegmentProps>,
    )
  }

  // ── Root — reads the collection's shape, mounts the tree ──
  //
  // The root is a parton so `total` is a live dependency: it resolves
  // the head slice (whose cell the source caches — the leaf covering
  // [0, leaf) hits the same partition), re-rendering when the
  // collection's shape moves. Middle segments' `{o, n}` props stay
  // fixed as total grows; only the clamped tail path re-renders.
  const RootSpec = _buildPartial(
    Object.assign(
      async function ScrollerRootRender({ children }: RenderArgs) {
        const { total } = await opts.range({ offset: 0, limit: leaf })
        const depth = scrollerDepthFor(total, leaf, fanout)
        const Node = depth === 0 ? LeafSpec : levels[depth - 1]
        const n = Math.max(total, 0)
        return (
          <>
            {placeNode(Node, 0, n)}
            {anchor ? (
              <>
                <ScrollerAnchorSync name={id} param={anchor.param} step={anchorStep} />
                {/* Pre-hydration deep link: a fresh document load of
                    ?page=N must paint AT the anchor, not at the head
                    and then jump. Runs during HTML parse (the marked
                    sections render above it); inert on client navs
                    (React never executes dangerouslySetInnerHTML
                    scripts). */}
                <script
                  dangerouslySetInnerHTML={{
                    __html:
                      `(function(){try{var p=+(new URLSearchParams(location.search).get(${JSON.stringify(anchor.param)})||1);` +
                      `if(p>1){var t=(p-1)*${anchorStep},b=null;` +
                      `document.querySelectorAll('[data-s=${JSON.stringify(id)}]').forEach(function(e){` +
                      `var o=+e.dataset.so,n=+e.dataset.sn;` +
                      `if(t>=o&&t<o+n&&(b===null||n<+b.dataset.sn))b=e});` +
                      `if(b)b.scrollIntoView({block:"start"})}}catch(_){}})()`,
                  }}
                />
              </>
            ) : null}
          </>
        )
      } as (props: RenderArgs) => ReactNode,
      { displayName: `${id}-root` },
    ) as never,
    {} as PartialOptions<object>,
  )

  return RootSpec as unknown as ComponentType
}
