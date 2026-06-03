/**
 * Applies the parton "server context" patch to a copy of
 * `@vitejs/plugin-rsc`'s vendored react-server-dom Flight server.
 *
 * React's RSC renderer has no Server Component context, so we thread a
 * server-context MAP through its task graph (see
 * `framework/src/lib/server-context.ts`). One channel carries every server
 * context — `createServerContext` values and the framework's parton parent
 * alike, each under its own key:
 *
 *  - `createTask` inherits the `serverContext` map from the currently-
 *    rendering task (`request.__renderingTask`), exactly how it already
 *    inherits `formatContext`;
 *  - `retryTask` save/restores `request.__renderingTask` so it always
 *    names the task whose render is executing (and depth-first sibling
 *    renders don't clobber it);
 *  - the render site runs the component inside `partonStorage.run(task, …)`
 *    — a dedicated `AsyncLocalStorage` (the same mechanism React's own dev
 *    `componentStorage` uses, extended to prod). Because ALS follows the JS
 *    engine's post-`await` continuations, a component reads context and
 *    scopes its children correctly ANYWHERE in its render, before or after
 *    its awaits, and sibling renders stay isolated. The ALS instance is
 *    exposed as `ReactSharedInternalsServer.__partonStorage` for the shim.
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

// Inherit the server-context map parent→child at createTask, exactly how
// formatContext already flows. This is the SINGLE channel carrying every
// server context — the framework parton parent included (server-context.ts
// reserves one key for it). A task prefers the rendering task's child map
// (what it scoped for its children) over its own inherited map.
const INHERIT =
  "request.__renderingTask ? (request.__renderingTask.serverChildContext !== undefined ? request.__renderingTask.serverChildContext : request.__renderingTask.serverContext) : null"

// The vendored build is the EDGE build: it never imports `AsyncLocalStorage`,
// so we source one ourselves for the parton store. `@vitejs/plugin-rsc` sets
// `globalThis.AsyncLocalStorage` (from `node:async_hooks`) for SSR/RSC, so on
// the real Vite server (dev = ESM, build = CJS) the global is present — prefer
// it. The vitest harness skips that transform, so fall back to `require`
// there (its module context is CJS). Ordering the global first means `require`
// is never evaluated in Vite's ESM dev module, and React's own storages stay
// in whatever mode the host put them in — we don't flip them. On a true edge
// runtime (no global, no `async_hooks`) the `require` throws at load: loud, not
// silent — revisit here if that's ever a target.
const NEW_ALS =
  'partonStorage = (typeof globalThis !== "undefined" && typeof globalThis.AsyncLocalStorage === "function") ? new globalThis.AsyncLocalStorage() : new (require("node:async_hooks").AsyncLocalStorage)(),'

function patch(file, edits) {
  let s = readFileSync(file, "utf8")
  for (const [needle, repl] of edits) {
    const n = s.split(needle).length - 1
    if (n !== 1) throw new Error(`${file}: expected 1 match, got ${n} for: ${needle.slice(0, 70)}…`)
    s = s.replace(needle, repl)
  }
  writeFileSync(file, s)
  console.log(`patched ${file.split("/").pop()}: ${edits.length} edits`)
}

// ── development build (8-space indent) ──
patch(cjs + "react-server-dom-webpack-server.edge.development.js", [
  // carrier: retryTask names the currently-rendering task
  [
    "    function retryTask(request, task) {\n      if (0 === task.status) {",
    "    function retryTask(request, task) {\n      var __prevRenderingTask = request.__renderingTask;\n      request.__renderingTask = task;\n      try {\n      if (0 === task.status) {",
  ],
  [
    "            (serializedSize = parentSerializedSize);\n        }\n      }\n    }",
    "            (serializedSize = parentSerializedSize);\n        }\n      }\n      } finally {\n        request.__renderingTask = __prevRenderingTask;\n      }\n    }",
  ],
  // carrier: createTask inherits the parent's server-context map
  [
    "        formatContext: formatContext,\n        ping: function () {\n          return pingTask(request, task);\n        },",
    `        formatContext: formatContext,\n        serverContext: ${INHERIT},\n        serverChildContext: ${INHERIT},\n        ping: function () {\n          return pingTask(request, task);\n        },`,
  ],
  // declare the parton ALS alongside requestStorage/componentStorage
  [
    "        : null,\n      TEMPORARY_REFERENCE_TAG = Symbol.for(\"react.temporary.reference\"),",
    `        : null,\n      ${NEW_ALS}\n      TEMPORARY_REFERENCE_TAG = Symbol.for("react.temporary.reference"),`,
  ],
  // render site: run the component inside partonStorage.run(task, …) so the
  // store follows its post-await continuation; expose the ALS for the shim.
  [
    "      currentComponentDebugInfo = componentDebugInfo;\n      props = supportsComponentStorage",
    "      currentComponentDebugInfo = componentDebugInfo;\n      ReactSharedInternalsServer.__partonStorage = partonStorage;\n      props = partonStorage.run(task, function () {\n        return supportsComponentStorage",
  ],
  [
    "          : callComponentInDEV(Component, props, componentDebugInfo);",
    "          : callComponentInDEV(Component, props, componentDebugInfo);\n      });",
  ],
])

// ── production build (2/4-space indent) ──
patch(cjs + "react-server-dom-webpack-server.edge.production.js", [
  // carrier: retryTask names the currently-rendering task
  [
    "function retryTask(request, task) {\n  if (0 === task.status) {",
    "function retryTask(request, task) {\n  var __prevRenderingTask = request.__renderingTask;\n  request.__renderingTask = task;\n  try {\n  if (0 === task.status) {",
  ],
  [
    "      serializedSize = parentSerializedSize;\n    }\n  }\n}",
    "      serializedSize = parentSerializedSize;\n    }\n  }\n  } finally {\n    request.__renderingTask = __prevRenderingTask;\n  }\n}",
  ],
  // carrier: createTask inherits the parent's server-context map
  [
    "    formatContext: formatContext,\n    ping: function () {\n      return pingTask(request, task);\n    },",
    `    formatContext: formatContext,\n    serverContext: ${INHERIT},\n    serverChildContext: ${INHERIT},\n    ping: function () {\n      return pingTask(request, task);\n    },`,
  ],
  // declare the parton ALS alongside requestStorage
  [
    "  requestStorage = supportsRequestStorage ? new AsyncLocalStorage() : null,\n  TEMPORARY_REFERENCE_TAG = Symbol.for(\"react.temporary.reference\"),",
    `  requestStorage = supportsRequestStorage ? new AsyncLocalStorage() : null,\n  ${NEW_ALS}\n  TEMPORARY_REFERENCE_TAG = Symbol.for("react.temporary.reference"),`,
  ],
  // render site: run the component inside partonStorage.run(task, …);
  // expose the ALS for the shim.
  [
    "  thenableState = prevThenableState;\n  props = Component(props, void 0);",
    "  thenableState = prevThenableState;\n  ReactSharedInternalsServer.__partonStorage = partonStorage;\n  props = partonStorage.run(task, Component, props, void 0);",
  ],
])

console.log("server-context patch applied")
