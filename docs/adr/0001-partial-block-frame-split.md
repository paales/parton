# 0001 — Partial / Block / Frame split

Date: 2026-05-11
Status: Shipped 2026-05-11 (commit `8b7f579`)

## TL;DR

Today's `parton(R, opts)` has accumulated options for three
unrelated concerns: addressable render units, slot-placed CMS blocks,
and frame-scope openers. Split into:

- `parton(R, {match?, vary?, selector?, cache?, defer?, fallback?})` —
  addressable, fingerprinted, refetchable subtree. Optionally URL-gated
  via `match`. The everything-else case. **No `cms` access in `vary`**.
- `block(R, {tags?, schema?, vary?, name?, selector?, cache?, defer?, fallback?})` —
  slot-placeable unit with a CMS schema. `schema({cms}) => ({...})`
  replaces the in-`vary` `cms.*` reads, and the editor's catalog
  manifest is derived from `schema` instead of from tracking-`vary`.
- `<Frame name initialUrl>...</Frame>` — scope opener. Plain
  React component, no constructor. Extends `parent.frameChain` for
  descendants and wires `useNavigation(name)`.

Dead/redundant options stripped: `id`, `errorWith` (already gone),
plus `tags`/`type`/`frame`/`frameUrl` removed from `partial` (`tags`
moves to `block`; `frame*` move to `<Frame>`).

The runtime engine doesn't change. `block` desugars to the same
SpecComponent shape as `partial`; the framework runtime sees one
"partial" abstraction. Two authoring surfaces, one engine.

## Context

The constructor today reads like this in user code:

```tsx
parton(HeroRender, {
  type: "hero",
  tags: [".composed-hero"],
  vary: ({ cms }) => ({ headline: cms.text("headline") }),
})
```

vs.

```tsx
parton(PokemonPageRender, {
  match: "/pokemon/:id",
  cache: { maxAge: 60 },
})
```

vs.

```tsx
parton(CartFrameRender, {
  selector: "#cart",
  frame: "cart",
  frameUrl: "/cart/closed",
  vary: ({ request }) => ({ state: parseCartState(request.url) }),
})
```

Three different roles, one constructor. The shared concept *is* real
(every spec is an addressable refetchable subtree — the "partial"
semantic), but the authoring API conflates routing, CMS schema, and
frame scoping behind a single shape that has 11 options of which
most are irrelevant on any given call.

Audited problems:

- `id` option had one user call site (`cms-demo.tsx`), and that
  call site matched the auto-derive exactly. Stripped 2026-05-11.
- `errorWith` had zero call sites outside the framework itself.
  Stripped 2026-05-11.
- `type` is overloaded with the TypeScript keyword and the HTML
  attribute; every block file declares it with the same string the
  auto-derive would produce.
- `tags` is used only by block specs (~12 files), zero non-block uses.
- `frame` / `frameUrl` couple "I open a scope" with "I am also the
  root partial of that scope" — limits framed scopes to a single
  partial unless the author nests siblings inside the opener's render.
- The `cms` accessor inside `vary` makes `vary` mix two distinct
  concerns: request dimensions (URL, cookies, headers, session) and
  request-keyed CMS lookups. The CMS read is a *result of* the
  request, not a dimension of it. The descendant-fp fold pays for
  the conflation: every ancestor render reconstructs a synthetic
  CMS surface per descendant to invoke its `vary`.

## Decision

### Public surface (after refactor)

```ts
parton<Opts>(Render, opts: Opts): SpecComponent<…, …>
block<Opts>(Render, opts: Opts): SpecComponent<…, …>

interface PartialOptions<V> {
  match?: MatchPattern
  vary?: (scope: VaryScope) => V | null      // request dims only — no `cms`
  selector?: SelectorTokens
  cache?: CacheOptions
  defer?: DeferSpec
  fallback?: ReactNode
}

interface BlockOptions<V, S> {
  tags?: ReadonlyArray<`.${string}`>          // slot-allow class tokens
  schema?: (scope: SchemaScope) => S          // CMS reads — replaces in-vary cms reads
  vary?: (scope: VaryScope) => V | null       // request dims, same shape as partial's
  name?: string                                // explicit override; default = auto-derived
  selector?: SelectorTokens
  cache?: CacheOptions
  defer?: DeferSpec
  fallback?: ReactNode
}

interface VaryScope {
  url: URL
  pathname: string
  search: Partial<Record<string, string>>
  cookies: Partial<Record<string, string>>
  headers: Partial<Record<string, string>>
  params: Record<string, string>
  session: SessionReadSurface
  // No `cms` — moved to SchemaScope on `block`.
}

interface SchemaScope {
  cms: CmsReadSurface
}
```

