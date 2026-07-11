import path from "node:path"
import react from "@vitejs/plugin-react"
import rsc from "@vitejs/plugin-rsc"
import { defineConfig } from "vite"

// This example keeps its own tiny content store, gitignored like every
// sibling app's `data/` — anchored here (not `process.cwd()`) because
// bundled code can't reach the workspace root by cwd in preview mode.
const DATA_DIR = path.resolve(import.meta.dirname, "data")
process.env.CMS_DATA_DIR ??= DATA_DIR

// Resolve `@parton/framework` straight to its TypeScript source — the
// same alias every sibling app carries, so edits to the framework show
// up here without a build step.
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..")
const workspaceAliases = [
  {
    find: /^@parton\/framework\/(.*)/,
    replacement: path.resolve(REPO_ROOT, "framework/src/$1"),
  },
  {
    find: /^@parton\/framework$/,
    replacement: path.resolve(REPO_ROOT, "framework/index.ts"),
  },
]

export default defineConfig(() => ({
  plugins: [rsc(), react()],
  server: {
    port: 5177,
    // Cell storage lives in data/ inside this workspace; writes are
    // runtime state, not source — without the ignore, every cell
    // persist triggers vite's full-reload and the page loops.
    watch: { ignored: ["**/examples/minimal/data/**"] },
  },
  preview: { port: 5177, strictPort: true },
  environments: {
    rsc: {
      build: {
        rollupOptions: {
          input: { index: "./src/entry.rsc.tsx" },
        },
      },
    },
    ssr: {
      build: {
        rollupOptions: {
          input: { index: "./src/entry.ssr.tsx" },
        },
      },
    },
    client: {
      build: {
        rollupOptions: {
          input: { index: "./src/entry.browser.tsx" },
        },
      },
    },
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: workspaceAliases,
  },
}))
