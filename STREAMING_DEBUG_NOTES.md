# Partials streaming investigation — findings

## The goal
Partial refetches (via `usePartial(...).refetch()` or similar) must **progressively stream** Suspense boundaries on the client, like the initial SSR does. Today: stage-1 (0ms), stage-2 (1s), stage-3 (2s) server-side delays must reveal progressively on refetch, not batch at ~2s.

## Confirmed facts

### 1. The server already streams cache-mode correctly
`curl` on the exact partial-refetch URL used by the pokemon test:
```
first_byte=0.003s  total=2.13s  size=59KB
```
Root arrives in ~3ms with `$Y` lazy refs for pending Suspense subtrees. Stage-3's chunk arrives at ~2218ms server-time. **The Flight stream is fine.** The problem is 100% client-side.

### 2. Streaming mode works; cache mode doesn't
- `/bare` full refetch (streaming mode) → progressive reveal ✓ (stage2 fallback at 24ms → content at 1021ms; stage3 content at 2021ms)
- `/bare` with `?partials=bare/stage-1,stage-2,stage-3` (cache mode) → all stages content at 4ms, no fallback, no progressive reveal ✗
- Pokemon `usePartial` refetch (cache mode) → same failure mode

So the broken path is specifically `PartialsClient` in `mode === "cache"`, which renders `renderTemplate(template, cache)`.

### 3. Rendering `{children}` directly instead of `renderTemplate(...)` **fixes streaming in cache mode**
Tested by replacing the cache-mode return with `return <...>{children}</...>`. Pokemon test then shows:
- Stage 2: fallback at 21ms → resolved at 1219ms
- Stage 3: fallback at 21ms → resolved at 2241ms
- Gap stage2→stage3: 1022ms ✓

So the elements in the `children` prop are fine — they remount via version-stamped Suspense keys and suspend properly. Something in `renderTemplate` breaks this.

### 4. The rendered-tree shapes are identical
I dumped both trees with a `describe()` helper. `CHILDREN` and `TREE` produce the **same string** (same element types, same keys, same lazy-ref `{object}` children). Yet React's reconciler treats them differently.

### 5. `patchNested` is the culprit
Skipping `patchNested` and pushing the cached element directly fixes streaming:
```ts
// BEFORE: result.push(patchNested(cached, cache));
// AFTER:  result.push(cached);
```
With this change, pokemon test passes: fallbacks at 25ms, stage2 at 1204ms, stage3 at 2128ms, gap 924ms ✓.

### 6. Even a "no-op" patchNested breaks things
With the visited-set seed fix I added (`new Set([id])`), patchNested walks the cached Suspense, finds no substitutions to make, and returns the original node via `return changed ? cloneElement(...) : node`. Since `changed === false` it returns the **exact same reference**. But the test still fails.

**Something about calling `patchNested` on the cached element breaks React's ability to detect the Suspense as a fresh mount**, even when patchNested returns the same reference.

### 7. CONFIRMED: `Children.forEach` on lazy-ref children is the culprit
Isolation test: kept `result.push(cached)` (same identity that works), but inserted a bare:
```ts
const kids = (cached.props as any).children;
if (kids != null) Children.forEach(kids, () => {});
```
before the push. The callback does nothing. The push is the same element.

Result: **streaming breaks**. `Stage 2 fallback: undefined, Stage 3 fallback: undefined` — fallbacks never appeared, exactly the "no remount" symptom.

So the mechanism is: merely iterating `Children.forEach` over a Suspense element's lazy-ref children is enough to make React treat them as already-resolved on the next commit. The iteration has a side effect on the RSC lazy-ref payload.

**Hypothesis:** `@vitejs/plugin-rsc` models lazy refs as thenables (or React.lazy-wrapped) with mutable state. `Children.forEach` may touch `.type`/`.props` getters that trigger resolution, or cache the resolved children on the element, so by the time React reconciles the tree the lazy ref is already "hot" and there is no pending suspension to fallback on.

### 8. Narrowing: React.Children.* helpers break, manual array iteration is fine

Four isolation tests, all pushing the same cached element reference:

| Between access and push                               | Streaming |
|-------------------------------------------------------|-----------|
| nothing                                               | ✓ works   |
| `const kids = cached.props.children; void kids;`      | ✓ works   |
| `Children.forEach(kids, () => {})`                    | ✗ breaks  |
| `Children.count(kids)`                                | ✗ breaks  |
| `for (let i = 0; i < kids.length; i++) void kids[i];` | ✓ works   |

