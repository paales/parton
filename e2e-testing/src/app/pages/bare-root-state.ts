/**
 * The bare-root-parton fixture's cell. Module scope is what lets the
 * plain `toggleBareRoot` server function import and write it directly,
 * while the parton resolves it in-body — the read IS the dependency, so
 * the write wakes exactly the partons that resolved it.
 */

import { localCell } from "@parton/framework"

export const bareRootToggle = localCell({
  id: "bare-root.toggle",
  shape: "boolean",
  initial: false,
})
