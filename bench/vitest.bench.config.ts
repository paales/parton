import path from "node:path"
import { vitePluginRscMinimal } from "@vitejs/plugin-rsc/plugin"
import { defineConfig } from "vitest/config"

/**
 * Dedicated Vitest config for the server warm-tick benchmark. Mirrors
 * `framework/vitest.rsc.config.ts` (the `react-server` condition + the
 * `"use client"` / `"use server"` transforms + the `@parton/*` aliases)
 * so the bench can import the vendored Flight server in-process, but
 * includes ONLY `bench/**` files.
 *
 * It is NOT referenced by the root `vitest.config.ts` `projects` list, so
 * it never runs during `yarn test` / `yarn test:rsc`. The only entry
 * point is `yarn bench:server`, which invokes
 * `vitest run --config bench/vitest.bench.config.ts` with the
 * `react-server` condition set in NODE_OPTIONS (same as `test:rsc`).
 */
const REPO_ROOT = path.resolve(import.meta.dirname, "..")

export default defineConfig({
  plugins: [
    ...vitePluginRscMinimal({
      environment: { rsc: "ssr" },
    }),
  ],
  resolve: {
    conditions: ["react-server"],
    alias: [
      {
        find: /^@parton\/framework\/(.*)/,
        replacement: path.resolve(REPO_ROOT, "framework/src/$1"),
      },
      {
        find: /^@parton\/framework$/,
        replacement: path.resolve(REPO_ROOT, "framework/index.ts"),
      },
      {
        find: /^@parton\/cms\/(.*)/,
        replacement: path.resolve(REPO_ROOT, "cms/src/$1"),
      },
      {
        find: /^@parton\/cms$/,
        replacement: path.resolve(REPO_ROOT, "cms/index.ts"),
      },
      {
        find: /^@parton\/copies\/(.*)/,
        replacement: path.resolve(REPO_ROOT, "copies/src/$1"),
      },
      {
        find: /^@parton\/copies$/,
        replacement: path.resolve(REPO_ROOT, "copies/index.ts"),
      },
    ],
  },
  ssr: {
    resolve: {
      conditions: ["react-server"],
    },
  },
  test: {
    name: "bench",
    dir: REPO_ROOT,
    include: ["bench/**/*.bench.?(c|m)[jt]s?(x)"],
    environment: "node",
    // Don't let a long sweep get killed mid-flight.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // No file-level parallelism — one bench file, and we want the whole
    // process quiet for clean timing.
    fileParallelism: false,
    server: {
      deps: {
        inline: ["react", "react-dom", "react-server-dom-webpack", /@vitejs\/plugin-rsc/],
      },
    },
  },
})
