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

### 1. chat-notes frame-URL projection — **RESOLVED 2026-04-23**

`ChatOverlay`'s signature was `function ChatOverlay()` — took no
props — even though `root.tsx` called it with `defaultOpen` and
`frameUrl`. Both props were silently dropped; the overlay rendered
with a hardcoded `defaultOpen={false}` and no frame URL, so
`/chat-notes?msgs=IDEAS` showed the pill.

Fix: give `ChatOverlay` the props it was already being called with,
and thread `frameUrl` through to the underlying `<Partial
frame="chat-overlay" frameUrl={…}>`. See
`src/app/chat/chat-overlay.tsx`.

Nothing at all wrong with the projection mechanism. The registry-
snapshot theory in the original write-up was a red herring.

### 2. Auto-tracked cache manifest regression — **ROOT CAUSE: frame-scope fingerprint drift**

Not actually HMR-staleness. The cache manifest was fine; the Partial
*fingerprint* fed to `<Cache id fingerprint=>` differed between full
renders and RSC refetches, so the two modes built different cache
`baseKey`s and never shared an entry.

Why the fp drifted: the `ambientFrameKey` component of the fp reads
`getCurrentFrameScope()` — a `React.cache`-backed mutable cell
(`notes/FRAME_SCOPING.md`). `<ChatOverlay>` renders as a sibling of
the page content in `root.tsx`; its `<Partial frame="chat-overlay">`
FrameWrapper mutates the cell synchronously. Under React 19's
concurrent server-component rendering, a sibling page Partial can
read the cell AFTER the mutation — the read picks up
`inFrame=chat-overlay` even though the Partial is not actually
inside the chat frame. RSC refetch paths render only the target
subtree (no sibling ChatOverlay), so the cell is clean and the fp
differs.

Fix: split into two hashes inside the Partial body.

- `structuralFp = hash(fingerprintElement(content) + ownFrameKey)`
  — feeds `<Cache>` so the cache key is stable regardless of
  ambient-frame leak.
- `fp = hash(…same… + ambientFrameKey)` — still used for the
  client fingerprint-match skip (preserves "descendants of a frame
  invalidate when the frame URL moves").

For legitimately nested frames the two hashes agree by construction
(ownFrameKey ≡ ambientFrameKey of the parent). The split only
affects the ChatOverlay-leak scenario. See
`src/lib/partial-component.tsx` + new section in
`notes/FRAME_SCOPING.md`.

Regression pin: `e2e/cache-demo.spec.ts:48` (RSC refetch of the
`#slow` Partial). Failed before the split, passes after.

### 3. E2E HTML-marker asserts — **RESOLVED 2026-04-23**

- `e2e/magento-cache-hit-renders-body.spec.ts` now matches on
  `data-testid="product-grid"`. Added the testid to the grid wrapper
  in `src/app/pages/magento/product-list.tsx`.
- `e2e/fingerprint-skip.spec.ts`: passes in isolation and in most
  full runs; the occasional fail is a worker-contention race
  (see "Flaky under parallel load" below).
- `e2e/search-open-first-keystroke.spec.ts` /
  `search-streaming.spec.ts`: same story — they assert on Suspense
  fallback visibility windows that shrink under 5-worker load.
- `e2e/debug-refetch.spec.ts`: removed. Diagnostic-only test with
  an 8 s `waitForTimeout` and `expect(true).toBe(true)`.

### 4. Client `_fingerprints` missing late-committing ids — **NEW FIX**

Unrelated to Tailwind, found during the e2e triage. The client
registers partial fingerprints only when each `<PartialErrorBoundary>`
commits on the browser. Commit order is non-deterministic under
React transitions — a click that dispatches a targeted refetch
immediately after a client nav can fire before all the new route's
Partials have registered, so `?cached=` goes out incomplete.

Fix: `src/lib/partial-client.tsx` now lifts the fingerprint off the
wrapper's props inside `cacheFromStreamingChildren` (the synchronous
walk that already runs on every payload) and sets it in
`_fingerprints` directly. `PartialErrorBoundary.render` still
registers on mount as a fallback (identical value). Also moved
`_fingerprints.clear()` to BEFORE the walk — clearing after was
wiping the freshly-walked entries.

### 5. Chat-stream e2e wall time — **NEW FIX**

`src/app/chat/log.ts` paced at 100 ms × 10 s budget. That's ~10 s
per spec in `e2e/chat-notes.spec.ts`. Added `isTestMode()` (see
`notes/SERVER_ISOLATION.md` addendum) and a pair of test-only
constants: 5 ms chunk delay, 3 s budget. Chat-notes specs now
settle in ~4 s total instead of ~15 s. Tried generalising this
(shared `simulatedDelay` used by Pokemon search stages etc.) —
broke progressive-streaming assertions that rely on fallback
visibility windows. Reverted and kept the test-mode path narrowly
scoped to the chat producer.

## Known flaky-under-parallel specs (not stability-blockers)

Under the default 5-worker Playwright run, one of these may fail on
any given invocation — the same suite passes cleanly run in
isolation:

- `e2e/search-open-first-keystroke.spec.ts:131`
- `e2e/search-streaming.spec.ts:11`
- `e2e/trace-partials.spec.ts:8`
- `e2e/timing-test.spec.ts:13`
- `e2e/frames-demo.spec.ts:201` (session persists across refresh)
- `e2e/cache-prune-across-nav.spec.ts:21` — racing `_fingerprints`
  population with an activate click; the `head` assertion was
  already dropped from the spec for the same reason.

All of these assert on streaming / Suspense-fallback timing and
contend on the single dev-server process when 5 workers hit it
concurrently. Local mitigation: `yarn playwright test --workers=2`
eliminates most of the flake; CI should either pin workers or
accept that the suite needs a retry to go green.

## Still open

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

- `TooltipProvider` wrapping everything. Not the cache regression —
  that was frame-scope fingerprint drift (see #2 above).
- The order of `matchPath` calls in `root.tsx`. `matchPath` is pure.
- Dual `React` instances via the `@/` alias. All imports still
  resolve to the same module — confirmed by grepping `framework/context`
  paths.
- `<code>` → `<Code>` wrapper component in cache-demo. Structurally
  equivalent from React's POV.
- HMR staleness of `manifestStore` (original #2 theory). Reproduced
  on a fresh `yarn dev` boot with no HMR — the bug was deterministic
  given ChatOverlay rendered as a sibling.
- Flight round-trip in `FrameWrapper` to contain the ALS scope.
  Spike regressed streaming inside framed subtrees (a slow async
  inside a frame blocked the outer render). Rolled back.
  `notes/FRAME_SCOPING.md` already called this out as an explored
  dead-end.

## Commit state at time of writing (2026-04-23)

Unit suite: **144/144 passing** (`yarn test`) — 133 node + 11 rsc.
E2E suite: **70–71/71 passing** (`yarn test:e2e`) per run; occasional
single-spec flake under 5-worker parallelism (see list above).
Single run ≈ 21–28 s depending on flake-retries.
Playwright now self-starts the dev server via `webServer` +
`reuseExistingServer: true` — no manual `yarn dev` needed before
`yarn test:e2e`.
