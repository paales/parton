# Testing

Four tiers, picked by glob. Each is an order of magnitude faster than
the one below it; pick the highest-up tier that can express the
assertion.

| Tier | Glob | Env | Speed (hot) | Use for |
|---|---|---|---|---|
| `node` | `src/**/*.{test,spec}.?(c\|m)[jt]s?(x)` | jsdom | ~2s / 133 tests | Pure units, client hooks, state logic |
| `rsc` | `src/**/*.rsc.test.?(c\|m)[jt]s?(x)` | Node + `react-server` condition | ~1s / 11 tests | Server-component trees rendered to Flight, inspected in-process |
| `browser` | `src/**/*.browser.test.?(c\|m)[jt]s?(x)` | Real Chromium via `@vitest/browser` | ~500ms / test | Things jsdom can't fake: focus, real layout, Navigation API |
| e2e | `e2e/**/*.spec.ts` | Real Chromium against `yarn dev` | ~30s fullyParallel | Full-stack assertions: routing, streaming, cookies, HTML |

Vitest tiers run together via `yarn test:all`; `yarn test` is the
fast pair (`node` + `rsc`). `yarn test:e2e` runs Playwright.

## node tier

jsdom; `@vitejs/plugin-rsc` deliberately off. The plugin's
`"use client"` transform wraps modules in client-reference proxies
that break hook rendering under jsdom. Configured in `vite.config.ts`
under `test.projects[0]` with `extends: true`.

Use this tier for the bulk of unit work — cache-key derivation,
selector parsing, manifest helpers, client hooks against a mocked
DOM.

## rsc tier

Server components rendered to a Flight stream and inspected
in-process. Configured in `vitest.rsc.config.ts`.

### `resolve.conditions: ["react-server"]` + `NODE_OPTIONS`

Vite's `resolve.conditions` only applies during Vite's transform.
Node's built-in resolver (used when React's CJS bundle does
`require("react")` internally) doesn't read it; the yarn scripts
`test:rsc` / `test:watch:rsc` set `NODE_OPTIONS='--conditions=react-server'`
to cover that path. Skipping it produces *"The 'react' package in
this environment is not configured correctly"* at runtime.

`poolOptions.forks.execArgv` inside the project config doesn't
propagate (empirically true on Vitest 3.2). Always set
`NODE_OPTIONS`.

### `vitePluginRscMinimal` with `environment: { rsc: "ssr" }`

Activates the plugin's `"use client"` / `"use server"` transforms
inside the worker and remaps the plugin's `"rsc"` role onto
Vitest's default SSR environment. Without the remap the transforms
target an env Vitest doesn't create.

### Why import the vendored Flight runtime directly

`@vitejs/plugin-rsc/rsc` pulls in `virtual:vite-rsc/assets-manifest`
and `virtual:vite-rsc/server-references` at module load — those only
resolve when the full plugin pipeline is serving. Plain Vitest
imports throw *"Only URLs with a scheme in: file, data, and node are
supported"* on load.

`@vitejs/plugin-rsc/react/rsc` is closer but reads
`import.meta.env.DEV` at render time, which is undefined when the
caller is the test runner.

Skip the wrappers entirely:

```ts
import * as ReactServer from "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge";
import * as ReactClient from "@vitejs/plugin-rsc/vendor/react-server-dom/client.edge";
```

The `.edge` variants use WHATWG streams and don't need
`__webpack_require__` globals the browser variants do.

### Permissive Proxy manifests

The plugin's transform stamps `"use client"` modules with paths like
`/src/foo.tsx#Export`. The Flight runtime looks them up in
shape-different manifests on the server (serialise) and client
(hydrate) sides. Tests inspect the stream rather than mounting the
client reference, so a Proxy-of-Proxies that fabricates
`{id, chunks: [], name}` entries on demand is enough. See
`src/test/rsc-server.ts`.

### Helpers

In `src/test/rsc-server.ts`:

| Helper | Returns |
|---|---|
| `renderServerToFlight(node)` | `ReadableStream<Uint8Array>` — raw bytes for stream-level assertions. |
| `flightToString(stream)` | `Promise<string>` — handy for `toContain` checks against the encoded payload. |
| `consumePayload<T>(stream)` | Parsed payload; walks lazy refs, identifies element types. |
| `renderAndInspect<T>(node)` | `{text, payload}` — render + tee + both. |
| `renderWithRequest(url, node, {headers})` | Opens a real ALS request context so tracked accessors resolve against the synthetic Request. |

### What the rsc tier isn't for

Partial-registry / `<PartialRoot>` tests that drive full-page trees
with refetch flows. Those need more request-context plumbing than
the helpers currently offer; the comprehensive `partial.test.tsx` is
in the node tier with mocked client modules. Migrating it is
separate work.

## browser tier

Real Chromium via `@vitest/browser`'s Playwright provider (requires
the `playwright` package separately from `@playwright/test`). Each
test file matches `*.browser.test.tsx`; opt-in via `yarn test:browser`,
not part of the default `yarn test` — the browser-boot cost isn't
worth paying on every save.

