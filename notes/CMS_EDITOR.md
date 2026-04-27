# CMS editor — the debug panel, expanded

**Added:** 2026-04-25
**Status:** MVE shipped 2026-04-25 (chunk 3) — tree + preview + field form + save + publish. Per-config tabs, block palette, drag-drop, entity pickers, draft isolation still deferred. Runtime underneath (chunk 1 content accessors + resolver, chunk 2a slots, chunk 2b provides/getReference, chunk 3 draft/published + catalog prerender) shipped 2026-04-25. Companion: `CMS_VISION.md` (why), `CMS_MANIFEST.md` (data model).

**Update 2026-04-25b:** tree polish round — slot intermediary split into a label HEADER row at the top of the slot's children plus a `+ Block` dropdown FOOTER row at the bottom (matches Shopify / WordPress / Storyblok "list grows downward" mental model). Tree labels fall back to a node's first `title` / `headline` / `name` field when no `displayName` is set, so blocks like product cards show "Linen apron" instead of `#product-card-1`. Tree column widened to 320px and labels carry a `title` attribute so heavy truncation still surfaces full names on hover. Group's `items` slot now uses `allow="*"` (wildcard) so a Group can compose anything its enclosing slot already permits.

**Update 2026-04-25c:** save-protocol fix — the client-side cache substitution (`substituteNested` in `src/lib/partial-client.tsx`) now recursively walks INTO substituted wrappers. Before, a cache-mode refetch that re-rendered an ancestor (e.g. `cms-demo-root`) but emitted fp-skip placeholders for its children would substitute the ancestor wrapper from cache and stop — the inner placeholders survived as `<i hidden>` markers in the DOM, leaving the partial's region blank. Three reported regressions all traced back to this:
- "Two consecutive moves on the same slot child blank the preview"
- "Save-to-draft after navigating the preview frame doesn't update the preview"
- "Selecting page-greeting then clicking the alpha frame nav loses the field form" (same cache-substitution miss surfacing on the editor's right pane)
The fix: on every substitution (placeholder → wrapper, OR wrapper → fresh wrapper), recurse into the result with the substituted id as the new `skipId` so a self-pointing reference can't loop.

**Update 2026-04-27c:** preview parity round.

- **Address bar is now a single editable input** (`src/editor/components/address-bar.tsx`). Browser-style: the input shows the current URL, accepts direct editing, hits Enter to navigate. No preset buttons (the `magento` / `cache demo` / etc. shortcuts are gone — type the path). The input syncs to the live URL on external navs unless it's focused, so a user mid-typing isn't clobbered.
- **`RouteSwitch` component** (`src/app/root.tsx`). Editor mode passes `<RouteSwitch />` (a component reference) as the preview's children, not `pickRoutedPage()` (a function call's return value). Cache-mode refetches reuse the snapshot's `content` JSX wholesale; with the function-call form, the route handler's output got baked into the snapshot at registration time and frame navs (e.g. LoadMore's `?pages=2` bump) re-rendered the same stale page-1 markup. With the component form React re-invokes the handler against the current request on every render. Non-editor mode keeps `{pickRoutedPage()}` inline so synchronous `notFound()` / `redirect()` throws still bubble to Root's try/catch.
- **Skip session URL sync on frame refetches.** EditorShell calls `setSessionFrameUrl(["preview"], previewUrl)` to align the frame URL with the window URL — but a frame refetch (`?__frame=preview&__frameUrl=…`) arrives with a session update already applied by `PartialRoot`. Overwriting it would clobber the frame nav (LoadMore's `?pages=2` round-trips, then the sync snaps the URL back to `/`). EditorShell now reads the request's `__frame` params and skips the sync when this request is itself a preview-frame refetch.
- **Layout rework: window-scrolled preview, sticky sidebars.** The tree and field panels are `position: sticky; top: 0; h-screen; overflow-y-auto`. The preview column flows naturally with the window's scroll axis. Two reasons:
  1. IntersectionObserver activators (`<WhenVisible>`, `LoadMore`'s sentinel) inside the previewed page default `root: viewport`. The previous `overflow-y-auto` preview wrapper made every observer non-firing — Pokemon's infinite scroll, the trivia activator, any `defer={<WhenVisible/>}` partial broke silently.
  2. Browser-native scroll experience — page-down / mouse wheel does what users expect.
- **Tree follows the previewed page.** `listAllCmsNodes` accepts an optional `rootIds` filter; `buildCmsTreeEntries` walks only the listed top-level nodes. The editor maps routes → root cmsIds via `PAGE_CMS_ROOTS` in `src/editor/shell.tsx` (today: `/cms-demo` → `cms-demo-root`, expandable). On routes without a registered root, the tree shows an empty hint pointing the author at `/cms-demo`. The probe loop calls `getPathname` for every pattern unconditionally so the tree's manifest captures the path dependency and a cross-page nav invalidates the fp.
- **Field panel auto-pick now invalidates on cross-page nav.** `FieldPanel` calls `rootCmsIdsForPreviewedPage()` purely for the manifest side-effect — `pickBestConfigIndex` matches internally without going through tracked accessors, so without the explicit probe the panel's fp wouldn't see the path change and the auto-picked config tab would serve stale on a `/cms-demo → /cms-demo/alpha` nav.
- **Address-bar nav uses selector targeting.** Every `Enter` on the URL bar navigates with `selector: "#preview #cms-edit-fields #cms-edit-tree"` so the editor sidebars refetch alongside the page content. Without explicit selectors, the page partial would refetch but tree/fields would fp-skip — they're explicit-included now and always re-render.

**Update 2026-04-27b:** editor-as-shell. The editor moved from a `/cms-edit` route to a cookie-gated chrome that wraps every page render.

- **`?editor=1`** sets a `__editor` cookie; **`?editor=0`** clears it. After the toggle, every URL renders inside the editor without the flag riding along (`syncEditorCookie()` in `src/app/root.tsx`). Visitors without the cookie pay no editor cost.
- The address bar (`src/editor/components/address-bar.tsx`) drives `useNavigation()` (window-scoped). Window URL == previewed-page URL — bookmarkable, browser back/forward walks preview history. Editor selection (`?select=…&config=…`) is preserved across address-bar navs so the workspace survives moving between previewed pages; preview-internal `<a>` clicks DO drop those params (regular page-nav semantics).
- **Preview frame retained, with session sync.** `<Partial selector="#preview" frame="preview" frameUrl={previewUrl}>` wraps the previewed page. The frame's session URL is **overwritten on every Root render** (`setSessionFrameUrl(["preview"], previewUrl)` from EditorShell) with the window URL minus editor-internal params. This reconciles two goals that look opposed:
  - **Address-bar drives window navigation** — the URL must be bookmarkable and browser-back must walk preview history.
  - **Frame scopes accessor reads** — without the frame, page-internal Partials (e.g. PokemonPage's `<Partial selector="#search">`) read the page URL directly and pick up the editor's `?select=` as a manifest read. The hoisting check throws `HoistingViolationError` the moment the user clicks a tree entry (a previously-empty manifest grows the `url:select` key for a Partial that has no business reading it).
  - The sync resolves both: the window URL is the source of truth; the frame URL is a clean projection (no editor params) that page-internal Partials see. `useNavigation("preview").navigate(...)` writes session, but the next Root render overwrites it — there is no explicit caller of that handle today; the address bar uses `useNavigation()` (window) which goes through normal page navigation. Future code that wants frame-isolated navigation needs to relax this sync.
- Config-tab default now follows the previewed page URL: `pickEffectiveConfig` calls `pickBestConfigIndex(configs, previewRequest())` to highlight the best-matching config tab automatically. Visiting `/cms-demo/alpha` with `?select=cms-demo-greeting` highlights the `slug=alpha` tab without an explicit override; explicit `?config=N` still wins. Implementation in `src/framework/cms-runtime.ts` (`pickBestConfigIndex`).
- Editor UI moved from `src/app/pages/cms-edit.tsx` + `src/app/components/cms-edit-*` + `src/app/actions/cms.ts` to `src/editor/{shell,actions,components/}` — top-level package boundary in prep for a monorepo split.

**Framework fix folded in:** fp-skip on a Partial used to register an empty manifest (`manifestScope.current` is freshly-empty when the body doesn't run). The next render that DID run the body would compare its real reads against that empty stored manifest and throw `HoistingViolationError` — every key looked "new." `partial-component.tsx` now stores `manifestScope.stored ?? manifestScope.current` on the fp-skip path, so the stored manifest is whatever the previous render-that-actually-ran captured. Without this fix, navigating between pages while editor mode was on threw violations on every accessor whose Partial had been fp-skipped on the prior request — the fp churn from frame-URL changes made it pervasive.

**Update 2026-04-25d:** streaming-mode prune fix + single-slot header collapse.

1. **Cache prune now keeps nested partials.** Streaming-mode pruning in `PartialsClient` derived its "live ids" from `collectTemplateIds(deriveTemplate(...))`, but `deriveTemplate` stops at any partial wrapper — nested partial ids were never visited and got deleted from `_cache` on every full render. Same hole for `_fingerprints.clear()`: the up-front clear plus a walk that only re-sets fresh wrappers wiped fingerprints for fp-skipped partials. Three reported regressions trace back to this:
    - "Click `alpha` on /cms-demo and most blocks (nav, hero, multi-slot, product cards) disappear; back button doesn't recover them" — nested partials' cache entries were pruned away before `substituteNested` ran.
    - "Selecting `#greeting` in /cms-edit then clicking `slug=alpha` blanks the field form and the tree" — the editor's `cms-edit-fields` and `cms-edit-tree` partials are nested inside `cms-edit-root`, so their cache also got wiped.
    - "alpha → beta → gamma blanks the slug nav" — the second regression: when the OUTER partial fp-skipped (cms-demo-root unchanged across beta → gamma since both match `{in:[beta,gamma]}`), the new streamed tree carried only the outer's placeholder, so the prune set saw only top-level ids; every nested partial inside the cached `cms-demo-root` wrapper got deleted out from under the next render.
   The fix has three parts: (a) `cacheFromStreamingChildren` threads a `seen` set that tracks fresh wrappers AND placeholders from the new tree, (b) after the walk, a frontier-style BFS expands `seen` by walking INTO each cached wrapper for ids in `seen` and harvesting nested partial ids transitively (so a top-level placeholder for `cms-demo-root` still keeps every partial reachable inside its cached wrapper), and (c) `_fingerprints.clear()` is gone — the prune handles staleness without losing skip-confirmed entries. The combined logic is exhaustive: any partial id reachable through the rendered tree (whether via a fresh wrapper, a placeholder over a cached wrapper, or transitively through a wrapper's children) survives the prune. Pinned by `e2e/cms-nav-stress.spec.ts`.
2. **Single-slot tree header collapsed.** `buildCmsTreeEntries` skips the `▸ <slot>` intermediary when a parent declares exactly one slot — the label adds no information when there's nothing to disambiguate it from. Children render at `depth + 1` directly under the parent; the +Block footer stays at `depth + 1` so authors can still append. Multi-slot parents (`cms-demo-multi-slot`) keep the header per slot.

---

## One-liner

The editor is a cookie-gated chrome around the whole app — when `__editor=1` is set, every page render is wrapped in a three-pane shell (tree / preview / fields). The previewed page **is** the window URL — typing in the address bar navigates the browser, and the same RSC pipeline that serves real visitors fills the preview. No iframe, no separate URL space, no parallel architecture. The "frame" name lives in test selectors and component naming; no `<Partial frame="preview">` is involved (see Update 2026-04-27b).

## Layout — Shopify-inspired three-pane

Following the Shopify theme editor shape, which works because it matches the mental model (structure / preview / details):

| Pane | Role | Source of truth |
|---|---|---|
| Left sidebar | **Structure tree.** Hierarchy of Partials in the CMS store. Expandable. Shows slot contents nested under their host Partial. Click to select. | CMS store (draft merged over published). |
| Center | **Address bar + preview.** The site being edited, rendered as the window URL's page. Authors browse between pages by typing in the bar or clicking presets — selection state is preserved across navs so the workspace survives moving around. | `pickRoute([...])` against the window URL — same code path real visitors hit. |
| Right sidebar | **Fields.** Form for the selected Partial: content fields, references, slot contents, and "varies by" dimensions from the request-input manifest. Tabbed per configuration match; the matching tab is auto-selected by the previewed page URL. | CMS store for the selected Partial. |

No on-canvas drag-drop initially. Selection is via tree clicks (`?select=…` on the URL). Reordering/adding/removing blocks happens in the tree sidebar via inline ↑/↓/× and the slot-add `+ Block` dropdown.

## Preview is the window URL

There's no separate URL space for the preview. The editor's address bar drives `useNavigation()` (window-scoped) — every nav updates the window URL, and `pickRoute` re-renders the new path inside the editor chrome. Browser back/forward, deep linking, and refresh all "just work."

```tsx
// src/app/root.tsx — when editor cookie is set, wrap whatever
// `pickRoute` returned in the editor shell.
{editorOn ? (
  <EditorShell>{pickRoutedPage()}</EditorShell>
) : (
  <>
    <AppNav />
    {pickRoutedPage()}
  </>
)}
```

- **No iframe**, no postMessage, no cookie-isolation workarounds.
- The `__editor` cookie persists across nav so URLs stay clean (no `?editor=1` riding along after the toggle).
- Editor selection state (`?select=…&config=…`) is preserved on address-bar navs but dropped by preview-internal links — those are regular page navs.
- DevTools stay one-level.

### Container queries, not viewport media queries

The preview pane's width ≠ the browser viewport width. Any block that uses `@media (max-width: …)` will render incorrectly in the editor (it thinks it's on a desktop because the viewport is). Block authors must use CSS container queries (`@container`). Ship this as:

- A documented constraint in the block-author guide.
- A dev-time HMR warning when `@media` appears inside a block file.
- A lint rule if practical.

### Future iframe escape hatch

If a scene ever needs security or cookie isolation from the editor (embedding third-party content, cross-origin flows), add a `<Partial iframe>` primitive alongside `frame` with its own security semantics. Explicitly not a v1 concern — the frame primitive covers every current use case.

## Selecting a Partial

Click anywhere in the preview → message bubbles to the editor chrome → tree highlights the hit Partial → field sidebar loads its manifest + current configs. DOM-level hit testing: every Partial already emits a `data-partial-id` marker (via `<PartialErrorBoundary>` or the skip-placeholder); the preview's click handler walks up from the click target to find the nearest one.

Selecting a slot (clicking in the gap between blocks, or on a slot-header in the tree) — not a Partial — shows the slot's `allow` grammar and an "add block" affordance in the sidebar.

## Field sidebar — per-configuration tabs

A Partial's manifest tells the editor:

- Which content fields it reads (→ form inputs)
- Which references it reads (→ entity pickers)
- Which slots it declares (→ drop zones shown in-tree, summary in sidebar)
- Which request-input dimensions it reads (→ configuration match tabs)

If the Partial reads `getPathname("/p/:slug")` and `getSearchParam("abtest")`, the author sees tabs like:

```
[ All ] [ slug=bulbasaur ] [ slug∈{1,2,3} ] [ + Add slug override ]
  [ No variant ] [ variant=A ] [ variant=B ] [ + Add variant ]
```

Each tab corresponds to a `match` clause in storage. Switching tabs switches which config the form writes to. Inheritance from less-specific tabs is indicated in the form (greyed defaults; explicit overrides highlighted).

## Save protocol — using the existing invalidation graph

Author edits a field in the right sidebar → debounced save fires a server action → action writes to the draft store → action returns `{ invalidate: { selector: "#product-hero" } }` → existing refetch pipeline re-renders that Partial in the preview frame → author sees the change.

**Nothing new.** The entire authoring loop uses mechanics that already exist:
- Server actions for persistence.
- Server-action-return `invalidate` directive for cache invalidation.
- Selector-based refetch for surgical updates.
- Cookie-driven accessor (`getCookie("cms-draft")`) for draft vs published.
- Tracked accessor → cache key folding, so the draft/published split participates in cache keys automatically.

## Drag-drop — structure only, in the tree sidebar

Blocks are reorderable within a slot and movable between slots, subject to each slot's `allow`:

- Drag from slot A → drop in slot B. Editor validates B's `allow` against the block's selectors. If not allowed, reject with a tooltip ("slot 'sidebar' accepts `.widget`; this block is `.product-card`"). If allowed, write new ordering to store for both slots, invalidate both.
- Reorder within a slot: update the slot's ordered contents, invalidate.

**On-canvas drag-drop** (drag directly in the preview frame) is deferred. Click-to-select in the preview + reorder in the tree sidebar is simpler to implement, has fewer edge cases, and matches how Shopify works today. Revisit if authors ask.

## Block palette — adding new blocks

When the author clicks "add block" on a slot, the editor shows a palette of block types whose selectors satisfy the slot's `allow`. Palette entries come from:

- The **block catalog manifest** (`src/blocks/catalog.ts`). Static list of block types with their `type` tag, selector(s), and presets.
- **Cached field manifests** (from the dev-time prerender pass). Used for palette card previews and initial form rendering.

Filter by `allow` is client-side: `catalog.filter(b => b.selectors.some(s => satisfies(s, slot.allow)))`.

**Adding a block:** generate a `cmsId`, push `{cmsId, type, configs: [], slots: {}}` into the slot's ordered contents, apply preset if selected, invalidate the slot's host Partial. The new block renders with preset values (or empty), manifest populates, sidebar shows its form.

## Entity picker widgets

`getReference(name, "product")` in a block → editor shows a "product" picker in the field sidebar. Picker UI per type is registered in a widget registry:

```ts
registerPickerWidget("product",    ProductPickerComponent);
registerPickerWidget("collection", CollectionPickerComponent);
```

Widgets are userspace — a Magento app registers pickers that hit GraphCommerce; a Shopify app registers pickers that hit Storefront API; a headless CMS registers pickers that hit its own entity store. The framework ships the registry mechanism and a simple "paste an ID" fallback widget for any type without a registered picker.

## Draft and published — cookie-driven

Two stores (or one store with draft + published fields per entry):
- **Draft.** Written by the editor on every save. Read when `cms-draft=<id>` cookie is set.
- **Published.** Read when the cookie is absent. Updated by the "publish" action, which copies (a subset of) draft → published.

Blocks read the store via the CMS runtime. The runtime reads the cookie (via `getCookie("cms-draft")` — tracked, participates in cache keys); forks the storage lookup accordingly; the rest is identical.

Published reads can be aggressively cached (`<Partial cache>` per-Partial with a `.published` shared token for global invalidation on publish). Draft reads bypass cache since authors are iterating rapidly.

## What's deferred — roadmap, not v1

Explicit list so nobody rebuilds these expecting them to exist.

- **Inline editing via `<Text>` / `<RichText>`.** Click text in the preview → edit in place with optimistic local rendering. The plumbing exists (cookie-driven draft, targeted refetch); the UX is real work.
- **On-canvas drag-drop.** Drag blocks directly in the preview pane. More complex hit-testing; Shopify doesn't bother.
- **Publishing workflow.** Review stage, multi-author review, scheduled publishes. v1: save → publish is one button.
- **Versioning and rollback.** v1: git history (the big JSON file is committed).
- **Multi-author concurrent editing.** v1: single-author editor; concurrent edits collide.
- **Entity management** (creating products, etc.) — out of scope. Entity backends own this.
- **Modules contributing blocks into shared slots** (the M1 `layout_default` merge analog). Waits on a contribution-protocol design. See `CMS_VISION.md § What this framework has already rebuilt`.
- **Presets.** See `CMS_MANIFEST.md § Presets`.
- **`<Partial iframe>`** for security-isolated preview or embedded third-party content.

## Implementation sketch — where the code lands

| Piece | File |
|---|---|
| Editor shell (entry component) | `src/editor/shell.tsx` |
| Tree sidebar | inline in `src/editor/shell.tsx` (TreePanel / TreeContents) |
| Address bar (preview URL bar) | `src/editor/components/address-bar.tsx` |
| Selector-targeted tree-link | `src/editor/components/tree-link.tsx` |
| Slot-add dropdown | `src/editor/components/add-block.tsx` |
| Field sidebar | inline in `src/editor/shell.tsx` (FieldPanel) |
| CMS store backend | `src/framework/cms-storage.ts` (`JsonFileStorage`) |
| CMS runtime + resolver | `src/framework/cms-runtime.ts` |
| Draft save / publish server actions | `src/editor/actions.ts` |
| Editor-mode toggle (cookie + Root wiring) | `src/app/root.tsx` (`syncEditorCookie`, `isEditorRequest` from `cms-runtime.ts`) |
| Content accessors (`getText` etc.) | `src/framework/context.ts` |
| `<Children>` / `<Child>` primitive | `src/lib/slot.tsx` |
| `provides` prop on `<Partial>` | `src/lib/partial-component.tsx` + `partial-context.ts` |
| Block catalog | `src/app/blocks/catalog.ts` |
| Dev-time field-manifest prerender | `src/framework/cms-prerender.ts` |

Nothing requires changes to the RSC pipeline, the Flight runtime, or the navigation surface. Every extension point is additive.

## Build order — suggested sequence

1. **Split `ManifestScope` into five sections.** Pure refactor; cache keys still read only `requestInputs`. Everything else empty until later steps fill them.
2. **Add content accessors.** `getText` / `getEnum` / `getNumber` / etc. Wired to the content-field section; reading from a stubbed in-memory store.
3. **Add `<Children>` / `<Child>`.** Slot declarations record into the child-slot section; at render time they read the store and render contributed blocks as `<Partial>`s.
4. **Add `provides` + `getClosest`.** Extend `PartialCtx`; thread through existing parent-token plumbing.
5. **Add `getReference` + one loader (`getProduct`).** Prove the reference flow end-to-end with PokeAPI or Magento product data.
6. **Big-JSON-file store + draft cookie.** Stub the CMS persistence; wire draft-vs-published via cookie accessor.
7. **Block catalog + prerender pass.** Dev-time manifest capture for each block type.
8. **Editor route, preview frame, tree sidebar (extend debug panel).** Selection wired; no editing yet.
9. **Field sidebar with form rendering from manifest.** Save via server action + `invalidate`. Single-config editing first.
10. **Configuration tabs for request-input dimensions.** Per-match editing with cascade.
11. **Palette + add-block.** Block-type selection constrained by `allow`.
12. **Drag-drop between slots.** Constraint validation on drop.

Each step is independently testable (the testing tiers in `TESTING_ARCHITECTURE.md` cover all of it) and each lands a visible capability. No big-bang merge.

## Related notes

- `CMS_VISION.md` — why this direction.
- `CMS_MANIFEST.md` — the data model.
- `FRAMES.md` — the frame primitive the preview uses.
- `SELECTOR_API.md` — selector grammar for `allow`.
- `PARTIAL_ARCHITECTURE.md` — the partial registry the tree sidebar reads.
- `NAVIGATE_UNIFIED.md` — the invalidation-driven save loop runs on this.
