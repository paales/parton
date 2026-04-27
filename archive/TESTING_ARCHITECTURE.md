> **Superseded 2026-04-27** by [`docs-dev/testing.md`](../docs-dev/testing.md).
> Historical design proposal preserved for context.

---

# Testing architecture

**Added:** 2026-04-22.

Four tiers. Pick the highest-up one that can express the assertion — each is an order of magnitude faster than the one below it.

| Tier | Glob | Env | Speed (hot) | What it's for |
|---|---|---|---|---|
| `node` | `src/**/*.{test,spec}.?(c\|m)[jt]s?(x)` | jsdom | ~2s / 133 tests | Pure units, client hooks, state logic |
| `rsc` | `src/**/*.rsc.test.?(c\|m)[jt]s?(x)` | Node + `react-server` condition | ~1s / 11 tests | Server-component trees rendered to Flight, inspected in-process |
| `browser` | `src/**/*.browser.test.?(c\|m)[jt]s?(x)` | Real Chromium via `@vitest/browser` (playwright provider) | ~500ms / test | Things jsdom can't fake: focus, real layout, Navigation API |
| e2e | `e2e/**/*.spec.ts` | Real Chromium against `yarn dev` | ~30s fullyParallel | Full-stack assertions: routing, streaming, cookies, HTML |

All three Vitest tiers run in one invocation (`yarn test:all`); `yarn test` is the fast pair (`node` + `rsc`).

## node tier — unchanged

jsdom, `@vitejs/plugin-rsc` intentionally **off** (its `"use client"` transform wraps modules in client-reference proxies that break hook rendering under jsdom). Set up in `vite.config.ts` under `test.projects[0]` with `extends: true`.

## rsc tier — in-process Flight streams

Runs tests in a Node worker with `react` resolved under the `react-server` condition (the hook-less subset), so the vendored `renderToReadableStream` actually works. Every Vitest tier in this project is a separate project config; the rsc tier lives in `vitest.rsc.config.ts`. Key pieces:

### `resolve.conditions: ["react-server"]` + `NODE_OPTIONS`

Vite's `resolve.conditions` applies during Vite's transform phase. Node's built-in resolver (used when React does `require("react")` internally from a CJS bundle) doesn't read it — the yarn scripts `test:rsc` / `test:watch:rsc` set `NODE_OPTIONS='--conditions=react-server'` to cover that path. Skipping it produces `"The 'react' package in this environment is not configured correctly"` at runtime. No, `poolOptions.forks.execArgv` inside the project config doesn't propagate (empirically true on Vitest 3.2).

### `vitePluginRscMinimal` with `environment: { rsc: "ssr" }`

Activates plugin-rsc's `"use client"` / `"use server"` transforms inside the worker and remaps the plugin's `"rsc"` role onto Vitest's default SSR environment. Without the remap the transforms target an env Vitest doesn't create.

### Why we import the vendored Flight runtime directly, not `@vitejs/plugin-rsc/rsc`

The `/rsc` entry pulls in `virtual:vite-rsc/assets-manifest` + `virtual:vite-rsc/server-references` at module load — those only resolve when the full plugin pipeline is serving. Plain Vitest imports throw `Only URLs with a scheme in: file, data, and node are supported` on load. `@vitejs/plugin-rsc/react/rsc` is closer but reads `import.meta.env.DEV` at render time, which is undefined when the caller is the test runner itself. Skip the plugin wrappers entirely:

```ts
import * as ReactServer from "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge";
import * as ReactClient from "@vitejs/plugin-rsc/vendor/react-server-dom/client.edge";
```

The `.edge` variants use WHATWG streams and don't need `__webpack_require__` globals the browser variants do — why the old `flight-streaming-helper.cjs` subprocess existed.

### Permissive Proxy manifests

Plugin-rsc's transform stamps `"use client"` modules with paths like `/src/foo.tsx#Export`. The Flight runtime looks those up in shape-different manifests on the server (serialise) and client (hydrate) sides. Tests inspect the stream — they don't mount the client reference — so a Proxy-of-Proxies that fabricates `{ id, chunks: [], name }` entries on demand is enough. See `src/test/rsc-server.ts`.

### Helpers

All in `src/test/rsc-server.ts`:

