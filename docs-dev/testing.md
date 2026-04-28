# Testing

Three Vitest projects:

| Project | Where | Runs |
|---|---|---|
| `node` | `src/lib/__tests__/*.test.ts(x)` (jsdom-safe), `src/editor/__tests__/*` | Plain TS / DOM-safe units. |
| `rsc` | `src/lib/__tests__/*.rsc.test.tsx`, `src/framework/__tests__/*` | In-process Flight render via `src/test/rsc-server.ts`. |
| `browser` | `src/lib/__tests__/*.browser.test.ts(x)` | Real Chromium via Vitest browser mode. |

Plus Playwright:

| Suite | Where |
|---|---|
| e2e | `e2e/*.spec.ts` |

## RSC harness

`src/test/rsc-server.ts` wraps the same Flight encode → decode
round-trip the production renderer uses, but inside a single Node
process. Use it to assert against the exact tree the client would
render:

```ts
const { rendered } = await renderRsc(<Root />, { url: "/cache-demo" })
expect(rendered).toContain("Cache size:")
```

## Per-test scope

Every RSC + Vitest test gets a per-test scope token via
`x-test-scope`. Parallel tests don't contend on the per-scope
state buckets (`<Cache>` store, registry, sessions, GraphQL cache).

## After the constructor migration

The 2026-04-28 rewrite replaced `<Partial>` + tracked accessors
with `ReactCms.partial(...)` specs. Most existing tests reference
removed APIs (`getCookie`, `getSearchParam`, `runWithCacheManifest`,
`HoistingViolationError`, `partial-component.tsx`) and don't run
yet — they need rewriting against the new surface.

The migration target shape for a test:

```ts
import { ReactCms, ROOT } from "../../lib"

const TestPartial = ReactCms.partial(
  ({ value }) => <span>{value}</span>,
  { selector: "#test", vary: ({ request }) => ({ value: new URL(request.url).searchParams.get("v") ?? "" }) }
)

const { rendered } = await renderRsc(<TestPartial parent={ROOT} />, { url: "/?v=hello" })
expect(rendered).toContain("hello")
```
