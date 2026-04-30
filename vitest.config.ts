import path from "node:path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

// Workspace alias map shared with the per-app vite configs.
// Order matters: longest prefixes first; `@` is the catch-all.
const workspaceAliases = [
  {
    find: /^@react-cms\/framework\/(.*)/,
    replacement: path.resolve(import.meta.dirname, "framework/src/$1"),
  },
  {
    find: /^@react-cms\/framework$/,
    replacement: path.resolve(import.meta.dirname, "framework/index.ts"),
  },
  {
    find: /^@react-cms\/cms\/(.*)/,
    replacement: path.resolve(import.meta.dirname, "cms/src/$1"),
  },
  {
    find: /^@react-cms\/cms$/,
    replacement: path.resolve(import.meta.dirname, "cms/index.ts"),
  },
  {
    find: /^@react-cms\/copies\/(.*)/,
    replacement: path.resolve(import.meta.dirname, "copies/src/$1"),
  },
  {
    find: /^@react-cms\/copies$/,
    replacement: path.resolve(import.meta.dirname, "copies/index.ts"),
  },
  // `@/` resolves per-workspace via each package's tsconfig. For tests we
  // route to e2e-testing/src — the only consumers that still use bare
  // `@/...` outside their own package are the app's tests, and they all
  // live under e2e-testing/.
  { find: "@", replacement: path.resolve(import.meta.dirname, "e2e-testing/src") },
]

/**
 * Three projects, each owning a distinct test tier:
 *   - node:    jsdom, plugin-rsc disabled — fast bulk of the
 *              suite (hook tests, client-only units).
 *   - rsc:     Node + `react-server` condition + plugin-rsc
 *              active — tests that render server trees to
 *              Flight in-process. See `framework/vitest.rsc.config.ts`.
 *   - browser: real Chromium via Playwright provider — tests
 *              that need real DOM primitives jsdom can't fake
 *              (focus, Navigation API, measurement). See
 *              `framework/vitest.browser.config.ts`.
 *
 * `yarn test` runs the fast tiers (node + rsc); browser tier is
 * opt-in via `yarn test:browser` to avoid paying the browser-boot
 * cost on every save. CI runs all three.
 *
 * The rsc and browser project configs live in framework/ — that's
 * where the rsc-tier and browser-tier tests live (lib/__tests__/,
 * test/). The node-project setup file (vitest.setup.ts) is also
 * under framework/ since the navigation-API jsdom shim it installs
 * is framework-scoped.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          setupFiles: ["./framework/vitest.setup.ts"],
          include: [
            "{framework,cms,copies,e2e-testing,e2e-magento}/**/*.{test,spec}.?(c|m)[jt]s?(x)",
          ],
          exclude: [
            "**/node_modules/**",
            // Playwright specs live in e2e-testing/e2e/ and are run by
            // `yarn test:e2e`, not vitest.
            "e2e-testing/e2e/**",
            "**/*.rsc.test.?(c|m)[jt]s?(x)",
            "**/*.browser.test.?(c|m)[jt]s?(x)",
          ],
          environment: "jsdom",
        },
      },
      "./framework/vitest.rsc.config.ts",
      "./framework/vitest.browser.config.ts",
    ],
  },
})
