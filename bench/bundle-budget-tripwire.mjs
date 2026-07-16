/**
 * Client-bundle ledger tripwire — asserts the committed
 * `bench/results/client-bundle.json` keeps each app's FIRST-LOAD client JS
 * (and the website's total) under a generous ceiling.
 * Run: `node bench/bundle-budget-tripwire.mjs` — reads the committed
 * ledger only; builds nothing.
 *
 * Same split as the idle-cpu tripwire: the MEASUREMENT happens on dev
 * machines (`node bench/client-bundle.mjs` builds both apps and writes the
 * ledger); CI guards the LEDGER. Bytes are deterministic per SHA, but the
 * macOS↔ubuntu minifier byte-drift is unmeasured from here — so rather than
 * rebuild-and-compare in CI (which could false-positive on that drift),
 * this guards the committed number directly, exactly like idle-cpu. A
 * regression that slips into the committed history (a re-measure that
 * ships a react DEV build to the browser, a heavy new first-load dep)
 * trips here visibly instead of silently becoming the baseline.
 *
 * The ceiling that matters is INITIAL JS gzip — the entry chunk plus its
 * static-import closure, what blocks first paint. The e2e app's TOTAL is
 * ~12 MB of code-split shiki grammars + mermaid, all lazy, so its total is
 * deliberately NOT guarded (it tracks grammar-registry churn, not
 * first-load cost). Ceilings are generous — they catch the pathology
 * class (a dev-build leak 5–10×s the number), not KB creep.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// gzip KiB ceilings.
const BUDGETS = {
  website: { initial: 130, total: 140 },
  "e2e-testing": { initial: 140 },
}

const artifact = join(dirname(fileURLToPath(import.meta.url)), "results", "client-bundle.json")
const ledger = JSON.parse(readFileSync(artifact, "utf8"))
const kb = (n) => (n / 1024).toFixed(1)

let failures = 0
const check = (ok, label, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${label} — ${detail}`)
  if (!ok) failures++
}

console.log(
  `ledger sha ${ledger.sha}, ${ledger.date} (vite ${ledger.vite}, rolldown ${ledger.rolldown})`,
)
for (const [app, budget] of Object.entries(BUDGETS)) {
  const r = ledger.apps?.[app]
  if (!r) {
    check(false, `${app} present in ledger`, "missing")
    continue
  }
  if (budget.initial != null)
    check(
      r.initialJs.gzip / 1024 < budget.initial,
      `${app} initial JS gzip below ${budget.initial} KiB`,
      `${kb(r.initialJs.gzip)} KiB (${r.initialJs.chunks} chunks)`,
    )
  if (budget.total != null)
    check(
      r.totalJs.gzip / 1024 < budget.total,
      `${app} total JS gzip below ${budget.total} KiB`,
      `${kb(r.totalJs.gzip)} KiB (${r.totalJs.chunks} chunks)`,
    )
}

process.exit(failures === 0 ? 0 : 1)
