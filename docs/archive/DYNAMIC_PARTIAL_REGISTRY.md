> **Superseded 2026-04-27** by
> [`docs-dev/render-pipeline.md`](../docs-dev/render-pipeline.md).
> Historical design proposal preserved for context.

---

# Dynamic Partial Registry — design notes

**Added:** 2026-04-16
**Updated:** 2026-04-21 (post `__inputs` removal — stale-snapshot correctness is driven by the ambient-frame-URL fold in the Partial fingerprint, not by fingerprint-after-applyInputs).
**Files:** `src/lib/partial-registry.ts`, `src/lib/partial-component.tsx`, `src/lib/partial.tsx`
**Related:** `NAVIGATE_UNIFIED.md` (the client-side dispatcher that drives refetches), `PARENT_CONTEXT.md` (why snapshots carry `parentPath`), `SELECTOR_API.md` (`#`/`.` token grammar resolved against the registry), `CACHE_SCOPING.md` (how the registry fits alongside the other cache tiers), `/archive/SERVER_CACHE_NOTES.md` (composition with `<Cache>`), `/archive/PARTIAL_CACHE_DESIGN.md` (fold Cache into Partial), `/archive/PARTIAL_WRAPPER_DESIGN.md` (historical `<Partial>` API proposal), `/archive/USE_PARTIAL_AND_INPUTS.md` (historical `__inputs` model)

---

## 1. The gap the registry closes

A CMS page often produces one Partial per row inside an async component:

```tsx
async function ProductList() {
  const products = await fetchProducts();
  return products.map((p) => (
    <ProductItem
      key={p.sku}
      product={p}
      // ↓ Partial is produced inside ProductList's *return value*,
      //   not passed as ProductList's children prop.
      price={
        <Partial selector={`#price-${p.sku}`}>
          <GoldPrice sku={p.sku} />
        </Partial>
      }
    />
  ));
}
```

An async `ProductList` component is a leaf from the outside — its
return value (including every `price-<sku>` Partial) only exists
after it executes. Without a runtime registry, that would mean:

- `?partials=price-X` refetches would have nothing to route to — the
  page would have to re-run the full page tree to find the Partial.
- `?tags=price` couldn't resolve without a full render.
- Server-action invalidations by id wouldn't match until the next
  full render populated an index.

## 2. The design in one paragraph

Every `<Partial>` renders a `<PartialBoundary>` wrapper that
side-effects into a module-level **route-scoped registry** keyed by
`(pathname, partialId)`. Because this registration happens during
the normal React render (not a pre-walk), it picks up every Partial
the page produces, including ones generated inside `.map()` in async
components. Subsequent refetches in `<PartialRoot>` consult the
registry to resolve ids and tags directly. A registry miss
(route never rendered in this process, or the id is genuinely
unknown) falls back to a full streaming render, which re-populates
the registry as a side effect.

## 3. Data

```ts
// src/lib/partial-registry.ts
interface PartialSnapshot {
  content: ReactNode;                 // the original children JSX
  fallback: ReactNode;
  errorWith: ReactNode | undefined;
  uniqueTokens: string[];             // `#`-tokens (see SELECTOR_API.md)
  sharedTokens: string[];             // `.`-tokens
  cache?: CacheOptions;               // replayed on cache-mode refetch
  framePath?: string;                 // dotted frame-chain identity, if any
  frameUrl?: string;
  parentPath: readonly string[];      // ancestor effective ids, outer-first — from the `parent` prop
}

const scopes = new Map<
  string,                              // test-scope (see SERVER_ISOLATION.md)
  Map<string, Map<string, PartialSnapshot>>
  //         ^ route-path   ^ partial id