- `renderServerToFlight(node)` → `ReadableStream<Uint8Array>`. Raw bytes for stream-level assertions.
- `flightToString(stream)` → string. Handy for `toContain` checks against the encoded payload.
- `consumePayload<T>(stream)` → parsed payload. Walks lazy refs, identifies element types.
- `renderAndInspect<T>(node)` → `{ text, payload }`. Render + tee + both.
- `renderWithRequest(url, node, { headers })` → `{ stream, cookies }`. Opens a real ALS request context so tracked accessors (`getCookie`, `getSearchParam`, `getPathname`) resolve against the synthetic Request.

### What the rsc tier is *not* for

Partial-registry / `<PartialRoot>` tests that drive full-page trees. Those need more request-context plumbing than the helpers currently offer; for now the big `partial.test.tsx` in the node tier uses mocked client modules. Migrating it would be a separate effort.

## browser tier — Vitest + real Chromium

Lives in `vitest.browser.config.ts`. Uses `@vitest/browser`'s Playwright provider (requires the `playwright` package separately from `@playwright/test`). Each test file matches `*.browser.test.tsx`; tests are opt-in via `yarn test:browser`, not part of the default `yarn test` — the browser-boot cost isn't worth paying on every save.

Setup file `vitest.browser.setup.ts` flips `IS_REACT_ACT_ENVIRONMENT = true` so `act()` calls don't warn. Smoke test in `src/test/click-counter.browser.test.tsx` mounts a client component, clicks it, asserts the DOM.

The first attempt tried to use jsdom-style `container.querySelector()` inside the test. Under real Chromium that doesn't settle before the test returns — wrap writes in `await act(async () => { root.render(...) })` and React commits synchronously with respect to the test. Don't rely on bare `setTimeout(0)`.

## e2e tier — Playwright, parallel by worker

`playwright.config.ts` now runs `fullyParallel: true`. Workers get chosen automatically by CPU count. Safe because:

### Per-worker scope header

`e2e/fixtures.ts` overrides both the `page` and `request` fixtures so every HTTP call carries `x-test-scope: worker-<workerIndex>`. The framework reads it in `framework/context.ts` (`deriveScope` — dev only, prod ignores it for safety) and buckets every piece of Category C state by scope. See `SERVER_ISOLATION.md`.

Spec files import `test`/`expect`/`request` from `./fixtures`, not `@playwright/test` directly. A standalone `request.newContext()` re-export is also provided — same scope injection — for specs that create their own API context outside the built-in fixture.

### Why the override is two-pronged

- `page` fixture calls `page.context().setExtraHTTPHeaders(...)` — covers `page.goto` + `page.request.*`.
- `request` fixture creates a fresh `APIRequestContext` with the header baked into `extraHTTPHeaders` — covers `const { request } = test()` destructuring.
- Named `request` export (for `import { request } from "./fixtures"`) calls `pwRequest.newContext(...)` with the header — covers specs that instantiate their own context.

Miss any of those three and you'd route into the `"default"` bucket, where workers contend.

### `fullyParallel: true` expectations

Demo pages that were previously keyed on process-global counters (`cache-demo.tsx:slowRenderCounts`, `chat/log.ts:scopes`) are now scope-bucketed too — tests within a file can assume sequential-looking counter semantics because every request in that worker shares one bucket, and no other worker touches it. When you add a demo page with module-level counters:

1. Bucket it per scope via `getScope()`.
2. Annotate with `// CATEGORY C — scope-bucketed` per `SERVER_ISOLATION.md`.

### What tests should do

- `beforeEach` that needs a cold cache: `await request.get("/__test/clear-caches")`. Clears just your worker's scope.
- Debug toolbar flush button: `/__test/clear-caches?all=1`. Wipes every scope (useful from dev, not from tests).
- Don't import directly from `@playwright/test`; use `./fixtures` so your requests inherit the scope header.

## Recurring speed wins

- `yarn test:watch` is the inner-loop default — node project only, re-runs on save.
- `yarn test:watch:rsc` for RSC work.
- `yarn test:e2e --grep "pattern"` for iterating on one spec.
- `yarn dev` stays up across e2e runs — Playwright hits the live server. HMR dispose hooks (`cache.tsx`, `partial-registry.ts`) clear module-owned state on code edits so you don't need to restart the server to reset caches.

## What's *not* documented here

- The fine details of each plugin-rsc version's transform behaviour — read the plugin source at the pinned version.
- Playwright's own fixture system — the docs are good. This doc only explains the two overrides we add.
