# React CMS

A React Server Components based framework layer for pages composed
of independently re-renderable, addressable, cacheable subtrees.
Research project — does this primitive shape hold up as a CMS data
layer?

The primitive is `<Partial>`. Pages are JSX trees of Partials; each
one self-registers at render time, computes a structural fingerprint,
and is independently refetchable. Targeted refetches re-run only the
requested Partial body — without re-executing any ancestor — by
replaying registry snapshots. State that varies between refetches
flows through URLs (page or frame) and is read server-side via
tracked accessors, which auto-derive cache keys for `<Partial cache>`.

For the full mental model, start with [`docs/reference/intro.md`](./docs/reference/intro.md).

## Layout

This repo is a yarn workspace monorepo. Each top-level folder is a
package.

| Folder | For |
|---|---|
| [`docs/reference/`](./docs/reference/) | Framework reference. `intro` · `partial` · `frames-navigation` · `cache` · `cms` · `prior-art`. |
| [`docs/internals/`](./docs/internals/) | Framework internals. `testing` · `render-pipeline` · `cache-internals` · `frame-scope` · `manifest-internals` · `server-isolation` · `flight-gotchas`. |
| [`docs/notes/`](./docs/notes/) | Active research and forward-looking design (`IDEAS.md`). |
| [`docs/archive/`](./docs/archive/) | Superseded designs and debugging logs. Reference only. |
| [`CLAUDE.md`](./CLAUDE.md) | Project structure, tooling, dev workflow. |
| `framework/` | The Partials library + RSC plumbing + in-process test harness. |
| `cms/` | CMS editor UI (three-pane shell) and committed content store. |
| `copies/` | Local copies of shadcn UI primitives + AI-elements + shared hooks. |
| `e2e-testing/` | Example testing app (PokeAPI + GraphCommerce Magento backends) and Playwright specs. |
| `e2e-magento/` | Empty showcase scaffold for a future Magento integration. |

## Quickstart

```bash
yarn install
yarn dev
```

Open `http://localhost:5173`. The example app exposes:

| Path | Demo |
|---|---|
| `/` | PokeAPI — search, infinite scroll, frame-scoped quick view. |
| `/magento` | GraphCommerce — product list, live cart, server-action invalidation. |
| `/cms-demo` | CMS-resolved page with cascading per-slug configs. |
| `/?editor=1` | The CMS editor — three-pane shell, save → preview refetch. |
| `/cache-demo` | `<Partial cache>` semantics: maxAge, SWR, manifest-derived keys. |
| `/defer-demo` | `defer={<WhenVisible/>}` and `<WhenStored>` activators. |
| `/frames-demo` | Per-frame URLs, two history axes, drawer navigation. |
| `/chat-notes` | Bounded `<Piece>` + compaction streaming pattern. |
| `/selector-demo` | Selector-targeted refetch — `#unique` vs `.shared`. |
| `/sentinels-demo` | `notFound()` and `redirect()` from deep async server components. |

## Test

```bash
yarn test       # Vitest — node + rsc projects (fast)
yarn test:e2e   # Playwright — full-stack
```

Both suites cover disjoint surfaces; both must pass before a change
is done. See [`docs/internals/testing.md`](./docs/internals/testing.md)
for tier picking and the in-process Flight harness.
