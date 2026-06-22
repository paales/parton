/**
 * Applies the parton "server context" patch to a copy of
 * `@vitejs/plugin-rsc`'s vendored react-server-dom Flight server.
 *
 * React's RSC renderer has no Server Component context. We carry one in an
 * `AsyncLocalStorage` (`partonStorage`) — the SAME store the reader already
 * uses, so context rides the mechanism that already follows post-`await`
 * continuations reliably (the carrier is not a separate, fragile channel).
 *
 * The unit threaded through the ALS is a small per-render FRAME object —
 * `{ ctx, childCtx?, parton? }`:
 *
 *  - `ctx` is the immutable context map this subtree READS (every
 *    `createServerContext` value, plus the framework parton parent).
 *  - `childCtx` is what a provider declares for its CHILDREN (set inside the
 *    provider component; consumed by the render site, never read back).
 *  - `parton` is the rendering parton's self-identity (`getCurrentParton`),
 *    read-your-own and not inherited.
 *
 * Edits per build (dev + prod edge):
 *
 *  1. Declare `partonStorage` (the ALS) and `PARTON_CTX` (a sentinel
 *     `Symbol.for` shared with `server-context.ts`) alongside React's storages.
 *  2. `createTask` captures the current frame's `ctx` onto the new task
 *     (`task.serverCtx`) — an immutable snapshot taken when the task is
 *     created, so a deferred/outlined child renders in the context that was
 *     active where its element appeared, not whatever a sibling wrote later.
 *  3. `retryTask` runs the whole task render inside
 *     `partonStorage.run({ ctx: task.serverCtx }, …)`, so reads, child
 *     `createTask`s, and post-`await` continuations all see that context.
 *  4. The render site runs each component in a FRESH frame inheriting the
 *     parent `ctx` (`partonStorage.run(__frame, Component, …)`) — that frame is
 *     where a parton stamps its self-identity (`getCurrentParton`) and where a
 *     read resolves `ctx`.
 *  5. `renderModelDestructive` recognises a `PARTON_CTX` marker (what a
 *     provider returns: `{ $$typeof: PARTON_CTX, _ctx, _node }`) and OUTLINES
 *     `_node` into its own task whose `serverCtx` is `_ctx` (`createTask` taken
 *     inside `partonStorage.run({ ctx: _ctx }, …)`, then `pingTask`). The whole
 *     subtree — arrays, client-component props, suspending children — then
 *     renders and serialises under the overlay (every pass runs through that
 *     task's `retryTask`, which re-establishes `_ctx`), which a render-time
 *     scope alone cannot guarantee across React's deferred serialization. The
 *     ALS is exposed as `ReactSharedInternalsServer.__partonStorage` for the
 *     shim.
 *
 * Run via `yarn patch` (see docs/internals). `node this.mjs <pkgDir>` edits
 * the dev + prod edge builds in `<pkgDir>/dist/vendor/react-server-dom/cjs/`.
 * Each edit asserts a unique anchor match, so an upstream change fails
 * loudly instead of silently mis-patching.
 */

import { readFileSync, writeFileSync } from "node:fs"

const pkgDir = process.argv[2]
if (!pkgDir) throw new Error("usage: node patch-plugin-rsc-server-context.mjs <pkgDir>")
const cjs = `${pkgDir}/dist/vendor/react-server-dom/cjs/`

// The vendored build is the EDGE build: it never imports `AsyncLocalStorage`,
// so we source one ourselves. `@vitejs/plugin-rsc` sets
// `globalThis.AsyncLocalStorage` (from `node:async_hooks`) for SSR/RSC, so on
// the real Vite server the global is present — prefer it. The vitest harness
// skips that transform, so fall back to `require` there (its module context is
// CJS). On a true edge runtime (no global, no `async_hooks`) the `require`
// throws at load: loud, not silent.
const NEW_ALS =
  'partonStorage = (typeof globalThis !== "undefined" && typeof globalThis.AsyncLocalStorage === "function") ? new globalThis.AsyncLocalStorage() : new (require("node:async_hooks").AsyncLocalStorage)(),'

// createTask snapshots the current frame's immutable ctx onto the new task.
// Taken at creation, when the ALS frame is the one whose render scheduled this
// task — so the task carries the context active where its element appeared.
const CTX_CAPTURE = "serverCtx: partonStorage.getStore() ? partonStorage.getStore().ctx : null,"

function patch(file, edits) {
  let s = readFileSync(file, "utf8")
  for (const [needle, repl] of edits) {
    const parts = s.split(needle)
    if (parts.length !== 2)
      throw new Error(
        `${file}: expected 1 match, got ${parts.length - 1} for: ${needle.slice(0, 70)}…`,
      )
    // join (not String.replace) so `$$` in the replacement — e.g. `$$typeof` —
    // is inserted literally rather than interpreted as a replacement pattern.
    s = parts.join(repl)
  }
  writeFileSync(file, s)
  console.log(`patched ${file.split("/").pop()}: ${edits.length} edits`)
}

