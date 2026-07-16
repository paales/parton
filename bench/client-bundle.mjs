/**
 * Client-bundle tracer — puts a size story on what ships to the browser.
 *
 * Two data points, the two in-repo apps whose client graphs differ most:
 *   - website     (@parton/website)     — the lean demo world
 *   - e2e-testing (@parton/e2e-testing) — the kitchen-sink app (chat +
 *                                         shiki grammars + mermaid/cytoscape)
 *
 * For each app the tracer reports, for the CLIENT (browser) environment:
 *   - total client JS: raw + gzip + brotli, and the INITIAL-load slice
 *     (entry chunk + its static-import closure) vs the LAZY slice
 *     (chunks reachable only through dynamic import)
 *   - per-chunk sizes (top N by raw)
 *   - a module-level attribution grouped by ORIGIN — react/react-dom,
 *     the RSC runtime (@vitejs/plugin-rsc client runtime + its vendored
 *     react-server-dom), @parton/framework client code (which lib/
 *     modules), vendored copies/, @parton/cms, app code, other
 *     node_modules (sub-grouped by package)
 *   - CSS reported separately from JS; fonts/other assets noted apart
 *
 * The lever is Rollup-compatible bundle metadata, which Rolldown honors
 * (Rolldown ships no native metafile — rolldown/rolldown#6425): a
 * `generateBundle` plugin reads `OutputChunk.modules[id].renderedLength`
 * for per-module bytes and each chunk's `imports` / `dynamicImports` for
 * the static-vs-dynamic graph. Chunk/asset BYTE sizes are then read from
 * the written files on disk (a later plugin mutates `chunk.code` after our
 * hook, so disk is the only byte-exact source — the ledger reconciles to
 * `ls -la dist` exactly). Per-module renderedLength is pre-minify, so it is
 * scaled per chunk to the chunk's real on-disk size before grouping (the
 * group bytes then reconcile to the disk total). The build is driven
 * programmatically through Vite's `createBuilder().buildApp()` so the same
 * three-environment plugin-rsc build `yarn build:website` / `yarn build`
 * run also emits the stats — one pass, real dist on disk.
 *
 * Run:
 *   node bench/client-bundle.mjs            # build both apps, write the ledger
 *   node bench/client-bundle.mjs --check    # build both, compare to the
 *                                           #   committed ledger (tolerance
 *                                           #   band), exit nonzero on breach
 *   node bench/client-bundle.mjs --app=website   # one app only (no ledger write)
 *
 * The ledger `bench/results/client-bundle.json` is committed — the
 * regression substrate, like server-warm-tick.json. It carries per-app
 * totals, the top chunks, and the origin groups + framework module list,
 * so a future diff shows WHERE growth came from, not merely that it grew.
 */
import { execSync } from "node:child_process"
import { readFileSync, writeFileSync, statSync } from "node:fs"
import { gzipSync, brotliCompressSync, constants as zlibConstants } from "node:zlib"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createBuilder } from "vite"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const LEDGER = path.join(REPO_ROOT, "bench", "results", "client-bundle.json")

const APPS = {
  website: { dir: path.join(REPO_ROOT, "website"), clientOut: "dist/client" },
  "e2e-testing": { dir: path.join(REPO_ROOT, "e2e-testing"), clientOut: "dist/client" },
}

const CHECK = process.argv.includes("--check")
const ONLY = process.argv.find((a) => a.startsWith("--app="))?.split("=")[1]
const TOP_CHUNKS = 15
// Tolerance for --check: a real regression (a new heavy dependency) is far
// larger than build nondeterminism or any macOS↔CI minifier drift; the band
// catches step-changes, not byte-for-byte creep. Both must be exceeded.
const TOLERANCE_PCT = 5
const TOLERANCE_ABS = 8 * 1024

const brotli = (buf) =>
  brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }).length
const gzip = (buf) => gzipSync(buf, { level: 9 }).length

// Byte-exact sizes for a written file (raw + gzip + brotli), read from disk
// so the ledger reconciles to `ls -la dist`.
function fileSizes(dir, fileName) {
  const buf = readFileSync(path.join(dir, fileName))
  return { raw: buf.length, gzip: gzip(buf), brotli: brotli(buf) }
}

