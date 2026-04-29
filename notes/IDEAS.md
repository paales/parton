## Define-step constructor — SHIPPED 2026-04-28

The implicit access-pattern manifest, the per-Partial frame/CMS/
manifest ALS cells, and the `<Partial>` JSX wrapper are all gone.
The new primitive is `ReactCms.partial(Render, options)` — a
module-scope constructor that returns a placeable React component.
Every dependency a spec has on the request, route, or CMS lives in
a single sync `vary` callback whose result is also the cache-key
surface. See [`docs/partial.md`](../docs/partial.md) and the
design rationale in [`partial-define-step-api.md`](./partial-define-step-api.md).

What landed:

- `<Partial>` + tracked accessors (`getCookie`, `getSearchParam`,
  `getPathname`, `getHeader`, `getText`, …) → deleted. ~1,200 lines
  of manifest / cell / hoisting machinery removed.
- `ReactCms.partial(Render, options)` constructor — pattern-as-router
  via `match`, declarative deps via `vary`, sync CMS read surface
  inside `vary`, slot block + page spec dual mode.
- `registerBlock` removed — slot blocks self-register on
  construction when they declare `tags: [".x"]`.
- `<Children>` / `<Child>` slots take explicit `host` + `hostCmsId`
  props (no ambient cell read).
- `flight-runtime.ts` shim — runtime-aware Flight encode/decode that
  uses `@vitejs/plugin-rsc/rsc` in production (real client manifest)
  and the vendored bundles with stub manifests in test mode (so
  `cache.tsx`'s import doesn't leak `virtual:` URLs to Vitest's
  bare-Node loader).

Test status at landing: 18/18 unit tests + 109/127 e2e tests passing.
Remaining 9 e2e failures are concentrated in two design-gap areas:
(1) per-SKU dynamic Partials in the Magento demo (the old `<Partial
selector="#price-{sku}">` pattern doesn't fit the constructor model;
either restore via a different mechanism or rewrite the tests), and
(2) a navigation-api / chat-overlay frame interaction where silent
URL bumps from infinite-scroll pollute the chat-overlay frame's
session URL, breaking back-nav.

---

## Continuous streaming content — SHIPPED as bounded `<Piece>` + compaction (2026-04-22)

`user-ideas.md:35` asked how to implement AI-chat-style trickling content. Landed as a demo at `/chat-notes`: recursive `<Piece>` server component, each chunk its own Suspense reveal, `MAX_DEPTH` cap with a client-side `<ResumeTail>` firing a targeted refetch at the bound. Server re-renders as `<FlatPrefix>` (synchronous chunks `[0..cursor)`) + fresh depth-0 Piece chain. Durable per-message log decouples source production from client reconnects; cursor lives in the URL so reloads/back-forward resume correctly. See `STREAMING_CHAT.md` for the full write-up, including why SSE / unbounded recursion / multipart-redirect were passed over, and the two gotchas that turned into generalizable lessons (React fiber reuse across targeted refetches requires per-value `useEffect` guards, not booleans; `disableTransition: true` is load-bearing for per-chunk reveals).

---

## Borrowed-from-Inertia candidates (2026-04-16)

### Lazy partials — SHIPPED as `<Partial defer>` (2026-04-18)

`defer={true}` emits fallback only; app calls `useNavigation().reload({selector: "#id"})` whenever. `defer={<Activator/>}` wires a client-side trigger automatically. Companion hook `useActivate(partialId, subscribe)` is the primitive every activator is built on. See `DEFER_ACTIVATORS.md`.

### Refetch-trigger pattern — SHIPPED as `useActivate`

`<WhenVisible>` is one reference activator built on the `useActivate(partialId, subscribe)` hook. Adding a new trigger type (idle, event, mediaQuery) is ~30 lines against that contract. Reference activators (`<WhenVisible>`, `<WhenStored>`) live in userspace (`src/app/components/`) — the framework only ships `defer` + `useActivate`. The `<AnyOf>` wrapper and a subsequent array/fragment `DeferSpec` experiment were both removed on 2026-04-19: `defer` takes one element; composition is written as a bespoke activator when needed.

### Prefetch links

`<PartialPrefetch id="trivia" on="hover">` or `<Link prefetch>` for full-page nav. Fires a refetch on hover/mousedown intent, populates `_cache` so the real click/scroll-activation is instant. Short TTL (~30s) so stale hovered data doesn't sit around. Pairs naturally with `lazy` and `<WhenVisible>`.

### Rich refetch event hooks + per-partial progress

`useNavigation().reload()` returns a Promise that resolves on commit, and callers track pending state via their own `useState`. Inertia emits `start / progress / success / error / finish` on every visit. Adding an options bag (`reload({ selector }, { onSuccess, onError, onProgress })`) or an event emitter keyed per-partial would let apps build NProgress-style top bars, per-partial progress affordances, and analytics without forking the framework.

