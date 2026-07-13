/**
 * /guarded-note — write authorization (`writeGuard`) worked example.
 *
 * One shared note cell (`guarded-note-state.ts`) declares who may
 * write it: callers carrying the `note_owner=1` cookie. The client's
 * save button calls the cell's `.set` directly, so an unauthorized
 * click exercises the real attack surface — the `__cellWrite` action
 * POST — and gets a server-side rejection: the promise rejects, the
 * form shows its denied state, and nothing commits (a refetch shows
 * the old value). Claim/release flip the credential via plain server
 * actions; `cookie("note_owner")` is a tracked read, so the ownership
 * badge re-renders on the action response. The unguarded bump cell is
 * the liveness control: writes to it keep committing after a denial.
 */

import { cookie, parton, type RenderArgs } from "@parton/framework"
import { Card, CardContent, CardHeader, CardTitle } from "@parton/copies/components/ui/card"
import { GuardedNoteForm } from "../components/guarded-note-form.tsx"
import { claimNoteOwnership, releaseNoteOwnership } from "./guarded-note-actions.ts"
import { guardedBumps, guardedNote } from "./guarded-note-state.ts"

export const GuardedNotePage = parton(
  async function GuardedNoteRender(_: RenderArgs) {
    // Tracked read — the badge (and the whole parton) re-renders when
    // the credential cookie changes on a claim/release action.
    const isOwner = cookie("note_owner") === "1"
    const note = await guardedNote.resolve()
    const bumps = await guardedBumps.resolve()
    return (
      <main className="py-4 space-y-4">
        <title>Guarded note — write authorization</title>
        <h1 className="text-2xl font-semibold">
          Guarded note — <code>writeGuard</code>
        </h1>
        <p className="text-sm text-muted-foreground">
          The note cell declares{" "}
          <code>writeGuard: ({"{cookies}"}) =&gt; cookies.note_owner === "1"</code>. The guard runs
          at the framework's write choke point, so the client's direct <code>.set</code>, server
          functions, <code>update</code>, and <code>atomic()</code> batches all pass through it —
          one declaration, every path. A denied write throws <code>CellWriteDenied</code>{" "}
          server-side before anything commits.
        </p>

        <Card className="p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">Shared note (owner-only writes)</CardTitle>
          </CardHeader>
          <CardContent className="px-0 space-y-3">
            <div className="text-sm">
              You are{" "}
              <span data-testid="guarded-note-owner" className="font-mono">
                {isOwner ? "owner" : "not-owner"}
              </span>
            </div>
            <div className="text-sm">
              Note: <span data-testid="guarded-note-value">{note.value}</span>
            </div>
            <div className="text-sm">
              Bumps (unguarded): <span data-testid="guarded-note-bumps">{bumps.value}</span>
            </div>
            <GuardedNoteForm
              note={note}
              bumps={bumps}
              claim={claimNoteOwnership}
              release={releaseNoteOwnership}
            />
          </CardContent>
        </Card>
      </main>
    )
  },
  { match: "/guarded-note" },
)
