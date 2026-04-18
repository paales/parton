# Dynamic Partial Registry — design notes

**Added:** 2026-04-16
**Updated:** 2026-04-18 (post unified-path refactor — see `LESSONS_FROM_REFACTOR.md`)
**Files:** `src/lib/partial-registry.ts`, `src/lib/partial-component.tsx`, `src/lib/partial.tsx`
**Related:** `SERVER_CACHE_NOTES.md` (composition with `<Cache>`), `archive/PARTIAL_WRAPPER_DESIGN.md` (historical `<Partial>` API proposal)

---

## 1. The gap the registry closes

A CMS page often produces one Partial per row inside an async component:

```tsx
async function ProductList() {
  const products = await fetchProducts();
  return products.map(p => (
    <ProductItem
      key={p.sku}
      product={p}
      // ↓ Partial is produced inside ProductList's *return value*,
      //   not passed as ProductList's children prop.
      price={<Partial id={`price-${p.sku}`}><GoldPrice sku={p.sku}/></Partial>}
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
  tags: string[];
}

const registry = new Map<string, Map<string, PartialSnapshot>>();
//                       ^ route-path        ^ partial id
```

Exposed functions: `registerPartial`, `lookupPartial`,
`getRouteSnapshots`, `clearRegistry`, `_registryStats`. HMR listener
clears the registry on `vite:beforeUpdate` / `vite:beforeFullReload`
so stale module references don't persist across edits.

## 4. Who populates it

One path, during render. `<Partial>` (`partial-component.tsx`)
renders `<PartialBoundary>`, which side-effects into the registry
as React executes it:

```tsx
export function PartialBoundary({ id, content, fallback, errorWith, tags, children }) {
  const route = new URL(getRequest().url).pathname;
  registerPartial(route, id, { content, fallback, errorWith, tags });
  return children;          // pass-through
}
```

Every Partial the page produces gets registered — static or dynamic,
deep inside an async component or at the top of the route tree.

There is also a one-shot **bootstrap walk** (`seedRegistry` in
`partial.tsx`, ~30 lines) that does a cheap static JSX scan to
populate the registry from whatever Partials are visible without
rendering. Purpose: a first-request cache-mode refetch (before any
full render has populated the route) can still resolve ids. Runtime
self-registration handles every later request and every dynamic
Partial. See `LESSONS_FROM_REFACTOR.md` §5 side notes for the
rationale for keeping it.

## 5. Who consults it

`PartialRoot` in cache mode. After parsing `?partials=` and `?tags=`
from the request, it looks up each requested id in the registry and
renders its snapshot as a flat sibling:

```ts
// sketch — see src/lib/partial.tsx
for (const id of requestedIds) {
  const snap = lookupPartial(routePath, id);
  if (!snap) { registryMiss = true; break; }
  activeEntries.push({ id, snap });
}
if (registryMiss) return fullStreamingRender();   // re-populates registry
```

Tag resolution works the same way — iterate the route's snapshots,
match `snap.tags` against the requested tag set, collect matching ids.

On cache-mode refetch, each active entry re-runs through `<Partial>`
(with its content from the snapshot). The Partial body computes
its own fingerprint, applies any `__inputs` override, decides
render-vs-placeholder, and wraps the output. The registry is purely
a content/metadata lookup; all the decision logic lives in the
Partial component body.

## 6. Client-side: partialId prop survives Flight

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

## 7. Registry-miss fallback

If a requested id is missing from the registry, the partial is
genuinely unknown on this route — either the user clicked a stale
ref button, or the conditional JSX that produced it no longer
reaches that branch. Instead of returning an empty partial,
`PartialRoot` **forces a full streaming render** (pass `children`
directly through `<PartialsClient mode="streaming">`).

Navigation-like behavior: the client reconciles against a fresh
tree; the stale partial just isn't there anymore. Every live partial
on the route also registers itself during that fresh render, so the
next refetch can resolve by id again.

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

## 9. What the registry does *not* do

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
<Partial id="products">
  <Cache id="products" dep={{ search }}>
    <ProductList />
  </Cache>
</Partial>
```

On a cache hit, ProductList doesn't run. The cached bytes contain
keyed partial wrappers for each dynamic partial. Client-side
`substituteNested` (with Flight lazy-ref unwrapping — see
`archive/STREAMING_DEBUG_NOTES.md · 2026-04-16 · Lazy-ref truncation`)
descends into the cached subtree, finds each wrapper by its
`partialId` prop, and swaps in the fresh content.

## 10. Trust boundary note

The `content` field of a `PartialSnapshot` is a captured React
element with bound props — e.g. `<GoldPrice sku="123"/>`. Server
renders the snapshot with optional `__inputs` overrides supplied by
the client via `usePartial(id).refetch(props)`. Props that travel
from client to server are user-controllable; the partial's content
component must validate its own inputs. This is the same trust
model as today's `__inputs` mechanism. The *type* (e.g. `GoldPrice`
function reference) stays server-side in the registry — only props
are client-mutable.
