# Notes

Active research and forward-looking design. Anything that's shipped
and stable lives in `../reference/` (user-facing) or `../internals/`
(framework internals). Anything superseded or abandoned lives in
`../archive/`.

## Current

| File | What it covers |
|---|---|
| [`IDEAS.md`](./IDEAS.md) | Forward-looking backlog. Resolved items keep a `RESOLVED YYYY-MM-DD` banner pointing to where the work landed. |
| [`AA_CHAT_STREAMING.md`](./AA_CHAT_STREAMING.md) | Demo content for the chat overlay (the file the streaming-chat demo reads first). Not a design doc — kept here because the chat producer resolves filenames against `docs/notes/`. |

## Where else to look

- [`../reference/`](../reference/) — framework reference (intro,
  partial, frames-navigation, cache, cms, prior-art).
- [`../internals/`](../internals/) — framework internals (testing,
  render-pipeline, cache-internals, frame-scope, manifest-internals,
  server-isolation, flight-gotchas).
- [`../../CLAUDE.md`](../../CLAUDE.md) — project structure, tooling,
  dev workflow.
- [`../archive/`](../archive/) — superseded designs, debugging logs,
  removed APIs. See `../archive/README.md` for the index.