Deliberately skipped (Inertia has these, we don't need them): Deferred Props (Suspense is better), useForm (RSC actions cover it), stacked modals (too specific), full Visit API surface.

Also deliberately skipped (2026-04-19): an `await getLocalStorage('key')` / `getMousePosition()` DSL that would bail a server component's render on a client-state read and re-render when the value arrives. Sharp edges win over ergonomics: (1) hidden control flow — every `await` becomes a latent Partial boundary invisible at the call-site; (2) every read implicitly subscribes, adding a client→server subscription lifecycle the one-shot model doesn't have; (3) per-client cache keys break the `<Partial cache>` model (either explode the cache fleet or disable caching for anything reading client state); (4) SSR has no access to localStorage so every page ships the fallback first, causing a hydration-time flip; (5) streams of client state to the server re-rendering continuously (mouse position, websocket multiplayer) route client-owned data through a request/response abstraction that isn't shaped for it. The existing `<Partial defer={<WhenStored .../>}>` pattern already covers the consent-banner / hydration-dependent-content use case with the defer boundary *visible in the JSX* — that legibility is load-bearing for the "look at the tree and see the boundaries" design promise.

---

## State-preserving refetches — RESOLVED (2026-04-16 → 2026-04-17)

**Resolution:** bare-key + `startTransition` default. The old
`?revalidate=1` flag and `streamVersion` key stamping are gone. React
19.3 on a bare-key refetch reconciles in place AND streams per-chunk
(outside transitions), so the fresh-mount / revalidate split was
unnecessary. Full write-up: `LESSONS.md` §1–§3 and
`/archive/BARE_KEY_REFETCH.md`.

Open tail:

- **Instance-identity debugger.** `useRef(() => randomColor())`
  rendered as a small corner dot in dev builds. Dot color changes →
  component remounted. Turns "did my component just remount" from a
  guessing game into a glance. Still worth building; lives alongside
  the PartialDebugPanel status dots.

---

## Fingerprint-skip v2 (2026-04-17)

Navigations now use the fingerprint-compare already embedded in the
`?cached=id:fp,…` protocol: server renders the skipped partials as
`<i data-partial hidden key={id}/>` placeholders, client fills from
its `_cache`. Empirical win on `/pokemon/1 → /pokemon/1?search=url`:
~75 KB → ~34 KB (~55% smaller). Regression test in
`e2e/fingerprint-skip.spec.ts`.

Follow-ups worth considering:

1. **Widen the match.** Today the fingerprint is purely structural
   (component name + scalar props + recursion). Two refetches of
   `<Partial selector="#cart">` from different carts hash the same because
   they carry no discriminating prop. In practice that's fine because
   carts render via `getRequest()` context, not props — but it means
   the server still has to execute the partial to know the output
   differs. A **content fingerprint** (hash of the decoded Flight
   bytes) would let two matching _renders_ share cached bytes, but
   costs a render to compute. Probably not worth it unless we see
   "server re-rendering identical output repeatedly" in practice.

2. **Prune stale `_cache` entries — RESOLVED (2026-04-19).** After
   every streaming render, the client now collects the placeholder
   ids in the derived template and drops `_cache` entries whose id
   isn't in that set. `_fingerprints` is cleared in the same pass —
   every live id is re-registered by its `PartialErrorBoundary`
   during the subsequent React render (both top-level and deep
   inside cached ancestors). The old problem — an earlier
   `cache.clear()` was clobbering skipped placeholders — is avoided
   by pruning AFTER `cacheFromStreamingChildren` + `deriveTemplate`
   run, so placeholders emitted for fingerprint-match ids still find
   their cache entry. Regression cover:
   `e2e/cache-prune-across-nav.spec.ts`.

3. **Per-partial opt-out.** An author may want a partial that
   _always_ re-renders on nav regardless of fingerprint match
   (e.g., a server-time readout). Would need a prop on `<Partial>`
   like `alwaysFresh` (or its inverse `cacheOnNav`) plus a filter
   in the skip loop. Not needed yet, but predictable ask.

---

## Cache + dynamic Partials — RESOLVED (2026-04-17)

**Resolution:** `<Cache>` now uses strip-on-store + reinject-on-return.
The rendered tree has its partial-bearing subtrees replaced with `<i
data-partial>` placeholders before the bytes are stored; on hit, the
registry is consulted to splice live `<PartialBoundary>` elements
back into the decoded tree. Dynamic partials inside a cached region
stay live. See `SERVER_CACHE_NOTES.md · Follow-up · The fix: strip-
on-store + reinject-on-return` for the implementation notes.

Open tails:

1. **Double-render on miss — RESOLVED.** On cold miss
   `renderToReadableStream` runs once; `stream.tee()` splits it
   into a user branch (decoded immediately, streamed to the outer
   render) and a storage branch (buffered, re-stripped of dynamic
   wrappers, re-encoded, stored in the background). User-facing
   latency is not doubled; inner async work (GraphQL) still fires
   exactly once. CPU / memory overhead from the storage-side
   encode → decode → re-encode cycle remains, but runs off the
   critical path. See `renderMissAndStore` in `cache.tsx`.
2. **Post-HMR cold hit.** If the cache hit lands on a request after
   `clearRegistry()` (HMR, new process), `lookupPartial` returns
   nothing and reinject produces placeholders only. Today this is
   harmless in practice — the test harness clears both stores
   together via `/__test/clear-caches`, and real dev restarts flush
   both via the HMR listener. Worth keeping in mind if we ever add
   a cross-process cache backend (Redis).

---

## Stringly-typed ids — selector-based addressing — SHIPPED 2026-04-19, SUPERSEDED 2026-04-21

**Original resolution.** `<Partial>` accepts optional `id` and `tags` (as an array OR a whitespace-separated string, like DOM `className`). An id-less Partial synthesizes `__anon:<sorted-tags>` internally — addressable only via a tag selector. `usePartial(selector)` parsed one of four shapes:

- `"hero"` — bare string, by id (back-compat).
- `"#hero"` — by id (explicit).
- `".price"` — every Partial tagged `price`.
- `".price.featured"` — every Partial tagged both `price` AND `featured` (AND intersection).

**Superseded 2026-04-21 (first pass).** `usePartial` replaced by `useNavigation().reload({ ids })` / `{ tags }`.

**Superseded again 2026-04-21 (second pass — selector API).** The `id` + `tags` prop pair on `<Partial>` and the `{ ids, tags }` shape on `reload` / `navigate` / action `invalidate` are gone. Collapsed into one CSS-style `selector` prop / option: `#foo` unique (hard-enforced per page), `.foo` shared (unions on refetch). `reload({ selector: "#cart .price" })`. Union still applies; for intersection, give the intersection its own label. The "codegen union types" follow-up below is now ergonomic-only (catch `#`-tokens statically) — the grammar grew the prefix instead. See `SELECTOR_API.md`.

**Deferred from the original sketch:**

- **Attribute selectors (`.price[data-sku="ABC"]`).** Skipped — dynamic Partial families keep using explicit `#`-tokens (`#price-${sku}`) + a shared label. Attribute selectors would eliminate id-family plumbing entirely but require `data-*` attribute tracking in `PartialSnapshot`; saved for later if the pain shows up.
- **Codegen union types for selectors.** Cheap stepping-stone: scan for `selector="#…"` literals, emit `type PartialSelector = "#hero" | …`. Would catch typos at the call site. Template-literal-type variant covered in `SELECTOR_API.md` §Open questions.

**Growth vectors still open:**

- **Pseudo-selectors** (`.price:cached`, `.price:visible`) — not needed yet, but the `parseSelector` grammar has room.
- **Shared-token-first refetch policy** as the default DX for most invalidation flows — mostly a docs/convention call now that the runtime supports it.

---

## Framework direction — backlog (2026-04-19)

Captured from a design session that walked the full app + lib + framework surface and compared it against `user-ideas.md`. These are directions that are not yet in-flight anywhere; some overlap with user-ideas at a conceptual level but add a concrete shape.

### Request-scoped data loader / dedup

Two Partials that both call `client.request(ProductsQuery)` today each hit the API. There's no per-request memo. A `useLoader(key, fn)` primitive — or a DataLoader-style batcher for per-row fetches — would dedupe within one render and make dynamic Partials (price-per-sku) composable without N+1. This is the simpler, framework-level analogue of the GraphQL normalized cache in `user-ideas.md` §graphql-response-cache; worth shipping first because it's independent of the data layer.

### Optimistic updates as a Partial primitive

Server-action → invalidate is round-tripping. `<Partial optimistic={(prev, input) => next}>` would render the optimistic state immediately and reconcile on commit. The plumbing shape previously lived in the `__inputs` channel (removed 2026-04-21); reviving it as an OPTIMISTIC channel — scoped to the action-return lifecycle, not exposed for general prop injection — is a live design question. Pairs naturally with the form primitives below.

### Cache invalidation by manifest value

Today `<Cache>` entries can be invalidated by id or tag. The manifest store already records *which* cookies/headers/URL params each entry depends on (see `AUTO_TRACKED_CACHE_KEYS.md`). So `invalidateByManifest({ cookie: "user_id", value: "42" })` could walk the manifest store and drop every entry read under that cookie value. Missing third axis of invalidation; falls out nearly for free from the tracked-accessor design.

### Cross-tab sync via BroadcastChannel

When tab A runs a server action that invalidates `["cart"]`, tab B is stale. A BroadcastChannel propagating invalidation signals across same-origin tabs would make multi-tab behaviour correct by default. Strictly simpler than server-push realtime (no websocket infra) and probably what 90% of apps actually need.

### Re-defer / unmount policy

`DEFER_ACTIVATORS.md` §Known-sharp-edges flags this: once activated, a Partial can't go dormant again. Design space: `<Partial unmountWhen={<WhenHidden/>}>`, memory-pressure eviction, TTL after last interaction. Relevant for long-session CMS pages where hundreds of Partials accumulate.

### Form primitives on top of Partials

React 19 actions + `useFormState` + the existing `invalidate` directive can be unified into a `<PartialForm partial="cart" action={addToCart}>` primitive: action runs, returns new cart, partial re-renders, progressive enhancement works without JS. No new protocol — ergonomics on top of what `entry.rsc.tsx` §server-action-handling already implements.

### Speculation Rules API integration

Browsers now have native prerender/prefetch. A framework-level `<PartialPrefetch>` could emit `<script type="speculationrules">` for likely-next refetch URLs, getting hover-prefetch without JS. Complement to the existing hover-prefetch idea earlier in this doc (§Prefetch-links).

### Flash / toast return channel from server actions

Actions invalidate Partials; they could also `return { flash: "Added to cart" }`. A `<FlashPartial>` that subscribes to action return values and displays transient messages would let actions communicate outcomes without the app hand-wiring channels. Small but high-leverage for CMS authoring flows.

### Deployment-unit split / remote Partials

The strip-and-reinject mechanics in `cache.tsx` already support this: the outer cached bytes can come from anywhere as long as placeholders get reinjected on the way out. Framed this way, each Partial becomes independently deployable — one in a worker, one on origin, one from a CDN HTML fragment. This is probably where the "Remote rendered" idea in `user-ideas.md` naturally wants to land.

### Static export / SSG mode

A build step that renders a route at build time, marks the Partials that can't be prerendered (anything reading cookies/headers — the manifest already tells us), and emits an HTML shell plus stubs for the dynamic Partials. Astro-style "islands of dynamism in a static shell," strongly aligned with the "CMS" framing in the repo name.

---

## Operational concerns — not yet designed (2026-04-19)

Things the framework will need before it can host a real app. Flagged here so they don't get forgotten behind the more interesting primitive work.

- **Error recovery beyond `errorWith`.** `PartialErrorBoundary` exists but the design stops at "show a fallback and a retry button." Missing: typed errors, retry/backoff policies, circuit breakers, serve-stale-on-error (the SWR entry is still there — why not reuse it on transient errors?), error → observability hook.
- **Testing harness for Partials.** No primitive for unit-testing a single Partial with mocked request context. Would force `getRequest()` / `getCookie()` / etc. to be injectable (not just ambient) and pay large DX dividends.
- **Accessibility defaults for refetch.** `aria-busy` during pending, focus restoration policy across swaps, live-region announcements. Currently on the app; will be pile-of-ad-hoc in a year.
- **Per-Partial observability.** Trace context threaded through Partial boundaries so logs group automatically. Pairs with the debug-overlay idea in `user-ideas.md` §partial-debugging-component.
- **i18n as a Partial concern.** Locale switching that refetches only locale-sensitive Partials (`tags={["i18n"]}`). Locale as a first-class input alongside URL/cookie state.
- **CMS authoring mode.** Conspicuously absent given the repo name. Directions: draft/preview modes as a Partial property, author-editable regions identified by tag/selector, per-Partial publish workflows, edit-in-place overlays. If the framework's positioning is "CMS," this isn't optional — it's the core use case. **— DESIGN EXTRACTED 2026-04-25** into a dedicated doc family: `CMS_VISION.md` (the why + prior art), `CMS_MANIFEST.md` (data model — the insight is that the existing tracked-accessor manifest already dimensions configuration space), `CMS_EDITOR.md` (authoring UX — the debug panel expanded with forms + drag-drop, preview via `<Partial frame>` not iframe). Not yet shipped; see those docs for the current design.

---

## Meta principle — prefer runtime discovery to static analysis (2026-04-19)

Reading the architecture end-to-end, the framework is making two layered claims:

1. **Partials as addressable RSC subtrees** — solid, working, primitive is coherent.
2. **Runtime discovery over static analysis** — fully realized. Every architectural lessons doc (`LESSONS.md`, `LESSONS_FROM_REFACTOR.md`, `LESSONS_2026-04-19.md`) is about removing one more pre-walk, and as of 2026-04-19 the last one (`refreshRegistry`) is gone.

The second claim is the one that distinguishes this from Next.js App Router in the long run. Everything that reinstates a static walker (typed partial registries via codegen, explicit route manifests, declarative input schemas resolved at build time) works against it. When evaluating future directions, the test is: *can this self-register at render time instead of requiring a pre-render walk?* The selector addressing scheme above passes that test. Typed-handle codegen fails it. Keep that principle sharp — it's the architectural load-bearing idea and it's easy to erode one convenient walker at a time.

### How `refreshRegistry` was eliminated (2026-04-19, revised 2026-04-21)

The old walker refreshed registry snapshots before cache-mode refetches so their captured closures (e.g. `<SearchStage2 query={searchQuery}/>` where `searchQuery` came from the URL) reflected the current request. It existed because:

- `cloneElement(__inputs)` couldn't drill through a `<Cache dep>` wrapper to reach the inner content.
- The Partial's fingerprint was hashed from pre-override `children`, so even when `__inputs` did apply, the cache key stayed pinned to the stale snapshot's values → cache hit on stale bytes.

Two changes made the walker redundant in 2026-04-19:

1. `<Cache>` was folded into `<Partial cache>` (part of the auto-tracked cache-keys work), removing the intermediate wrapper. `cloneElement(__inputs)` reached the content component directly.
2. `<Partial>`'s fingerprint was computed AFTER `applyInputs` (`partial-component.tsx`). A cache-mode refetch whose inputs changed a prop yielded a distinct fingerprint, a distinct `<Cache>` key, and correctly missed stale entries.

**2026-04-21 revision.** `__inputs` and `applyInputs` are gone entirely. Stale-snapshot correctness is now driven by **ambient-frame-URL folding into the fingerprint**: the Partial body looks up `getCurrentFrameScope()` and folds the enclosing frame URL into its fp seed. A refetch that changes the frame URL (or the page URL, if the Partial is framed) produces a distinct fingerprint and Cache key without any client-supplied prop override. Request-varying state reaches descendant Partials through URL accessors (or scalar props threaded by a parent that reads the accessor); the `cloneElement(__inputs)` channel no longer exists. See `NAVIGATE_UNIFIED.md` for the replacement surface and `/archive/USE_PARTIAL_AND_INPUTS.md` for a historical summary.

With those in place, deleting `refreshRegistry` kept all unit tests and e2e tests passing. The PartialRoot now has exactly two branches (streaming + cache-mode) with no author-JSX walking in either; `stripPartials`/`reinject` in `cache.tsx` is the only remaining walker and it operates on rendered output, not on author JSX.

### Follow-up backlog

- **Unify the two PartialRoot branches** into one. With the walker gone, cache-mode exists only as an optimization (skip ancestor execution on a refetch by rendering directly from snapshots). An alternative: always stream, and have authors wrap expensive ancestors in `<Partial cache>`. The ergonomic trade-off is worth a design pass — the simplification would also let `PartialsClient` shed its `mode` prop.
- **Dynamic-partial-inside-cached-ancestor on partial refetch.** If a refetch targets a dynamic partial whose ancestor is wrapped in `<Partial cache>`, cache-mode pulls the dynamic partial's snapshot directly (works today). Under a unified always-streaming model the ancestor's Partial body would need to NOT skip when it contains a requested descendant — but that requires knowing topology ahead of render, i.e., a static walker. Likely the reason to keep cache-mode as the optimization path, even after the refresh walker is gone.

---

## Transient client state — the un-URL-able middle (2026-04-29)

The framework's load-bearing position is that **state lives in URLs**:
page URL for shareable, frame URL for subtree-scoped. Combined with
`vary` purity, this gives the strong promise that a Partial's render
is reproducible from its URL alone. The cost: there is no first-class
story for state that is **not yet authoritative** and **not appropriate
for a URL**. Today this falls on the floor between client components
(which can hold any state but can't influence a Partial's render) and
server actions (which only commit authoritative state).

The shape of the gap, with concrete failure cases:

1. **Drag-to-reorder with debounced save.** User drags item 5 above
   item 2 in a 50-item list; visual reorder must be instant, save
   debounced. The new ordering doesn't belong in a URL (you're not
   serializing a 50-item permutation in a query string), and `vary`
   has no client-state input. Best you can do today is a client-only
   visual layer that diverges from the server tree until the action
   commits — the very split-state the "one primitive" thesis wants
   to avoid.