Diagnosis: property access alone is safe. Manual for-loop indexing is safe. Only `React.Children.*` helpers trigger the break. They share the internal `mapIntoArray` → `traverseAllChildren` path, which per-child checks `$$typeof` and recurses into fragments/arrays.

**Working hypothesis:** `@vitejs/plugin-rsc`'s RSC lazy refs are not plain React elements. Each lazy ref likely has a `$$typeof` marker (e.g. `REACT_LAZY_TYPE` or a custom RSC thenable) and carries internal mutable state. `traverseAllChildren` reads `$$typeof` and maybe `key` on each child; for lazy refs that read could trigger a getter that kicks off resolution (or flips a "consumed" flag). Manual `kids[i]` doesn't invoke that getter.

**Implication for fix:** `patchNested` was built on `Children.forEach` to recursively walk the template. It can be rewritten using manual iteration (`Array.isArray` + for-loop, direct `cloneElement`) to avoid touching lazy refs at all while still substituting nested partials. That preserves the nested-partial feature *and* keeps streaming working.

### 9. Final fix: delete `patchNested` outright

Re-examined the architecture: top-level partials live as *siblings* in the template, not nested inside each other's cached content. Nested `<Partials>` instances (e.g., `layout` → `pokemon`) each run their own `PartialsClient` with their own `renderTemplate`, so every placeholder substitution happens at the top level of *some* instance's template. There is no case where a cached parent's own `children` subtree contains a sibling's placeholder that needs substituting — because `collectPartials` extracts those as their own top-level cache entries and `buildTemplate` puts the placeholder at the top level of the template, not buried inside another partial's children.

So `patchNested` was solving a case that doesn't actually exist. Deleting it.

`renderTemplate` now:
1. `Children.forEach` over the **template** (always plain elements from `buildTemplate`, never contains lazy refs — safe).
2. Recurses into structural wrappers (`html`/`body`/`main`/etc.) which also contain only template elements.
3. On a placeholder `<i data-partial>`, `cache.get(id)` and push the cached Suspense **as-is** — no traversal, no cloneElement.

Result: pokemon streaming test and all 6 playwright specs pass. 160/160 unit tests pass. Cache-mode refetches now stream progressively (stage 2 at ~1200ms, stage 3 at ~2100ms, gap ~900ms).

## What the architecture actually does (ground truth)

### Two render modes in `partial.tsx`
```
if (!isPartialRefetch || populateCache) {
  // STREAMING mode — returns transformForStreaming(children)
} else {
  // CACHE mode — returns renderTemplate(template, cache) from PartialsClient
}
```
- `isPartialRefetch = hasGlobalFilter || populateCache` — any `?partials=` or `?tags=` triggers cache mode.
- Full navigation (no filter) → streaming mode.
- `__populateCache` forces streaming mode even with a filter, to repopulate the empty client cache after a streaming render.

### The version stamp
Added `streamVersion = \`${n ?? ""}-${Date.now()}\`` per request. Used as Suspense key suffix: `key={`${child.key}#${version}`}`. This forces React to see new Suspense boundaries as fresh mounts on each refetch, so they show their fallback and reveal content as lazy refs resolve.

Streaming mode bakes the version into Suspense via `transformForStreaming(...)`.
Cache mode bakes it into `wrappedChildren` before passing to `<PartialsClient>`.

