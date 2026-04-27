# Introduction

A React Server Components based framework layer for pages composed of
independently re-renderable, addressable, cacheable subtrees.

The primitive is `<Partial>`. The contract is:

- A Partial is **addressable** — `selector="#cart"` makes it the target
  of `useNavigation().reload({ selector: "#cart" })` and of server-action
  `return { invalidate: { selector: "#cart" } }`.
- A Partial is **independently re-renderable** — a targeted refetch
  re-runs only the requested Partial's body, from a stored snapshot,
  without re-executing any ancestor.
- A Partial is **fingerprinted** — every render computes a structural
  hash from the JSX shape plus the request inputs read inside it. The
  client sends the hashes it has on every refetch; the server emits a
  3-byte placeholder for any Partial whose fingerprint is unchanged,
  and the client paints the cached subtree from its module-level
  `_cache`.

Every Partial discovers itself at render time. Register, render,
skip, fall through — every decision is made inside the body when
React runs it. Partials produced inside an opaque async component
or a `.map()` are first-class; the registry picks them up the same
way it picks up statically-placed ones.

## The mental model

> Render the whole tree on a full request. After that, every
> client-initiated render is a navigation, and every navigation can
> ask for any subset of Partials; the server returns only what was
> asked for, the client merges them into a persisted template.

A page render walks the tree once and streams it to the browser. As
each `<Partial>` body executes, it side-effects three things:

1. A snapshot of its content (the JSX inside it, with bound props) into
   a route-scoped server registry, keyed by the Partial's effective id.
2. Its structural fingerprint into the client (via the
   `<PartialErrorBoundary>` wrapper that ships with the wire payload).
3. A manifest of every tracked-accessor read (`getCookie`,
   `getSearchParam`, `getPathname`, `getHeader`) it performed, attached
   to the snapshot for the next render.

The browser walks the streamed tree once: builds the structural
template (layout DOM with `<i hidden data-partial>` placeholders
where Partials live), populates `_cache` (rendered wrappers by id),
populates `_fingerprints` (id → hash). All three module-level maps
survive across React state updates.

When the user clicks a link, the navigation listener intercepts and
fetches the new URL with `?cached=id1:fp1,id2:fp2,…` — every
fingerprint the client knows. The server runs the tree, but every
Partial whose computed fingerprint matches one in `?cached=` emits the
placeholder and skips its content. The client merges the fresh
Partials into `_cache` and renders the persisted template against the
combined cache.

When user code calls `useNavigation().reload({ selector: "#cart" })`,
the framework does the same thing but with `?partials=cart` in the
URL. The server finds `#cart`'s snapshot in the registry, runs _just
the Partial body_ against that snapshot's content, sends the result.
Ancestors don't run.

That's it. One render path; the payload shape (full tree vs. flat
sibling list of just the requested ids) tells the client which path
it took.

## Why RSC

Three things RSC makes possible:

**Composition is a runtime concern.** A Partial whose component the
page author never imported can render against the same request,
because RSC resolves modules server-side at request time. No bundle
pre-resolution; no contribution registry baked in at build time.

**Render owns its data.** A Partial body fetches its own data and
renders against it; data-loading and rendering share one lifetime.
`<Partial cache>` caches the _rendered output_ — a cache hit is a
Flight-bytes hit, not a tree of decoded values that has to be
re-rendered against the request.

**Streaming is native.** `renderToReadableStream` emits Flight chunks
as they're produced. A slow Partial doesn't block its siblings; each
Suspense boundary inside the tree is its own reveal. The bounded
recursive `<Piece>` pattern in `src/app/chat/` is the canonical
example — server-side streaming of arbitrary-length content with
client-side compaction at a depth bound, all over one Flight stream.

What RSC gives you that this framework adds nothing on top of: server
components, async server components, `"use server"` actions, the
Suspense boundary as a streaming unit. What this framework adds: a
primitive that makes those subtrees **addressable, fingerprinted,
cacheable, and refetchable** without re-running ancestors.

## Three render modes

`PartialRoot` (`src/lib/partial.tsx`) decides which mode to enter
based on the request URL.

| Mode                      | Trigger                                                                    | Behavior                                                                                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Streaming**             | No filter, or filter exists but no `#`-token resolves against the registry | Clears the route, runs the whole tree, every Partial body decides fingerprint-match-skip vs. fresh render. Snapshots are written to the registry as bodies run.                                                                                              |
| **Cache-mode**            | `?partials=` / `?tags=` resolves to ids the registry knows                 | Renders only the requested Partials as flat siblings, reconstructed from their snapshots. Ancestors don't execute. The client re-renders against its persisted `_template` with the new entries merged in.                                                   |
| **Registry-miss bailout** | A `#`-token in the filter doesn't resolve                                  | Drops the filter, falls back to streaming. Covers cold processes, range-expanding paginators, conditional partials that haven't rendered yet. `.class` tokens don't trigger the bailout — a tag union that resolves to a subset of known snapshots is valid. |