// ── Origin classification ─────────────────────────────────────────────
// Maps a resolved module id to a top-level GROUP and a finer SUB label.
function classify(id) {
  const n = id.replace(/\\/g, "/")
  const nm = n.lastIndexOf("/node_modules/")
  if (nm !== -1) {
    const after = n.slice(nm + "/node_modules/".length)
    const parts = after.split("/")
    const pkg = after.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]
    if (pkg === "@vitejs/plugin-rsc") {
      return after.includes("react-server-dom")
        ? { group: "rsc-runtime", sub: "react-server-dom (vendored)" }
        : { group: "rsc-runtime", sub: "@vitejs/plugin-rsc client runtime" }
    }
    if (pkg === "react" || pkg === "react-dom" || pkg === "scheduler")
      return { group: "react", sub: pkg }
    return { group: "node_modules", sub: pkg }
  }
  const rel = (marker) => n.slice(n.lastIndexOf(marker) + marker.length)
  if (n.includes("/framework/src/")) return { group: "framework", sub: rel("/framework/src/") }
  if (n.includes("/copies/src/")) return { group: "copies", sub: rel("/copies/src/") }
  if (n.includes("/cms/src/")) return { group: "cms", sub: rel("/cms/src/") }
  if (n.includes("/website/src/")) return { group: "app", sub: rel("/website/src/") }
  if (n.includes("/e2e-testing/src/")) return { group: "app", sub: rel("/e2e-testing/src/") }
  // Rolldown runtime, vite preload-helper, \0 virtual modules, JSX runtime shims.
  const virt = n.replace(/^\0/, "").split("/node_modules/").pop()
  return { group: "other", sub: virt.length < 80 ? virt : virt.slice(-80) }
}

// ── The stats-capturing plugin ────────────────────────────────────────
// generateBundle fires per environment; we keep only the client one. We
// capture the module GRAPH here (fileName, per-module renderedLength,
// static/dynamic imports); byte sizes come from disk after the write.
function statsPlugin(capture) {
  return {
    name: "parton:client-bundle-stats",
    generateBundle(_options, bundle) {
      if (this.environment?.name !== "client") return
      const chunks = []
      const assetNames = []
      for (const file of Object.values(bundle)) {
        if (file.type === "chunk") {
          chunks.push({
            fileName: file.fileName,
            isEntry: file.isEntry,
            imports: file.imports ?? [],
            dynamicImports: file.dynamicImports ?? [],
            modules: Object.fromEntries(
              Object.entries(file.modules).map(([id, m]) => [id, m.renderedLength]),
            ),
          })
        } else if (file.type === "asset") {
          assetNames.push(file.fileName)
        }
      }
      capture.chunks = chunks
      capture.assetNames = assetNames
    },
  }
}

// ── Build one app, capture the client bundle stats ────────────────────
async function buildApp(name) {
  const app = APPS[name]
  const capture = {}
  const builder = await createBuilder({
    root: app.dir,
    configFile: path.join(app.dir, "vite.config.ts"),
    logLevel: "warn",
    plugins: [statsPlugin(capture)],
  })
  await builder.buildApp()
  if (!capture.chunks) throw new Error(`${name}: no client generateBundle captured`)
  // Attach byte-exact sizes from the written files.
  const outDir = path.join(app.dir, app.clientOut)
  for (const c of capture.chunks) Object.assign(c, fileSizes(outDir, c.fileName))
  capture.assets = capture.assetNames.map((fileName) => ({
    fileName,
    ...fileSizes(outDir, fileName),
  }))
  return analyze(name, capture)
}

// ── Reachability: initial (static closure from entries) vs lazy ───────
function reachability(chunks) {
  const byName = new Map(chunks.map((c) => [c.fileName, c]))
  const initial = new Set()
  const stack = chunks.filter((c) => c.isEntry).map((c) => c.fileName)
  while (stack.length) {
    const f = stack.pop()
    if (initial.has(f)) continue
    initial.add(f)
    for (const dep of byName.get(f)?.imports ?? []) if (byName.has(dep)) stack.push(dep)
  }
  return initial
}

