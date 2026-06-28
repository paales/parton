# View culling — a stable, data-driven product scroller

**Status:** working, app-side, at `/magento/browse`
(`e2e-testing/src/app/pages/magento/product-browse.tsx` +
`components/browse-scroller.tsx`, specs in
`e2e/product-browse-scroller.spec.ts`). This note is the design and the
framework-level findings the build surfaced — the substrate for a future
framework `<Scroller>`.

This is the shipped form of the "Activate ⇄ deactivate symmetry" backlog
item in [`IDEAS.md`](./IDEAS.md).

## The model — all pages, fixed height, only the ring fetches

`BrowseList` renders **one fixed-height section per page of the whole
catalog** — the count comes from `total_count`, not a hardcoded pool, so
it's data-driven and unbounded. Because every page is the same `PAGE_H`
and they're all present, the document height is constant: **scrolling
never jumps.** Off-screen pages are culled from PAINT by
`content-visibility: auto` (browser-native), so keeping them all in the
DOM stays cheap.

Only the **ring** — the pages within ±`RING_OVER` of the anchor — fetches
products (one cell each, a parton keyed by page so in-ring pages fp-skip
across a scroll). Every other page is a skeleton. As the anchor moves, the
ring slides and the products follow the viewport.

This is render/fetch culling, not DOM eviction. True windowing — keeping
only ~N sections live with spacers for the rest — would shrink the DOM for
enormous catalogs, but it needs the framework to substitute a
*structurally changing* partial on refetch, which it can't today (see
findings). For moderate catalogs, all-pages + `content-visibility` is the
working trade.

## The protocol — anchor on a cookie, reload the list

- **Anchor → `browse_vis` cookie.** The driver. `<BrowseScroller>` writes
  the most-prominent visible page to the cookie (via `document.cookie` —
  not the History API) and reloads `#browse-list`, which reads the cookie
  in `vary`. The cookie keeps the anchor **off the sharable url**.
- **`?page=` → cold-start only.** A deep-linked `?page=N` is read by
  BrowseList's `vary` as the cold fallback (no cookie yet), and the
  scroller scrolls page N into view on mount. (`?page=` is NOT rewritten
  as you scroll — a silent navigate re-commits and resets the
  cookie-driven list; live url-position is a known gap.)

`<BrowseScroller>` renders nothing and sits *beside* the list: it observes
the `[data-page]` sections through a stable `browse-scope` element via one
IntersectionObserver (+ a MutationObserver to re-sync after a commit), and
serializes its reloads.

## Findings (the load-bearing part for a framework `<Scroller>`)

The model is simple; getting it to commit reliably surfaced these:

1. **A `schema` cell on the refetched partial silently breaks its
   reloads.** With `total_count` bound as BrowseList's `schema` cell, every
   reload *resolved* and the server *re-rendered* — but the client never
   committed the new content (a false fp-skip; the cached cell made the
   partial look unchanged). The fix: fetch derived data (`total_count`) in
   a parent that renders **once** (the route) and pass it down as a
   **prop**. The refetched partial keeps a cookie-only `vary`.

2. **Rapid same-selector reloads supersede each other.** Fire-and-forget
   reloads on every scroll tick abort each other (deferred-abort), and the
   slow product fetch means none lands. **Serialize**: one reload in
   flight, re-firing with the latest anchor when it changes.

3. **A `silent` navigate re-commits and resets a cookie-driven partial.**
   That's why `?page=` isn't written during scroll — it knocked the ring
   back to its cold state. Deep-link via a *pasted* `?page=` still works
   (cold-start path).

4. **`observeUsing` can't watch framework partials.** A React 19.2 Fragment
   ref would be the no-wrapper way, but the framework substitutes partials
   outside the fragment's React-child range, so it observes zero nodes. The
   scroller queries the DOM under a stable scope element and keeps the
   observer synced with a MutationObserver.

5. **Stability is fixed height + a constant page count**, not spacers — and
   `content-visibility: auto` keeps the off-screen pages from costing paint.

## Toward a framework `<Scroller>`

The app owns: the all-pages list with a cookie `vary`, the fixed-height
sections, the ring policy, and the `BrowseScroller` reporter. A framework
`<Scroller name>` would absorb the reporter (observe + cookie + serialized
reload + cold-start scroll) and could, with framework support for
refetch-substituting a structurally changing partial, do true windowing
with spacers. Findings 1–4 are its hard requirements. Extraction waits for
a second call site (the AI-thread streaming case), per YAGNI.
