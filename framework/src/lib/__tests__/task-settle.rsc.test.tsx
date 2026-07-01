/**
 * Per-parton subtree settlement — DEV Flight build.
 *
 * `_onPartonSettled(cb)` fires when the registering parton's subtree has no
 * unfinished Flight tasks left — the settle-scope refcount the vendored-server
 * patch maintains (see `scripts/patch-plugin-rsc-server-context.mjs` and
 * `docs/notes/task-settle.md`). Scenario bodies are shared with the prod tier
 * (`task-settle.rsc-prod.test.tsx`) via `task-settle-scenarios.tsx`.
 */

import { describe, it } from "vitest"
import {
  abortSettleScenario,
  errorSettleScenario,
  nestedSettleScenario,
  siblingSettleScenario,
} from "./task-settle-scenarios.tsx"

describe("task settle — per-parton subtree settlement (dev Flight build)", () => {
  it("a fast parton settles while a slow sibling's loader is pending", siblingSettleScenario)
  it("a parent settles only after its nested child parton settles", nestedSettleScenario)
  it("a descendant error still settles the parton, exactly once", errorSettleScenario)
  it("an aborted render settles every open parton, exactly once", abortSettleScenario)
})
