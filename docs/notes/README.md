# Notes

In-progress work ONLY: the backlog and live design docs for arcs
actively being built. Anything shipped and stable lives in
`../reference/` (contracts) or `../internals/` (mechanisms) — latest
state only. Anything superseded or dormant lives in `../archive/`
with a `Superseded` banner (see `../archive/README.md` for the
index). When a design here lands, its note moves to the archive and
the reference/internals pages become the owner — a note never stays
behind as a second description of shipped behavior.

## Current

| File                                                 | What it covers                                                                                                                                                                                                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`IDEAS.md`](./IDEAS.md)                             | Concrete framework backlog — chapters describing what to build. Open items only; resolved/shipped items are deleted, collapsed to a one-line resolved pointer, or moved to `../archive/` when the design exploration is worth preserving.                                     |
| [`user-ideas.md`](./user-ideas.md)                   | Wider exploratory directions — "what if we…" / "should we investigate…" items, distinct from `IDEAS.md`'s concrete backlog.                                                                                                                                                   |
| [`delivery-plane.md`](./delivery-plane.md)           | The delivery plane — deadlines and broadcast as one indexed layer draining a single per-connection pending set. D1/D2 landed; the remaining consolidation is the active design conversation.                                                                                  |
| [`remote-frame-arc.md`](./remote-frame-arc.md)       | The federation arc — the consolidated `<RemoteFrame>` design: ordinary pages as the unit, trust tiers as splice-time payload constraints, the framework vocabulary, the URL/dimensionality grant, cells across the boundary, increments (6/7 pending).                        |
| [`remote-frame-design.md`](./remote-frame-design.md) | Detail backlog for `<RemoteFrame>` v2+ — numbered open questions (permissions / batching / signed tokens / sessions / hydration); §4 and §6 are the only home of two still-intended designs. Read [`remote-frame-arc.md`](./remote-frame-arc.md) first; it wins on conflicts. |

## Where else to look

- [`../reference/`](../reference/) — framework reference (intro,
  partial, block, cells, frames-navigation, remote-frame, cache,
  cms, deployment, errors, prior-art).
- [`../internals/`](../internals/) — framework internals (testing,
  render-pipeline, streaming, channel, cache-internals,
  cell-internals, registry-internals, frame-scope, page-embed,
  server-isolation, server-context, flight-gotchas).
- [`../../CLAUDE.md`](../../CLAUDE.md) — project structure, tooling,
  dev workflow.
- [`../archive/`](../archive/) — superseded designs, debugging logs,
  removed APIs. See `../archive/README.md` for the index.
