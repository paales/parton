#!/usr/bin/env node
/**
 * Embed economics — measure the per-hop cost of `<RemoteFrame>` page
 * embeds against an inline control.
 *
 * Requires the prod preview running (`yarn build:all && yarn
 * preview:all`); measures against http://localhost:5173.
 *
 * Pages (see `src/app/pages/embed-econ.tsx`):
 *   /embed-econ         — 8 same-origin embeds of /econ-item
 *   /embed-econ-inline  — the same content inline ×8 (zero hops)
 *
 * Per page: N sequential document GETs, recording TTFB (headers
 * received), total wall time, and body bytes — plus the preview
 * server's cumulative CPU time (ps cputime) sampled around the run,
 * so (embedCPU − inlineCPU) / N / 8 is the server-CPU cost of ONE
 * embed hop (fetch + producer render + slice + decode→re-encode).
 *
 * Usage: node scripts/measure-embed-econ.mjs [N]
 */

import { execSync } from "node:child_process"

const ORIGIN = process.env.ECON_ORIGIN ?? "http://localhost:5173"
const N = Number(process.argv[2] ?? 60)
const FRAMES = 8

function serverPids() {
  try {
    const out = execSync(`lsof -ti :${new URL(ORIGIN).port}`, { encoding: "utf8" })
    return [...new Set(out.split("\n").filter(Boolean))]
  } catch {
    return []
  }
}

/** Cumulative CPU seconds for a pid set (`ps -o cputime`). */
function cpuSeconds(pids) {
  let total = 0
  for (const pid of pids) {
    try {
      const raw = execSync(`ps -o cputime= -p ${pid}`, { encoding: "utf8" }).trim()
      // Formats: MM:SS.cc or HH:MM:SS.
      const parts = raw.split(":").map(Number)
      const secs =
        parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]
      total += secs
    } catch {
      // Process gone — count as 0.
    }
  }
  return total
}

async function measureOnce(path) {
  const t0 = performance.now()
  const res = await fetch(`${ORIGIN}${path}`, { headers: { "x-test-scope": "econ-bench" } })
  const ttfb = performance.now() - t0
  const body = await res.arrayBuffer()
  const total = performance.now() - t0
  return { ttfb, total, bytes: body.byteLength }
}

function stats(rows, key) {
  const vals = rows.map((r) => r[key]).sort((a, b) => a - b)
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  const p = (q) => vals[Math.min(vals.length - 1, Math.floor(q * vals.length))]
  return { mean, p50: p(0.5), p95: p(0.95) }
}

async function measurePage(path, pids) {
  // Warm: route modules, caches, JIT.
  for (let i = 0; i < 5; i++) await measureOnce(path)
  const cpu0 = cpuSeconds(pids)
  const wall0 = performance.now()
  const rows = []
  for (let i = 0; i < N; i++) rows.push(await measureOnce(path))
  const wall = performance.now() - wall0
  const cpu = cpuSeconds(pids) - cpu0
  return { rows, cpu, wall }
}

const pids = serverPids()
if (pids.length === 0) {
  console.error(`No server on ${ORIGIN} — run \`yarn build:all && yarn preview:all\` first.`)
  process.exit(1)
}
console.log(`origin=${ORIGIN} pids=${pids.join(",")} N=${N} frames=${FRAMES}\n`)

const embed = await measurePage("/embed-econ", pids)
const inline = await measurePage("/embed-econ-inline", pids)
// The embedded unit alone (one producer render + trailer, no splice):
const unit = await measurePage("/econ-item", pids)

function report(name, m) {
  const t = stats(m.rows, "ttfb")
  const w = stats(m.rows, "total")
  const b = stats(m.rows, "bytes")
  console.log(
    `${name.padEnd(20)} ttfb p50=${t.p50.toFixed(1)}ms p95=${t.p95.toFixed(1)}ms | ` +
      `total p50=${w.p50.toFixed(1)}ms p95=${w.p95.toFixed(1)}ms | ` +
      `bytes=${Math.round(b.mean)} | serverCPU/req=${((m.cpu / N) * 1000).toFixed(1)}ms`,
  )
}
report("/embed-econ", embed)
report("/embed-econ-inline", inline)
report("/econ-item (unit)", unit)

const cpuPerReqEmbed = (embed.cpu / N) * 1000
const cpuPerReqInline = (inline.cpu / N) * 1000
const perHopCpu = (cpuPerReqEmbed - cpuPerReqInline) / FRAMES
const ttfbDelta = stats(embed.rows, "total").p50 - stats(inline.rows, "total").p50
console.log(
  `\nper-hop server CPU  = ${perHopCpu.toFixed(2)}ms  ` +
    `(embed ${cpuPerReqEmbed.toFixed(1)}ms − inline ${cpuPerReqInline.toFixed(1)}ms, /${FRAMES})`,
)
console.log(`page CPU ratio      = ${(cpuPerReqEmbed / cpuPerReqInline).toFixed(2)}× inline`)
console.log(`page wall delta p50 = ${ttfbDelta.toFixed(1)}ms for ${FRAMES} embeds`)
