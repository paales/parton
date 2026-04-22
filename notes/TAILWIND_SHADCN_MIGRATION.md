# Tailwind + shadcn migration — status & open issues

Work-in-progress log for the refactor that moves the demo app from
inline styles to Tailwind v4 + shadcn/ui + ai-elements. Captures what
landed, what broke, and what's left so the next pass has context.

## What landed

- **Tailwind v4 via `@tailwindcss/vite`**
  - `src/app/styles.css` imports `tailwindcss`, `tw-animate-css`,
    `shadcn/tailwind.css`, and `@fontsource-variable/jetbrains-mono`.
  - Dark theme enabled with `<html className="dark">` in `root.tsx`.
  - CSS is linked into the SSR stream via `plugin-rsc`'s auto-emitted
    `<link>` tag (imported from `root.tsx` at the server component
    level). Dev + prod both produce the link.
- **shadcn primitives (rsc: true)** wired through `@/components/ui/*`.
  - `@/` alias added to `vite.config.ts`.
  - Single `TooltipProvider` at layout level (removed mid-debug, see
    below).
- **Structural refactor**
  - Every demo page used to render its own `<PartialRoot><html>
    <head>…<style>…</style></head><body><AppNav/>…<ChatOverlay/>
    </body></html></PartialRoot>`. Now `root.tsx` owns the chrome and
    every page returns just its content fragment.
  - `root.tsx` uses a single `pickRoute([…])` covering every path
    (including `/magento/*`, `/not-found-demo`, `/redirect-demo`, the
    `/*` Pokemon fallback).
- **Styling migration pass**
  - `.card` → shadcn `Card` / `CardContent` / `CardHeader` / `CardTitle`
    where the semantic fit was clean; plain Tailwind classes in
    hot-path callsites (pokemon grid, chat message, etc.).
  - `.badge` → shadcn `Badge` (with a `TypeBadge` helper mapping
    pokemon types to `bg-{color}/60 text-{color}-200` Tailwind
    palettes — open-ended so not a shadcn variant).
  - `.partial-controls` buttons, `FrameNavigationBar`, cart/magento
    controls → shadcn `Button`.
  - `<a>` styled as button: use `buttonVariants({ variant, size })`
    directly on the anchor — **do not use `asChild`** (Base UI's
    `Button` doesn't support the Radix `asChild` contract; it threw
    `useContext null` + "React does not recognize the `asChild` prop"
    at runtime).
  - Inline-styled spinners → `animate-spin` utility.
  - `grid-template-columns: repeat(auto-fill, minmax(200px, 1fr))` →
    Tailwind arbitrary value `grid-cols-[repeat(auto-fill,minmax(200px,1fr))]`.
- **Chat overlay**: still uses custom markup for now. Hooked up
  `buttonVariants` on the pills; `ChatClosePill` / `ResetChatButton` /
  `NewMessageLink` use the shadcn `Button` component proper.

## What's broken / flaky

### 1. chat-notes frame-URL projection
**Symptom.** `/chat-notes?msgs=IDEAS` should seed the overlay's frame
URL with `?msgs=IDEAS` so the message streams on initial render. Test
`e2e/chat-notes.spec.ts` expects `chat-body-IDEAS`; we see
`chat-empty` instead.

**Where.** Pre-refactor, `ChatNotesPage` computed the frame URL and
rendered `<ChatOverlay defaultOpen frameUrl={…} />` itself. Post-
refactor, the overlay lives in the shared `<body>` of `root.tsx`, so
the projection has to be routed there:

```tsx
<ChatOverlay
  defaultOpen={matchPath("/chat-notes") != null}
  frameUrl={matchPath("/chat-notes") != null ? chatOverlayFrameUrl() : undefined}
/>
```

The Flight payload for `/chat-notes?msgs=IDEAS` contains
`frameUrl: "/?msgs=IDEAS"` once, so the value IS reaching the Partial
call — but three sibling `FrameWrapper` serializations show
`frameUrl: "$undefined"`, and the overlay body renders the empty
state. Possibly a registry-snapshot replay issue: the snapshot
captured at first render (before my conditional had the right value)
gets served on subsequent renders. Needs someone who understands
`registerPartial` / `FrameWrapper` round-trips to confirm.

**Hypothesis to try first.** Pass the frame URL through the chat-
notes page component directly instead of computing it in `root.tsx`
— e.g. let the page itself render a `<Partial frame="chat-overlay">`
override, and have `root.tsx`'s `<ChatOverlay/>` degrade to "no-op
when a chat-overlay frame is already in the tree."

