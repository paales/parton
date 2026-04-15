# `<Partial>` Wrapper API — Design Document

**Status:** Proposal — not yet implemented
**Supersedes:** the current `<Partials namespace="...">` + keyed-children API described in CLAUDE.md
**Related:** `Ideas.md` (trigger palette sketches), `STREAMING_DEBUG_NOTES.md` (constraints the implementation must preserve)

---

## 1. Motivation

Today a page declares partials as keyed children of a `<Partials namespace="...">` wrapper, with reserved props on each child:

```tsx
<Partials namespace="magento">
  <Hero key="hero" pokemonId={1} tags={["pokemon"]} cache={60} fallback={<Spinner/>} />
  <header key="header">
    {new Date().toLocaleString()}
    <CartPartial key="cart" tags={["cart"]} fallback={<CartBadge quantity="?"/>} />
  </header>
</Partials>
```

This works but has four ergonomic problems:

1. **Reserved props pollute the content component.** `tags`, `cache`, `fallback` are magic props stripped before render. A component that legitimately wants a `cache` prop collides.
2. **`key` is React-magic.** Cannot be typed, read, forwarded, or introspected. Using it as the partial ID is a hack.
3. **Two wrappers for layout + page.** Outer `<Partials namespace="layout">` + inner `<Partials namespace="magento">` is real machinery that page authors have to understand.
4. **No natural home for HTMX-style modifiers.** If we add `<Partial trigger="visible" debounce={300}>` later, it collides with the content component's prop namespace.

Goal: collapse all of this into one primitive — `<Partial>` — that page authors use directly, with a single framework-owned root wrapper that page code never touches.

---

## 2. Target API

### 2.1 Page author surface

```tsx
export default function ProductListPage() {
  return (
    <>
      <header>
        {new Date().toLocaleString()}
        <Partial id="cart" tags={["cart"]} fallback={<CartBadge quantity="?" />}>
          <CartPartial />
        </Partial>
      </header>

      <Partial id="products" cache={60}>
        <ProductGrid />
      </Partial>
    </>
  );
}
```

No `<Partials>` wrapper. No namespace. No `key` prop. No reserved props on `<CartPartial>` or `<ProductGrid>` — they are plain components again.

### 2.2 Framework surface (one-time, in `entry.rsc.tsx`)

```tsx
<PartialRoot>
  <App />
</PartialRoot>
```

Page authors never see this.

### 2.3 Types

```ts
export interface PartialProps {
  /** Globally unique identifier. Collision throws in dev. */
  id: string;

  /** The content rendered as a partial. */
  children: ReactNode;

  /** Invalidation tags. Server actions `revalidate: { tags: [...] }` target these. */
  tags?: string[];

  /** Server-side data cache TTL in seconds. 0 = no cache (default). */
  cache?: number;

  /** Suspense fallback while streaming/loading. */
  fallback?: ReactNode;

  /** Custom error boundary. Default: framework PartialErrorBoundary. */
  errorFallback?: ReactNode | ((error: Error, retry: () => void) => ReactNode);

  /** Activation trigger (future — HTMX-style DSL, see §7). */
  trigger?: TriggerSpec;
}

export type TriggerSpec =
  | "mount"     // default — render eagerly
  | "visible"   // IntersectionObserver
  | "idle"      // requestIdleCallback
  | "hover"     // mouseenter
  | "never"     // render only on explicit refetch
  | {
      on: "visible" | "idle" | "hover" | "interval" | "event";
      once?: boolean;
      delay?: number;           // ms before firing
      throttle?: number;        // ms minimum between fires
      debounce?: number;        // ms to wait for quiet
      rootMargin?: string;      // IntersectionObserver
      threshold?: number;       // IntersectionObserver
      interval?: number;        // polling
      event?: string;           // custom event name (future SSE channel)
      mediaQuery?: string;      // gate on matchMedia
    };

export interface PartialRootProps {
  children: ReactNode;
  /** Throw on duplicate id. Default: true in dev, false in prod. */
  strict?: boolean;
}
```

---

## 3. What moves where

