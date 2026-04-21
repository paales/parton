# Unified navigation surface — design note

**Added:** 2026-04-21
**Updated:** 2026-04-21 (Navigation API cutover — see "Navigation API migration" below).
**Status:** implemented.
**Files:** `src/lib/partial-client.tsx`, `src/lib/partial.tsx`, `src/lib/partial-component.tsx`, `src/framework/entry.browser.tsx`, `src/framework/navigation-api.ts`.
**Supersedes:** `usePartial`, `usePartialParams`, `__inputs`, `silent-replace.ts`, classic `history.pushState` / `replaceState` in app-path code (all removed). See `../archive/USE_PARTIAL_AND_INPUTS.md` for the old model.

---

## One-liner

Every client-initiated render is a navigation. `useNavigation()` returns a single handle that drives the page URL, a frame URL, or a targeted partial refetch — the only thing that changes is the options.

```ts
const nav = useNavigation();          // page scope (or ambient frame)
const cart = useNavigation("cart");   // explicit frame by name

nav.navigate("/products?sort=price", { history: "push" });            // full page nav
nav.navigate(url,    { history: "replace", tags: ["search-results"] }); // URL update + targeted refetch
nav.navigate(url,    { history: "replace", silent: true });             // URL update only, no refetch
nav.reload({ ids: ["cart"] });                                           // targeted refetch, no URL change
nav.reload({ tags: ["price"] });                                         // tag-resolved refetch
nav.back(); nav.forward(); nav.reload();                                 // everything else you'd expect
```

No `usePartial`, no `__inputs`, no `silentReplace`. State lives in **some URL** (page or frame); the server reads it through the existing tracked accessors (`getSearchParam` / `getPathname` / `getCookie` / `getHeader`).

## Why

The old model had three semi-overlapping client APIs:

1. `useNavigation()` for page and frame URL state.
2. `usePartial(selector).refetch(props)` for partial-level refetches. `props` rode along as `?__inputs=...` and applied as `cloneElement` overrides on the Partial's content.
3. `usePartialParams()` + `silentReplace()` for refetches that wanted transient URL params without mutating history.

Reasons to collapse them:

- **`__inputs` is a hidden state channel.** Prop overrides that don't live in any URL break bookmarkability, can't be server-rendered on a cold load, and bake into the registry snapshot (fingerprint-after-applyInputs kept the Cache path honest but added its own complexity).
- **Three ways to update the URL.** `history.pushState` (direct), `silentReplace` (suppress intercept), `useNavigation().navigate` (via Navigation API) — each with subtly different rules. The Navigation API cutover (see bottom) finished this: there is now exactly one URL writer.
- **The selector grammar (`.tag.tag2`)** was a whole client-side index (`_partialTags`) and parser that only served refetch. Tag→id resolution at the server is enough; the client doesn't need the index.
- **The frame work (2026-04-20) already established the shape.** `useNavigation().navigate` works inside and outside frames. Extending it to carry `ids` / `tags` / `silent` covers the remaining cases.

## Surface

### `NavigateOptions`

```ts
interface NavigateOptions {
  history?: "auto" | "push" | "replace";  // Navigation API
  state?: unknown;
  info?: unknown;
  disableTransition?: boolean;  // bypass startTransition on commit

  ids?: string[];    // targeted refetch by id
  tags?: string[];   // targeted refetch by tag (server-side resolution)
  silent?: boolean;  // update URL only, skip refetch entirely
}
```

Decision matrix on `navigate(url, opts)` for the window handle:

| `silent` | `ids` / `tags` | Behavior |
|---|---|---|
| `true` | — | `navigation.navigate(url, { info: silent-marker })`, no refetch. Bookmarkability-only URL sync. |
| `false` (default) | set | `navigation.navigate(url, { info: silent-marker })` + targeted refetch (microtask-batched). Page-level intercept is bypassed. |
| `false` (default) | unset | Default: `window.navigation.navigate(url)` → intercept fires → full-page refetch. |

For `reload(opts)`:

| `ids` / `tags` | Behavior |
|---|---|
| set | Targeted refetch of current URL. No history mutation. |
| unset | `window.navigation.reload()` → full-page refetch. |

Frame handles (`useNavigation("name")`) ignore `ids` / `tags` / `silent` on `navigate`: frame navigation refetches the frame Partial, which re-runs its subtree with the new frame URL. A frame `reload()` just redispatches the current frame URL.

### Dispatch

A targeted refetch URL looks like:

```
/pokemon/1?search=url&q=pika & partials=page-stage-1,page-stage-2,page-stage-3 & cached=header:… & disableTransition=1
```

Built by the module-level dispatcher in `partial-client.tsx`:

- **Microtask-batched.** Two `reload({ids: ["a"]})` + `reload({tags: ["b"]})` calls in the same tick coalesce into one request with `?partials=a&tags=b`.
- **`?cached=id:fp,…`** is appended with every fingerprint the client has EXCEPT the ones being targeted (the server would skip them as unchanged otherwise).
- **Silent info marker.** When the dispatcher calls `navigation.navigate(url, ...)` for a URL-only update (silent / targeted-refetch), it stamps a branded `info` payload (`{__framework: "silent-navigate", mode: "window" | "frame"}`). The navigate listener reads `event.info`, calls `event.intercept()` with no handler (declaring same-document), and returns — no refetch. The classic History API is out of the picture.