Setup in `vitest.browser.setup.ts` flips
`IS_REACT_ACT_ENVIRONMENT = true` so `act()` calls don't warn.
Smoke test in `src/test/click-counter.browser.test.tsx` mounts a
client component, clicks it, asserts the DOM.

Wrap React renders in `act()` to commit synchronously with respect
to the test:

```ts
await act(async () => { root.render(<Component/>); });
```

Bare `setTimeout(0)` doesn't reliably settle under real Chromium.

## e2e tier

`playwright.config.ts` sets `fullyParallel: true`. Workers picked
automatically by CPU count. Safe because every request carries a
per-worker scope token.

### Per-worker scope header

`e2e/fixtures.ts` overrides both the `page` and `request` fixtures
so every HTTP call carries `x-test-scope: worker-<workerIndex>`.
The framework reads it in `framework/context.ts` (`deriveScope`,
dev-only — prod always ignores) and buckets every piece of
Category C state by scope.

Spec files import `test`, `expect`, `request` from `e2e/fixtures.ts`,
not `@playwright/test` directly:

```ts
import { test, expect, request } from "./fixtures";
```

### Why the override is two-pronged

- `page` fixture calls `page.context().setExtraHTTPHeaders(...)` —
  covers `page.goto` + `page.request.*`.
- `request` fixture creates a fresh `APIRequestContext` with the
  header baked into `extraHTTPHeaders` — covers
  `const { request } = test()` destructuring.
- Named `request` export calls `pwRequest.newContext(...)` with the
  header — covers specs that instantiate their own context.

Miss any of those and a request lands in the `"default"` bucket
where workers contend.

### Auto-started dev server

`webServer: { command: "yarn dev", url: "http://localhost:5173",
reuseExistingServer: true }` — Playwright boots `yarn dev` if
nothing is on port 5173, or reuses an existing server if you have
one running. Dev-server stdout forwards into the Playwright
reporter prefixed with `[WebServer]`, so React warnings,
`console.error` calls, and Vite logs from RSC/SSR all surface in
the test output.

### `/__test/clear-caches` endpoint

Dev-only, in `src/framework/entry.rsc.tsx`. Clears state per scope:

```ts
await request.get("/__test/clear-caches");          // your worker only
await request.get("/__test/clear-caches?all=1");    // every scope
```

The debug toolbar's flush button uses `?all=1`. The draft file
(`src/cms/draft.json`) is on-disk and not scope-bucketed, so it's
always cleared on both calls.

Use in `beforeEach` for specs asserting Suspense fallback behavior
or anything sensitive to cold state.

### Demo-page counters

Anything that exposes a counter (cache-demo render counts, chat
log producers) is scope-bucketed too. Tests within a file can assume
sequential-looking counter semantics because every request in that
worker shares one bucket. When you add a demo page with module-level
counters:

1. Bucket per scope via `getScope()` from `framework/context.ts`.
2. Annotate with `// CATEGORY C — scope-bucketed` per
   `docs-dev/server-isolation.md`.

## Vitest fixtures

Route-keyed fixtures in `partial.test.tsx` need a registry reset.
Dynamic Partials registered under the fake URL (`http://localhost/test`)
otherwise leak across tests and contaminate tag resolution:

```ts
import { clearRegistry } from "../partial-registry.ts";
beforeEach(() => clearRegistry());
```

## Speed wins

- `yarn test:watch` — node project only, re-runs on save. Inner-loop
  default.
- `yarn test:watch:rsc` — for RSC work.
- `yarn test:e2e --grep "pattern"` — iterate on one spec.
- Keep `yarn dev` up across e2e runs — Playwright hits the live
  server. HMR dispose hooks (`cache.tsx`, `partial-registry.ts`)
  clear module-owned state on code edits, so you don't restart the
  server to reset caches.

## isTestMode()

`isTestMode()` from `framework/context.ts` returns `true` whenever
the current request's scope is non-default. Use it to narrow
hand-crafted latency in demo code so e2e tests don't spend wall
time on artificial delays:

```ts
const chunkDelay = isTestMode() ? 5 : 100;
const budget = isTestMode() ? 3_000 : 10_000;
```

Currently used by the chat log producer (`src/app/chat/log.ts`).

**Don't apply globally to demo latency.** Some specs assert on
absolute-latency behavior (Suspense fallback visible before its
resolved content). Uniformly shrinking demo delays breaks those
assertions. Narrow per-call only.

## Adding a new test

| Want | Tier |
|---|---|
| A pure function returns the right thing | `node` |
| A client hook updates state correctly | `node` |
| A server component emits the right Flight payload | `rsc` |
| A rendered tree's `cmsId` correctly opens a CMS scope | `rsc` |
| Real focus / layout / Navigation API behavior | `browser` |
| Page nav from `/foo` to `/bar` updates the cart partial | `e2e` |
| A server action returns `invalidate` and the preview refetches | `e2e` |

Both `yarn test` and `yarn test:e2e` must pass before a change is
done. They cover disjoint suites.