The fingerprint-match skip is independent of the mode. It runs
inside the `<Partial>` body in both streaming and cache mode: if the
client sent `?cached=id:fp` and the body's computed fp matches, the
Partial emits a placeholder regardless of which path the request took.

## What's idiomatic

- **State that drives a refetch lives in some URL.** Page URL for
  shareable state (search query, filter values, pagination cursor);
  frame URL for subtree-scoped state that shouldn't pollute the window
  URL (a cart drawer, a quick-view panel). The server reads it through
  `getSearchParam` / `getPathname` / `getCookie` / `getHeader`. There
  is no client→server prop-override channel.

- **Tracked accessors hoist like React hooks.** Call them at the
  synchronous top of the component body, before any `await`. Reading
  the same set of keys on every render is the contract; a render that
  reads a key the previous render didn't read throws
  `HoistingViolationError`. The discipline buys auto-derived cache keys
  and structural-fingerprint correctness with no `varyOn` declaration.

- **Selectors are CSS-style.** `#unique` for a Partial that exists once
  per page (validated at render time); `.shared` for a label any number
  of Partials may carry, refetch unions across them. `reload({ selector:
"#cart .price" })` refreshes `#cart` AND every `.price`. Server
  actions use the same grammar in `invalidate`.

- **Server actions return invalidation directives.** A successful
  action returns `{ invalidate: { selector: "..." } }`; the framework
  rewrites the response URL to a partial-refetch and runs the same
  cache-mode pipeline. The action handler doesn't reach into client
  state.

- **One client navigation surface.** `useNavigation()` returns a typed
  superset of `window.navigation`. Inside a `<Partial frame="cart">`
  it binds to that frame; outside any frame it binds to the window.
  The same code (a "back" button, a "reload" icon) works in both
  scopes.

- **`parent` is required on every `<Partial>`.** RSC interleaves async
  siblings, so a single ancestor-tracking cell drifts across awaits.
  The author threads the parent token explicitly: `ROOT` at the top,
  `capturePartialContext()` (or a `parent` prop received from a
  caller) for nested Partials. The chain lands on the snapshot, so
  cache-mode refetches reconstruct the tree position without
  re-executing ancestors.

## What's deliberately not here

- **No router abstraction beyond `URLPattern`.** `framework/router.ts`
  exposes `matchPath(pattern)` and `pickRoute([...])`. The page tree
  is plain JSX inside `Root`. A page is a function that returns JSX;
  it picks itself based on `matchPath`.

- **No static export / SSG.** Every render is a server render. The
  `manifest`-driven model doesn't preclude a future build-step that
  pre-renders routes and shells out only the dynamic Partials, but
  it's not built.

- **No styling opinion.** The demo uses Tailwind v4 + shadcn/ui;
  neither leaks into `src/lib` or `src/framework`. The Partial
  primitive doesn't generate any classes.

- **No persistent storage primitives.** `<Cache>`'s store is in-memory
  by default; the interface in `src/lib/cache.tsx` is async-by-contract
  so a Redis backend slots in, but the framework ships only the memory
  store.

- **No client-side data layer.** `graphql-request` + gql.tada in server
  components is the data path; client components are for interactivity
  on top of server-rendered content.

## Where to read next

- `partial.md` — the `<Partial>` primitive: selector grammar, parent
  context, fingerprint, defer, fallback / errorWith.
- `frames-navigation.md` — `useNavigation()` and `<Partial frame>`:
  the client surface for page nav, frame nav, and targeted refetch.
- `cache.md` — `<Partial cache>`: tracked accessors, manifest,
  hoisting rule, Cache-Control fields, storage tiers.
- `cms.md` — content store, blocks, configs, slots, editor.
- `prior-art.md` — what this borrows from and what it differs from.

`docs-dev/` holds material for someone modifying the framework itself —
render pipeline mechanics, the strip-and-reinject scheme inside
`<Cache>`, the manifest dual-attribution (ALS + cell), the
RSC test harness, the four test tiers, Flight-protocol gotchas.

`notes/` holds active research and design proposals; `archive/` holds
superseded designs with pointers to their successors.