>();
```

`parentPath` is what lets a cache-mode refetch reconstruct a
Partial's place in the tree without re-executing ancestors — see
`PARENT_CONTEXT.md` for why the `parent` prop is required and how
the chain is built.

Scaling + cross-route sharing live in `CACHE_SCOPING.md` — short
reference covering the three storage tiers, what "route" means
(pathname vs pathname+search), and the `getPathname(pattern)` +
pending LRU cap story for high-cardinality routes.

Exposed functions: `registerPartial`, `lookupPartial`,
`getRouteSnapshots`, `clearRegistry`, `_registryStats`. HMR listener
clears the registry on `vite:beforeUpdate` / `vite:beforeFullReload`
so stale module references don't persist across edits.

## 4. Who populates it

One path, during render. `<Partial>` (`partial-component.tsx`)
renders `<PartialBoundary>`, which side-effects into the registry
as React executes it:

```tsx
export function PartialBoundary({
  id,
  content,
  fallback,
  errorWith,
  tags,
  children,
}) {
  const route = new URL(getRequest().url).pathname;
  registerPartial(route, id, { content, fallback, errorWith, tags });
  return children; // pass-through
}
```

Every Partial the page produces gets registered — static or dynamic,
deep inside an async component or at the top of the route tree.

`clearRoute(route)` runs at the start of every streaming render,
emptying the registry so only the current layout's partials
remain. This is the only registry-maintenance walk — there is no
longer a static refresh walker.

**Stale snapshot content across cache-mode refetches is handled via
the fingerprint-scope fold, not by a refresh walker.** State that
varies between refetches lives in a URL (page URL or frame URL); the
`<Partial>` body folds its OWN frame URL (if any) and the AMBIENT
frame URL (if it sits inside a framed subtree) into its fingerprint.
A refetch against a new URL therefore yields a distinct fingerprint,
a distinct `<Cache>` key, and a clean miss. No `__inputs` /
`cloneElement` overrides; authors who need dynamic values in a
descendant Partial read them via tracked accessors
(`getSearchParam` / `getPathname` / `getCookie` / `getHeader`) or
receive them as scalar props from a parent that reads the accessor.
See `NAVIGATE_UNIFIED.md` for how refetches are dispatched and
`/archive/USE_PARTIAL_AND_INPUTS.md` for the predecessor
`fingerprint-after-applyInputs` design.

## 5. Refetch modes — when the tree-shake works vs when it bails

The registry is only half the story; the other half is
`PartialRoot`'s decision about which of three modes to enter. This
is the full "when does the minimal-transfer path kick in, and when
does it fall back to a full render" walkthrough. All three branches
live in `src/lib/partial.tsx` around the `// Streaming mode` /
`// Cache mode` / `// Registry-miss fallback` comments.

### Mode A — streaming (full render)

Entered when the request has no partial filter (normal nav, cold
load, server action without a filtered response). `clearRoute(route)`
wipes stale snapshots first; every `<Partial>` executes normally and
self-registers via `<PartialBoundary>`. Ancestors run. Fingerprint-skip
still applies per-partial: if the client sent `?cached=id:fp` and the
body's computed fp matches, the Partial emits a 3-byte placeholder
(`<i data-partial hidden>`) instead of its content.

### Mode B — cache (targeted refetch — the tree-shake path)

Entered when the request carries `?partials=` / `?tags=` **and** every
requested `#`-token resolves against the registry. Only the
requested ids render, as flat siblings reconstructed from their
snapshots:

```ts
// sketch — see src/lib/partial.tsx
for (const id of requestedIds) {
  const snap = lookupPartial(routePath, id);
  if (!snap) {
    registryMiss = true;
    break;
  }
  activeEntries.push({ id, snap });
}
if (registryMiss) return fullStreamingRender(); // see Mode C
// else: render snapshots as flat siblings, ancestors never execute
```

Each active entry re-runs through `<Partial>` with its content from
the snapshot — `parentPath` is reconstructed from `snap.parentPath`
so the frame chain and registry edges stay identical to the original
render. The Partial body re-computes its fingerprint (including
ambient frame URL), and if the client already has the content
unchanged, it still emits a placeholder. Selector resolution for
`.class` tokens scans snapshots and unions matching ids — same
complexity as mode-B's id list.

**What this buys:** the producer ancestors (`ProductList`, the
async `.map()`, whatever else surrounds the targeted Partial) don't
execute at all. The wire payload is the handful of requested
Partials plus placeholders for everything the client already knows;
see `fingerprint-skip.spec.ts` for the e2e size check.

**No server-side template is sent** — the client's persisted
`_template` (built during the most recent streaming render) is what
gets filled with the refetched entries.

### Mode C — registry-miss bailout (fall through to streaming)

Entered when the filter targets a `#`-token the registry hasn't
seen. Concrete triggers:

- **Stale client button.** The user held a refetch ref for a
  Partial that no longer appears on the route (conditional branch,
  deletion, layout change).
- **Range expansion.** Infinite scroll bumps `?end=N+1` before
  `page-{N+1}` has ever been rendered on this process — no snapshot
  exists yet.
- **Cold process.** First refetch to a route after a dev restart;
  the registry is empty for that route.

The server drops the filter, calls `clearRoute(route)`, and renders
the route in streaming mode. The client reconciles against the fresh
tree — if the Partial is genuinely gone, it isn't in the response;
if it exists, the fresh render registers it so the next refetch can
resolve in mode B.

Only `#`-tokens gate the bailout. A `.class` token that unions across
a subset of known snapshots is always valid — that's how unions work.

## 6. Fingerprint skip — the inner optimization

Independent of the streaming-vs-cache decision, every Partial body
checks its computed structural fingerprint against the client's
`?cached=id:fp,…` entry. A match emits a placeholder
(`<i data-partial hidden>` — 3 bytes) instead of rendering the
subtree. This is what makes the "rerender the whole world" stance
cheap: ancestors may re-execute in streaming mode, but every
descendant Partial whose shape hasn't moved short-circuits to the
placeholder, and the client fills the hole from its `_cache`.

Explicitly-requested ids (the ones in `?partials=`) never skip on
fingerprint match — they're what the caller asked for.

## 7. Client-side: partialId prop survives Flight

