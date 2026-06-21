#!/usr/bin/env node
/**
 * `yarn bench:server` entry point.
 *
 * Spawns vitest against `bench/vitest.bench.config.ts` with the
 * `react-server` condition (so the vendored Flight server resolves its
 * hook-less build) — the same transform env the rsc test tier uses, but
 * pointed only at the bench file. This wrapper is the seam where the
 * `--prof` flag and env knobs get applied; the actual benchmark logic
 * lives in the `.bench.ts` file vitest runs.
 *
 * Usage:
 *   yarn bench:server                 full matrix → stdout table + JSON
 *   yarn bench:server --prof          ONE scenario (scaling/N=1000) under
 *                                     Node --cpu-prof → bench/results/prof/
 *   yarn bench:server --only=depth    run only scenarios matching a name
 *   yarn bench:server --warmup=20 --measure=200
 *
 * Flags map to BENCH_* env vars the bench file reads (see
 * server-warm-tick.bench.ts).
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, readdirSync, statSync, rmSync, renameSync } from "node:fs"
import { resolve, join } from "node:path"

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const val = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

const prof = has("--prof")
const env = { ...process.env }

if (val("warmup")) env.BENCH_WARMUP = val("warmup")
if (val("measure")) env.BENCH_MEASURE = val("measure")
if (val("only")) env.BENCH_ONLY = val("only")
if (val("out")) env.BENCH_OUT = val("out")

// The vendored Flight server's internal `require("react")` goes through
// Node's CJS resolver, which ignores Vite conditions — so set the
// condition process-wide, exactly as `test:rsc` does. (The prof fork
// also sets it via execArgv; harmless to set both.)
const baseNodeOptions = ["--conditions=react-server"]

// Pick the config: the prof variant runs in a single forked child whose
// execArgv carries --cpu-prof (so the profile captures the render work,
// not this launcher). See bench/vitest.prof.config.ts.
const configPath = prof ? "bench/vitest.prof.config.ts" : "bench/vitest.bench.config.ts"

const profDir = resolve(process.cwd(), "bench/results/prof")
if (prof) {
  // Profile a single, large scenario so the flame graph is dominated by
  // steady-state warm-tick work, not scenario churn.
  env.BENCH_ONLY = env.BENCH_ONLY ?? "scaling/N=1000"
  // Keep the measured window meaty so the profile has signal, but bounded
  // — --cpu-prof slows execution, and N=1000 ticks are ~80ms each.
  env.BENCH_WARMUP = env.BENCH_WARMUP ?? "20"
  env.BENCH_MEASURE = env.BENCH_MEASURE ?? "400"
  // Start clean so `pickLargestProfile` can't pick up a stale file.
  rmSync(profDir, { recursive: true, force: true })
  mkdirSync(profDir, { recursive: true })
  console.log(`[bench] --prof: profiling "${env.BENCH_ONLY}" → ${profDir}/`)
}

env.NODE_OPTIONS = [env.NODE_OPTIONS, ...baseNodeOptions].filter(Boolean).join(" ")

const vitestArgs = ["vitest", "run", "--config", configPath]

const res = spawnSync("yarn", vitestArgs, { stdio: "inherit", env })

if (prof) {
  // Node emitted one CPU.*.cpuprofile per profiled process. The render
  // worker's profile is by far the largest; rename it to a stable name
  // and drop the near-empty manager profiles.
  const target = pickLargestProfile(profDir)
  if (target) {
    const stable = join(profDir, "warm-tick.cpuprofile")
    if (target !== stable) renameSync(target, stable)
    for (const f of readdirSync(profDir)) {
      if (f.endsWith(".cpuprofile") && join(profDir, f) !== stable) {
        rmSync(join(profDir, f), { force: true })
      }
    }
    console.log(`\n[bench] CPU profile: ${stable}`)
    console.log("[bench] open in Chrome DevTools (Performance → Load profile) or `npx speedscope " + stable + "`")
  } else {
    console.log("[bench] WARNING: no .cpuprofile produced — check the fork execArgv")
  }
}

process.exit(res.status ?? 1)

/** Return the path of the largest .cpuprofile in `dir` (the render
 *  worker), or null if none. */
function pickLargestProfile(dir) {
  let best = null
  let bestSize = -1
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".cpuprofile")) continue
    const p = join(dir, f)
    const size = statSync(p).size
    if (size > bestSize) {
      bestSize = size
      best = p
    }
  }
  return best
}
