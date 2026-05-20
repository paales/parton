"use server"

/**
 * Server actions for the /streaming-demo page.
 *
 * The bump and card-form mutations both go through the framework's
 * built-in cell write path — the bump button via the per-call
 * server-action ref on the cell handle, the card form via the
 * client-side microtask coalescer (`useCell(cell).set(...)` →
 * `__cellWriteBatch`). Neither needs an app-level wrapper action.
 *
 * What remains here is `pushSeq` — an example of
 * `getServerNavigation().navigate(...)` for server-pushed URL
 * updates, unrelated to cells.
 */

import { getServerNavigation } from "@parton/framework"

/**
 * Push a `?seq=N` value into the window URL via the server-side
 * navigate primitive. Each call advances N so the URL bar changes
 * visibly on every click.
 */
let seq = 0
export async function pushSeq() {
  seq++
  getServerNavigation().navigate(`?seq=${seq}`)
}
