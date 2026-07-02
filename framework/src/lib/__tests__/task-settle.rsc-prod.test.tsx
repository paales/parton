/**
 * Per-parton subtree settlement — PRODUCTION Flight build.
 *
 * The settle refcount is maintained by patched decrement sites in BOTH
 * vendored builds, and the two builds differ exactly where this could
 * silently diverge: the prod `retryTask`/`erroredTask`/stream done-sites are
 * separately minified code with their own anchors, and the prod scheduler
 * batches pings differently. `yarn test:rsc` covers only the dev half; this
 * suite runs the same shared scenarios (`task-settle-scenarios.tsx`) against
 * the prod build under `yarn test:rsc:prod` (NODE_ENV=production). Under any
 * other run it skips.
 */

import { describe, expect, it } from "vitest"
import { flightToString, renderServerToFlight } from "../../test/rsc-server.ts"
import {
  abortSettleScenario,
  errorSettleScenario,
  nestedSettleScenario,
  siblingSettleScenario,
} from "./task-settle-scenarios.tsx"

const PROD = process.env.NODE_ENV === "production"

describe.skipIf(!PROD)("task settle — per-parton subtree settlement (prod Flight build)", () => {
  it("loaded the production build (guard)", async () => {
    // The dev build emits per-component debug-info rows the prod build omits.
    // If NODE_ENV=production didn't swap in the prod build, fail loud rather
    // than silently re-testing dev.
    async function Probe() {
      await new Promise((r) => setTimeout(r, 1))
      return <span>probe</span>
    }
    const text = await flightToString(renderServerToFlight(<Probe />))
    expect(text).not.toMatch(/"env":/) // dev-only componentDebugInfo
  })

  it("a fast parton settles while a slow sibling's loader is pending", siblingSettleScenario)
  it("a parent settles only after its nested child parton settles", nestedSettleScenario)
  it("a descendant error still settles the parton, exactly once", errorSettleScenario)
  it("an aborted render settles every open parton, exactly once", abortSettleScenario)
})