| Responsibility | Today (`<Partials>`) | Proposed |
|---|---|---|
| Parse request URL (`?partials=`, `?tags=`, `?cached=`, `?__inputs=`) | `<Partials>` | `<PartialRoot>` |
| Decide streaming vs cache mode | `<Partials>` | `<PartialRoot>` |
| Collect partials + compute fingerprints | `collectPartials()` walk | same walk, rooted at `<PartialRoot>` (see §4) |
| Filter / pass-through / populate-cache logic | `<Partials>` | `<PartialRoot>` |
| `__inputs` override for refetch | `<Partials>` wrapper | `<PartialRoot>` applies via prop override |
| Build structural template | `buildTemplate()` | same, rooted at `<PartialRoot>` |
| Strip nested partials (flat-sibling render) | `stripNested()` | same |
| Wrap in Suspense + ErrorBoundary | wrapper logic | same, keyed by `id` |
| Client cache merge | `<PartialsClient>` | unchanged (namespace param dropped) |
| Namespace prefixing | URL params, cache keys, `__inputs` keys | **deleted everywhere** |
| Collision detection | n/a | `<PartialRoot>`: `Set<string>` of seen ids, throw on duplicate |

---

## 4. Discovery: how `<Partial>` is found (decided: Option A)

**Decision:** static element-tree walk from `<PartialRoot>`, matching today's `collectPartials` behavior. Keeps the refactor as close to the current implementation as possible; preserves flat-sibling render isolation.

### 4.1 How the walk works

`<PartialRoot>` walks its `children` prop as an element tree **before rendering**, recursing through any element's `children` prop to find `<Partial>` elements. The walker does not descend into a function component's *return value* — only into the `children` prop of an element it encounters.

**Constraint:** `<Partial>` elements must be reachable via JSX `children` chains from `<PartialRoot>`. They can be wrapped by any structural JSX (divs, sections, layout components that forward `children`), but they cannot be *created inside* a function component's return value.

#### What works

Wrapping divs and semantic HTML are fine — the walker descends through any element's `children` prop:

```tsx
<PartialRoot>
  <div className="page">
    <header>
      <Partial id="cart">...</Partial>    {/* found */}
    </header>
    <main>
      <section>
        <Partial id="products">...</Partial>  {/* found */}
      </section>
    </main>
  </div>
</PartialRoot>
```

Function-component wrappers that forward `children` are also fine. The walker sees `<Partial>` via the wrapper's `children` prop, regardless of what the wrapper *renders*:

```tsx
function Layout({ children }) {
  return <div className="layout"><main>{children}</main></div>;
}

<PartialRoot>
  <Layout>
    <Partial id="hero">...</Partial>    {/* found — passed as Layout's children */}
  </Layout>
</PartialRoot>
```

Pages can be authored as components that return JSX with any wrapping structure, as long as the `<Partial>` elements are in the tree passed *down* through `children`:

```tsx
// pages/pokemon.tsx — standard component, returns JSX with wrappers
export default async function PokemonPage({ id }) {
  const data = await load(id);
  return (
    <div className="pokemon-page">
      <Partial id="hero" fallback={<Spinner/>}>
        <Hero {...data} />
      </Partial>
      <Partial id="stats" cache={60}>
        <Stats {...data} />
      </Partial>
    </div>
  );
}
```

To be walkable, this page needs to be placed as `children` of `<PartialRoot>`, not called inline as a new component. The router does this — e.g., it resolves the route, awaits the page function, and slots the returned JSX directly under `<PartialRoot>`:

```tsx
// Router (framework-owned)
async function Router() {
  const pageElement = await resolvePage(request);  // the JSX above
  return <PartialRoot>{pageElement}</PartialRoot>;
}
```

#### What does NOT work

Creating `<Partial>` inside a component that is *itself rendered* as a component (not passed as children):

```tsx
function ProductCard({ id }) {
  return <Partial id={`product-${id}`}>...</Partial>;  // created here
}

<PartialRoot>
  <div>
    <ProductCard id={1} />   {/* walker sees <ProductCard/>, not its output */}
  </div>
</PartialRoot>
```

This fails silently — the `<Partial>` is invisible to the walker, never registered, never filterable. If we want to allow this later, it's a separate feature (Option B, see §4.2); for now, page authors must place `<Partial>` elements directly in the JSX tree that flows into `<PartialRoot>`.

