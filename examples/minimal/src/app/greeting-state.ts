/**
 * A cell is a typed, identity-keyed slot of server-authoritative state.
 * One global slot (no `partition`) is enough for this demo — every
 * visitor reads and writes the same greeting.
 */
import { localCell } from "@parton/framework"

export const greeting = localCell({
  id: "greeting",
  shape: "string",
  initial: "",
})
