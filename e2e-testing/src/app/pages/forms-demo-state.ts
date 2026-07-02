/**
 * Forms-demo cells — one module cell per field, each partitioned per
 * session (`partition: ({session}) => ({sid: session.id})`) so every
 * session sees its own draft, notes, save history, and failure
 * setting. Module scope is what lets the plain `saveCard` server
 * function import and write them directly.
 */

import { localCell, type CellPartitionScope } from "@parton/framework"

// Per-session partition for every cell on this page — re-derived in the
// server function's request too, so a session resolves its own slot.
const bySession = ({ session }: CellPartitionScope) => ({ sid: session.id })

export const cardName = localCell({
  id: "forms.cardName",
  shape: "string",
  initial: "",
  partition: bySession,
})
export const cardCvc = localCell({
  id: "forms.cardCvc",
  shape: "string",
  initial: "",
  partition: bySession,
})
export const notes = localCell({
  id: "forms.notes",
  shape: "string",
  initial: "",
  partition: bySession,
})
export const saves = localCell({
  id: "forms.saves",
  shape: "string",
  initial: "",
  partition: bySession,
})
export const failChance = localCell({
  id: "forms.failChance",
  shape: "number",
  initial: 0,
  partition: bySession,
})
