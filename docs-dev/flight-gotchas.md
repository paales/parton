# Flight protocol gotchas

The Flight wire format has rules that interact with `<Partial>`'s
keyed-Suspense + `.map()`-friendly model in non-obvious ways. Most
of the workarounds in `cache.tsx` and `partial-component.tsx` exist
because of one of the items below.

## Composite keys

When an element with a `key` prop is placed inside an array (e.g.
inside a `.map()`), Flight serializes its key by **concatenating
the array's outer key with the element's own key** — `"outer,inner"`
on the wire.

This is a problem for `<Partial>` because the wrapper a Partial
renders has its OWN `key` (the Partial's effective id). A Partial
inside a `.map()` produces a tree like:

```tsx
items.map((p) => (
  <Partial key={p.id} parent={parent} selector={`#item-${p.id}`}>
    <Item p={p}/>
  </Partial>
))
```

`<Partial>` internally renders `<Suspense key={id}>` (when fallback
is set) or `<PartialErrorBoundary key={id}>`. With the outer
`key={p.id}` set:

- Outer key: `p.id`
- Inner Suspense key: `id` (which equals `p.id`)
- On the wire: `"p.id,p.id"` — composite

The client decodes this composite-keyed wrapper. React reconciles
it as a different identity than the plain `"p.id"` emitted by the
streaming render — it remounts the Suspense subtree, which wipes
client state inside the Partial (the `/cache-demo` click counter
was the canonical repro).

### The workarounds

**Don't put `key` on a `<Partial>` inside an array.** Wrap in a
keyed `<Fragment>`:

```tsx
items.map((p) => (
  <Fragment key={p.id}>
    <Partial parent={parent} selector={`#item-${p.id}`}>
      <Item p={p}/>
    </Partial>
  </Fragment>
))
```

Fragments are transparent — their key affects sibling reconciliation
without compositing onto children's keys. The Partial's own
`<Suspense key={id}>` survives clean.

The `<Children>` slot primitive (`src/lib/slot.tsx`) does this
automatically when rendering CMS-stored block instances. Same story
in `cache.tsx::reinjectDynamic` when reconstructing a `<Partial>`
from a snapshot during reinject.

**Use `partialId` prop, not `node.key`, for client identity.**
Flight doesn't composite props the same way it composites keys.
`getPartialId(node)` reads `partialId` first and falls back to the
key only for `<Suspense>` (a React built-in that doesn't get
composite-keyed because Suspense isn't a client-component
boundary).

**Render snapshots as positional children.** `partialFromSnapshot`
in `partial.tsx` builds Partial elements without a `key` and the
`PartialRoot` cache-mode branch passes them as positional args to
`createElement`:

```ts
return React.createElement(PartialsClient, { mode: "cache" }, ...wrappedChildren);
```

Positional children don't trigger React's "each child needs a key"
warning. `key={id}` would composite with the inner `<Suspense
key={id}>` and remount.

## Lazy ref unwrapping

`createFromReadableStream` returns a tree whose nested chunks are
sometimes still **Flight lazy refs** — pending references that
resolve when the corresponding server chunk lands.

```ts
const decoded = await createFromReadableStream<ReactNode>(stream);
// decoded.props.children may be a lazy ref, not a real element
```

Three places this matters:

### 1. `<Cache>` storage branch

The user branch wants lazies to stay lazy (so client paints
fallbacks until they stream). The storage branch wants lazies
resolved (otherwise the re-encoded bytes are missing content).
`resolveLazies` recursively forces resolution by reading the
lazy's `_payload._result`:

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

The init function throws a thenable while pending, returns the
resolved element when settled. Mirror React's standard lazy
resolution.

### 2. `substituteNested` on the client

The cached element tree contains client-component boundaries
(`<PartialErrorBoundary>{lazyRef}</PartialErrorBoundary>` where the
server was still streaming when the cache was populated). On a
later refetch, those lazies have resolved — but the cached element
still references the lazy. `substituteNested` calls `unwrapLazy` to
descend through resolved lazies:

```ts
const unwrapped = unwrapLazy(node);
if (unwrapped !== node) {
  if (unwrapped == null) return node;
  return substituteNested(unwrapped, cache, skipId);
}
```

Pending / errored lazies return null and are treated as opaque (the
original node stays in place).

### 3. `cacheFromStreamingChildren` — same need

Walking the streamed tree to populate the cache and `_fingerprints`
hits lazies the same way. Same `unwrapLazy` helper.

## `Children.forEach` resolves lazies

React helpers like `Children.forEach`, `Children.map`,
`Children.toArray` all eagerly descend into their children — and on
a Flight-decoded tree with lazy refs, that **forces resolution**.
A pending lazy that hasn't received its server chunk gets thrown as
a thenable; React treats it as a Suspense miss and re-renders the
whole region.

The cache layer can't use `Children.*` helpers inside cached
subtrees — `substituteNested` walks via plain prop access
(`node.props.children`) and `unwrapLazy` instead. Same rule applies
to any walker that descends through cached client-component
boundaries: prop access only.

## `cloneElement` and array children

`React.cloneElement(node, {}, arrayChildren)` enforces the
unique-key rule on every item in the array. For decoded Flight
trees, even simple sibling arrays trigger this — the client's
"each child should have a unique key" warning fires.

The workaround: spread arrays as variadic when re-cloning:

```ts
return Array.isArray(newChildren)
  ? cloneElement(node, {}, ...newChildren)
  : cloneElement(node, {}, newChildren);