function analyze(name, capture) {
  const { chunks, assets } = capture
  const initial = reachability(chunks)

  const sum = (list, key) => list.reduce((a, c) => a + c[key], 0)
  const initialChunks = chunks.filter((c) => initial.has(c.fileName))
  const lazyChunks = chunks.filter((c) => !initial.has(c.fileName))

  // Per-origin attribution: each module's renderedLength scaled to its
  // chunk's real minified raw size, so group totals reconcile to on-disk.
  const groups = new Map() // group -> { raw, initialRaw, subs: Map(sub -> raw) }
  const bump = (g, sub, raw, isInitial) => {
    let e = groups.get(g)
    if (!e) groups.set(g, (e = { raw: 0, initialRaw: 0, subs: new Map() }))
    e.raw += raw
    if (isInitial) e.initialRaw += raw
    e.subs.set(sub, (e.subs.get(sub) ?? 0) + raw)
  }
  for (const c of chunks) {
    const rlTotal = Object.values(c.modules).reduce((a, b) => a + b, 0) || 1
    const scale = c.raw / rlTotal
    const isInitial = initial.has(c.fileName)
    for (const [id, rl] of Object.entries(c.modules)) {
      const { group, sub } = classify(id)
      bump(group, sub, rl * scale, isInitial)
    }
  }

  const groupList = [...groups.entries()]
    .map(([group, e]) => ({
      group,
      raw: Math.round(e.raw),
      initialRaw: Math.round(e.initialRaw),
      subs: [...e.subs.entries()]
        .map(([sub, raw]) => ({ sub, raw: Math.round(raw) }))
        .sort((a, b) => b.raw - a.raw),
    }))
    .sort((a, b) => b.raw - a.raw)

  const frameworkModules = groupList.find((g) => g.group === "framework")?.subs ?? []
  const css = assets.filter((a) => a.fileName.endsWith(".css"))
  const fonts = assets.filter((a) => /\.(woff2?|ttf|otf|eot)$/.test(a.fileName))

  return {
    totalJs: {
      raw: sum(chunks, "raw"),
      gzip: sum(chunks, "gzip"),
      brotli: sum(chunks, "brotli"),
      chunks: chunks.length,
    },
    initialJs: {
      raw: sum(initialChunks, "raw"),
      gzip: sum(initialChunks, "gzip"),
      brotli: sum(initialChunks, "brotli"),
      chunks: initialChunks.length,
    },
    lazyJs: {
      raw: sum(lazyChunks, "raw"),
      gzip: sum(lazyChunks, "gzip"),
      brotli: sum(lazyChunks, "brotli"),
      chunks: lazyChunks.length,
    },
    css: { raw: sum(css, "raw"), gzip: sum(css, "gzip"), files: css.length },
    fonts: { raw: sum(fonts, "raw"), files: fonts.length },
    entry: chunks.find((c) => c.isEntry)?.fileName ?? null,
    topChunks: [...chunks]
      .sort((a, b) => b.raw - a.raw)
      .slice(0, TOP_CHUNKS)
      .map((c) => ({
        file: c.fileName,
        raw: c.raw,
        gzip: c.gzip,
        load: initial.has(c.fileName) ? "initial" : "lazy",
      })),
    groups: groupList.map((g) => ({
      group: g.group,
      raw: g.raw,
      initialRaw: g.initialRaw,
      // Framework, app and rsc-runtime keep their full module list (the
      // diff substrate); noisy groups keep only their top subs.
      subs:
        g.group === "framework" || g.group === "app" || g.group === "rsc-runtime"
          ? g.subs
          : g.subs.slice(0, 12),
    })),
    frameworkModules,
    _appName: name,
    _clientOut: path.join(APPS[name].dir, APPS[name].clientOut),
  }
}

