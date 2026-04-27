# Render pipeline

End-to-end mechanics from request to rendered HTML / Flight bytes.
The pipeline has three render modes — streaming, cache, registry-miss
bailout — picked by `PartialRoot` from the request URL.

## Request entry

`src/framework/entry.rsc.tsx` exports a `default { fetch: handler }`
that the Vite plugin wires as the RSC handler. For every request:

1. Dev-only `/__test/clear-caches` short-circuit. Reads
   `x-test-scope` and clears that scope's buckets (or `?all=1` wipes
   every scope). Always clears the on-disk draft file.
2. `parseRenderRequest(request)` — classifies the request as
   HTML / RSC / action.
3. `warmCmsCache()` — async re-read of `content.json` + `draft.json`
   so the synchronous accessors inside Partial bodies hit a hot
   cache.
4. `runWithRequestAsync(request, () => handleRequest(...))` — opens
   the per-request ALS store. Set-Cookie accumulates inside the
   store; cookies are appended to the response after.

`handleRequest` runs server actions when present, then renders
`<Root />` to a Flight stream. The HTML path tees the stream and
hands one branch to `entry.ssr.tsx::renderHTML` for SSR + RSC-payload
injection; the RSC path returns the stream directly with content-type
`text/x-component`.

## Action handling

When `renderRequest.isAction === true`:

- The action is loaded by id (`loadServerAction`), called with the
  decoded reply, return value captured in `RscPayload.returnValue`.
- The handler inspects the return value for an `invalidate` (or alias
  `revalidate`) directive:
  ```ts
  return { invalidate: { selector: "#cart .price" } };
  ```
- Selector tokens are split into `#`-tokens and `.`-tokens. The
  request URL is mutated:
  - `?partials=` gains the `#`-token names.
  - `?tags=` gains the `.`-token names. Also fires
    `invalidateByTags` so the per-query response cache drops matching
    entries.
  - If `?cached=` is absent (client cache empty — first visit, post-
    action), `?__populateCache=1` is set so streaming mode runs the
    whole tree fresh to refill the client.
- `setRequest()` updates the ALS request so `getRequest().url`
  reflects the new params downstream.

The action handler doesn't reach into client state. The directive
travels in-band through the existing partial-refetch protocol.

## `PartialRoot` decision

`src/lib/partial.tsx` is the orchestrator. It parses the request,
seeds `PartialRequestState` on ALS, picks a mode.

```
parseCsvTokens(?partials=) ──┐
parseCsvTokens(?tags=)    ───┤
parseCachedFingerprints(  ───┤
  ?cached=)                  │
?__populateCache             │
?__frame / ?__frameUrl ─→ writeSession                 │
                              ▼
                    resolveSelectorToIds(route)
                              │
                       ┌──────┴───────┐
                       │              │
              null/no-match       has matches
                       │              │
              registry-miss?      cache mode
                       │
                streaming mode
```

Order of operations inside the handler:

1. **Frame session writes.** Every `?__frame=path&__frameUrl=…` pair
   writes into the in-memory session before any framed Partial
   renders, so `resolveFrameRequest` sees the new URL.
2. **Selector resolution.** `resolveSelectorToIds(uniqueParam,
   sharedParam, route)` does a 3-pass scan:
   - direct effective-id lookup against the registry
   - scan for `#`-token matches not caught by direct lookup
   - scan for `.`-token (shared) matches
   Returns the union or `null`.
3. **`explicitIds` seeding.** Every requested `#`-token name AND
   every resolved id lands in `state.explicitIds`. These are never
   skipped on fingerprint match.
4. **Registry-miss check.** `state.isPartialRefetch && hasGlobalFilter
   && !combinedRequestedIds` is the trivial miss; otherwise scan
   `?partials=` token names against snapshots' `uniqueTokens`. Any
   missing `#`-token flips `registryMiss`.
5. **Mode dispatch.**

## Streaming mode