### 4.2 Option B (rejected for now)

For historical context: an alternative design has `<Partial>` self-register at render time via a request-scoped context, which would allow it to live inside any function component. Rejected because:

- Breaks flat-sibling isolation — a nested `<Partial>` inside a parent `<Partial>` receives the parent's React context on full render but not on independent refetch (rendered as a flat sibling). Inconsistent, bug-prone.
- Discovery-vs-filter chicken-and-egg: deciding whether a parent partial should render as a placeholder requires knowing whether it contains an active descendant, which only exists after rendering.
- Larger refactor; farther from today's implementation.

Worth reconsidering if the "`<Partial>` lives inside any component" ergonomic becomes important. Not today.

---

## 5. Walking through the example

Given this page (from `src/app/pages/magento/product-list.tsx` lines 51–58):

```tsx
<header key="header">
  {new Date().toLocaleString()}
  <CartPartial
    key="cart"
    tags={["cart"]}
    fallback={<CartBadge quantity={"?"} />}
  />
</header>
```

### 5.1 Rewritten in the new API

```tsx
<Partial id="header">
  <header>
    {new Date().toLocaleString()}
    <Partial id="cart" tags={["cart"]} fallback={<CartBadge quantity="?" />}>
      <CartPartial />
    </Partial>
  </header>
</Partial>
```

Note: `<header>` is no longer keyed — it's a plain HTML element. The partial-ness is carried by `<Partial id="header">` wrapping it.

### 5.2 Full-page render

