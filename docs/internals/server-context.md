# Server context

Values threaded parent→child through the server render tree, readable during
any Server Component's render. React's RSC renderer has no Context for Server
Components (and the experimental `createServerContext` was removed), so the
framework implements it as a small patch to the vendored Flight server.

**One channel, every consumer.** A single immutable map flows down the task
graph. Each context is one keyed entry — every `createServerContext` value,
and the framework's own parton parent (`PartialCtx` — ancestor id path + frame
chain), which rides the same channel under a reserved key, `ParentContext`. The
generic primitive is `framework/src/lib/server-context.ts`; the parton-parent
consumer (`ParentContext`) lives in `partial-context.ts`; the patch is
`.yarn/patches/@vitejs-plugin-rsc-*.patch`, authored reproducibly by
`scripts/patch-plugin-rsc-server-context.mjs`.

## The two parts: a carrier and a reader

A value must (a) flow parent→child and survive `await`, and (b) be readable by
the rendering component. These are different mechanisms:

- **Carrier — React's Task graph.** Each Task is a node in the render tree, and
  the graph already threads values parent→child (e.g. `formatContext`). We
  thread a `serverContext` map the same way. It survives `await` because an
  async component resumes *through* `retryTask`, which re-establishes the
  rendering task.
- **Reader — an `AsyncLocalStorage`.** The patch runs every component inside
  `partonStorage.run(task, …)` — the same mechanism React's own dev
  `componentStorage` uses, extended to prod. Because an ALS store follows the
  JS engine's post-`await` continuation, a component reads context *anywhere*
  in its render — before or after its awaits — and sibling renders stay
  isolated.

## Why not a request-level AsyncLocalStorage

Both naive ALS strategies fail for the carrier, and we have probes proving it
(`__tests__/als-parent-probe`):

- `als.run(ctx, …)` at the request root does not reach a child rendered in a
  later continuation — children read nothing.
- `als.enterWith(ctx)` leaks across siblings — React's work loop renders
  siblings in one shared async context, so the last `enterWith` wins.

A *per-component* `run` (what the patch does at the render site) is different:
each component gets its own scope, so its post-`await` reads stay correct and
siblings don't cross-contaminate. That's the reader half; the carrier still
needs the task graph because a child renders in a fresh continuation outside
the parent's `run` scope.

## The patch (dev + prod edge builds)

Authored by `scripts/patch-plugin-rsc-server-context.mjs`; each edit asserts a
unique anchor, so an upstream change fails loudly.

1. **`createTask`** inherits the `serverContext` map from
   `request.__renderingTask` — the task whose render is executing — exactly how
   `formatContext` is already inherited (preferring its `serverChildContext`,
   the map it scoped for children, over its own `serverContext`).
2. **`retryTask`** save/restores `request.__renderingTask` around its body, so
   it always names the currently-rendering task. Without the restore, a
   depth-first sibling render clobbers it and the next sibling wrongly inherits
   the previous one's child map.
3. The **render site** declares a `partonStorage` `AsyncLocalStorage` and runs
   the component inside `partonStorage.run(task, …)`, exposing the ALS as
   `ReactSharedInternalsServer.__partonStorage` for the shim.

The edge build never imports `AsyncLocalStorage` (edge runtimes lack
`async_hooks`). `@vitejs/plugin-rsc` injects `globalThis.AsyncLocalStorage`
from `node:async_hooks` for SSR/RSC, so on the real Vite server the global is
present; the patch prefers it and falls back to `require("node:async_hooks")`
for the vitest harness (which skips that transform). On a true edge runtime
with no `async_hooks` the `require` throws at load — loud, not silent.

## The public API

`server-context.ts` exposes two functions (reading
`ReactSharedInternalsServer.__partonStorage` under the hood):

- `createServerContext(default)` → a value that is BOTH a provider component
  and the handle for `getServerContext`:

```tsx
const Theme = createServerContext<"light" | "dark">("light")

<Theme value="dark">
  <Page />          {/* getServerContext(Theme) → "dark" anywhere inside */}
</Theme>
```

- `getServerContext(Ctx)` → the value for `Ctx` (its child map first, then its
  inherited map — a provider's un-outlined direct child renders in the
  provider's own task), or `Ctx`'s default. Valid anywhere in a render — there
  is no "sync-top rule".

The provider yields once (`await null`) so it renders in its own task, then
overlays its key onto that task's child map — siblings sharing the parent task
never inherit it. The overlay copies the existing map, so every OTHER key
flows through untouched.

`partial-context.ts` is the first consumer: the parton parent is one reserved
entry, `ParentContext`. A parton reads its parent with
`getServerContext(ParentContext)` and scopes its descendants by returning them
inside `<ParentContext value={childCtx}>` (so does `<Frame>`, and the cache's
isolated render). Because that overlays only the parent key, every user server
context threads through a parton to its descendants for free.

Isolated renders that are their own render root — a cache hole, a
`<RemoteFrame>`, an addressable refetch — have no ambient parent task; those
seed `parent` explicitly (the cache renders its body inside
`<ParentContext value={bodyParent}>`; refetch injects the `__parent` prop), and
the task graph threads it onward.

## Maintaining the patch across upgrades

The patch targets `@vitejs/plugin-rsc`'s vendored
`react-server-dom-webpack-server.edge.{development,production}.js`. On an
upgrade, regenerate it:

```
yarn patch @vitejs/plugin-rsc
node scripts/patch-plugin-rsc-server-context.mjs <printed-temp-dir>
yarn patch-commit -s <printed-temp-dir>
```

If an anchor no longer matches, the script throws — re-locate `createTask` /
`retryTask` / the render site in the new build and update the anchors. The
wire format and these internals are unspecified and may change; the asserted
anchors are the early-warning system.
```
