// Public API surface for @react-cms/framework.
//
// The package contains three layers under src/:
//   - lib/        the partials library (spec constructor, render runtime)
//   - framework/  RSC plumbing (request context, errors, CMS runtime, session)
//   - test/       in-process Flight test harness (consumed by per-package tests)
//
// This barrel re-exports the user-facing surface from those layers so most
// consumers can `import { … } from "@react-cms/framework"`. Deep paths
// (`@react-cms/framework/framework/cms-runtime.ts`) remain available for
// integrators that need them — the editor package and the app entries do.

// ── Partial spec API (lib/) ─────────────────────────────────────────────
export * from "./src/lib/index.ts"

// ── Framework runtime — control + errors ────────────────────────────────
export {
  NotFoundError,
  RedirectError,
  notFound,
  redirect,
} from "./src/framework/errors.ts"

export { Redirect } from "./src/framework/redirect-client.tsx"

// ── Framework runtime — request context (server) ────────────────────────
export {
  setFrameworkControl,
  getFrameworkControl,
  getRequest,
  setRequest,
  setCookie,
  readCookie,
  isTestMode,
  getScope,
  runWithRequestAsync,
  matchRoutePattern,
} from "./src/framework/context.ts"

// ── Navigation API (server-readable) ────────────────────────────────────
export { getNavigation } from "./src/framework/navigation-api.ts"

// ── CMS runtime (server) ────────────────────────────────────────────────
export type { Reference } from "./src/framework/cms-runtime.ts"

// ── CMS prerender (build-time catalog) ──────────────────────────────────
export {
  getCatalogManifest,
  type BlockManifest,
} from "./src/framework/cms-prerender.ts"

// ── Session (frame URLs, scopes) ────────────────────────────────────────
export { setSessionFrameUrl } from "./src/framework/session.ts"