1. `<PartialRoot>` walks its children statically. Finds:
   - `<Partial id="header">` at depth 0
   - `<Partial id="cart">` at depth 1 (nested inside header's children tree)
2. `collectPartials` returns `[{id: "header", ...}, {id: "cart", depth: 1, ...}]`. `nestedIds = {"cart"}`.
3. No filter applied → streaming mode, render all.
4. `stripNested` replaces `<Partial id="cart">` inside header's children with a placeholder (`<i hidden data-partial="cart"/>`). Header renders its date + the placeholder.
5. `<Partial id="cart">` renders separately as a flat sibling at the top level.
6. Client receives both fresh partials + the structural template. Template merge: client places cart's fresh HTML into the `<i data-partial="cart"/>` slot inside header.

### 5.3 Refetch `?partials=cart`

1. Filter resolves to `{cart}`. Header is NOT active.
2. Server renders only `<Partial id="cart">` (fresh).
3. Client has header cached from the previous render. Template merge: fresh cart HTML replaces the cart slot inside the cached header.
4. Header does not re-render — the date does not tick forward.

### 5.4 Refetch `?partials=header`

1. Filter resolves to `{header}`.
2. `stripNested` strips cart from header's children (replaced with placeholder).
3. Server renders header fresh (new date). Cart is NOT re-rendered — it's already cached and the placeholder tells the client to fill from cache.
4. Client receives fresh header, places cached cart into the placeholder slot.

### 5.5 Refetch `?tags=cart`

Same as §5.3 — tag resolves to `{cart}` via the tag index.

---

## 6. The React context question

> **Question from the user:** "No shared context doesn't make sense as context isn't available in server components, right? But a parent component still is rendered first and could influence global scope."

**Partial correction:** React 19 does support Context in server components — request-scoped, with the caveat that server components cannot read context set by client components. So sharing theme/i18n/request context across the server tree IS possible.

**The real isolation guarantee:** with flat-sibling rendering (Option A's `stripNested`), nested partials do not share React context across partial boundaries, because a nested partial's "refetch" render happens as a flat sibling at the root, outside any Provider the parent might have declared.

Concretely:

```tsx
<Partial id="parent">
  <ThemeContext.Provider value={dark}>
    <Partial id="child">
      <Child /> {/* reads ThemeContext */}
    </Partial>
  </ThemeContext.Provider>
</Partial>
```

| Scenario | Full render | Refetch parent | Refetch child |
|---|---|---|---|
| Parent renders? | yes (with provider) | yes (provider present; child is stripped to placeholder) | no (cached) |
| Child renders? | yes, reads `dark` from provider | yes, as a flat sibling — **no provider** → reads default context value | yes, as a flat sibling — **no provider** |

So on full-page render the child reads `dark`, but on any refetch the child reads the default context value. This is inconsistent and a real foot-gun.

**Design rule:** partials are isolated units. Shared React context across partial boundaries is unsupported. If a child partial needs request-level data (user, locale, theme, request URL), it reads it from framework-provided sources (e.g., `getRequest()`), not from React context set by a parent partial.

The global-scope concern the user raised (mutable module state that a parent partial sets and a child reads) is a different, worse problem — don't do it. There is no framework defense; it is a code-review-level rule.

---

## 7. Trigger palette — REJECTED (see §11)

> **Status update (2026-04-15):** this entire direction is rejected.
> See §11 "Lessons learned" for the reasoning and §12 for the
> narrower replacement (dormant partials).
>
> The original table is kept below as historical record — it shows
> what we *thought* we'd build before the renderOn experiment
> proved the DSL direction wrong.

---

### (historical) Trigger palette sketch

HTMX, Phoenix LiveView, and Magento Section API all converged on the same trigger vocabulary. When we add this, the DSL lives on `<Partial trigger={...}>`. Reference table:

| Intent | HTMX | LiveView | Proposed `trigger` |
|---|---|---|---|
| on visible | `hx-trigger="revealed"` | `phx-viewport-top` | `"visible"` or `{on:"visible", rootMargin, threshold}` |
| on idle | — | — | `"idle"` |
| on hover (prefetch) | `hx-trigger="mouseenter once"` | — | `{on:"hover", once:true}` |
| debounced | `delay:500ms` | `phx-debounce="500"` | `{debounce: 500}` |
| throttled | `throttle:1s` | `phx-throttle="1000"` | `{throttle: 1000}` |
| polling | `every 2s` | — | `{on:"interval", interval: 2000}` |
| media query | — | — | `{mediaQuery: "(min-width: 768px)"}` |
| server-pushed | `HX-Trigger:` header + custom event | pubsub | `{on:"event", event:"cart-updated"}` + SSE channel |

This is deferred. The point of documenting it here is that the API surface `<Partial>` has room for it; the current `<Partials>` + keyed-children API does not.

---

## 8. Implementation plan

Single-commit migration. No backwards compatibility — `<Partials namespace>` and all namespace handling is deleted in the same change that introduces `<PartialRoot>` + `<Partial>`. Everything is validated green (unit + playwright) before the commit lands.

Scope estimate: half a day to a day of focused work, assuming STREAMING_DEBUG_NOTES-era tests stay green after migration.

1. **New file: `src/lib/partial-component.tsx`** (~80 lines)
   `<Partial id ...>` server component. A marker — `<PartialRoot>` does the real work via static walk. `<Partial>` itself renders `children` (or a placeholder) based on what `<PartialRoot>` decided.

2. **Refactor `src/lib/partial.tsx`** (~200 lines touched)
   - Rename exported `Partials` → `PartialRoot`
   - Drop `namespace` prop and all prefixing logic
   - Update `collectPartials` to recognize `<Partial>` elements by component type (`child.type === Partial`) instead of by `key != null`
   - Update `fingerprintElement` to unwrap `<Partial>` wrappers (fingerprint the inner content + the `id`/`tags`/`cache` metadata)
   - Update `stripNested` / `buildTemplate` / `transformForStreaming` to match
   - Add `Set<string>`-based collision detection with synchronous throw on duplicate `id`

3. **Refactor `src/lib/partial-client.tsx`** (~50 lines touched)
   - Drop `namespace` prop from `PartialsClient`
   - Drop prefix handling in `usePartial`, `usePartialParams`, cached-token parsing, `__inputs` serialization

4. **Refactor `src/framework/entry.rsc.tsx` + `entry.browser.tsx`**
   - Drop namespace from `?cached=` emission and `?__inputs=` keys
   - Swap the top-level `<Partials namespace="layout">` for `<PartialRoot>`
   - Remove per-page inner `<Partials namespace="...">` wrappers — pages return normal JSX with `<Partial>` elements inside wrapping structure

5. **Migrate app code**
   - `src/app/pages/pokemon.tsx`: replace `<Partials><X key=...>...</Partials>` with JSX containing `<Partial id="X">...</Partial>` elements
   - `src/app/pages/magento/product-list.tsx`: same migration for `header` + `cart` + `products`
   - `src/app/pages/bare-stream.tsx`: no partials, unchanged
   - `src/app/components/load-more.tsx`: `usePartial` call loses namespace concern

6. **Tests**
   - Drop namespace assertions from existing tests
   - Add collision-detection test (two `<Partial id="cart">` in the same tree → throws)
   - Add context-isolation test (parent `<Partial>` with Provider; child `<Partial>` on independent refetch sees default context — documents the foot-gun from §6)
   - Full playwright suite must pass

7. **Docs**
   - Update `CLAUDE.md` to describe the new API
   - Leave `PARTIAL_WRAPPER_DESIGN.md` as historical record of the refactor; link from `CLAUDE.md`

---

## 9. Decisions

Decisions made before implementation starts. Recorded here so a future reader understands why the design is what it is.

| # | Question | Decision |
|---|---|---|
| 1 | Option A (static walk) vs Option B (self-registering) | **Option A** — stay close to current implementation; preserve flat-sibling isolation |
| 2 | Root wrapper name | `<PartialRoot>` |
| 3 | Collision behavior | **Throw** (dev and prod) |
| 4 | Page authoring convention | Any JSX — wrapping divs, semantic HTML, and function-component wrappers that forward `children` are all supported (§4.1). No special "pages return arrays" convention. |
| 5 | Backwards compat | **None.** Single-commit migration with all apps + tests green. |

---

## 10. Non-goals of this refactor

- Adding the trigger palette (§7) — deferred, but API leaves room
- SSE / push-based invalidation — deferred (see brainstorm notes, not this doc)
- Changing the streaming / cache / revalidate mode logic — preserved verbatim
- Changing the GraphQL data layer — orthogonal
- Changing the proxy data layer (legacy, see `PROXY_DESIGN.md`) — untouched

---

## 11. Lessons learned (2026-04-15)

The refactor shipped: `<PartialRoot>`, `<Partial id>`, `usePartial`,
`usePartialParams` all landed and all pull their weight. Infinite
scroll on `/bare` composes on them without touching any framework
internals. The walker-discovery claims in §4 were validated with a
six-test vitest suite (`src/lib/__tests__/partial.test.tsx` →
"Walker discovery limits").

What did **not** earn its weight: `renderOn` and the trigger-palette
direction in §7. This section records why, so a future reader
doesn't re-litigate it.

### 11.1 What we tried

We shipped `renderOn="visible"` as the first (and only) trigger:
the framework substitutes an internal `DeferredPartial` client
component when the partial is not in the explicit filter. The
DeferredPartial renders the `fallback`, observes itself with
`IntersectionObserver`, and dispatches `usePartial(id).refetch()`
when visible.

For one specific case — the trivia card on `/pokemon/:id`, a
singleton known-id below-the-fold partial — it works.

### 11.2 What killed the DSL direction

The next real case (infinite scroll) needed triggers that a DSL
cannot express:

- **Mutate URL state** before firing — `silentReplace` bumps
  `?end=N+1` so the URL is bookmarkable and reload-safe.
- **Refetch a *different* partial** — the "next" trigger activates
  `page-{N+1}`, not itself.
- **Coordinate multiple dispatches** — `setParams`, `dispatchPage`,
  `dispatchNext` batched in one microtask.

None of that is expressible as `{on:"visible", debounce, throttle,
rootMargin, threshold}`. It is app logic. `src/app/components/next-observer.tsx`
is ~50 lines of plain `"use client"` code using `usePartial` +
`usePartialParams`. It reads fine. It composes.

### 11.3 Why HTMX's DSL is the right primitive for HTMX and the wrong one for us

HTMX has no programming model — no JS, no state, no callbacks.
Its trigger DSL exists because HTML attributes were the only
expressive surface available. It had to invent `hx-trigger` to
express anything at all.

We have React, hooks, and `"use client"` components. Our natural
primitive is already `useEffect` + `IntersectionObserver` +
`usePartial`. A `{on, debounce, throttle, rootMargin}` DSL would
be a second, worse way to express what hooks express — and would
cap out well before the infinite-scroll case.

HTMX triggers are beautiful **because** HTMX has no alternative.
Ours would be gratuitous.

### 11.4 Revised position on §7

The full trigger palette is **rejected as framework API**. Debounce,
throttle, delay, interval, mediaQuery, event — all of it is app
concerns, written in app code, with full access to the surrounding
request/state/transition context.

The one use case `renderOn` still earns — self-activating singleton
partials where the trigger *is* the entire behavior — is handled
by the narrower primitive proposed in §12.

---

## 12. Dormant partials (replaces `renderOn`)

### 12.1 Shape

Replace `renderOn` with a single boolean prop: `defer`.

```tsx
<Partial id="trivia" defer fallback={<TriviaSkeleton/>}>
  <TriviaContent pokemonId={id}/>
</Partial>
```

Semantics:

- A deferred partial renders its `fallback` on initial load and on
  any refetch that does not explicitly target it.
- It renders its `children` only when its id appears in `?partials=`
  or `__inputs` — i.e. a client explicitly activated it.
- The framework provides no trigger machinery. Activation is
  whatever the app wires: `usePartial(id).refetch()` called from a
  button click, `IntersectionObserver`, hover, timer, SSE message,
  `requestIdleCallback`, media-query match — whatever.

### 12.2 The trivia card under this model

Current code (with `renderOn`):

```tsx
<Partial id="trivia" renderOn="visible" fallback={<Spinner/>}>
  <TriviaContent pokemonId={id}/>
</Partial>
```

Proposed code (with `defer`):

```tsx
<Partial id="trivia" defer fallback={
  <TriviaSkeleton>
    <VisibleTrigger partialId="trivia"/>
  </TriviaSkeleton>
}>
  <TriviaContent pokemonId={id}/>
</Partial>
```

`VisibleTrigger` is an app-provided `"use client"` utility — same
shape as `NextObserver` but simpler (no URL mutation, just an
IntersectionObserver that calls `usePartial(partialId).refetch()`).
Because the trigger lives *inside* the fallback, it unmounts as
soon as activation happens; no manual teardown.

### 12.3 Other triggers, for free

The `defer` primitive makes every trigger shape possible without a
framework change:

- **Hover prefetch:** `onMouseEnter={() => dispatch()}` on a link.
- **Click:** a button whose `onClick` activates a partial.
- **Idle:** a client component using `requestIdleCallback`.
- **Timer / interval:** `setInterval` in a client effect.
- **SSE / push:** listen to an EventSource in a client provider,
  dispatch on message.
- **Conditional on media query:** `matchMedia` listener.

None of these need framework support. They are all ~15 lines of
client code with `usePartial` at the core.

### 12.4 Why this is better than `renderOn`

- **Decoupled.** `<Partial>`'s API stops caring about when content
  activates. `defer` is a single bit: "dormant or not."
- **Extensible.** The DSL in §7 would cap out; composition does not.
- **Combinable.** Two triggers can coexist — a `<VisibleTrigger>`
  *and* a `<Button>` that both activate the same partial.
- **Honest.** It exposes the two-step nature (declare dormant,
  then activate from the client) that `renderOn` hid behind an
  injected `DeferredPartial`.

### 12.5 Migration

- Delete the `renderOn` prop, the `RenderOn` type, and the
  `normalizeRenderOn` / DeferredPartial-substitution branches in
  `partial.tsx`.
- Keep `DeferredPartial` as an app-level component (rename to
  `VisibleTrigger`, maybe) — not framework API.
- Migrate the trivia example in `pokemon.tsx` to the `defer +
  VisibleTrigger` pattern.
- The walker-discovery tests stay as-is; they don't exercise
  `renderOn`. The three existing `renderOn` vitest tests get
  replaced with `defer` equivalents.
- `e2e/render-on-visible.spec.ts` is renamed and rewritten to test
  the `defer + VisibleTrigger` composition — asserting the same
  behaviors (fallback on initial render, single RSC refetch on
  scroll, real content replaces fallback).

### 12.6 Open questions

- Do we still emit a `<span data-partial-deferred>` marker around
  the fallback? With `defer` the app owns rendering; probably no
  framework-injected wrapper is needed. To be decided when we
  implement.
- Does `defer` interact with `cache`? A partial with `defer
  cache={60}` would still honor the cache on activation — no
  special case. Worth a test.

