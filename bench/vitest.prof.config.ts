import { resolve } from "node:path"
import { mergeConfig } from "vitest/config"
import baseConfig from "./vitest.bench.config.ts"

/**
 * `--prof` variant of the bench config. Identical to
 * `vitest.bench.config.ts` except the test runs in a SINGLE FORKED child
 * whose `execArgv` carries Node's `--cpu-prof` flags — so the CPU profile
 * captures the WORKER that actually renders, not the launcher process.
 *
 * (NODE_OPTIONS=--cpu-prof on the parent only profiles the parent, which
 * just blocks in spawnSync waiting on the child — useless. execArgv on
 * the fork pool is the seam that reaches the render work. Threads don't
 * honor --cpu-prof cleanly; forks do.)
 *
 * The prof output dir is fixed to `bench/results/prof`. Node writes one
 * `CPU.<ts>.<pid>.<seq>.cpuprofile` per profiled process; the CLI picks
 * the largest (the render worker has the most samples — the vitest fork
 * manager produces a near-empty one). We deliberately do NOT pin
 * `--cpu-prof-name`: a fixed name would have the last process to exit
 * (the manager) overwrite the worker's profile.
 */
const PROF_DIR = resolve(import.meta.dirname, "..", "bench/results/prof")

export default mergeConfig(baseConfig, {
  test: {
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
        execArgv: ["--conditions=react-server", "--cpu-prof", "--cpu-prof-dir", PROF_DIR],
      },
    },
  },
})