```

This keeps the children as positional args, which `createElement`
spreads back into a children array internally — but skips React's
"is this an array of keyed elements?" check. Same story in
`reinject`, `reinjectDynamic`, `substituteNested`, and the
deep-render path inside `cache.tsx::resolveLazies`.

## Module-identity boundary at RSC ↔ SSR

Class identity comparisons (`node.type === PartialErrorBoundary`)
break at the module boundary. The RSC bundle and the SSR bundle
each load their own copy of `partial-error-boundary.tsx` —
different module graphs, different class objects. An element
decoded from Flight in the SSR environment has `.type` pointing at
the SSR bundle's class, which doesn't `===` the RSC bundle's import.

The framework doesn't compare against class identity. `isPartialWrapper`
checks the **`partialId` prop** (a plain string that survives Flight
verbatim) and the wrapper's element type via Suspense (a React
built-in shared across bundles). Class type is never the source of
truth.

`PartialErrorBoundary.getDerivedStateFromError` uses the
`__framework` brand on framework sentinels (`NotFoundError`,
`RedirectError`) for the same reason — `instanceof` would force
an import that crosses the boundary and may resolve to the wrong
class.

## `data-partial-id` on placeholder `<i>` elements

Placeholders carry `data-partial-id={id}` as a prop in addition to
`key={id}`. Same composite-key concern: a placeholder inside a
`.map()` would emit `"outer,id"` on the wire, breaking
`String(node.key)`-based id lookup on the client.

`getPlaceholderId(node)` reads `data-partial-id` first, falls back
to `node.key`. Always set the prop when emitting a placeholder; the
key is for React's array reconciliation.

## `plugin-rsc` `"use client"` transform breaks hooks under jsdom

The `@vitejs/plugin-rsc` `"use client"` transform wraps client-
component modules in client-reference proxies. Under real RSC the
proxies resolve to the actual modules; under jsdom (vitest's `node`
tier) they don't, and any hook call inside a wrapped module throws
*"Cannot read properties of undefined (reading 'useState')"*.

The node tier deliberately skips the plugin:

```ts
// vite.config.ts
plugins: isTest ? [react()] : [rsc(), react()],
```

The `rsc` tier needs the transform (for `"use client"` markers), so
it goes through `vitePluginRscMinimal` instead — a stripped version
that handles the transforms without the runtime client-reference
proxies.

## `node.key` of a Suspense boundary stays clean

Suspense is a React built-in. Flight doesn't apply the composite-key
rule to it. So a `<Suspense key={id}>` produced by `<Partial>`
keeps `node.key === id` on both the RSC and SSR sides — even when
the Partial is inside a `.map()` and its outer wrapper is keyed.

This is what `getPartialId` falls back to: when a wrapper has no
`partialId` prop directly but `node.type === Suspense`, the key is
trustworthy. Belt-and-braces: the framework still prefers the
prop because `<PartialErrorBoundary>`-only wrappers (when the
Partial has no fallback) DO get composite keys.

## `setPayload` vs `setPayloadRaw` and Suspense fallbacks

The browser entry exposes two setState calls:

```ts
React.useEffect(() => {
  setPayload = (v) => React.startTransition(() => setPayload_(v));
  setPayloadRaw = setPayload_;
}, [setPayload_]);
```

`startTransition` holds the commit until pending children resolve
— no Suspense fallback flash, atomic swap. Used as the default by
`fetchRscPayload`. Right for "swap a value" UX.

Plain `setState` outside a transition shows fallbacks for pending
children and commits Flight chunks as they arrive. Right for per-row
streaming or concurrent refetches across disjoint ids — multiple
in-flight transitions can collapse, the older one's bytes lost when
a newer one supersedes. Plain setState commits each on arrival.

`?disableTransition=1` on the refetch URL routes through
`setPayloadRaw`. The server doesn't read it; the client uses it to
pick the commit path.