For the client's `cacheFromStreamingChildren` / `substituteNested`
walkers to find a dynamic partial at refetch time, something in the
rendered tree has to carry an identifier that survives the Flight
boundary. `PartialBoundary` is a server component — it dissolves
during serialization. The wrapper that ends up on the wire is a
`<Suspense key={id}>` (when the Partial has a fallback) or a
`<PartialErrorBoundary key={id} partialId={id}>` (when it doesn't).

The client walkers identify partial wrappers via the **`partialId`
prop**, not via class/type identity and not via `node.key`:

- `node.key` is unreliable when a Partial is produced inside a
  `.map()` — Flight combines the caller's key with the wrapper's
  own key into a composite string (`"page-1,page-1"`).
- Class identity (`node.type === PartialErrorBoundary`) breaks at
  the RSC → SSR module boundary — imported class references don't
  `===` the types on elements decoded from Flight.
- The `partialId` string prop travels through Flight verbatim and
  is stable across the module boundary.

Suspense keys stay clean (no composite key bug) because Suspense is
a React built-in, so when a Partial has a fallback and is wrapped in
Suspense, `node.key` works too — but `partialId` is the source of
truth. See `LESSONS_FROM_REFACTOR.md` §3–§4.

**Side note — cache-hit reinjection:** when `<Cache>` serves bytes on
a hit, dynamic partials inside the cached region are holes
represented by `<i key={id} hidden data-partial>` placeholders. On
the way out, `reinjectDynamic` (`cache.tsx`) swaps each placeholder
for a fresh `<Partial>` element, which the RSC renderer then expands
into its Suspense / PartialErrorBoundary wrapper. The subtle part:
the new `<Partial>` has to preserve the placeholder's array-slot key
(the placeholder was one item in a parent's children array), but it
must not put `key={id}` on the Partial itself — Flight would
composite that with the inner `<Suspense key={id}>` as `"id,id"` on
the wire, which the client reconciles as a different identity than
the plain `"id"` emitted in streaming mode and remounts client state
inside the partial. The fix is to wrap the replacement in a keyed
`<Fragment key={id}>` — Fragments are transparent, the key survives
in the parent's child list for reconciliation, and no composite
lands on the Partial's own wrappers. Without the Fragment wrap,
React fires "Each child in a list should have a unique 'key' prop"
for every cache-hit render that has a sibling-list dynamic Partial
(e.g. `/magento` — each `ProductCard` contains a `<Partial>` for
LivePrice).

## 8. Persistence + HMR

Registry is **module-level, per Node process**. No cross-request
cleanup. A partial registered on route `/magento` during an earlier
request stays registered for subsequent requests to `/magento`
until:

- The process restarts.
- HMR fires `vite:beforeUpdate` / `vite:beforeFullReload` (dev).
- Explicit `clearRegistry()` via `/__test/clear-caches` (dev-only
  endpoint used by e2e tests for deterministic cold-state runs).

Cross-request persistence is **desired**: the registry is an
availability index, not per-request state. Two users concurrently
refetching `price-X` on `/magento` both hit the same snapshot.

For unit tests: the registry is route-keyed, and test fixtures tend
to reuse the same fake URL (`http://localhost/test`), so entries
from one test leak into the next. `partial.test.tsx` has a
top-level `beforeEach(clearRegistry)` to neutralize this.

## 9. What the registry does _not_ do

**It doesn't skip ancestor execution on a full render.** On a
dynamic-partial refetch (`?partials=price-X`), the registry lets the
server render only `price-X` as a flat sibling — ancestors don't run
in this path. But on a streaming render (no filter, or a registry
miss), ancestors execute as normal to produce the DOM scaffolding
plus register every descendant Partial. The registry saves work on
the refetch hot path; it doesn't save work on the cold-start /
miss / fresh-render path.

To additionally skip ancestor execution on full renders, wrap the
producer in `<Cache>`:

```tsx
<Partial selector="#products">
  <Cache id="products" dep={{ search }}>
    <ProductList />
  </Cache>
</Partial>
```

On a cache hit, ProductList doesn't run. The cached bytes contain
keyed partial wrappers for each dynamic partial. Client-side
`substituteNested` (with Flight lazy-ref unwrapping — see
`/archive/STREAMING_DEBUG_NOTES.md · 2026-04-16 · Lazy-ref truncation`)
descends into the cached subtree, finds each wrapper by its
`partialId` prop, and swaps in the fresh content.

## 10. Trust boundary note

The `content` field of a `PartialSnapshot` is a captured React
element with bound props — e.g. `<GoldPrice sku="123"/>`. The
snapshot's props are fixed at capture time (bound from the ancestor
render's scope). Request-varying state flows through URL / cookie /
header accessors, not through client-supplied prop overrides — so
the trust surface is the request itself (URL, cookies, headers),
which the framework already handles. The _type_ (e.g. `GoldPrice`
function reference) stays server-side in the registry — nothing
about the snapshot is client-mutable.
