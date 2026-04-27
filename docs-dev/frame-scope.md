# Frame scope

Every framed Partial — `<Partial frame="name">` — opens a scope
descendant server components see when they call tracked accessors.
Inside the frame, `getSearchParam("q")` reads the frame URL's query,
not the page URL's. The scope has to propagate through async server-
component renders without buffering the whole subtree before the
parent returns. None of the obvious propagation primitives quite
work in the RSC environment.

## The constraint

React's RSC build (`react.react-server.js`) deliberately excludes
`createContext`. Server components can't create their own provider
trees:

```bash
$ node -e "console.log(Object.keys(require('react/cjs/react.react-server.development.js'))
                              .filter(k => /context/i.test(k)))"
[]
```

If a future React RSC build adds `createContext`, `<Partial frame>`
becomes a one-line provider wrap and this whole document goes away.

## What didn't work

| Pattern | Why it doesn't work |
|---|---|
| `React.createContext` | Excluded from the RSC build (see above). |
| `AsyncLocalStorage.run(scope, () => jsx)` | The store closes when `run` returns, before React walks the JSX. Descendants see no store. |
| `AsyncLocalStorage.enterWith(scope)` | Propagates to descendants (one-way set on current async context) but **leaks** to siblings and to everything that renders after a nested frame returns. Not isolatable. |
| ALS + Flight render+decode roundtrip | Open an ALS scope, render children through `renderToReadableStream`, decode, return the tree. The async walk happens inside the ALS scope so descendants inherit. Correct, but the Flight roundtrip **buffers the whole subtree** before returning — a slow async server component inside a framed subtree blocks the outer render. Streaming dies. |

## What works: `React.cache` mutation cell

Pattern borrowed from
https://github.com/zhangyu1818/react-server-only-context.

```ts
const frameScopeCell = cache((): { current: FrameScope | null } => ({
  current: null,
}));

export function setCurrentFrameScope(scope: FrameScope | null): void {
  frameScopeCell().current = scope;
}

export function getCurrentFrameScope(): FrameScope | null {
  return frameScopeCell().current;
}
```

Two things make this work:

1. **`React.cache(fn)` returns the same object reference for a given
   function identity within one request.** So `frameScopeCell()` is
   the shared cell every reader sees. Different requests get
   different cells (the cache is per request).
2. **The cell is mutable.** `FrameWrapper` writes to `cell.current`
   synchronously before React walks its children. Depth-first
   rendering means descendants pick up the new scope at their
   moment of render — no buffering, no Flight roundtrip.

Streaming preserved. A slow async component inside a framed subtree
yields normally; outer Flight chunks emit progressively.

## The discipline

Tracked accessors must be called **at the synchronous top of a
server component body, before any `await`**. Same rule as the cache
manifest's `HoistingViolationError`; same reason.

After an `await`, the per-request cell may have been mutated by a
sibling Partial that ran while this component was suspended. The
current value is whoever-set-it-most-recently, not necessarily the
ancestor frame this component is supposed to be inside.

```tsx
// ✓ scope captured at sync top
async function SlowCart() {
  const sku = getSearchParam("sku");
  const data = await fetchCart(sku);
  return <Cart data={data}/>;
}

// ✗ post-await read attributes to whichever frame ran last
async function BrokenCart() {
  await fetchSomething();
  const sku = getSearchParam("sku");   // cell may have drifted
  ...
}
```

## The sibling leak

Concrete trigger: `<ChatOverlay>` is rendered as a sibling of the
page content in `root.tsx`. The overlay's `<Partial frame="chat-
overlay">` runs, mutates the cell. React schedules the sibling page's
Partials, which read the cell and see `inFrame=chat-overlay` in
their fingerprint inputs even though they are not inside the chat
frame.

Two consequences:

1. **Fingerprint corruption.** A page Partial's `fp` includes
   `ambientFrameKey` from the leaked sibling. On a streaming render
   where `<ChatOverlay>` is present, fp = `…|inFrame=chat-overlay:url`.
   On an RSC refetch where the overlay isn't rendered, the cell is
   clean and `ambientFrameKey === ""`. Two different fps → fp-skip
   handshake misses, server re-renders unnecessarily.
2. **Cross-route fp drift.** Open the overlay on `/`, navigate to
   `/magento` (no sibling frame). `/`'s cached fp held
   `inFrame=search:…` from pokemon's `<Partial frame="search">`;
   `/magento`'s fresh fp doesn't. Cross-page fingerprint-skip
   misses; the overlay re-renders and the streamed chat briefly
   vanishes.

## The fix

Two layers, both in `partial-component.tsx`:

### Layer 1: split fp / structuralFp