```ts
if (!state.isPartialRefetch || registryMiss) {
  clearRoute(route);
  enterPartialState({...state, requestedIds: null, isPartialRefetch: false});
  return <PartialsClient mode="streaming">{children}</PartialsClient>;
}
```

- **`clearRoute(route)`** moves the route's current snapshots into
  the previous-render slot, then empties the current slot. Stale
  ids that no longer appear on this request can't leak into future
  tag/id lookups; the previous-render map remains queryable for the
  duration of the render (descendant-manifest fold reads it).
- The full tree runs. Every `<Partial>` body executes:
  - Validates `parent`. Throws if missing.
  - Parses selector, resolves effective id, enforces `#`-token
    page-wide uniqueness via `state.seenUniqueTokens`.
  - Pushes child context onto the per-request partial-context cell.
  - Mutates the CMS scope cell (or clears if no `cmsId`).
  - Resets the frame-scope cell from `parent.frameChain` (preserves
    own frame, restores ambient from session, or clears).
  - Computes `structuralFp` and `fp` (see Fingerprint below).
  - Decides skip via `state.cachedFingerprints.get(id) === fp`.
  - On skip: emits `<i hidden data-partial>` placeholder, registers
    the snapshot with the previous manifest carried forward.
  - On render: wraps in Suspense (if fallback) + PartialErrorBoundary
    + PartialBoundary; the boundary registers the snapshot during
    React's pass.
- The client (`PartialsClient` mode="streaming") walks the rendered
  children: derives `_template`, populates `_cache`, populates
  `_fingerprints`, prunes stale ids transitively (BFS through cached
  wrappers).

## Cache mode

```ts
enterPartialState(state);
const wrappedChildren = activeIds
  .map(id => partialFromSnapshot(id, lookupPartial(route, id)))
  .filter(Boolean);
return createElement(PartialsClient, {mode: "cache"}, ...wrappedChildren);
```

- **`partialFromSnapshot`** reconstructs a `<Partial>` element from
  the registry entry: selector tokens become a string array (so
  whitespace-bearing names survive), `parent` is rebuilt from the
  stored `parentPath` + `framePath` (frameChain = framePath without
  the last segment, frameLocalName = last segment).
- The wrapped children render as **flat siblings** via positional
  `createElement` args (an array as children would force key
  enforcement on Partials whose intentional non-keys avoid Flight
  composite-key remounting).
- Each Partial body re-runs through the same code path as streaming
  — the registry snapshot's `content` becomes the body's `children`.
  Frame scope reopens, manifest re-runs against current request,
  fp recomputes. The body decides skip independently, just like
  streaming.
- **No server-side template.** The client uses its persisted
  `_template` from the most recent streaming render and merges the
  fresh wrappers in.
- **`_template` is reused.** A streaming render must precede the
  first cache-mode refetch on a route. Direct cache-mode entry on a
  cold client falls back to the registry-miss bailout because the
  client can't produce a template from a flat-sibling payload.

### What cache mode buys

Ancestor `<Partial>` bodies don't run. The producer of a 50-row list
(`async function ProductList() { ... return rows.map(...) }`) doesn't
re-execute when only one row's price refreshes — the snapshot for
`#price-<sku>` was registered the first time the list ran, and
`partialFromSnapshot` reconstructs it directly.

## Registry-miss bailout

A `#`-token in the filter that doesn't resolve flips back to
streaming. `clearRoute(route)`, full tree, snapshots repopulate.
Cosmetic cost only — the response body is the rendered tree, not a
narrowed payload. Fingerprint-match skips still apply per-Partial,
so unchanged subtrees still emit placeholders.

`.class` tokens never trigger the bailout — a tag union resolving to
a subset of known snapshots is by definition a valid union.

## Fingerprint computation

In `partial-component.tsx`, the body computes two hashes from the
same inputs:

