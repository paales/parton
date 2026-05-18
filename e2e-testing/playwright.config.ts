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
  // Tolerate a handful of known dev-mode flakes (Vite cold dep-
  // optimization rounds, segment-loop teardown races,
  // console-error-vs-pageerror ordering on the error-boundary
  // specs). A test that flips between pass and fail across runs
  // gets two retries before being declared failed; tests that fail
  // every retry are real bugs.
  retries: 2,
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
  // NOTE: cross-origin tests in `remote-frame-crossorigin.spec.ts`
  // require `e2e-magento` running on port 5181. The spec's
  // `beforeAll` skips cleanly when magento isn't reachable. We
  // don't auto-start magento here because vite-rsc emits unstable
  // client-reference IDs across cold dev starts (sometimes
  // `/@fs/...` paths the host can resolve, sometimes hash IDs that
  // only exist in the remote's vite session and that the host's
  // vite-rsc rejects as invalid cross-origin client references).
  // Manual workflow: run `yarn dev:magento` in a separate terminal
  // and the cross-origin specs run.
})
