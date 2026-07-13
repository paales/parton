/**
 * Guarded-note cells — the write-authorization demo's state.
 *
 * `guardedNote` declares a `writeGuard`: only a caller whose request
 * carries the `note_owner=1` cookie may write it. The guard lives on
 * the cell definition and is enforced at the framework's write choke
 * point, so EVERY path is covered — the client's direct `.set` action
 * POST, a server function writing on its own initiative, `update`,
 * batched writes, `atomic()`. A denied write throws `CellWriteDenied`
 * server-side before anything commits.
 *
 * `guardedBumps` is deliberately unguarded — the page's control cell,
 * proving a denial leaves the rest of the page fully live.
 */

import { localCell } from "@parton/framework"

export const guardedNote = localCell({
  id: "guarded.note",
  shape: "string",
  initial: "nothing saved yet",
  writeGuard: ({ cookies }) => cookies.note_owner === "1",
})

export const guardedBumps = localCell({
  id: "guarded.bumps",
  shape: "number",
  initial: 0,
})