### Frame navigation

Frame `navigate()` also goes through `navigation.navigate` — same-URL push/replace carrying the updated frames snapshot in `state`, stamped with an `info` marker (`{mode: "frame", name}`) so the page-level listener doesn't also refetch. After commit, the frame refetch runs (`?__frame=name&__frameUrl=…&partials=name`). `ids` / `tags` / `silent` options are accepted but ignored (frame refetch is coarse by design).

### Tag-based refetch

Tags are resolved **server-side** against the route-scoped partial registry (`partial.tsx:resolveTagsToIds`). The client never maintains a tag index.

```ts
nav.reload({ tags: ["price"] });
// → GET /foo?tags=price&cached=…
// server: match "price" against registered snapshots → {price-abc, price-def, price-ghi}
// server: render those three from their snapshots
```

**Union semantics on multiple tags.** `{tags: ["a", "b"]}` matches any partial carrying tag `a` OR tag `b`. Intersection (the old `.tag1.tag2` grammar) is gone; if you need it, give the intersection its own tag (e.g. `tags="price featured-price"`).

## How app code patterns map

| Old | New |
|---|---|
| `usePartial("cart").refetch()` | `useNavigation().reload({ids: ["cart"]})` |
| `usePartial(".price").refetch()` | `useNavigation().reload({tags: ["price"]})` |
| `usePartial("search").refetch({query: q})` | Put `q` in a URL: `nav.navigate(urlWithQ, {tags: ["search-results"]})`. Server reads `getSearchParam("q")`. |
| `silentReplace(url)` | `nav.navigate(url, {history: "replace", silent: true})` |
| `silentReplace(url); dispatchStage1(); dispatchStage2();` | `nav.navigate(url, {history: "replace", ids: ["stage-1", "stage-2"]})` |
| `frame("cart").navigate("/checkout")` | `useNavigation("cart").navigate("/checkout")` — the plain-function `frame()` is now framework-internal (`_frame()`, not exported from `src/lib/index.ts`). |

## Activators

`useActivate(partialId, subscribe)` still exists; `subscribe` receives a zero-arg `fire()` that dispatches `reload({ids: [partialId]})`. If an activator needs to pass dynamic state to the server, it writes that state to a URL before firing (see `src/app/components/when-stored.tsx` for the canonical pattern: the component calls `useNavigation()` in render and closes over the handle in the subscribe callback, which writes `?<as>=<value>` via `nav.navigate(url, {history: "replace", silent: true})` and then fires).

## Trade-offs

**Lost: ephemeral per-refetch state.** The old `usePartialParams` could push `?q=p` onto just the refetch URL without touching history. The new model forces that state into _some_ URL (page or frame). If you don't want it in the page URL, wrap the subtree in a `<Partial frame="search">` and navigate the frame — its URL is session-backed and never pollutes the window.

**Lost: client-side tag intersection (`.a.b`).** Move to either a composite tag or to an id list. Server-side resolution does union only.

**Won:** one API surface, one place for URL mutation (`navigate`), one silent mechanism, one dispatcher. State discovery is uniform: every client-side state source flows through `nav.currentUrl` (page or frame), is written via `nav.navigate(newUrl, opts)`, and is read server-side via tracked accessors.

## Sharp edges

1. **Stages inside `<Partial cache>` inside a frame can't read frame scope from their body.** Cache's inner render uses `renderToReadableStream` which opens a new React internal context — the `React.cache`-backed frame scope cell doesn't propagate. Workaround: have the PARENT of the cached Partial read the scope accessor and pass the value as a scalar prop. The fingerprint includes the scalar prop, so cache keys remain URL-correct. Pattern in pokemon.tsx: `SearchArea` reads `getSearchParam("q")` and passes `<SearchStageN query={q}/>`. See `src/lib/cache.tsx:570` for where the frame request is captured.

2. **Tag refetch needs the registry warm.** `resolveTagsToIds` works off `getRouteSnapshots(route)`. If a conditional Partial has never rendered, it's not in the registry and the tag filter misses it. Two options: (a) render the Partial unconditionally, let its body short-circuit when there's nothing to do (the `SearchStage2`/`3` pattern); (b) tag the enclosing container instead of the stages — the refetch rebuilds the container, which re-creates the stages on each refetch. The pokemon-page search demo uses (b) because stages are cache-wrapped and the stage snapshots would otherwise bake a stale `query` prop.

3. **`nav.currentUrl` for the window handle is `pathname + search`, not the full URL.** Callers that want to construct a new URL with `new URL(...)` need to supply a base — either `location.origin` or a throwaway `http://_`. This is deliberate: the throwaway base keeps the code free of `window.location` references so the same helper (`withParam(base, key, value)` in search.tsx) works for page AND frame URLs without branching.

