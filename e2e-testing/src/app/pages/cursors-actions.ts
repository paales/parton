"use server"

/**
 * Cursor move — the up-channel for the /cursors multiplayer demo.
 *
 * Every viewer calls this on pointer-move with its per-tab id. The
 * reducer merges the caller's position into the shared map and drops
 * entries that have gone stale (tabs that closed or stopped moving).
 *
 * `cursorsCell` is `deferred`, so this action's response carries no
 * re-render: the new map reaches every other viewer over their open
 * heartbeat stream, not on this POST. The write is fire-up; the
 * propagation is stream-down.
 *
 * The merge rides `cell.update` — the reducer applies against the
 * current stored map inside the write path's synchronous section, so
 * two cursors moving in the exact same tick COMPOSE: each merge sees
 * the other's entry, and nobody's dot drops for a frame.
 */

import { cursorsCell, type CursorMap } from "./cursors-state.ts"

/** Cursors older than this (no move within the window) are evicted. */
const STALE_MS = 10_000

export async function moveCursor(uid: string, x: number, y: number, color: string): Promise<void> {
  const now = Date.now()
  await cursorsCell.update((current) => {
    const next: CursorMap = { [uid]: { x, y, color, ts: now } }
    for (const [id, cursor] of Object.entries(current)) {
      if (id === uid) continue
      if (now - cursor.ts < STALE_MS) next[id] = cursor
    }
    return next
  })
}
