# `<Cache>` internals

`<Cache>` (`src/lib/cache.tsx`) is `<Partial cache={…}>`'s
implementation. Authors don't render it directly — the `Partial`
body wraps content in `<Cache id fingerprint options>` when the
`cache` prop is set.

The component performs four jobs: derive a cache key from the
auto-tracked manifest, look up bytes in the store, on miss render to
Flight and store, on hit decode + reinject live Partials. Inner
Partials don't bake into the cached bytes; they're stripped to
placeholders before storage and reinjected on return.

## ScopeState

Every piece of cache state lives behind a per-scope bucket:

```ts
interface ScopeState {
  store: CacheStore;                       // bytes
  snapshotIndex: Map<string, Map<string, PartialSnapshot>>;
                                            // dynamic-partial snapshots per cache key
  manifestStore: Map<string, Set<string>>; // manifest by base key
  refreshing: Set<string>;                  // SWR in-flight guard
  inFlightMiss: Map<string, Promise<...>>;  // cold-miss dedupe
}

const scopes = new Map<string, ScopeState>();
```

`getScope()` from `framework/context.ts` picks the bucket. Production
maps every request to `"default"` (one bucket, one cache); dev with
the `x-test-scope` header maps to per-worker buckets so parallel
test workers don't contend.

Public clear functions (`_clearCache(scope?)`) accept a scope or
`"all"`. HMR dispose hooks call `_clearCache()` (no arg → all).

## `MemoryCacheStore`

Async-by-contract — the `CacheStore` interface uses Promises so a
Redis backend can swap in. The default in-memory implementation
keeps an LRU map:

```ts
async get(key) {
  const entry = this.map.get(key);
  if (entry !== undefined) {
    this.map.delete(key);
    this.map.set(key, entry);          // LRU: move to end
  }
  return entry;
}

async set(key, entry) {
  this.map.set(key, entry);
  while (this.map.size > this.maxEntries) {
    const oldest = this.map.keys().next().value;
    this.map.delete(oldest);
  }
}
```

Default `maxEntries = 10_000`. Per scope.

## The Cache component flow

```ts
export async function Cache({ id, fingerprint, options, children }) {
  const frameRequest = getCurrentFrameScope()?.request;
  if (options.bypass) return children;

  const baseKeyPrefix = `${id}:${fingerprint}:`;
  const scope: ManifestScope = {
    current: new Set(),
    stored: findStoredManifestByPrefix(baseKeyPrefix) ?? null,
    partialId: id,
  };

  return runWithCacheManifest(scope, async () =>
    cacheImpl(id, fingerprint, options, children, scope, frameRequest)
  );
}
```

`runWithCacheManifest` opens an ALS scope so descendant tracked-
accessor calls record into `scope.current`. The pre-computed
`scope.stored` lets the synchronous hoisting check fire on the first
new key (otherwise the check would only fire after the render
completes, and a new key could land mid-stream before the throw).

`frameRequest` is the request the cache key should resolve manifest
values against. When `<Cache>` runs inside a `<Partial frame=…>`, the
frame's request is what tracked accessors read inside the cached
subtree (the cell propagates synchronously). Without capturing it
here, the resolved manifest would key against the page request and
hit different entries on every nav.

## Cache key derivation

```
baseKey = `${id}:${fingerprint}:${djb2(ids.join(","))}`
key     = `${baseKey}:${hashParts(resolvedManifestValues, options.vary ?? null)}`
```

- `id` — Partial effective id.
- `fingerprint` — `structuralFp` from the `<Partial>` body.
  Excludes ambient frame URL so cache keys stay stable across full
  vs. cache-mode renders (which differ in whether the cell is set).
- `ids.join(",")` — sorted ids of statically-visible Partials inside
  the cached subtree. Adding or removing a nested Partial changes
  the hash, which invalidates the entry.
- `resolvedManifestValues` — `resolveManifest(stored, frameRequest)`
  returns `{spec: value}` for every key in the stored manifest.
  Sorted keys → stable hash regardless of insertion order.
- `options.vary` — author-supplied scalars stable-stringified.

`maxAge` and `staleWhileRevalidate` don't participate. They're
entry metadata; changing them doesn't invalidate.

## Hit path