// ── Human-readable stdout ─────────────────────────────────────────────
const kb = (n) => (n / 1024).toFixed(1) + " KiB"
function print(name, r) {
  console.log(`\n══ ${name} ═══════════════════════════════════════════════`)
  console.log(
    `  total JS   ${kb(r.totalJs.raw).padStart(11)} raw  ${kb(r.totalJs.gzip).padStart(11)} gz  ` +
      `${kb(r.totalJs.brotli).padStart(11)} br   (${r.totalJs.chunks} chunks)`,
  )
  console.log(
    `  initial    ${kb(r.initialJs.raw).padStart(11)} raw  ${kb(r.initialJs.gzip).padStart(11)} gz  ` +
      `${kb(r.initialJs.brotli).padStart(11)} br   (${r.initialJs.chunks} chunks)`,
  )
  console.log(
    `  lazy       ${kb(r.lazyJs.raw).padStart(11)} raw  ${kb(r.lazyJs.gzip).padStart(11)} gz  ` +
      `${kb(r.lazyJs.brotli).padStart(11)} br   (${r.lazyJs.chunks} chunks)`,
  )
  console.log(
    `  CSS        ${kb(r.css.raw).padStart(11)} raw  ${kb(r.css.gzip).padStart(11)} gz  (${r.css.files} files)`,
  )
  console.log(`  fonts      ${kb(r.fonts.raw).padStart(11)} raw  (${r.fonts.files} files)`)
  console.log(`  — origin (raw, scaled to disk; ‹initial› of that) —`)
  for (const g of r.groups)
    console.log(`    ${g.group.padEnd(14)} ${kb(g.raw).padStart(11)}  ‹${kb(g.initialRaw)}›`)
  console.log(`  — top chunks —`)
  for (const c of r.topChunks)
    console.log(
      `    ${c.load.padEnd(7)} ${kb(c.raw).padStart(11)} ${kb(c.gzip).padStart(10)} gz  ${c.file}`,
    )
}

// ── --check: compare to committed ledger ──────────────────────────────
function check(results) {
  const prev = JSON.parse(readFileSync(LEDGER, "utf8"))
  let failures = 0
  const guard = (appName, label, now, then) => {
    if (then == null) return
    const limit = Math.max((then * TOLERANCE_PCT) / 100, TOLERANCE_ABS)
    const over = now - then
    const ok = over <= limit
    if (!ok) failures++
    console.log(
      `${ok ? "✓" : "✗"} ${appName} ${label}: ${kb(now)} vs ledger ${kb(then)} ` +
        `(${over >= 0 ? "+" : ""}${kb(over)}, band ±${kb(limit)})`,
    )
  }
  for (const [appName, r] of Object.entries(results)) {
    const p = prev.apps?.[appName]
    if (!p) {
      console.log(`• ${appName}: no ledger baseline — skipped`)
      continue
    }
    guard(appName, "total JS gzip", r.totalJs.gzip, p.totalJs.gzip)
    guard(appName, "initial JS gzip", r.initialJs.gzip, p.initialJs.gzip)
    guard(appName, "CSS gzip", r.css.gzip, p.css.gzip)
  }
  console.log(
    failures === 0
      ? `\nbundle budget OK (baseline sha ${prev.sha})`
      : `\n✗ ${failures} bundle budget breach(es) vs baseline sha ${prev.sha}`,
  )
  return failures
}

// ── main ──────────────────────────────────────────────────────────────
const names = ONLY ? [ONLY] : Object.keys(APPS)
const results = {}
for (const name of names) {
  console.log(`building ${name}…`)
  results[name] = await buildApp(name)
  print(name, results[name])
}

if (CHECK) {
  process.exit(check(results) === 0 ? 0 : 1)
}

if (ONLY) {
  console.log(`\n(--app=${ONLY}: single app, ledger not written)`)
  process.exit(0)
}

// Strip internal fields before writing the ledger.
const apps = Object.fromEntries(
  Object.entries(results).map(([name, r]) => {
    const { _appName, _clientOut, ...rest } = r
    return [name, rest]
  }),
)
const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim()
const ledger = {
  sha,
  date: new Date().toISOString(),
  node: process.version,
  vite: JSON.parse(readFileSync(path.join(REPO_ROOT, "node_modules/vite/package.json"), "utf8"))
    .version,
  rolldown: JSON.parse(
    readFileSync(path.join(REPO_ROOT, "node_modules/rolldown/package.json"), "utf8"),
  ).version,
  apps,
}
writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n")
console.log(`\nwrote ledger → ${path.relative(REPO_ROOT, LEDGER)} (sha ${sha})`)

// Spot-check: an independent statSync on the top chunks must equal the
// captured raw (proves the ledger reconciles to `ls -la dist`).
for (const [name, r] of Object.entries(results)) {
  let ok = true
  for (const c of r.topChunks.slice(0, 3)) {
    const onDisk = statSync(path.join(r._clientOut, c.file)).size
    if (onDisk !== c.raw) ok = false
    console.log(
      `  disk-check ${name}: ${c.file} statSync=${onDisk}B captured=${c.raw}B ${onDisk === c.raw ? "✓" : "✗"}`,
    )
  }
  if (!ok) process.exitCode = 1
}
