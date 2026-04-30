> **Superseded 2026-04-28** by
> [`notes/partial-define-step-api.md`](./partial-define-step-api.md)
> — same vary/render core, but moved from a call-site `<Partial>`
> prop pair to a `ReactCms.partial(Render, …)` constructor at module
> scope. The constructor subsumes `registerBlock`, auto-derives
> `selector` and `cmsId`, and drops all ALS in one pass.

# `<Partial vary={...} render={...}>` — explicit dependency surface

Proposal to replace the implicit access-pattern manifest with an
explicit `vary` function. The function takes the current request,
returns a flat object of computed values, and the framework forwards
that object as props to `render`.

```tsx
<Partial
  vary={(request) => ({
    isHome: request.pathname === "/",
  })}
  render={HomePage}
/>

function HomePage({ isHome }: { isHome: boolean }) {
  return isHome ? <HeroBanner /> : <BreadcrumbBar />
}
```

## What goes away

Every cell-drift / hoisting-check / manifest-baseline mechanism in
the framework is downstream of "we don't know which Partial body a
tracked accessor's read belongs to." Move the read into a function
the author explicitly hands the framework, and:

- **No per-request manifest cell.** The accessors don't write to a
  cell; they're called inside a function the framework provides the
  request to.
- **No hoisting check.** The dependency surface IS the keys the
  `vary` function returns. There's nothing to compare across renders
  — every render re-computes by definition.
- **No first-render-vs-warm-render asymmetry.** The fingerprint is
  derivable on the very first render: hash of the `vary` result.
  No `stored` / `baseline` / `liveManifest` distinction.
- **No conditional-read-after-early-return idiom.** The vary function
  is a pure data computation; "conditional" reads inside it just
  short-circuit. The shape of the returned object is the contract.
- **No `getRequest()` reach in app code.** The request is passed in
  as an argument, not pulled from ALS. `vary` is a pure function of
  its input.
- **No drift across siblings / awaits.** `vary` is sync, takes the
  request directly, returns. No async, no React rendering inside it.

## What stays the same

- **Snapshot registry.** The `render` function still gets snapshotted
  for cache-mode refetches; it's the body that re-runs against the
  current request via `vary`.
- **`<Cache>` with `vary` scalars on the snapshot.** The vary result
  is naturally the cache-key surface — same hash, but with the
  values explicit instead of resolved-from-manifest.
- **Frames.** A frame's request is what `vary` receives when the
  Partial declares `frame="search"`. Same scoping rules; the source
  changes from "the ambient cell" to "the explicit argument."
- **CMS scope.** `getText` / `getEnum` / `getReference` reads happen
  inside `render`, against the Partial's `cmsId` scope. Same as today.
- **Parent chain, frame chain, provides.** All threaded the same way
  via `parent` / `provides` props.

## What changes for authors

Today:

```tsx
function PokemonPage() {
  const routeIdStr = getPathname("/pokemon/:id")?.id
  const pokemonId = routeIdStr && /^\d+$/.test(routeIdStr) ? Number(routeIdStr) : undefined
  const urlSearchOpen = getSearchParam("search") != null
  const pages = Math.max(1, Number(getSearchParam("pages")) || 1)
  return (
    <>
      <Partial parent={ROOT} selector="#header">
        <header>...<SearchToggle urlOpen={urlSearchOpen} /></header>
      </Partial>
      ...
    </>
  )
}
```

Tomorrow:

```tsx
<Partial
  parent={ROOT}
  selector="#pokemon-page"
  vary={(req) => {
    const slug = req.pathname.match(/^\/pokemon\/(\d+)$/)?.[1]
    return {
      pokemonId: slug ? Number(slug) : undefined,
      urlSearchOpen: req.searchParams.get("search") !== null,
      pages: Math.max(1, Number(req.searchParams.get("pages")) || 1),
    }
  }}
  render={PokemonPageBody}
/>

function PokemonPageBody({ pokemonId, urlSearchOpen, pages }: {
  pokemonId: number | undefined
  urlSearchOpen: boolean
  pages: number
}) {
  return (
    <>
      <Partial parent={ROOT} selector="#header">
        <header>...<SearchToggle urlOpen={urlSearchOpen} /></header>
      </Partial>
      ...
    </>
  )
}
```

