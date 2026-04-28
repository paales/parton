# Flight gotchas

A few RSC-specific quirks the framework works around. Mostly
unchanged after the 2026-04-28 rewrite — they live one level below
the API surface.

## Composite keys on dynamic partials

Flight composites the outer `.map()` key with a client-component's
own `key` into `"outerKey,innerKey"` on the wire. A
`<SpecComponent key={item.id} />` produced inside a `.map()` would
emit `"item.id,item.id"` on a wrapping `<Suspense key={item.id}>`,
which the client reconciles as a different identity than the plain
`"item.id"` emitted in streaming mode — forcing a remount that
wipes client state inside the partial.

Fix: wrap in a keyed `<Fragment>` instead of putting the key on the
spec component itself.

```tsx
{items.map((item) => (
  <Fragment key={item.id}>
    <ItemSpec parent={parent} />
  </Fragment>
))}
```

## Lazy refs inside cached bytes

`createFromReadableStream` returns a tree whose nested chunks may
still be represented as Flight lazy refs. `cache.tsx::resolveLazies`
forces resolution before re-stripping dynamic wrappers — both cache
hit and miss paths return an equivalent fully-materialized tree.

## `data-partial-id` on placeholders

Placeholder elements carry `data-partial-id` (in addition to a key)
because Flight composite-key behavior also affects the `<i>`'s key
for placeholders emitted inside `.map()` walks. The client looks up
ids via `data-partial-id` first, falling back to `key` only when
the attribute is missing.

## `key` on a `<PartialBoundary>` element

The framework never puts a `key` on a `<PartialBoundary>` — the
inner Suspense already has one. Doing so would composite as
`"id,id"` on the wire and break reconciliation.

## Why no `createContext` in server bundles

React's RSC build (`react.react-server.js`) deliberately excludes
`createContext`. Server components can't create their own
providers. The framework works around this by:

- Threading `parent: PartialCtx` as an explicit prop (no context
  needed).
- Passing the frame-resolved `request` to `vary` as an argument
  (no ALS, no cell, no context).