2. **Multi-step form draft restoration.** User starts filling a long
   checkout / CMS authoring form, navigates away, comes back. Draft
   lives in `localStorage` (or wants to). Today the Partial that
   renders the form has no way to read that draft on the server; the
   form re-renders blank from server state, and a client effect has
   to repopulate. Hydration-time flip.
3. **Optimistic UI on a server-rendered region.** User clicks
   favorite; UI shows favorited instantly; server confirms. React's
   `useOptimistic` works inside a client component, but the
   surrounding Partial re-renders authoritatively from server state
   only after the action commits. The optimistic value is invisible
   to anything that renders through the Partial pipeline.
4. **Cross-tab leak via session-scoped frame URL.** Two tabs viewing
   the same app share the frame URL through the session cookie
   (`docs/frames-navigation.md` §Sharp-edges). Tab A opens a drawer,
   tab B's drawer also opens on next render. Already a known leak;
   a per-tab-id channel would fix it but that channel doesn't exist.

The deliberately-rejected design (`getLocalStorage()` /
`getMousePosition()` server-side accessors, see "Borrowed-from-Inertia
§Deliberately skipped", 2026-04-19) is still the right thing to reject:
implicit subscription, hidden control flow, per-client cache keys,
SSR fallback flips. Those critiques stand. The directions below try
to address the gap **without** reinstating that DSL.

### Direction A — Durable draft as a server entity (Partial reads it)

The CMS layer already has the precedent: `content.json` (published) +
`draft.json` (gitignored), with `lookupCmsNode(cmsId, request)`
checking draft first when `cms-draft=1` is set. Generalize that shape
to **app draft state**:

```tsx
const CheckoutForm = ReactCms.partial(CheckoutFormRender, {
  match: "/checkout",
  draft: { kind: "checkout", scope: "session" },   // new option
  vary: ({ request, draft }) => ({
    step: new URL(request.url).searchParams.get("step") ?? "shipping",
    values: draft.fields(),                         // sync read like cms.*
  }),
})
```

`draft.fields()` reads from a per-session draft store keyed by
`(sessionId, kind)`. A `useDraft()` hook in client code writes to the
same store via a narrow server action. The store is the single
authoritative place; the Partial reads it like it reads CMS fields;
the cache key derives correctly because the read appears in `vary`.

What this buys: zero new primitives, zero URL pollution, draft
restoration across reloads, multi-tab consistency (it's server state),
SSR works (no client state read at render time). The Partial re-renders
on every draft mutation because the action invalidates by selector.

What it costs: every keystroke in the form costs a server round-trip
to write the draft. Acceptable for checkout / CMS authoring; too heavy
for an autosave-on-every-keystroke text editor. For the heavy case,
client-side debouncing inside the `useDraft` hook brings round-trips
down to one-per-pause without changing the contract.

Open question: scope key. `session` cookie works for anonymous flows;
authenticated flows want the user id. Probably a `scope:
(req) => string` callback.

### Direction B — Optimistic overlay channel (one-shot, narrow)

The "no client→server prop-override channel" rule was about preventing
arbitrary client state from leaking into `vary`. A narrower channel —
**optimistic overlays attached to a specific in-flight server action**
— doesn't have the cache-key explosion problem because the overlay
exists only for the duration of the action's lifetime.

```tsx
// Client component inside a Partial render:
const [optimistic, addOptimistic] = useOptimistic(items)
function onReorder(next) {
  addOptimistic(next)
  reorderItemsAction(next)              // server action
}

// Server action returns a directive the framework already understands:
async function reorderItemsAction(next) {
  await db.saveOrder(next)
  return { invalidate: { selector: "#item-list" } }
}
```

Today this works for the client component itself but the Partial body
re-renders from authoritative state. Proposal: when an action is
in-flight against a Partial, the framework holds the previous render's
output and lets the Partial's *client* descendants read an optimistic
overlay via `useOptimisticPartial(partialId)`. On commit, the new
server render replaces both. No new server-side accessor; no `vary`
input from client state; the channel is one-shot per action.

This is roughly "Inertia visit progress events" + `useOptimistic`
glued together at the Partial boundary. Aligns with the
"Rich refetch event hooks" item earlier in this doc.

### Direction C — Per-tab session axis

The cross-tab leak (#4 above) and the "where does drag-reorder
intermediate state live" question (#1) both want the same thing: a
**per-tab** state cell the server can read sync. Today's session is
cookie-backed and shared across tabs.

A per-tab id stamped at first paint (e.g., a `sessionStorage`-backed
nonce sent in a header on every request) gives a third URL-like axis:

- Page URL — shareable, browser back/forward.
- Frame URL — subtree-scoped, browser back/forward.
- **Tab-scoped session** — per-tab transient state, no back/forward,
  not shareable, not URL-visible.

`vary` could read it: `vary: ({ tab }) => ({ draftOrder: tab.get("order") })`.
Client writes via `useTabState("order", value)` which posts to a
narrow framework action. This is closer to URL-discipline than
Direction B (still server-authoritative, still appears in `vary`,
still cache-keys correctly) but solves the multi-tab case Direction A
doesn't.

Risk: tab session becomes the dumping ground for "state I didn't
want to think about." A sharp constraint — values must be
JSON-serializable and under N bytes — keeps it honest.

### Direction D — `<PartialForm>` with first-class draft

Pull A + B together into a form-specific primitive:

```tsx
<PartialForm partial="#checkout" action={submitCheckout}
             draft={{ kind: "checkout", debounce: 500 }}>
  <Field name="email" />
  <Field name="address" />
</PartialForm>
```

Behaviour:
- Field values write to the server-side draft store (Direction A) on
  blur / debounce.
- `submitCheckout` runs against the draft + final field values.
- On in-flight submit, the optimistic-overlay channel (Direction B)
  holds the form's "submitting" state visible to client descendants.
- Cancel / abandon clears the draft.

Most of the unhappy paths in the four failure cases above collapse
into known-good behaviour: refresh restores the draft, multi-tab sees
the same draft, optimistic state is scoped to the submission, and
the partial's `vary` appears in cache keys.

### What to NOT build

- A server-side `getLocalStorage()` / `getClientState()` accessor.
  The 2026-04-19 critique still applies: hidden control flow, every
  read is a subscription, cache-key explosion, SSR fallback flips.
- Implicit synchronization of arbitrary client state into `vary`.
  The whole point of `vary` purity is that the cache key is
  predictable; admitting any client value defeats it.
- A "Partial-aware Redux." If the answer is a global store with
  selectors, we're rebuilding what RSC was supposed to delete.

### Decision the framework still owes

Pick one of A / B / C / D as the *opinionated* path, document the
others as escape hatches, and ship it before anyone tries to build a
real form on this. Today the docs are silent on transient state;
that silence will turn into a pile of bespoke client-side workarounds
that are hard to reverse later. The CMS draft pattern (Direction A
generalized) is the most architecturally consistent — it reuses the
existing draft/published cascade and stays inside the
"vary purity + URL-discipline" frame — and is probably the right
default. B and C are additive on top.

---

## Critique inventory — open issues with priority (2026-04-29)

Captured from a critical review session against Next.js / Remix.
Items already conceded in conversation are folded in for completeness
so future work has a single ranked list. Priority legend:

- **P0** — silent correctness failure. Fix before any adoption.
- **P1** — production blocker. Must address for non-research deployment.
- **P2** — ergonomic / scaling pain. Will hurt as the project grows.
- **P3** — future polish or out-of-scope today.

### P0 — correctness

- **djb2-32-bit hash for fingerprints + cache keys + variant keys.**
  `src/lib/hash.ts`, used at `cache.tsx:464`, `partial.tsx:348`,
  `partial-registry.ts:84`. Birthday-paradox collisions appear ~65k
  distinct values. A *fingerprint* collision is a correctness bug:
  client paints a stale `_cache` subtree as fresh because two
  unrelated renders happen to share an fp. Variant-key collision in
  the registry → cache-mode reconstructs the wrong snapshot →
  wrong subtree rendered. Fix: xxhash64 / murmur3-128 over
  `stable-stringify` output. Cheap; not yet wired.
- **`stable-stringify.ts` correctness for hash inputs.** 17 lines,
  ad-hoc. If it doesn't normalize Dates, Sets, Maps, `undefined`,
  `+0`/`-0`, Symbol-keyed properties, NaN consistently, two equal
  vary results may hash differently (spurious miss) or two different
  vary results may hash equal (wrong cached output). Replace with
  `safe-stable-stringify` or equivalent and add property-based
  tests on the canonicalization.
- **In-memory state breaks horizontal scale.** Sessions
  (`session.ts:61`), render cache (`cache.tsx:55`), partial registry
  (`partial-registry.ts:73`) are module-global Maps. Two server
  instances → `__frame_sid` cookie points to memory that doesn't
  exist on the other → frame URLs randomly disappear depending on
  which instance routes the request. The "session is the source of
  truth for what scene the user is looking at" claim collapses
  under any HA deploy. Need a real `SessionStore` interface +
  Redis/KV backend before claiming production-readiness.
- **CMS cache invalidation across processes is unsound.**
  `cms-storage.ts:113` uses `Date.now()` as the mtime tag in the
  async path. Per-process parsed-store cache. Two writers → lost
  writes; one writer + N readers → stale cache for arbitrary time
  on the readers. The right answer is a real database, not "atomic
  rename + per-process cache."

### P1 — production blockers

- **No auth / principal / CSRF model.** `entry.rsc.tsx:97` decodes and
  executes server actions with zero identity check. CMS write
  actions (`editor/actions.ts`) are unauthenticated by default.
  Adopters must wire auth into every action by hand and there's no
  CSRF protection on the RSC action endpoint. Need a documented
  pattern + framework hook (e.g. `partial({ auth: requireRole(...) })`).
- **Default CMS storage is a JSON file committed to git.** Fine for
  the demo; unworkable for a real CMS (merge conflicts on every
  edit, no row-level auth, no concurrent-author safety, deploy-on-
  content-change). `setCmsStorage()` swap point exists but no real
  backend ships. The repo is *named* "react-cms"; this is the
  primary use case and it isn't covered.
- **No metadata / SEO API.** `<title>`s rendered inline inside
  spec render functions (`pokemon.tsx:567`). No Open Graph helpers,
  no canonical URLs, no robots, no structured data. Conspicuous
  absence for a CMS framework where content IS the SEO target.
  Design space: a `head` option on `partial()` that contributes to
  a per-request `<head>` collector, deduped by tag/key.
- **No request-scoped data dedup.** Two specs that load the same
  product fire two requests. Compare Next's `cache(fn)` and Remix's
  loader composition. Workaround today: hand-roll a request-scoped
  Map. Belongs in the framework.
- **No observability hooks.** No per-spec timing, no slow-spec
  warnings, no trace context propagation across Partial boundaries,
  no cache hit/miss metrics. Production teams need this on day one
  to find the spec adding 800ms per page. Pairs with the
  per-Partial trace context idea in §Operational concerns.
- **No deploy story.** `@vitejs/plugin-rsc` is experimental; no
  edge runtime adapter, no ISR, no static export despite the
  project name. The flight-runtime shim (`flight-runtime.ts`)
  imports vendored React-Server-DOM bundles directly from
  plugin-rsc's vendor path — if plugin-rsc moves the path, the
  framework breaks. Need either an abstraction over the Flight
  runtime or a commitment to a stable upstream.

### P2 — ergonomic / scaling pain

- **Selector tokens are a global flat namespace** (conceded
  2026-04-29). `partial.tsx:367` throws on collision at render time;
  fine for a demo, hostile for a multi-team codebase. Move to
  module-scoped or path-scoped selector resolution. The
  `makeSearchArea` factory at `pokemon.tsx:194` already has to
  hand-disambiguate `#page-stage-1` vs `#frame-stage-1`; scoped
  selectors would let the same internal name be reused across
  factory invocations.
- **Pattern-as-router doesn't compose hierarchically** (conceded
  2026-04-29). Every spec on `/pokemon/:id` repeats the match and
  re-validates `params.id` (`pokemon.tsx:357,398,444,488`). Fix:
  ship `<PartialMatch>` (first-match-wins page-level container
  with 404 fallback) so child specs inherit the matched scope
  without re-declaring it. **— SHIPPED 2026-04-29** as
  `src/lib/partial-match.tsx` exporting `<PartialMatch>` +
  `<Match>`. First-match-wins routing, fallback on miss, ambient
  match-params injected into descendant spec components via a
  JSX-tree walk (cloneElement + `__ambientMatchParams` prop —
  `react-server` doesn't export `createContext`, ALS scope exits
  before render descends, so element-walk is the only option that
  survives RSC's render boundary). Documented in `docs/partial.md`
  §Page-level routing. Demo migration deferred — opt-in for new
  pages, existing per-spec `match` keeps working unchanged. Walker
  limitation: doesn't traverse user-defined function components,
  so deeply-nested specs need explicit prop threading.
- **Auto-derived selector + STRIP_SUFFIXES list is fragile.**
  `partial.tsx:160` strips a hardcoded suffix list; renaming
  `PokemonHeroRender` → `HeroRender` silently flips `#pokemon-hero`
  to `#hero`. Production minification mangles `Render.name`
  entirely. The escape hatch (`selector:` explicit) works but the
  default path is a footgun. Fix: require explicit `selector` in
  production builds, or freeze the auto-derive at module load
  before minification (Babel/Vite plugin that stamps `displayName`).
- **Pattern params are stringly-typed.** `params.id: string` has
  no compile-time link to the `/pokemon/:id` pattern. Five copies
  of `if (!idStr || !/^\d+$/.test(idStr)) return null` in
  `pokemon.tsx`. Codegen typed-params from the pattern (Next-style)
  or a runtime schema validator (`vary: ({ params: { id } }) =>
  ({ pokemonId: int(id) })`).
- **Module-graph eagerness on the server** (partially conceded
  2026-04-29). `app/root.tsx` static-imports every page module;
  RSC's native code-splitting is at `'use client'` boundaries, not
  route boundaries. Fine for current scale; matters for serverless
  cold-start at large catalogs. Pairs with the `<PartialMatch>`
  hierarchy work — once routes have explicit hierarchy, lazy-import
  page modules behind the match boundary.
- **`partial-client.tsx` is 1752 lines in one file.** Cohesion is
  real but the file accumulates lazy resolution, key-collision-in-
  `.map()`, snapshot reinjection, fingerprint registration, frame-
  name context, Suspense-wrapper detection. Will resist refactor
  the longer it grows. Carve into: `merge.ts` (template + cache
  diff), `nav.ts` (navigation API surface), `wrappers.ts`
  (Suspense / boundary detection helpers).
- **Constructor has two API faces with one signature.** Slot blocks
  use `{tags, type}`; page specs use `{selector, match}`.
  Constructor branches on `tags != null` (`partial.tsx:554`).
  Either two named constructors (`ReactCms.partial(...)` /
  `ReactCms.block(...)`) or a discriminated options type that
  forces the choice up-front.
- **HMR nukes every cache on every edit.** `cache.tsx:584` and
  `entry.rsc.tsx:33`. Dev iteration gets slower the more partials
  you have — the gradient is exactly backwards. Granular HMR-
  invalidation by spec id (only specs whose source module changed
  evict their cache entries) is the right shape.
- **Children pass-through naming overlap.**
  `PartialComponentProps.children` (JSX wrapper pattern) vs
  `<Children name="body">` (CMS slot iteration). Same word, two
  unrelated mechanisms. Rename the slot primitive (`<SlotChildren>`,
  `<Slot>`) before the docs surface ossifies.

### P3 — future polish

- **Frame URL appears in every shareable page URL**
  (`?__frame=...&__frameUrl=...`). Privacy mostly OK (closed
  drawer), occasionally surprising (open-with-content state). At
  minimum, doc a recommendation; ideally collapse the param to a
  short opaque token resolved server-side.
- **i18n as a first-class concern.** Already in
  §Operational-concerns. Locale routing, locale as a vary axis,
  translation function. Required for "CMS" framing.
- **a11y of selector-targeted reload.** Already in
  §Operational-concerns. Focus restoration policy, `aria-busy`
  during pending, live-region announcements.
- **ALS-spine fragility.** `runWithRequestAsync` is the request
  context spine; userspace code that captures Promises into
  module-level variables can resolve under the wrong request's
  ALS context. Class-of-bugs that comes with the territory; doc
  it loudly in `docs-dev/server-isolation.md`.
- **Bundle eagerness for serverless cold-start.** See P2 module-
  graph entry; same root cause, different symptom — a 200-page
  app pays full module-init on every cold container boot.

### Withdrawn / not-a-bug

- **"Cache strip-and-reinject is expensive."** Withdrawn 2026-04-29;
  local measurement is <5ms. Worth benchmarking under large
  product-grid subtrees before re-raising.
- **"The big incumbents are funded."** Withdrawn 2026-04-29;
  stage-of-project, not value-prop.

### Suggested sequencing

1. **P0 sweep first** — they're all small, mostly mechanical, and
   each one is a silent-failure mode. Ship before any external
   adoption.
2. **`<PartialMatch>` + scoped selectors** — unblocks the biggest
   ergonomic complaints from the review (P2 conceded items) with
   a single coherent design pass.
3. **P1 auth + storage + metadata** — the three things every
   real adopter would have to build themselves on day one.
   Picking opinionated defaults (NextAuth-style adapter, Postgres
   default backend, head-collector hook) lowers the integration
   tax dramatically.
4. **P1 observability** — one OpenTelemetry tracer hook around
   each Partial render goes a long way; can land alongside the
   debug overlay work.
5. **Everything else** opportunistically.