## Implementation pointers

| Piece | File | What it does |
|---|---|---|
| `useNavigation()` hook | `src/lib/partial-client.tsx` | Returns scope-bound handle. Subscribes to `navigate` events for reactive getters. |
| `buildWindowNavigationHandle()` | `src/lib/partial-client.tsx` | Page-scoped handle. Decides between Navigation API and direct dispatch based on `ids` / `tags` / `silent`. |
| `buildFrameHandle()` | `src/lib/partial-client.tsx` | Frame-scoped handle. Writes frame state via `navigation.navigate(sameUrl, { state, info })` + session-backed frame URL. |
| `enqueueRefetch()` + `flushRefetchBatch()` | `src/lib/partial-client.tsx` | Microtask-batched dispatcher. Reads `_fingerprints` for `?cached=`. |
| `makeSilentInfo()` / `isFrameworkSilentInfo()` | `src/lib/partial-client.tsx` | Branded `info` payload stamped on internal `navigation.navigate` calls. The listener in `entry.browser.tsx` reads `event.info` and short-circuits with `event.intercept()` (no handler) so no refetch runs. |
| Server-side tag → id resolution | `src/lib/partial.tsx:resolveTagsToIds` | Unchanged from pre-migration. |
| Ambient frame URL folded into fp | `src/lib/partial-component.tsx` | For Partials inside a frame subtree — their structural fp alone doesn't capture URL-derived state; folding the ambient URL keeps fingerprint-skip decisions honest. |

## Navigation API migration (follow-up, 2026-04-21 later)

The initial unification left two URL-writing paths in the internal
dispatcher: `useNavigation().navigate` for user-initiated nav, and
`history.pushState` / `replaceState` for silent URL syncs (targeted
refetches, frame state pushes, activator URL writes). The latter was
coordinated with a 50 ms `performance.now()` window
(`markSilentNextNavigate` / `_consumeSilentFlag`) that the navigate
listener consumed to skip the intercept.

That mechanism is gone. The dispatcher now calls `navigation.navigate`
for those paths too and stamps a branded `info` payload
(`{__framework: "silent-navigate", mode: "window" | "frame", name?}`)
via `makeSilentInfo`. The listener reads `event.info`, matches via
`isFrameworkSilentInfo`, and calls `event.intercept()` with no handler
— declaring same-document without running a refetch. No time window,
no race, no second URL writer.

### Consequences

- **No classic History API in active framework code.** The remaining
  `history.*` reference is `history.scrollRestoration = "manual"` in
  `src/app/components/scroll-restore.tsx` (not replaced by Navigation
  API). Test files still use `history.replaceState` to seed jsdom's
  URL — those are test-env setup, not production.
- **No `typeof window === "undefined"` / `typeof navigation === "undefined"` checks** in the framework.
  The single accessor `getNavigation()` (in `src/framework/navigation-api.ts`) returns
  `FrameworkNavigation | null` by reading `globalThis.navigation`.
- **Types moved off ambient.** `src/framework/navigation-api.d.ts` is
  deleted. `src/framework/navigation-api.ts` is a regular module that
  exports only the pieces TS 5.9's `lib.dom.d.ts` doesn't ship
  (`Navigation`, `NavigateEvent`, `NavigationDestination`,
  `NavigationTransition`, `NavigationCurrentEntryChangeEvent`), plus a
  framework-refined `FrameEntryState` / `FrameNavigationHistoryEntry`.
  No global pollution.
- **`frame()` / `windowNav()` renamed to `_frame()` / `_windowNav()`**
  and removed from `src/lib/index.ts`. App code uses `useNavigation()`
  for everything. The underscore-prefixed escape hatches exist for
  code that can't call hooks (class-component methods like
  `PartialErrorBoundary.retry`).
- **`useNavigation()` memoizes the handle.** Pre-migration, the handle
  was a fresh object each render; post-migration the `navigate` event
  fires on silent navs too (it didn't pre-migration — `pushState`
  doesn't fire `navigate`), so a consumer effect with `[nav]` in its
  dep list would re-run on every commit. `useMemo(..., [resolved])`
  stabilizes the reference so only the bound name changing triggers a
  re-subscribe. Live values still come through the getters.
- **`_frameUrls.set(name, url)` moved before `navigation.navigate`**
  in the frame path. The navigate event fires synchronously from
  `nav.navigate(...)` and bumps reactive consumers via the
  `useNavigation`-internal tick; waiting until after `await committed`
  to update the cache would render the bump against stale data (visible
  as a stuck "Close" button on frame-scoped dialogs after Escape).
- **vitest needs a Navigation API shim.** jsdom doesn't implement it.
  `vitest.setup.ts` installs a minimal shim that delegates
  `navigate` / `back` / `forward` to `history.*`, plus sets
  `IS_REACT_ACT_ENVIRONMENT = true`. The `@vitejs/plugin-rsc` plugin
  is skipped in the test config (`isTest ? [react()] : [rsc(), react()]`)
  — its `"use client"` transform otherwise wraps modules in
  client-reference proxies that break hook rendering in jsdom.