The ergonomic delta: `vary` is one extra function the author writes,
but the call-site is colocated with the Partial declaration, the
dependency surface is explicit, and the body is a plain function of
its inputs.

## Fingerprint derivation

```ts
fp = hash([
  fingerprintElement(render-static-shape),
  stableStringify(varyResult),
  ownFrameKey,
  ambientFrameKey,
  cmsKey,
  descendantManifestKey,  // or: descendant vary results, sorted
])
```

`fingerprintElement(render-static-shape)` walks the JSX shape of
what `render` returns. Since `render` is a function (not pre-built
JSX), this requires either:

- A speculative call to `render(varyResult)` to get the shape
  (cheap if `render` is mostly synchronous static JSX), OR
- A separate `staticShape` parameter the author declares, OR
- Skip — `render` is identified by reference (function identity);
  re-render only happens when vary result changes.

Probably option 3 is enough: function identity + vary result =
sufficient identity.

## Catch — what becomes harder

- **Async data inside `vary`.** A `vary` that wants to fetch from a
  database (e.g. "compute the cart-id from the cookie THEN check
  the cart's existence") can't — `vary` is sync by contract.
  Solution: split. Sync vary computes a stable key (cookie value);
  `render` does the async fetch with that key in its props.
- **Authors who want to vary on something deep in the tree.** Today
  a deeply-nested `getSearchParam` records into the ancestor's
  manifest via the cell. With explicit `vary`, the parent has to
  declare the dep; the descendant just consumes it as a prop. That
  flips the responsibility — descendants stop varying, parents do.
  Probably for the better; the descendant fold logic exists to
  approximate this anyway.
- **Migration cost.** Every existing Partial that uses tracked
  accessors needs rewriting. Rough count for the demo:
  - `<PokemonPage>` (3 reads), `<CacheDemoPage>` (1), `<BarePage>`
    (1), `<SearchArea>` (2), `<ChatOverlayBody>` (2),
    `<CartFrameContent>` (3), `<MenuFrameContent>` (4), `<TabBody>`
    (1), `<MagentoPage::ProductGrid>` (1), `<CartPartial>` (1
    cookie), CMS-edit shell (3 reads), CMS-edit field panel (2),
    chat pieces (1 per message), …
  - Plus all the `getRequest()` callers that aren't tracked but
    use the request directly (frames, sessions, etc.).

## Migration path

Backward-compatible introduction:

1. Add `vary` and `render` as optional props alongside `children`.
   When both `vary`/`render` are provided, ignore `children` /
   `getXxx` calls (the new path); else use the legacy access-pattern
   path.
2. Migrate userspace one Partial at a time. Each migration is local
   to the Partial's call site.
3. Once every Partial migrates, delete the access-pattern code:
   `manifestScope`, `setCurrentPartialManifest`, the cell-drift
   workarounds, `HoistingViolationError`, the frame-cell trick,
   `runWithCacheManifest`, `partialManifestCell`, the entire
   identity / content split. The framework shrinks meaningfully.

## Open questions

1. **Does `vary` need access to anything beyond `request`?** Cookies
   accumulated via `setCookie` during this same request? Frame
   resolution? Probably yes — pass a small scope object:
   `{ request, frame, cookies }` rather than the raw `Request`.
2. **What about CMS scope reads inside `vary`?** Today `getText` is
   a Partial-body-only call. Could move to `vary` if the framework
   threads the CMS scope through. Or keep CMS reads in `render`.
3. **Children vs render.** `children` is the React-idiomatic way to
   pass a subtree. If `render` is preferred for forwarding props,
   we lose child composition. Or `render` could be `(props,
   children) => ReactNode` — both work.
4. **`<Cache>`'s `vary` prop.** Already named `vary`. Same concept,
   so a single `vary` on `<Partial>` (which subsumes the cached
   case) is consistent.