```ts
if (storedManifest) {
  const values = resolveManifest(storedManifest, frameRequest);
  const key = `${baseKey}:${hashParts(values, options.vary ?? null)}`;

  const existing = await store.get(key);
  const existingSnapshots = existing ? snapshotIndex.get(key) : undefined;
  if (existing && existingSnapshots) {
    if (existing.expiresAt > now || existing.staleUntil > now) {
      registerDynamicSnapshots(route, existingSnapshots);  // (1)
      if (existing.expiresAt <= now && !refreshing.has(key)) {
        refreshing.add(key);
        void refreshEntry(...).finally(() => refreshing.delete(key));  // (2)
      }
      const decoded = await createFromReadableStream(bytesToStream(existing.bytes));
      const resolved = await resolveLazies(decoded);                    // (3)
      const withStatic = reinject(resolved, partials);                  // (4)
      return reinjectDynamic(withStatic, existingSnapshots);            // (5)
    }
  }
  // Past staleUntil, snapshots gone, or absent → miss.
}
```

1. **Snapshot republish.** Dynamic Partials inside the cached region
   need their snapshots re-registered on every hit so cache-mode
   refetches that target them resolve. The snapshot was captured at
   miss time; subsequent hits re-publish the same data.
2. **SWR kick.** `refreshing` is a per-scope Set guarding concurrent
   refresh attempts. Benign race — two requests in the millisecond
   window both kick refreshes; cache reads still return stale bytes
   either way.
3. **Lazy resolution.** `createFromReadableStream` returns a tree
   whose nested chunks may still be Flight lazy refs. Resolve them
   eagerly so the user-branch tree is materialized before reinject
   walks it.
4. **Static reinject.** Replace placeholder `<i hidden>` with the
   live `<PartialBoundary>` element captured before the bytes were
   stored.
5. **Dynamic reinject.** For dynamic-partial placeholders inside the
   cached bytes, rebuild a `<Partial>` element from the snapshot
   (selector tokens, parent path, frame chain), wrapped in a keyed
   `<Fragment>` so the array slot's identity survives without
   compositing onto the inner `<Suspense key={id}>`.

## Miss path

`renderMissAndStore` runs the children once, tees the Flight stream,
serves the user branch directly while the storage branch buffers,
strips dynamic wrappers, re-encodes, stores.

```ts
const stream = renderToReadableStream(stripped);
const [userBranch, storageBranch] = stream.tee();

const storagePromise = (async () => {
  const rawBytes = await readAll(storageBranch);
  // Manifest verification — added-key violations already threw
  // synchronously during render; here we catch missing-key (stored
  // had X, current didn't touch X). Soft fail: log + preserve old.
  if (storedManifest && !manifestsEqual(storedManifest, manifest)) {
    console.error(`[cache] manifest mismatch for "${id}"`, ...);
    return new Map<string, PartialSnapshot>();
  }

  const rawDecoded = await createFromReadableStream(bytesToStream(rawBytes));
  const rawResolved = await resolveLazies(rawDecoded);

  const { stripped: holeTree, snapshots } =
    stripDynamicWrappers(rawResolved, staticIds);
  const cleanBytes = await renderAndBuffer(holeTree);

  const values = resolveManifest(manifest, frameRequest);
  const key = `${baseKey}:${hashParts(values, options.vary ?? null)}`;

  manifestStore.set(baseKey, new Set(manifest));
  await store.set(key, freshEntry(cleanBytes, options.maxAge, options.swr, Date.now()));
  setSnapshots(key, snapshots);
  return snapshots;
})();

const liveTree = await createFromReadableStream(userBranch);
return { liveTree, dynamicSnapshots: new Map() };
```

The user branch decodes immediately and returns to the outer render —
inner Suspense boundaries stay lazy so the client paints fallbacks
until they stream. The storage branch runs off the critical path:
double-encode (Flight → bytes → decode → strip → re-encode) costs
CPU and memory but doesn't block the response.

`reinject(liveTree, partials)` runs after the user branch returns —
re-injecting live `<PartialBoundary>` elements for the static-visible
Partials whose placeholders went into the bytes.

## Strip and reinject

Two parallel pairs:

### Static (`stripPartials` / `reinject`)

