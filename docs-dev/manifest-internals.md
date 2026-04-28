# Manifest internals — superseded

The auto-tracked manifest system (per-Partial `current` / `stored`
sets, `HoistingViolationError`, descendant manifest folding,
`baselineManifest` rotation, etc.) was removed in the 2026-04-28
rewrite to the `ReactCms.partial(...)` constructor.

The cache-key surface is now whatever `vary` returns — see
[`docs/cache.md`](../docs/cache.md) for the new shape, and
[`notes/partial-define-step-api.md`](../notes/partial-define-step-api.md)
for the design rationale.

The historical manifest docs are preserved in
[`archive/`](../archive/) under `AUTO_TRACKED_CACHE_KEYS.md` and
`AUTO_TRACKED_VARY.md`.