`structuralFp` is the cache-key contributor; `fp` is the client-skip
contributor. Only `fp` folds in `ambientFrameKey`.

```ts
const structuralFp = hashFingerprint(
  fingerprintElement(rawContent) + ownFrameKey + cmsKey + ownManifestKey + descendantManifestKey,
);
const fp = hashFingerprint(
  fingerprintElement(rawContent) + ownFrameKey + ambientFrameKey + cmsKey + ownManifestKey + descendantManifestKey,
);
```

`<Cache>`'s base key uses `structuralFp` so cache entries stay
stable across full vs. cache-mode renders. `fp` keeps ambient for
the client handshake — descendants of a frame whose URL changed
must invalidate.

A self-framing Partial skips ambient entirely (`ambientFrameKey ===
""` when `frame != null`), so `fp === structuralFp` in that case —
the only difference between them is the ambient term, and a Partial
opening its own frame has no semantic dependency on a sibling's leak.

### Layer 2: explicit set-on-entry per Partial

The cell-leak persisted into `ambientFrameKey` even after layer 1.
Every `<Partial>` body now resets the frame cell on entry, using
`parent.frameChain` as the authority on what the ambient frame
should be:

```ts
if (frame == null) {
  if (parent.frameChain.length > 0) {
    const cell = getCurrentFrameScope();
    const expected = _joinFrameChain(parent.frameChain);
    const cellMatches = cell != null && _joinFrameChain(cell.path) === expected;
    if (!cellMatches) {
      const ambientReq = resolveFrameRequest(parent.frameChain, undefined);
      setCurrentFrameScope({ path: parent.frameChain, request: ambientReq });
    }
  } else {
    setCurrentFrameScope(null);
  }
}
```

Three cases:

| Case | Behavior |
|---|---|
| Own frame (`frame != null`) | Leave the cell — `FrameWrapper` (rendered via `content` below) sets it to our own frame request. |
| Ambient frame (no own frame, `parent.frameChain.length > 0`) | Keep the cell IF it already points at the expected ancestor. Otherwise restore from session via `resolveFrameRequest(parent.frameChain, undefined)`. |
| No frame (no own, no ancestor) | Clear the cell to null. Descendants resolve accessors against the page request. |

The `parent.frameChain` thread is load-bearing here. Authors must
pass `parent={ROOT}` or `parent={capturePartialContext()}` correctly
across awaits — the framework relies on that information to defang
the sibling leak.

**Behavior change.** A non-framed `<Partial parent={ROOT}>` nested
inside a `<Partial frame="X">` no longer inherits frame X via the
leak. The author must thread `parent={capturePartialContext()}` to
get ambient inheritance. `parent={ROOT}` now means what it says (no
ancestor).

## Same pattern: CMS scope and partial manifest

The same React.cache + cell-mutation pattern shows up two more
places:

| Cell | Set by | Read by |
|---|---|---|
| `frameScopeCell` | `<Partial frame=…>`'s `FrameWrapper` | Tracked accessors via `currentRequest()` |
| `cmsScopeCell` | `<Partial cmsId=…>` body | Content accessors (`getText`, `getEnum`, …) |
| `partialManifestCell` | Every `<Partial>` body | `trackAccess` for the per-Partial fp manifest |

All three follow:

1. Set on entry from explicit ancestor info (`parent.frameChain`,
   `cmsId`, fresh ManifestScope object).
2. Read by descendants synchronously at the top of their body.
3. Clear / reset on every Partial entry that doesn't open the
   corresponding scope, so leaks from sibling Partials don't reach
   non-participating descendants.

The CMS scope is explicitly cleared (`_setCurrentCmsScope(null)`)
when a Partial without `cmsId` runs — otherwise an ancestor's CMS
scope would leak into a non-CMS descendant Partial and its `getText`
calls would resolve against the wrong node.

## Frame request resolution

```ts
function resolveFrameRequest(framePath, initialUrl) {
  const pageRequest = getRequest();
  const sessionUrl = getSessionFrameUrl(framePath);
  const effective = sessionUrl ?? initialUrl;
  if (effective == null) return pageRequest;
  const resolved = new URL(effective, pageRequest.url).toString();
  return new Request(resolved, {
    headers: pageRequest.headers,
    method: "GET",
  });
}
```

Lookup order: session entry for the dotted path → `frameUrl` prop →
page request (frame and page agree). The Request is reconstructed
with the page's headers so cookie reads inside the frame still work
— cookies live on the response, not per-frame.

`getSessionFrameUrl` reads the framework session via
`_readCookieUntracked` so the read doesn't pollute the partial
manifest. If every page's manifest grew `cookie:__frame_sid` from
session lookup, the hoisting check would refuse the first request
that introduces a frame.