`<Frame>` is a plain React component:

```tsx
interface FrameProps {
  name: string
  initialUrl?: string
  children: ReactNode
}

function Frame({ name, initialUrl, children }: FrameProps): ReactNode
```

### Mental model (for docs)

> Pages are not a *kind* of thing. They are partials whose `match`
> happened to gate by URL. There is no router — only addressable
> partials, some of which render only when a URL matches them.

> Blocks are partials with a CMS content schema. They are placed by
> slots, not by URL. A block reads CMS via `schema`; a partial does
> not (it can host CMS-managed slots via `id` binding, but it
> doesn't read individual fields).

> Frames are not partials. They are scope openers — a `<Frame>` opens
> a per-name URL scope; the partials inside read the frame-resolved
> request via their normal `vary` (the framework swaps the request
> via the ambient frame chain). `useNavigation(frameName)` writes the
> frame URL; refetch fires for every partial whose `parentFrameChain`
> includes that frame.

### Internal (runtime) shape — unchanged

- One spec catalog. `block`-constructed specs register in the type
  catalog (for slot lookup); `partial`-constructed specs do not.
- One snapshot registry. Same shape, same fp pipeline, same
  cache-mode reconstruction.
- One render pipeline. `block` desugars to `partial` internally with
  `schema` merged into the framework-supplied prop bag alongside
  `vary`'s output.
- `<Frame>` is a thin component that wraps children in a context
  provider extending `parent.frameChain`; the framework's existing
  frame-URL-resolution code (already in `partial.tsx`'s frame phase)
  moves to `<Frame>` verbatim.

## Detailed migrations

### What goes away

| Symbol | Today | After |
|---|---|---|
| `PartialOptions.id` | option, defaults to id | gone — stripped 2026-05-11 |
| `PartialOptions.errorWith` | option, dead | gone — stripped 2026-05-11 |
| `PartialOptions.type` | option, used on blocks | moves to `BlockOptions.name` (auto-derived) |
| `PartialOptions.tags` | option, used on blocks | moves to `BlockOptions.tags` |
| `PartialOptions.frame` | option, opens frame scope | gone — use `<Frame>` |
| `PartialOptions.frameUrl` | option, frame initial URL | gone — use `<Frame initialUrl>` |
| `VaryScope.cms` | sync CMS reads | gone — moves to `SchemaScope.cms` on `block` |

### What stays on partial

`match`, `vary`, `selector`, `cache`, `defer`, `fallback`, plus
framework props on the component itself (`parent`, `id` runtime
override, `children`).

### What's new on block

`tags`, `schema`, `name` (optional override), `vary` (request dims).
Plus the partial-shared options (`selector`, `cache`, `defer`,
`fallback`).

### Call-site migrations

**Blocks** — every file in `e2e-testing/src/app/blocks/`:

```tsx
// Before
parton(HeroRender, {
  type: "hero",
  tags: [".demo-block", ".composed-hero"],
  vary: ({ cms }) => ({
    headline: cms.text("headline"),
    body: cms.richText("body"),
  }),
})

// After
block(HeroRender, {
  tags: [".demo-block", ".composed-hero"],
  schema: ({ cms }) => ({
    headline: cms.text("headline"),
    body: cms.richText("body"),
  }),
})
// `name` auto-derives to "hero" from HeroRender.name
```

Affected files (~12):
- `blocks/hero.tsx`
- `blocks/rich-text.tsx`
- `blocks/group.tsx`
- `blocks/nav-link.tsx`
- `blocks/nav-root.tsx` (tags `[] as never` → just omit)
- `blocks/page-root.tsx` (same)
- `blocks/page-greeting.tsx`
- `blocks/page-multi-slot.tsx`
- `blocks/page-composed.tsx`
- `blocks/page-hero.tsx`
- `blocks/page-slug-nav.tsx`
- `blocks/product-card.tsx`
- `pages/magento/live-price.tsx`

**Frames** — every `partial({frame, frameUrl})`:

```tsx
// Before
const CartFramePartial = parton(CartFrameRender, {
  selector: "#cart",
  frame: "cart",
  frameUrl: "/cart/closed",
  vary: ({ request }) => ({ state: parseCartState(request.url) }),
})

// Place:
<CartFramePartial parent={parent} />

// After
const CartFramePartial = parton(CartFrameRender, {
  selector: "#cart",
  vary: ({ request }) => ({ state: parseCartState(request.url) }),
})

// Place:
<Frame name="cart" initialUrl="/cart/closed">
  <CartFramePartial parent={parent} />
</Frame>
```

Affected files (~5):
- `e2e-testing/src/app/chat/chat-overlay.tsx`
- `e2e-testing/src/app/components/frames-demo-controls.tsx`
- `e2e-testing/src/app/pages/pokemon.tsx`
- `e2e-testing/src/app/pages/frames-demo.tsx`
- `cms/src/editor/shell.tsx` (uses `setSessionFrameUrl` directly; check
  if it needs `<Frame>` too)

**Partials reading `cms` in vary** — every non-block spec that calls
`cms.*` inside `vary`:

```tsx
// Before
parton(R, {
  match: "/x",
  vary: ({ cms }) => ({ tone: cms.enum("tone", ["info", "warn"]) }),
})

// After — if the spec is content-driven, it should be a block:
block(R, {
  tags: [".x"],
  schema: ({ cms }) => ({ tone: cms.enum("tone", ["info", "warn"]) }),
})
// Or — if the spec is a page wrapper that doesn't really need cms in vary,
// rework to not depend on the CMS read at the wrapper level.
```

Search reveals that all current `cms.*` reads in `vary` are inside
block-shaped specs (the existing slot-block files). After migration
to `block(R, {schema})` there are no remaining `cms` reads in `vary`,
so the strip from `VaryScope` is clean.

### Frame component implementation

```tsx
// framework/src/lib/frame.tsx (new file)
import React, { type ReactNode, useContext } from "react"
import { getRequest } from "../runtime/context.ts"
import { getSessionFrameUrl, setSessionFrameUrl } from "../runtime/session.ts"
import { FrameNameProvider } from "./partial-client.tsx"
import { _childContext, type PartialCtx } from "./partial-context.ts"

interface FrameProps {
  name: string
  initialUrl?: string
  parent: PartialCtx       // explicit, like everything else in the framework
  children: ReactNode
}

export function Frame({ name, initialUrl, parent, children }: FrameProps): ReactNode {
  const ourFrameChain = [...parent.frameChain, name]
  const sessionUrl = getSessionFrameUrl(ourFrameChain)
  const effective = sessionUrl ?? initialUrl

  if (effective != null && sessionUrl == null) {
    setSessionFrameUrl(ourFrameChain, effective)
  }

  // Frame-resolved request is what descendants' `vary` see — already
  // computed in partial.tsx's frame phase. Move that resolution here.
  const pageRequest = getRequest()
  const resolved = effective != null
    ? new URL(effective, pageRequest.url).toString()
    : pageRequest.url

  const url = new URL(resolved)
  const initialUrlForProvider = url.pathname + url.search

  const childCtx: PartialCtx = {
    path: parent.path,        // frames don't extend the path; only the frameChain
    frameChain: ourFrameChain,
  }

  return (
    <FrameNameProvider path={ourFrameChain} initialUrl={initialUrlForProvider}>
      {React.Children.map(children, (child) =>
        React.isValidElement(child)
          ? React.cloneElement(child as React.ReactElement<{ parent?: PartialCtx }>, { parent: childCtx })
          : child,
      )}
    </FrameNameProvider>
  )
}
```

Open: should `Frame` accept `parent` as a prop, or read it from
context? Today every partial accepts `parent` explicitly. Keeping
the same convention for symmetry. If we later add a `<RootContext>`
component that provides `parent={ROOT}` ambiently, both partials and
`<Frame>` can drop the explicit prop together.

### Block constructor implementation

```tsx
// framework/src/lib/block.tsx (new file)
import type { ReactNode } from "react"
import { type PartialOptions, type RenderArgs, type SelectorTokens,
         type SpecComponent, type SpecExtraProps } from "./partial.tsx"

interface BlockOptions<V, S> {
  tags?: ReadonlyArray<`.${string}`>
  schema?: (scope: SchemaScope) => S
  vary?: (scope: VaryScope) => V | null
  name?: string
  selector?: SelectorTokens
  cache?: CacheOptions
  defer?: DeferSpec
  fallback?: ReactNode
}

interface SchemaScope {
  cms: CmsReadSurface
}

// Internally desugars to parton with merged vary+schema and
// `type: name ?? auto-derive`, `tags`. Schema runs after vary and is
// merged into the framework-supplied prop bag.
function buildBlockComponent<V, S>(Render, options: BlockOptions<V, S>) {
  const partialOptions: PartialOptions<V & S> = {
    tags: options.tags,                       // internal — stays so isSlotBlock works
    selector: options.selector,
    cache: options.cache,
    defer: options.defer,
    fallback: options.fallback,
    vary: (scope) => {
      const v = options.vary ? options.vary(scope) : ({} as V)
      if (v === null) return null
      const cmsSurface = createCmsReadSurface(/* …id… */, scope.request)
      const s = options.schema ? options.schema({ cms: cmsSurface }) : ({} as S)
      return { ...v, ...s }
    },
    // The auto-id derivation uses `name` override if present, else
    // Render.name auto-derive. `type` flows from `name`.
  }
  return parton(Render, partialOptions)
}
```

Open detail: the catalog manifest (editor's field discovery) walks
each block's `schema`. Today the same is done with `vary` — the
tracker observes `cms.text(...)` calls. After the split, the tracker
observes `schema` instead. Implementation in `cms-prerender.ts`
changes from `spec.vary({...})` to `spec.schema({...})`.

## Refactor sequence

Each step keeps `yarn test` green. The whole refactor lands as one
commit per CLAUDE.md "workflow after a task is done."

1. **Add `<Frame>` component** at `framework/src/lib/frame.tsx`. Export
   from the barrel. Tests for: scope opening, session URL write,
   frame chain extension, descendant `vary` sees frame-resolved
   request.
2. **Migrate every frame call site** from `partial({frame, frameUrl})`
   to `<Frame name initialUrl>`. Verify e2e specs still pass (`yarn
   test:e2e`).
3. **Remove `frame` + `frameUrl` from `PartialOptions`** and the
   frame-opening logic in `partial.tsx` (the `FrameNameProvider`
   wrapper, the `resolveFrameRequest` call, the ambient-frame-key
   fp contribution). The frame chain still flows through `parent` —
   only the "this spec opens a new frame" branch goes away.
4. **Add `block` constructor** at `framework/src/lib/block.tsx`.
   Internally desugars to `partial` via the engine described above.
   Same `SpecComponent` return type. Schema callback feeds a tracking
   CMS surface at prerender time and a real one at render time.
5. **Migrate every block call site** (~13 files) from
   `partial({type, tags, vary: ({cms}) => ...})` to
   `block({tags, schema: ({cms}) => ...})`. Drop `type` (auto-derive).
6. **Update `cms-prerender.ts`** to derive `BlockManifest.contentFields`
   from `spec.schema` instead of `spec.vary`.
7. **Remove `tags` and `type` from `PartialOptions`.** Search for any
   leftover non-block usage; convert or fail.
8. **Remove `cms` from `VaryScope`.** Update `partial.tsx` to not
   build a CMS surface for `vary`. Update the descendant-fp fold to
   call `vary` without a `cms` surface; CMS contribution comes
   exclusively via `cmsFingerprintContribution`.
9. **Update docs.** Split `docs/reference/partial.md` into
   `partial.md` (just the partial constructor) and `block.md` (new
   block constructor). Update `intro.md` to introduce the "partials,
   blocks, frames" trio. Update `frames-navigation.md` to use
   `<Frame>`. Update `cms.md` to reference the schema callback.
10. **Run full test suite.** `yarn test` + `yarn test:e2e` both
    green before committing.
11. **Archive `notes/partial-define-step-api.md`** if its design is
    fully superseded; otherwise leave with a "post-split corrections"
    section.

## Risks & open tails

- **CMS reads in non-block partials.** Audit confirms no in-tree
  `partial(R, {vary: ({cms}) => ...})` outside block files. Once
  migrated, removing `cms` from `VaryScope` is clean. Anyone adding
  one mid-refactor will hit a type error.
- **The descendant-fp fold today builds CMS surfaces per descendant.**
  After the split, only block descendants need the synthetic CMS
  surface — but they have `schema`, not `vary`. The fold needs to
  invoke both `vary(scope without cms)` AND `schema({cms})` for
  block descendants; partial descendants need only `vary`. This is
  a measurable simplification: most descendants are non-block
  partials, and they skip the CMS surface entirely.
- **Frame initial URL writes.** Today the spec runs `setSessionFrameUrl`
  on first render of a framed spec via the partial.tsx frame phase.
  After the move to `<Frame>`, the component does this directly on
  mount. Order of operations: `<Frame>` writes the URL BEFORE its
  children render, so descendants' `vary` already sees the
  session-resolved URL on the same request.
- **Frame children threading.** `<Frame>` needs to pass an
  extended-frame-chain `parent` to its children. If a child is a
  partial component, it accepts `parent` as a prop; if a child is
  arbitrary JSX, `React.Children.map` + `cloneElement` injects
  `parent`. Could be cleaner with a render-prop API
  (`<Frame name="cart">{(parent) => <CartContent parent={parent}/>}</Frame>`)
  but adds verbosity. Try cloneElement first; fall back to
  render-prop if it gets messy.
- **The editor's preview frame.** `cms/src/editor/shell.tsx` writes
  `setSessionFrameUrl(["preview"], previewUrl)` directly inside
  EditorShellRender. After the refactor, the editor either keeps
  the direct call (and we keep `setSessionFrameUrl` exported) or
  wraps with `<Frame name="preview">`. The former is simpler given
  the editor's lifecycle; leave as direct call for now.
- **Slot-block snapshots with `parent.path` mismatch.** Slot blocks
  registered inside `<Frame>` will have a frameChain that includes
  the frame, but the snapshot's `parentPath` doesn't change. Verify
  cache-mode reconstruction still finds them via the `type` catalog.

## Punted for later (not in this refactor)

- **ArkType schema.** `schema({cms}) => ({...})` callback shape stays
  for now; future swap to declarative ArkType types is a separate
  change.
- **Error recovery design.** `errorWith` is gone; per-spec error
  fallbacks come back if/when we design the broader error model.
- **Schema-without-cms-callback.** Today the schema HAS to be a
  callback because it's tracked. With ArkType, the schema is a
  static value. Both will eventually be supported; for now only the
  callback form.
- **Pluggable schema sources.** A block whose schema comes from a
  GraphQL fragment / Contentful / etc. is a future direction
  (`user-ideas.md §forkable-data-architecture`).

## Naming notes for the diff

- `BlockOptions` is the new option interface; lives alongside
  `PartialOptions` in `partial.tsx` (or in the new `block.tsx`).
- `SchemaScope` replaces the `cms` portion of `VaryScope`.
- The internal `isSlotBlock` flag stays — `block()` always sets it,
  `partial()` never does.
- Internal `id` field stays on the spec (used for slot-instance
  overrides via JSX prop, and for `cmsFingerprintContribution` even
  for non-block slot-host partials like `CmsDemoRootPartial`).
