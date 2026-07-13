"use server"

/**
 * Guarded-note credential actions — grant and revoke the cookie the
 * `guardedNote` cell's `writeGuard` checks. The credential is a plain
 * cookie so the demo stays legible; the guard itself doesn't care
 * where the grant comes from — it reads the caller's request scope.
 */

import { setCookie } from "@parton/framework"

export async function claimNoteOwnership(): Promise<void> {
  setCookie("note_owner", "1")
}

export async function releaseNoteOwnership(): Promise<void> {
  // Max-Age 0 deletes the cookie (browser deletion semantics).
  setCookie("note_owner", "", 0)
}
