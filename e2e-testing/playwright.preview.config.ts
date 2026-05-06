import { defineConfig } from "@playwright/test"

/**
 * Playwright config for the preview tier.
 *
 * The dev-server config (`playwright.config.ts`) covers behavior under
 * `yarn dev`. This one runs the same kind of HTTP-level checks against
 * the production bundle: `yarn build` outputs `dist/{rsc,ssr,client}/`,
 * `yarn preview` boots a Node server that loads the built RSC handler
 * via `vite preview`'s `configurePreviewServer` hook (see
 * `node_modules/@vitejs/plugin-rsc/dist/plugin-*.js`).
 *
 * The two configs run on different ports so they can coexist; the dev
 * config sticks with 5179, this config uses 5181.
 *
 * Specs that are preview-tier-only live under `e2e/preview/` and are
 * `testIgnore`d by the dev config — they would fail there because dev
 * has different streaming characteristics (HMR pings, eager source
 * transforms) and the assertions targeted at the production bundle's
 * single-shot HTML response wouldn't hold.
 */
export default defineConfig({
  testDir: "./e2e/preview",
  timeout: 30000,
  fullyParallel: true,
  use: {
    baseURL: "http://localhost:5181",
    headless: true,
  },
  webServer: {
    // `yarn build` populates `dist/`; `yarn preview` serves it. Both
    // happen in this workspace's cwd. `reuseExistingServer: true` lets
    // a manually-started preview server take over so iterating on the
    // spec doesn't pay the full build cost every run.
    command: "yarn build && yarn preview --port 5181 --strictPort",
    url: "http://localhost:5181",
    reuseExistingServer: true,
    // Build + boot can be slow on a cold cache.
    timeout: 180000,
  },
})
