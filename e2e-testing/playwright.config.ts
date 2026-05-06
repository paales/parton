import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  // Preview-tier specs live under `e2e/preview/` and run via the
  // separate `playwright.preview.config.ts` (port 5181, build+preview).
  // Skipping the directory here keeps `yarn test:e2e` (dev tier, port
  // 5179) from picking them up — assertions about production-bundle
  // streaming wouldn't hold against the dev server.
  testIgnore: ["preview/**"],
  timeout: 30000,
  // Workers > 1 is safe now: `e2e/fixtures.ts` stamps every request with
  // a per-worker `x-test-scope` header, and the framework (see
  // `framework/src/runtime/context.ts` — `deriveScope`) routes each
  // request to its own bucket of process-wide state (<Cache>, registry,
  // session, GraphQL cache). Default (`undefined`) lets Playwright pick
  // based on CPU count.
  fullyParallel: true,
  use: {
    baseURL: "http://localhost:5179",
    headless: true,
  },
  webServer: {
    // Resolved within the e2e-testing workspace — `yarn dev` runs
    // `vite` here.
    command: "yarn dev --port 5179",
    url: "http://localhost:5179",
    reuseExistingServer: true,
    timeout: 60000,
  },
})