Walks the JSX *before* render. `<PartialBoundary>` elements (via
`Partial`'s wrapper layer) get replaced with `<i hidden data-partial
data-partial-id={id}>` placeholders; the `partials` map captures the
live elements for reinject after decode.

Why before: the bytes shouldn't contain baked Partial content.
Refetching `#cart` should re-render its body, not pull stale bytes
out of the parent's `<Cache>` entry.

### Dynamic (`stripDynamicWrappers` / `reinjectDynamic`)

Walks the *decoded* tree post-render. Looks for keyed Partial
wrappers (Suspense or PartialErrorBoundary with a `partialId` prop)
that are NOT in `staticIds` — those are dynamic Partials produced
inside an opaque async component. For each:

```ts
const snap = lookupPartial(route, wrapperId);
if (snap) {
  snapshots.set(wrapperId, snap);
  return placeholderFor(wrapperId);
}
```

The snapshots end up on `snapshotIndex.set(key, snapshots)` so the
hit path can re-register them on subsequent hits. Reinject rebuilds
a fresh `<Partial>` element from the snapshot:

```tsx
<Fragment key={id}>
  <Partial
    parent={{ path: snap.parentPath, frameChain, provides: {} }}
    selector={[...uniqueTokens.map(t => `#${t}`), ...sharedTokens.map(t => `.${t}`)]}
    fallback={snap.fallback}
    errorWith={snap.errorWith}
    cache={snap.cache}
  >
    {snap.content}
  </Partial>
</Fragment>
```

The Fragment wrap is load-bearing — see `flight-gotchas.md` for why
a bare `<Partial key={id}>` would composite with the inner
`<Suspense key={id}>` and remount client state.

## Cold-miss dedupe

```ts
let pending = inFlightMiss.get(baseKey);
if (!pending) {
  pending = renderMissAndStore(...).finally(() => inFlightMiss.delete(baseKey));
  inFlightMiss.set(baseKey, pending);
}
const { liveTree } = await pending;
```

Two concurrent requests for the same cold key share one render. The
second arrival awaits the first's promise; only one `renderToReadable
Stream` runs.

Keyed on `baseKey` (not the full key). Two requests with different
manifest values would still produce the same render shape — the
manifest resolves to identical *registered keys* during the inner
work; the baseKey suffices for dedupe.

## SWR refresh

`refreshEntry` runs in a separate async chain triggered by the hit
path's stale check. It opens its own ALS manifest scope, re-renders,
verifies the manifest matches the stored one (mismatch = log +
preserve, same as the miss-path soft fail), strips, encodes, stores
under a fresh key derived from current values.

```ts
async function refreshEntry(baseKey, _oldKey, stripped, ids, options, partialId, frameRequest) {
  const storedManifest = manifestStore.get(baseKey);
  const scope: ManifestScope = { current: new Set(), stored: storedManifest ?? null, partialId };
  await runWithCacheManifest(scope, async () => {
    const stream = renderToReadableStream(stripped);
    const bytes = await readAll(stream);
    // verify, strip dynamic, re-encode, store under new key
  });
}
```

The new entry replaces the stale one (it lives at a fresh key
derived from current values). The old entry stays in the map until
LRU-evicted.

## Lazy ref resolution

`createFromReadableStream` returns trees whose chunks are sometimes
still Flight lazy references — pending until their server chunk
resolves. The cache layer eagerly resolves them via `awaitLazy`:

```ts
async function awaitLazy(node) {
  if (typeof node.$$typeof !== "symbol") return node;
  if (node.$$typeof.toString() !== "Symbol(react.lazy)") return node;
  const payload = node._payload;
  if (payload?._status === 1) return payload._result;
  try {
    return node._init?.(payload);
  } catch (pending) {
    if (pending?.then) {
      await pending;
      return node._init?.(payload);
    }
    throw pending;
  }
}
```

Why eagerly: both the storage branch (re-encoding bytes for storage)
and the user branch (returning to the outer render) need a real tree.
Pending lazies in the storage branch would serialize as `null` and
the cached bytes would be missing content; pending lazies in the
user branch would block reinject from finding wrappers underneath.

`resolveLazies` recurses through arrays, elements, and children —
the only nodes it leaves opaque are non-element terminal values
(strings, numbers, etc).
