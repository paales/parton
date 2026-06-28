# View culling — a windowed, data-driven product scroller

**Status:** working, app-side, at `/magento/browse`
(`e2e-testing/src/app/pages/magento/product-browse.tsx` +
`components/browse-scroller.tsx`, specs in
`e2e/product-browse-scroller.spec.ts`). This note is the design and the
framework-level findings the build surfaced — the substrate for a future
framework `<Scroller>`.

This is the shipped form of the "Activate ⇄ deactivate symmetry" backlog
item in [`IDEAS.md`](./IDEAS.md).

## The model — a window over a data-driven catalog

`BrowseList` renders only a **window** of fixed-height sections around the
anchor page; everything above and below collapses into two **spacers**
sized from `total_count`. So:

- the document height is `totalPages × PAGE_H`, constant as the window
  slides → **scrolling never jumps**;
- the page count is data-driven and unbounded (no hardcoded pool); the
  whole catalog's height is held by the spacers, but only the window is
  rendered → small payload;
- within the window, only the **ring** (±`RING_OVER` of the anchor)
  fetches products (a parton keyed by page, so in-ring pages fp-skip
  across a scroll); the rest of the window is a skeleton **runway** so the
  observer sees the window's edge coming before the spacer.

`<BrowseScroller>` writes the anchor to the `browse_vis` cookie (the
driver, off the sharable url) and reloads `#browse-list` against it,
serialized so each window commits. As the window slides the spacers
resize; the ring follows the viewport.

## The protocol — anchor on a cookie, reload the list

- **Anchor → `browse_vis` cookie** (`document.cookie` — not the History
  API). Read by BrowseList's `vary`; cold-start falls back to `?page=`.
- **`?page=` → sharable shadow.** Written via `useNavigation().navigate({
  silent: true })` (Navigation API), but **debounced past the reload
  cycle**: a silent navigate's commit disrupts an in-flight reload, so the
  URL only updates once the scroll settles. Deep-link `?page=N` cold-starts
  centered there (cookie absent → `vary` reads `search.page`, and the
  scroller scrolls N into view).

The scroller renders nothing and sits *beside* the list, observing the
`[data-page]` sections under a stable `browse-scope` element via one
IntersectionObserver (+ a MutationObserver to re-sync after a commit).

## Findings (the load-bearing part for a framework `<Scroller>`)

1. **A `schema` cell on the refetched partial silently breaks its
   reloads** — and was the real blocker behind every "the window won't
   move" dead end. With `total_count` bound as BrowseList's `schema` cell,
   reloads *resolved* and the server *re-rendered*, but the client never
   committed (a cached schema cell makes the partial look unchanged). Fetch
   derived data in a parent that renders **once** (the route) and pass it
   down as a **prop**; the refetched partial keeps a cookie-only `vary`.
2. **Rapid same-selector reloads supersede each other.** Serialize: one in
   flight, re-firing with the latest anchor when it changes.
3. **A silent navigate disrupts an in-flight reload** → debounce the
   `?page=` write past the reload cycle (it's a lazy shadow anyway).
4. **`observeUsing` can't watch framework partials** (substituted outside
   the fragment's React-child range) → DOM query under a scope element +
   MutationObserver, scroller beside the list.

## On payload size

A reload looks huge in **dev** (~200kB for a window) — but that's React's
dev-only `_debugInfo`: every element carries its source path + owner
stack. Production strips it: the same reload is ~48kB (≈8kB gzipped). The
real lever is the window size (`RING_OVER` product pages); the skeleton
runway and spacers are nearly free.

## Toward a framework `<Scroller>`

The app owns: the windowed list with a cookie `vary` + spacers, the ring
policy, and the `BrowseScroller` reporter. A framework `<Scroller name>`
would absorb the reporter (observe + cookie + serialized reload +
cold-start scroll + debounced `?page=`) and the spacer/window bookkeeping.
Findings 1–4 are its hard requirements. Extraction waits for a second call
site (the AI-thread streaming case), per YAGNI.
