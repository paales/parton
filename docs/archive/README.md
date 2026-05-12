# Archive

Historical design documents and debugging sessions. Each file either
(a) describes code that no longer exists, (b) proposes a change that
shipped and is now covered by `../reference/` or `../internals/`, or
(c) captures a debugging trail whose conclusions are folded into
current docs and code.

Kept for context; **do not consult for how the code works today.**
For that, start at [`../reference/intro.md`](../reference/intro.md).

## Superseded by `docs/reference/` (current reference)

| File | Successor |
|---|---|
| `PARTIAL_ARCHITECTURE.md` | [`reference/intro.md`](../reference/intro.md) + [`reference/partial.md`](../reference/partial.md) |
| `PARTIAL_DEFINE_STEP_API.md` | [`adr/0001-partial-block-frame-split.md`](../adr/0001-partial-block-frame-split.md) + [`reference/partial.md`](../reference/partial.md) + [`reference/block.md`](../reference/block.md) |
| `SELECTOR_API.md` | [`reference/partial.md`](../reference/partial.md) § selector |
| `PARENT_CONTEXT.md` | [`reference/partial.md`](../reference/partial.md) § parent |
| `NAVIGATE_UNIFIED.md` | [`reference/frames-navigation.md`](../reference/frames-navigation.md) |
| `FRAMES.md` | [`reference/frames-navigation.md`](../reference/frames-navigation.md) |
| `DEFER_ACTIVATORS.md` | [`reference/partial.md`](../reference/partial.md) § defer |
| `AUTO_TRACKED_CACHE_KEYS.md` | [`reference/cache.md`](../reference/cache.md) + [`internals/cache-internals.md`](../internals/cache-internals.md) |
| `AUTO_TRACKED_VARY.md` | [`reference/cache.md`](../reference/cache.md) + [`internals/cache-internals.md`](../internals/cache-internals.md) |
| `CACHE_SCOPING.md` | [`reference/cache.md`](../reference/cache.md) |
| `CMS_VISION.md` | [`reference/cms.md`](../reference/cms.md) + [`reference/prior-art.md`](../reference/prior-art.md) |
| `CMS_MANIFEST.md` | [`reference/cms.md`](../reference/cms.md) |
| `CMS_EDITOR.md` | [`reference/cms.md`](../reference/cms.md) § Editor mode |
| `CMS_AUTHORING.md` | [`reference/cms.md`](../reference/cms.md) § Authoring a block |

## Superseded by `docs/internals/` (framework internals)

| File | Successor |
|---|---|
| `DYNAMIC_PARTIAL_REGISTRY.md` | [`internals/render-pipeline.md`](../internals/render-pipeline.md) + [`internals/registry-internals.md`](../internals/registry-internals.md) |
| `FRAME_SCOPING.md` | [`internals/frame-scope.md`](../internals/frame-scope.md) |
| `TESTING_ARCHITECTURE.md` | [`internals/testing.md`](../internals/testing.md) |
| `SERVER_ISOLATION.md` | [`internals/server-isolation.md`](../internals/server-isolation.md) |

## Pattern shipped, design retrospective archived

| File | Where the pattern lives |
|---|---|
| `STREAMING_CHAT.md` | `e2e-testing/src/app/chat/` — bounded `<Piece>` + compaction |

## Reference material (not code-bound)

| Path | Purpose |
|---|---|
| `design/` | V6 floating block editor design bundle — Claude Design conversation (`chats/chat1.md`), V6 prototype (`project/`), screenshots (`v6-screenshots/`, `live/`), Playwright drivers. Implementation lives in `cms/src/editor/`; this directory captures the *why* behind the chrome. |

## Removed APIs / earlier designs

| File | Why archived |
|---|---|
| `AGENTS.md` | Old `<Partials namespace="...">` API. Replaced by `<PartialRoot>` + `<Partial>`. Was at repo root; moved here 2026-04-18. |
| `BARE_KEY_REFETCH.md` | Switch from version-stamped Suspense keys to bare `key={id}`. Insights rolled into `LESSONS.md`. |
| `PARTIAL_WRAPPER_DESIGN.md` | Original `<PartialRoot>` + `<Partial>` proposal + activator pattern + rejection of HTMX-style trigger DSL. Implemented; kept as rationale. |
| `PLAN.md` | Original proxy-based data layer plan. Direction abandoned in favor of hand-written GraphQL queries with `graphql-request` + gql.tada. See `proxy-design/README.md`. |
| `REFACTOR_PROGRESS.md` | In-progress log from the 2026-04-18 unified-path refactor. |
| `SERVER_CACHE_NOTES.md` | Original `<Cache dep ttl staleWhileRevalidate>` design. Mechanics still load-bearing inside `framework/src/lib/cache.tsx`; surface replaced by per-spec `cache` option with auto-tracked manifest keys. |
| `PARTIAL_CACHE_DESIGN.md` | Proposal to fold `<Cache>` into `<Partial cache={…}>`. Implemented; cache shape further reshaped to a Cache-Control object. |
| `STREAMING_DEBUG_NOTES.md` | 584 lines of pre-refactor debugging across the streaming / cache / substitute paths. Surviving insights are folded into the code and the lessons docs. |
| `USE_PARTIAL_AND_INPUTS.md` | Reference for `usePartial` / `__inputs` / `usePartialParams` / `silentReplace` — all removed 2026-04-21. Replaced by one `useNavigation()` surface. |
| `VARY_RENDER_API.md` | Original `<Partial vary={...} render={...}>` proposal (2026-04-27). Superseded by `PARTIAL_DEFINE_STEP_API.md` — same vary/render core, moved from a call-site prop pair to a `ReactCms.partial(Render, …)` module-scope constructor. |
| `LESSONS.md` | Refetch-mechanics lessons 2026-04-16 → 2026-04-17 (bare-key Suspense reconciliation, fingerprint-skip, transition default). |
| `LESSONS_FROM_REFACTOR.md` | The 2026-04-18 unified-path refactor. |
| `LESSONS_2026-04-19.md` | `seedRegistry` and `buildTemplate` removal, Flight composite-key on placeholders, `cloneElement` drilling through wrappers. |
| `TAILWIND_SHADCN_MIGRATION.md` | 2026-04-23 status log for the Tailwind v4 + shadcn/ui refactor. |

## Subdirectories

- [`proxy-design/`](./proxy-design/) — the legacy proxy data layer
  (where field access *was* the query). Not wired into the app; kept
  for reference.
- [`design/`](./design/) — V6 floating block editor design bundle.
  See the table above.