// PARTON_CTX marker handling for renderModelDestructive: a provider returns
// `{ $$typeof: PARTON_CTX, _ctx, _node }`; outline `_node` into a task whose
// captured `serverCtx` is the overlay (createTask runs inside the overlay's ALS
// frame), then defer it. Everything under the marker — including arrays and
// client-component props serialized later — renders through that task's
// `retryTask`, which re-enters `_ctx`. This is exactly `deferTask` (new task
// for the model, `pingTask`, `$L` lazy reference) — the proven path for a
// model that may suspend and stream — only with the model `_node` instead of
// `task.model` and the `createTask` taken inside the overlay's ALS frame. The
// dev `createTask`/`deferTask` carry four extra debug args, so dev needs its
// own branch or the dev stream's debug chunks reference undefined.
const MARKER_BRANCH_PROD =
  "if (value.$$typeof === PARTON_CTX) { var __ct = partonStorage.run({ ctx: value._ctx }, createTask, request, value._node, task.keyPath, task.implicitSlot, task.formatContext, request.abortableTasks); pingTask(request, __ct); return serializeLazyID(__ct.id); }"
const MARKER_BRANCH_DEV =
  "if (value.$$typeof === PARTON_CTX) { var __ct = partonStorage.run({ ctx: value._ctx }, createTask, request, value._node, task.keyPath, task.implicitSlot, task.formatContext, request.abortableTasks, task.time, task.debugOwner, task.debugStack, task.debugTask); pingTask(request, __ct); return serializeLazyID(__ct.id); }"

// ── production build (2/4-space indent) ──
patch(cjs + "react-server-dom-webpack-server.edge.production.js", [
  // 1. declare the parton ALS + the marker sentinel
  [
    '  requestStorage = supportsRequestStorage ? new AsyncLocalStorage() : null,\n  TEMPORARY_REFERENCE_TAG = Symbol.for("react.temporary.reference"),',
    `  requestStorage = supportsRequestStorage ? new AsyncLocalStorage() : null,\n  ${NEW_ALS}\n  PARTON_CTX = Symbol.for("parton.serverContext"),\n  TEMPORARY_REFERENCE_TAG = Symbol.for("react.temporary.reference"),`,
  ],
  // 2. createTask snapshots the current frame's ctx onto the task
  [
    "    formatContext: formatContext,\n    ping: function () {",
    `    formatContext: formatContext,\n    ${CTX_CAPTURE}\n    ping: function () {`,
  ],
  // 3. retryTask renders the task inside its captured ctx
  [
    "function retryTask(request, task) {\n  if (0 === task.status) {",
    "function retryTask(request, task) {\n  partonStorage.run({ ctx: task.serverCtx }, function () {\n  if (0 === task.status) {",
  ],
  [
    "      serializedSize = parentSerializedSize;\n    }\n  }\n}",
    "      serializedSize = parentSerializedSize;\n    }\n  }\n  });\n}",
  ],
  // 4. render site: run each component in a fresh frame inheriting parent ctx
  [
    "  thenableState = prevThenableState;\n  props = Component(props, void 0);",
    "  thenableState = prevThenableState;\n  ReactSharedInternalsServer.__partonStorage = partonStorage;\n  var __pf = partonStorage.getStore();\n  var __frame = { ctx: __pf ? __pf.ctx : null };\n  props = partonStorage.run(__frame, Component, props, void 0);",
  ],
  // 5. renderModelDestructive re-scopes a provider's PARTON_CTX marker subtree
  [
    '  if ("object" === typeof value) {\n    switch (value.$$typeof) {',
    `  if ("object" === typeof value) {\n    ${MARKER_BRANCH_PROD}\n    switch (value.$$typeof) {`,
  ],
])

// ── development build (8-space indent) ──
patch(cjs + "react-server-dom-webpack-server.edge.development.js", [
  // 1. declare the parton ALS + the marker sentinel
  [
    '        : null,\n      TEMPORARY_REFERENCE_TAG = Symbol.for("react.temporary.reference"),',
    `        : null,\n      ${NEW_ALS}\n      PARTON_CTX = Symbol.for("parton.serverContext"),\n      TEMPORARY_REFERENCE_TAG = Symbol.for("react.temporary.reference"),`,
  ],
  // 2. createTask snapshots the current frame's ctx onto the task
  [
    "        formatContext: formatContext,\n        ping: function () {",
    `        formatContext: formatContext,\n        ${CTX_CAPTURE}\n        ping: function () {`,
  ],
  // 3. retryTask renders the task inside its captured ctx
  [
    "    function retryTask(request, task) {\n      if (0 === task.status) {",
    "    function retryTask(request, task) {\n      partonStorage.run({ ctx: task.serverCtx }, function () {\n      if (0 === task.status) {",
  ],
  [
    "            (serializedSize = parentSerializedSize);\n        }\n      }\n    }",
    "            (serializedSize = parentSerializedSize);\n        }\n      }\n      });\n    }",
  ],
  // 4. render site: run each component in a fresh frame inheriting parent ctx
  [
    "      currentComponentDebugInfo = componentDebugInfo;\n      props = supportsComponentStorage",
    "      currentComponentDebugInfo = componentDebugInfo;\n      ReactSharedInternalsServer.__partonStorage = partonStorage;\n      var __pf = partonStorage.getStore();\n      var __frame = { ctx: __pf ? __pf.ctx : null };\n      props = partonStorage.run(__frame, function () {\n        return supportsComponentStorage",
  ],
  [
    "          : callComponentInDEV(Component, props, componentDebugInfo);",
    "          : callComponentInDEV(Component, props, componentDebugInfo);\n      });",
  ],
  // 5. renderModelDestructive re-scopes a provider's PARTON_CTX marker subtree
  [
    '      if ("object" === typeof value) {\n        switch (value.$$typeof) {',
    `      if ("object" === typeof value) {\n        ${MARKER_BRANCH_DEV}\n        switch (value.$$typeof) {`,
  ],
])

console.log("server-context patch applied")
