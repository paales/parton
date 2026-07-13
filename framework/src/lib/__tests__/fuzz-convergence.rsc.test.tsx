/**
 * Convergence fuzzing — seeded random walks over navigate / write /
 * flip / refetch / settle against a purpose-built fixture app, with
 * the convergence oracle at quiescence: the client model's committed
 * tree must equal a fresh cold render of the final URL + scope +
 * visibility set. Harness: `framework/src/test/fuzz-harness.ts`;
 * fixture: `fuzz-fixture.tsx`; design note:
 * `docs/notes/convergence-fuzzing.md` (findings ledger).
 *
 * CI runs a fixed, deterministic budget: 25 sequences × 20 actions
 * from seed 1. EVERY sequence must converge — zero mismatches of any
 * class is the gate (the first runs' finding classes F1/F2 are fixed;
 * their seeds — 9, 18, 10 — run as ordinary cases here).
 *
 * Long local runs:
 *
 *   PARTON_WAKE_PARITY=1 FUZZ_BUDGET=500 yarn test:rsc fuzz-convergence
 *
 * Knobs: FUZZ_BUDGET (sequences), FUZZ_LEN (actions per sequence),
 * FUZZ_SEED (first seed; sequence i uses seed FUZZ_SEED + i).
 *
 * On any failure the harness delta-debugs the action sequence to a
 * locally-minimal repro; the assertion message carries seed + minimal
 * sequence + expected/actual — paste the sequence back through
 * `runSequence` to reproduce.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { _resetCellStorage } from "../../runtime/cell-storage.ts"
import {
  generateSequence,
  runSequence,
  shrinkSequence,
  formatResult,
} from "../../test/fuzz-harness.ts"
import { _setFirstAckDeadlineMs, _setReconcileIntervalMs } from "../segmented-response.ts"
import { fixture, isolate } from "./fuzz-fixture.tsx"

// ─── Budget ──────────────────────────────────────────────────────────

const BUDGET = Number(process.env.FUZZ_BUDGET ?? 25)
const LEN = Number(process.env.FUZZ_LEN ?? 20)
const SEED0 = Number(process.env.FUZZ_SEED ?? 1)
const TIMEOUT_MS = Math.max(180_000, BUDGET * 2_000)

beforeAll(() => {
  // Long deadlines keep the run deterministic under load: the model
  // acks promptly anyway (so the never-acked degrade never arms in a
  // healthy run), and the scheduled whole-tree reconcile would
  // otherwise inject healing segments on slow machines — the oracle
  // wants the LANE path to be correct without the healer.
  _setFirstAckDeadlineMs(300_000)
  _setReconcileIntervalMs(3_600_000)
})

afterAll(() => {
  _setFirstAckDeadlineMs(undefined)
  _setReconcileIntervalMs(undefined)
  isolate()
  _resetCellStorage()
})

describe("convergence fuzzing — incremental merge ≡ cold render", () => {
  it(
    `${BUDGET} random walks × ${LEN} actions from seed ${SEED0} converge`,
    async () => {
      const findings: string[] = []
      let clean = 0
      for (let i = 0; i < BUDGET; i++) {
        const seed = SEED0 + i
        const actions = generateSequence(seed, LEN, fixture)
        const t0 = Date.now()
        const r = await runSequence(fixture, seed, actions, isolate)
        // A healthy sequence runs in milliseconds — seconds means
        // watchdog waits (a wedged wire), worth flagging even when the
        // run ultimately passes.
        if (Date.now() - t0 > 2_000) console.log(`SLOWSEED ${seed} ${Date.now() - t0}ms`)
        if (r.mismatches.length === 0 && r.failure === null) {
          clean++
          continue
        }
        const shrunk = await shrinkSequence(fixture, seed, actions, isolate)
        findings.push(
          `${formatResult(shrunk.result)}\n(shrunk ${actions.length} → ` +
            `${shrunk.actions.length} actions in ${shrunk.runs} runs)`,
        )
      }
      if (BUDGET > 25) {
        console.log(`fuzz summary: ${clean} clean, ${findings.length} findings`)
      }
      expect(findings, `\n${findings.join("\n\n")}\n`).toEqual([])
    },
    TIMEOUT_MS,
  )
})