### 2. Auto-tracked cache manifest goes empty after long HMR sessions
**Symptom.** `e2e/cache-auto-tracking.spec.ts` +
`e2e/cache-demo.spec.ts` (three cache-semantics tests) fail — every
flavor hits the same cache entry. Manually I reproduced it with
`curl /cache-demo?flavor=aa → flavor=bb → flavor=cc` and saw
`data-render-count` frozen at the first value. The manifest recorded
on the first render was empty (no `url:flavor`), so
`resolveManifest({}) → {} → hashParts({}, null)` produces one key for
every flavor.

**Key observation.** After `kill $(lsof -ti:5173)` + fresh `yarn dev`,
the exact same curl trace produces 1 → 1 → 2, i.e. cache tracking
works correctly. The failure is tied to a dev server that's been
through many HMR reloads — possibly `manifestStore` / `snapshotIndex`
holding entries from a previous module identity (so `findStoredManifestByPrefix`
finds nothing with the new `fingerprint`, and first-render logic
skips accessor tracking for stored-manifest-less paths).

**Not a real prod regression** — a fresh boot is clean. Still needs
fixing so the dev feedback loop isn't lying. Likely a wire-up in
`src/lib/cache.tsx`'s HMR-clear hook (it already invalidates
`manifestStore` on `vite:beforeUpdate`; maybe it doesn't clear
`snapshotIndex` or `inFlightMiss` aggressively enough, or the first
render after HMR lands with stale scope state).

### 3. Pre-existing tests that depend on specific HTML markers
Some tests grep the response body for specific class names or
substrings:

- `e2e/magento-cache-hit-renders-body.spec.ts` expects
  `class="grid"`. Migration moved to Tailwind
  `grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4` —
  no bare `class="grid"` anymore. Test needs updating to match on
  the `grid` token within a larger className, or on a data-testid.
- `e2e/fingerprint-skip.spec.ts` failed intermittently — likely
  related to the HMR staleness above; not confirmed a real
  regression from styling.
- `e2e/search-open-first-keystroke.spec.ts` / `search-streaming.spec.ts`
  timed out trying to `.check()` a checkbox that used to be a native
  `<input type="checkbox">`. The migration initially swapped it for
  shadcn's `<Checkbox/>` (Base UI compound component), which doesn't
  look like a native checkbox to the test. Reverted to native
  `<input type="checkbox">` in `src/app/components/search.tsx` —
  verify the retry passes.

## Open TODOs

- **Fix the chat-notes frame-URL projection** (item 1 above).
- **Investigate HMR-stale manifest state** in `src/lib/cache.tsx` so
  the cache tests don't flake mid-dev-session (item 2).
- **Update e2e HTML-marker asserts** (item 3) — prefer
  `[data-testid]` over class-name substring matches.
- **Chat overlay → ai-elements.** The overlay's body (`aside` +
  header + list + footer) is a fine candidate for `Conversation` /
  `Message` / `PromptInput` from `src/components/ai-elements/*`.
  Didn't touch it yet because the streaming semantics (bounded
  `<Piece>` recursion + `ResumeTail`) are load-bearing and the
  ai-elements primitives assume different data flow.
- **Chrome theme polish.** Dark-mode palette is shadcn-neutral by
  default; the old design had custom accent colors. Pick a palette
  pass once the rest is green.
- **Dev-time warnings.** Base UI emits a handful of
  `optimizeDeps.exclude` warnings (its `button/Button.js`,
  `useRefWithInit.js`, etc.). Cosmetic but noisy — add the suggested
  excludes when the wider dust settles.

## Things that were *not* the culprit (dead ends)

- `TooltipProvider` wrapping everything. Removing it didn't fix the
  cache regression; likely HMR state.
- The order of `matchPath` calls in `root.tsx`. `matchPath` is pure.
- Dual `React` instances via the `@/` alias. All imports still
  resolve to the same module — confirmed by grepping `framework/context`
  paths.
- `<code>` → `<Code>` wrapper component in cache-demo. Structurally
  equivalent from React's POV.

## Commit state at time of writing

Unit suite: **137/137 passing** (`yarn test`).
Prod build: **passing** (`yarn build`).
E2E suite: **61/71 passing** (`yarn test:e2e`) — failures listed above.