| Input | Source | In `structuralFp` | In `fp` |
|---|---|---|---|
| Structural shape of `rawContent` | `fingerprintElement(node)` — types + scalar props + recursion | ✓ | ✓ |
| Own frame URL | `frame != null && frameRequest.url` | ✓ | ✓ |
| Ambient frame URL | `getCurrentFrameScope()` — when this Partial doesn't open its own frame | ✗ | ✓ |
| CMS contribution | `cmsFingerprintContribution(cmsId, request)` — resolved fields + recursive slot fields | ✓ | ✓ |
| Own manifest values | `resolveManifest(stored, request)` — previous render's tracked-accessor reads against current request | ✓ | ✓ |
| Descendant manifest fold | `walkRegistry + walkJsx` for descendants of this id | ✓ | ✓ |

`structuralFp` is what `<Cache>` keys on. Excluding ambient frame
URL keeps cache keys stable across full vs. cache-mode renders
(which differ in whether the per-request frame cell is populated).
A self-framing Partial has `ambientFrameKey === ""` by construction
so `fp === structuralFp` in that case.

`fp` is what the client skip handshake uses. Ambient changes must
invalidate.

### Descendant manifest fold

```ts
function computeDescendantManifestKey(ownId, ownFrameChain, rawContent) {
  const contributions = new Map<string, string>();
  walkJsxForDescendantManifest(rawContent, ownFrameChain, contributions);
  walkRegistryForDescendantManifest(ownId, ownFrameChain, contributions);
  // ...sorted, joined
}
```

Two walks, deduped by descendant effective id:

1. **Static JSX walk** of `rawContent` — finds `<Partial>` elements
   directly visible in children JSX. Looks up each one's previous-
   render snapshot; resolves its manifest against the descendant's
   own effective request (own frame, ambient via session, or page).
2. **Previous-render registry walk** — finds snapshots whose
   `parentPath` includes `ownId`. Catches dynamic Partials produced
   inside opaque async components when the author threaded `parent=
   {capturePartialContext()}`.

Why fold descendants: fp-skip at an ancestor short-circuits
descendant rendering. Without the fold, an ancestor whose own JSX
is unchanged emits a placeholder, the client reuses the cached
subtree, and a descendant whose URL dep changed never re-renders.

Over-folding bias: a snapshot from a Partial that no longer exists
under this ancestor still contributes until the next render swaps
in a fresh "previous" map. Extra re-renders, never stale subtrees.

## Client commit paths

`entry.browser.tsx::fetchRscPayload` chooses between two setState
calls:

| Path | When | React behavior |
|---|---|---|
| `setPayload` (default) | `disableTransition` flag absent | Wraps in `startTransition`. React holds current UI visible until all pending children resolve, atomic-swaps. No fallback flash. |
| `setPayloadRaw` | `?disableTransition=1` set on the URL | Plain setState. Suspense fallbacks visible for pending children; Flight chunks commit as they arrive. |

Use `disableTransition: true` for per-row progressive streaming or
for concurrent refetches across disjoint ids that should each
commit on arrival. Default for everything else.

## Browser traverse handler

`entry.browser.tsx::listenNavigation` intercepts `navigate` events
and dispatches refetches. Three cases:

1. **Framework-silent info** (window-silent or frame-internal): call
   `event.intercept({ focusReset: "manual" })` with no handler — the
   browser registers the navigation as same-document but doesn't run
   our refetch.
2. **Browser back/forward (`navigationType: "traverse"`)**: diff the
   destination's `__frames` snapshot vs. current. URL changed → full
   refetch with `__frame`/`__frameUrl` pairs appended for each
   differing frame. URL unchanged + frames differ → per-frame
   `_dispatchFrameRefetch` calls in parallel.
3. **Default (link click, programmatic nav)**: `event.intercept({
   handler: () => onNavigation(destinationUrl) })` runs the standard
   refetch.

`focusReset: "manual"` opts out of the default post-commit focus
reset to `<body>`. Without it, an input driving a live refetch
(search-as-you-type into a frame URL, etc.) loses focus on every
keystroke.