### Cache key normalization
`PartialsClient` cache is keyed by **bare partial id** (e.g. `"stage-1"`), not the versioned key. I strip the `#...` suffix before `cache.set`:
```ts
const partialId = hashIdx >= 0 ? rawKey.slice(0, hashIdx) : rawKey;
cache.set(partialId, child);
```
This is needed because `renderTemplate` looks up placeholders by bare id (the template's `<i key="stage-1" hidden data-partial/>` placeholders never had a version suffix).

### The bug I hit and partially fixed
Once cache keys are bare ids, `patchNested` starts substituting wrongly. The cached Suspense for partial "stage-1" contains an inner `<SearchStage1 key="stage-1">`. patchNested walks `cached.props.children`, sees a keyed child with key "stage-1", looks up `cache.get("stage-1")`, and gets the outer Suspense itself → infinite self-wrapping (limited to 1 level by `visited`).

I fixed that by seeding the visited set with the partial's id:
```ts
result.push(patchNested(cached, cache, new Set([id])));
```
This stops the self-substitution, and the rendered tree now matches `children` in shape. But it **still doesn't stream**. That's the residual mystery.

## The simple workaround that actually works

Skip `patchNested` for cache-filled placeholders:
```ts
if (cached) {
  result.push(cached);
}
```

This is what's in the file right now, and the pokemon streaming test passes with it. **I have not run the full test suite with this change** — the user interrupted me before I could do that.

### Risk of skipping patchNested
`patchNested` exists to substitute nested partials inside cached parents. E.g. if `<Header>` is cached and `<Cart>` (nested inside Header) has a newer cache entry, patchNested swaps the nested Cart.

But: `collectPartials` extracts nested partials into their own top-level cache entries, and `stripNested` replaces them in the parent with placeholders. So a cached Header's tree contains `<i key="cart" hidden/>` placeholders, not stale Cart markup. `patchNested` was swapping those placeholders with fresh Cart content.

**Skipping patchNested will break nested-partial updates** where a parent is served from cache and a nested child has a newer cache entry. This isn't exercised by the pokemon or bare tests (their partials are all leaves).

The real fix needs to either:
1. Keep patchNested for deeply-nested placeholders but skip it when the cached element is itself Suspense-wrapped, OR
2. Stop wrapping cache-mode partials in `<Suspense>` client-side — wrap them in `buildTemplate` output itself, so the cached content IS the raw partial without an outer Suspense, OR
3. Figure out why a reference-preserving patchNested still disturbs Suspense remount.

## Loose ends (what I was about to do when interrupted)

- Run full playwright suite to verify the skip-patchNested fix doesn't break other tests (bare-stream-cache, debug-refetch, trace-partials, timing-test).
- Run unit tests (`yarn test`) — 160 were passing pre-change.
- Remove diagnostic logging I added:
  - `[partial] ${namespace} CHILDREN:` / `TREE:` dumps in `partial-client.tsx`
  - `[partial] ${namespace} cache render, freshKeys: ... types: ...` with type introspection
  - `[partial] ${namespace} streaming render, childKeys:` in the streaming branch
  - `[stream] fetch / resolved / payload flushed` in `entry.browser.tsx`

## Files currently modified vs. main

- `src/lib/partial.tsx` — adds `streamVersion`, version-stamped Suspense keys in both streaming (`transformForStreaming`) and cache (`wrappedChildren`) paths.
- `src/lib/partial-client.tsx` — cache.set uses bare partial id (strips version). Cache-mode render currently bypasses patchNested. Has diagnostic console.log instrumentation.
- `src/framework/entry.browser.tsx` — removed the old VOID→PAYLOAD two-phase flushSync; uses a single `flushSync(setPayloadRaw)` with timing logs.
- `e2e/search-streaming.spec.ts` — fixed test to set `started=true` and `t0` before typing (stage-1 has 0ms delay so there's no fallback flash to detect on it), and track fallback→content transitions for stages 2 and 3.

## Why this has been looping

The compaction happened with task #74 still "in progress" and a summary that claimed `/bare` already streamed progressively after the patch. That claim was misleading — `/bare` streams only in **streaming mode** (`refetch-full` button). Cache mode has always been broken, both in `/bare` and in pokemon. Every post-compaction iteration has been re-running tests and re-arriving at the same "fallback never appeared" failure without moving forward, because the real difference between streaming-mode and cache-mode (patchNested / renderTemplate) wasn't isolated until this session's final diagnostics.

---

## §10 Follow-up: first-keystroke bug (post-patchNested-deletion)

### The symptom
After fixing Children.forEach / patchNested (§7-9), a new bug surfaced on the pokemon search overlay:

1. Open `/pokemon/1?search=url` — only stage-1 is in the tree (stages 2/3 are gated behind `searchQuery`).
2. Type "p" — body blanks briefly, comes back with stage-1 filled, **but stages 2/3 never show** (not even fallbacks).
3. Type "o" — now body blanks, reappears with stage-1 + stage-2/3 fallbacks, then streams in.

Only keystroke #1 was broken. Keystroke #2 worked.

### Why
The dispatch is `usePartial("stage-1") + usePartial("stage-2") + usePartial("stage-3")`, batched into one refetch. The batch flush logic in `partial-client.tsx` had a branch:

```ts
if (cache.size === 0) {
  // First refetch after streaming render: cache is empty.
  // Request ALL known partials to populate cache.
  const allIds = [...fps.keys()].map((id) => `${prefix}${id}`);
  url.searchParams.set("partials", allIds.join(","));
} else {
  url.searchParams.set("partials", targetIds.join(","));
}
```

After the streaming-mode render, `cache.clear()` ran unconditionally (no cache population path existed), so `cache.size === 0` was **always true** after an SSR-like render. The branch then requested only what was in `fps.keys()` — and `fps` was populated from the **previous** render's fingerprints, which had only stage-1 (searchQuery was empty, so stages 2/3 weren't even in the JSX tree).

So the request became `?partials=pokemon/stage-1` instead of `?partials=pokemon/stage-1,pokemon/stage-2,pokemon/stage-3`. Server rendered: `searchQuery="p"` now puts stages 2/3 in the JSX; `collectPartials` finds all 3; filter keeps only stage-1 active; wrappedChildren has 1 fresh, template has 3 placeholders. Client cache is empty → placeholders 2/3 fill with nothing.

Keystroke #2 "works" because stage-1 was cached by that point → the else branch triggers → all 3 target IDs are requested.

### The fix
Populate the cache from the streaming render itself. New helper `cacheFromStreamingChildren` walks the server-transformed children tree:

- **Manual iteration only.** Arrays via `for (i; i < len; i++)`, objects via `node.props.children` direct access, `isValidElement` checks. Never `React.Children.*` — per §8 those trigger lazy-ref resolution and kill progressive streaming.
- **Stop at partial boundaries.** When a keyed element matches a freshId (after stripping `#version`), cache the wrapper element by bare partial id and return. Don't descend into its children — the contents may be RSC lazy-ref thenables.
- Called unconditionally in streaming mode, after `cache.clear()`, replacing whatever was there with wrappers from this render.

Result: on the first subsequent partial refetch, `cache.size > 0` (stage-1 was cached by SSR), so the flush falls through to the normal branch and requests the actual target IDs the user dispatched.

### What streaming mode now does with the cache
It doesn't *use* the cache (passthrough renders `children` directly). It just **populates** it as a side effect, so cache-mode's template-fill has something to look up next time.

### Trade-offs / known limits
- Only top-level partials are cached. If partial A is nested inside partial B (same namespace), the walker stops at B and never caches A. A subsequent cache-mode refetch targeting A alone would find B's cached wrapper but no entry for A — A's placeholder would fill with nothing. Not exercised by current tests; treat as a TODO if nested partials land.
- The cache is replaced (not merged) on every streaming render. If the shape of `children` shrinks between full navigations (a partial disappears), its cache entry is dropped. That's correct — otherwise stale partials would haunt future cache-mode renders.

---

## §11 Partial-mode vs URL-mode divergence

Pokemon search has two toggle variants:
- **URL mode** (`?search=url`) — `SearchInput` both updates `?q=` via `history.replaceState` **and** dispatches via `usePartial`.
- **Partial mode** (`?search=partial`) — dispatches only, never updates `?q=`.

After the §10 fix, URL mode streams correctly on every keystroke. **Partial mode still shows stage-1 only; stages 2/3 never appear.**

### Why
On a partial refetch, the server re-executes the page component. `PokemonPage` reads `searchQuery` from `url.searchParams.get("q")`. The JSX is:

```tsx
{searchQuery && <SearchStage2 key="stage-2" ... />}
{searchQuery && <SearchStage3 key="stage-3" ... />}
```

- URL mode: client updated `?q=p` before refetch → server sees `searchQuery="p"` → stages 2/3 are in the tree → `collectPartials` finds them → filter (explicit partials= or __inputs override) keeps them → they render.
- Partial mode: `?q=` is never set → server sees `searchQuery=""` → **stages 2/3 aren't in the JSX tree at all** → `collectPartials` never sees them → `resolvedInputs["stage-2"]` exists but the filter can't activate a partial that wasn't collected.

`__inputs` overrides an existing partial's props via `cloneElement`; it can't inject a partial that the JSX conditional hid.

### What this means for partial-mode as a design
`usePartial(id).refetch({ props })` only works if the partial's **element** exists in the current render — i.e., it must be rendered unconditionally (or conditional on state the server can see, not on the prop being passed). For stage-2/3 to work in partial mode, one of:

1. Render them unconditionally and let the component no-op when query is empty (`if (!query) return null;`), OR
2. Store search state somewhere the server can read on refetch (URL, cookie, header), so the conditional evaluates based on request state, OR
3. Teach `__inputs` to inject new partial entries — a larger architectural change.

Not fixed in this pass. The first-keystroke test documents the expected URL-mode behavior and the still-broken partial-mode behavior as an assertion.

---

## §12 The "blank body flash" — cache-mode wrapping mismatch

### The symptom (reported by user)
"Open search, press 'p' — the whole body becomes blank, BUT header and footer still exist, then everything flashes back with stage-1 filled."

The header DID disappear in the initial test trace (`HDR:no` appeared between states), contradicting the user's report that header stays mounted. The user's eyes were right — an earlier partial-wrapping bug was unmounting more than it should.

### Root cause: element-type mismatch between streaming and cache modes
In `partial.tsx`, partials without a `fallback` prop were wrapped differently in each mode:

- **Streaming mode** (`transformForStreaming`): `<PartialErrorBoundary key={id}>{child}</PartialErrorBoundary>`
- **Cache mode** (`wrappedChildren`): `<Suspense key={`${id}#${version}`} fallback={null}>{child}</Suspense>`

Same JSX position, different element *types*. React's reconciler saw a type change at that slot on the first refetch (streaming render → cache render) and unmounted the entire subtree. For `layout/page` (the pokemon page wrapper, no fallback), this meant unmounting `<PokemonPage>`, which takes `<header>` with it → blank flash including header.

### The fix
Make cache mode's wrapping logic match streaming mode: wrap in `Suspense` only when a fallback exists; otherwise wrap in `PartialErrorBoundary` with the bare key (no version suffix). Element types now agree across modes; reconciler treats it as an in-place update → `<header>` stays mounted.

```ts
const wrappedChildren = activeChildren.map((child) => {
  if (child.key == null) return child;
  const id = String(child.key);
  const fallback = fallbackMap.get(id);
  if (fallback != null) {
    return <Suspense key={`${child.key}#${streamVersion}`} fallback={fallback}>{child}</Suspense>;
  }
  return <PartialErrorBoundary key={child.key} partialId={id}>{child}</PartialErrorBoundary>;
});
```

### Why the versioned key only on Suspense
The version suffix forces a Suspense *remount* so a fresh refetch re-shows its fallback (otherwise React treats an update as "already resolved" and skips fallback). `PartialErrorBoundary` has no fallback of its own — no reason to remount it, and a bare key lets the reconciler treat its child subtree as an update rather than a mount, preserving state (header, footer, scroll, etc.).

### Verification
E2E trace after the fix:
- `bodyKids=24` constant across keystroke 1 and 2 (no body unmount).
- `HDR:yes` at every sampled state (no header unmount).
- Stages progression matches streaming: fallback@~20ms → stage1@~330ms → stage2@~1150ms → stage3@~2150ms.

### The other cosmetic "flash": the input lives inside stage-1
`<SearchInput>` is rendered inside `SearchStage1` (pokemon.tsx:252). When stage-1 shows its Suspense fallback during refetch, the input vanishes with it. The enclosing header, footer, and dialog frame stay mounted, but the input briefly shows "Loading stage 1..." in its place.

Cosmetic fix (not applied): hoist `<SearchInput>` into `<SearchDialog>` directly so it lives above the Suspense boundary. Leaving as-is for now — the user sees it, noted it as "progress."

---

## §13 Hydration race on the first keystroke

### Flaky symptom
The URL-mode e2e test passed standalone but intermittently failed when run as part of the full suite. Trace showed input DOM value = `"p"`, but stage-1 rendered `"Start typing to search..."` — meaning the server received `searchQuery=""` despite the keystroke landing.

### Why
`SearchInput` in URL mode does `History.prototype.replaceState.call(history, ..., url.toString())` inside its React `onChange` handler, then dispatches `usePartial(...).refetch`. If the keystroke fires **before** React's onChange handler has hydrated onto the input, the browser's native handler updates the DOM value, but the URL-rewriting + dispatch never runs. The refetch request then goes out with `?q=""`.

### The fix (e2e test only)
Force focus and wait for hydration to stabilize before the first `input.press`:

```ts
await input.click();
await input.focus();
await page.waitForTimeout(100);
```

Verified across 4 standalone runs and 1 full-suite run (all 8 e2e tests passing). Not a fix in app code — it's a test-harness guard for a real race that humans don't hit in practice (they can't type within ~100ms of initial load).

If the race does reproduce in production, the real fix is on the client: block URL updates + dispatch until after hydration completes (e.g., `useEffect` flag), or make the server tolerate `searchQuery=""` on what should have been a keystroke refetch. Out of scope for the current pass.
