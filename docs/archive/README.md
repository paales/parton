# Archive

Historical design documents and debugging sessions. Each file either
(a) describes code that no longer exists, (b) proposes a change that
shipped and is now covered by `../docs/` or `../docs-dev/`, or
(c) captures a debugging trail whose conclusions are folded into
current docs and code.

Kept for context; **do not consult for how the code works today.**
For that, start at [`../docs/intro.md`](../docs/intro.md).

## Superseded by `docs/` (current reference)

| File | Successor |
|---|---|
| `PARTIAL_ARCHITECTURE.md` | [`docs/intro.md`](../docs/intro.md) + [`docs/partial.md`](../docs/partial.md) |
| `SELECTOR_API.md` | [`docs/partial.md`](../docs/partial.md) § selector |
| `PARENT_CONTEXT.md` | [`docs/partial.md`](../docs/partial.md) § parent |
| `NAVIGATE_UNIFIED.md` | [`docs/frames-navigation.md`](../docs/frames-navigation.md) |
| `FRAMES.md` | [`docs/frames-navigation.md`](../docs/frames-navigation.md) |
| `DEFER_ACTIVATORS.md` | [`docs/partial.md`](../docs/partial.md) § defer |
| `AUTO_TRACKED_CACHE_KEYS.md` | [`docs/cache.md`](../docs/cache.md) + [`docs-dev/manifest-internals.md`](../docs-dev/manifest-internals.md) |
| `AUTO_TRACKED_VARY.md` | [`docs/cache.md`](../docs/cache.md) + [`docs-dev/manifest-internals.md`](../docs-dev/manifest-internals.md) |
| `CACHE_SCOPING.md` | [`docs/cache.md`](../docs/cache.md) § Storage tiers |
| `CMS_VISION.md` | [`docs/cms.md`](../docs/cms.md) + [`docs/prior-art.md`](../docs/prior-art.md) |
| `CMS_MANIFEST.md` | [`docs/cms.md`](../docs/cms.md) |
| `CMS_EDITOR.md` | [`docs/cms.md`](../docs/cms.md) § Editor mode |
| `CMS_AUTHORING.md` | [`docs/cms.md`](../docs/cms.md) § Authoring a block |

## Superseded by `docs-dev/` (framework internals)

| File | Successor |
|---|---|
| `DYNAMIC_PARTIAL_REGISTRY.md` | [`docs-dev/render-pipeline.md`](../docs-dev/render-pipeline.md) |
| `FRAME_SCOPING.md` | [`docs-dev/frame-scope.md`](../docs-dev/frame-scope.md) |
| `TESTING_ARCHITECTURE.md` | [`docs-dev/testing.md`](../docs-dev/testing.md) |
| `SERVER_ISOLATION.md` | [`docs-dev/server-isolation.md`](../docs-dev/server-isolation.md) |

## Pattern shipped, design retrospective archived

| File | Where the pattern lives |
|---|---|
| `STREAMING_CHAT.md` | `src/app/chat/` — bounded `<Piece>` + compaction |

## Removed APIs / earlier designs

| File | Why archived |
|---|---|
| `AGENTS.md` | Old `<Partials namespace="...">` API. Replaced by `<PartialRoot>` + `<Partial>`. Was at repo root; moved here 2026-04-18. |
| `BARE_KEY_REFETCH.md` | Switch from version-stamped Suspense keys to bare `key={id}`. Insights rolled into `LESSONS.md`. |
| `PARTIAL_WRAPPER_DESIGN.md` | Original `<PartialRoot>` + `<Partial>` proposal + activator pattern + rejection of HTMX-style trigger DSL. Implemented; kept as rationale. |
| `PLAN.md` | Original proxy-based data layer plan. Direction abandoned in favor of hand-written GraphQL queries with `graphql-request` + gql.tada. See `proxy-design/README.md`. |
| `REFACTOR_PROGRESS.md` | In-progress log from the 2026-04-18 unified-path refactor. |
| `SERVER_CACHE_NOTES.md` | Original `<Cache dep ttl staleWhileRevalidate>` design. Mechanics still load-bearing inside `src/lib/cache.tsx`; surface replaced by `<Partial cache={…}>` with auto-tracked manifest keys. |
| `PARTIAL_CACHE_DESIGN.md` | Proposal to fold `<Cache>` into `<Partial cache={…}>`. Implemented; cache shape further reshaped to a Cache-Control object. |
| `STREAMING_DEBUG_NOTES.md` | 584 lines of pre-refactor debugging across the streaming / cache / substitute paths. Surviving insights are folded into the code and the lessons docs. |
| `USE_PARTIAL_AND_INPUTS.md` | Reference for `usePartial` / `__inputs` / `usePartialParams` / `silentReplace` — all removed 2026-04-21. Replaced by one `useNavigation()` surface. |
| `VARY_RENDER_API.md` | Original `<Partial vary={...} render={...}>` proposal (2026-04-27). Superseded the same week by `notes/partial-define-step-api.md` — same vary/render core, but moved from a call-site prop pair to a `ReactCms.partial(Render, …)` module-scope constructor. |
| `LESSONS.md` | Refetch-mechanics lessons 2026-04-16 → 2026-04-17 (bare-key Suspense reconciliation, fingerprint-skip, transition default). |
| `LESSONS_FROM_REFACTOR.md` | The 2026-04-18 unified-path refactor. |
| `LESSONS_2026-04-19.md` | `seedRegistry` and `buildTemplate` removal, Flight composite-key on placeholders, `cloneElement` drilling through wrappers. |
| `TAILWIND_SHADCN_MIGRATION.md` | 2026-04-23 status log for the Tailwind v4 + shadcn/ui refactor. |

## Subdirectory

- [`proxy-design/`](./proxy-design/) — the legacy proxy data layer
  (where field access *was* the query). Not wired into the app; kept
  for reference.
