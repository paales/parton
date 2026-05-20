# Notes

Active research and forward-looking design. Anything that's shipped
and stable lives in `../reference/` (user-facing) or `../internals/`
(framework internals). Anything superseded or abandoned lives in
`../archive/`.

## Current

| File | What it covers |
|---|---|
| [`IDEAS.md`](./IDEAS.md) | Concrete framework backlog — chapters describing what to build. Open items only; resolved/shipped items are deleted, or moved to `../archive/` when the design exploration is worth preserving. |
| [`user-ideas.md`](./user-ideas.md) | Wider exploratory directions — "what if we…" / "should we investigate…" items, distinct from `IDEAS.md`'s concrete backlog. |
| [`cells.md`](./cells.md) | Live design doc for the cell primitive — typed, identity-keyed slot of server-authoritative state. Covers the controlled-input discipline and the `useCell` hook (optimistic value, batched set, `cell.input()` bindings). |
| [`replicated-state.md`](./replicated-state.md) | Live design doc translating Unreal's actor replication model into parton primitives — authority taxonomy, RepNotify, useReplayableOptimistic. Forward-looking; cells cover the narrow "single typed value" lane today. |
| [`perspectives.md`](./perspectives.md) | Cross-cutting framing notes — primitives compared, prior-art tensions. |
| [`remote-frame-design.md`](./remote-frame-design.md) | Design notes for `<RemoteFrame>` (cross-origin partial composition). |
| [`AA_CHAT_STREAMING.md`](./AA_CHAT_STREAMING.md) | Demo content for the chat overlay (the file the streaming-chat demo reads first). Not a design doc — kept here because the chat producer resolves filenames against `docs/notes/`. |

## Where else to look

- [`../reference/`](../reference/) — framework reference (intro,
  partial, block, frames-navigation, cache, cms, prior-art).
- [`../internals/`](../internals/) — framework internals (testing,
  render-pipeline, cache-internals, registry-internals, frame-scope,
  server-isolation, flight-gotchas).
- [`../adr/`](../adr/) — architecture decision records.
- [`../../CLAUDE.md`](../../CLAUDE.md) — project structure, tooling,
  dev workflow.
- [`../archive/`](../archive/) — superseded designs, debugging logs,
  removed APIs. See `../archive/README.md` for the index.
