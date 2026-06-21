/**
 * /forms-demo — scoped cells + transactional actions, inline.
 *
 * Cells are declared inline in the parton's `Render` via the
 * `localCell("key", …)` server-hook, each partitioned per session
 * (`vary: ({session}) => ({sid: session.id})`) so every session sees its
 * own draft, notes, save history, and failure setting. The render calls
 * `ensureSessionId()` first to mint the `__frame_sid` cookie, so each
 * visitor has a stable, non-empty `session.id` and the cells land in
 * their OWN persistent partition. `session()` folds the session into the
 * parton's fingerprint, so it re-renders when the session changes.
 *
 * The `save` action resolves those inline cells by key without a render
 * (the framework records each inline cell on declaration; the action
 * dispatcher rebuilds + resolves them, re-deriving the per-session
 * partition against the action's own request). It commits args
 * atomically: card fields flow in as `args` and auto-write to the
 * matching cells; `saves` is staged explicitly.
 *
 * The save handler throws `~failChance` of the time to demonstrate
 * transactional rollback — on throw NO writes commit (they're staged in a
 * pending map, dropped on throw) and the client's optimistic UI rewinds to
 * the prior server value. Inputs bind either directly to a cell (notes —
 * per-keystroke writes via `useCell.input({mode: 'onChange'})`) or
 * local-then-submit (cardName / cardCvc — `useCell.input({mode:
 * 'onSubmit'})` seeds `defaultValue`, the write happens on submit through
 * the action).
 */

import {
  ensureSessionId,
  localCell,
  parton,
  session,
  type CellVaryScope,
  type RenderArgs,
  type ResolvedAction,
  type ResolvedCell,
} from "@parton/framework"
import { Card, CardContent, CardHeader, CardTitle } from "@parton/copies/components/ui/card"
import { FormsDemoForm } from "../components/forms-demo-form.tsx"

// Per-session partition for every cell on this page — re-derived in the
// action's request too, so a session resolves its own slot there.
const bySession = ({ session }: CellVaryScope) => ({ sid: session.id })

export const FormsDemoPage = parton(
  async function FormsDemoRender({
    save,
  }: {
    save: ResolvedAction<{ cardName?: string; cardCvc?: string }, void>
  } & RenderArgs) {
    // Establish a session BEFORE the cells resolve. Every cell here
    // partitions on `session.id`; minting the `__frame_sid` cookie up
    // front gives each visitor a stable, non-empty id, so the cells
    // route to their OWN persistent partition (an unresolved, empty
    // `session.id` would be routed to per-request ephemeral storage and
    // never persist). Session-minting is app policy — the framework
    // only provides the capability and the safe-by-default routing.
    ensureSessionId()
    // Fold the session into the fp so the parton re-renders when the
    // session changes (the cells partition by it).
    session()
    const cardName = await localCell("cardName", { shape: "string", initial: "", vary: bySession })
    const cardCvc = await localCell("cardCvc", { shape: "string", initial: "", vary: bySession })
    const notes = await localCell("notes", { shape: "string", initial: "", vary: bySession })
    const saves = await localCell("saves", { shape: "string", initial: "", vary: bySession })
    const failChance = await localCell("failChance", { shape: "number", initial: 0, vary: bySession })
    return (
      <main className="py-4 space-y-4">
        <title>Forms demo — scoped cells + actions</title>
        <h1 className="text-2xl font-semibold">Forms — scoped cells + actions</h1>
        <p className="text-sm text-muted-foreground">
          Cells declared inline in the parton's <code>Render</code> via{" "}
          <code>localCell(…)</code>.<code>notes</code> is bound directly via{" "}
          <code>useCell.input({"{mode: 'onChange'}"})</code> — every keystroke writes through the
          cell batcher. Card fields are local until submit:{" "}
          <code>useCell.input({"{mode: 'onSubmit'}"})</code> seeds <code>defaultValue</code> from the
          cell, the input owns the draft locally, and the <code>save</code> action commits atomically.{" "}
          <code>failChance</code> toggles a simulated failure path — on throw, the entire transaction
          rolls back and the client's optimistic view rewinds.
        </p>

        <Card className="p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">Card form (action-bound commit)</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <FormsDemoForm
              cardName={cardName}
              cardCvc={cardCvc}
              notes={notes}
              saves={saves}
              failChance={failChance}
              save={save}
            />
          </CardContent>
        </Card>
      </main>
    )
  },
  {
    match: "/forms-demo",
    actions: {
      save: async (
        { saves, failChance }: { saves: ResolvedCell<string>; failChance: ResolvedCell<number> },
        args: { cardName?: string; cardCvc?: string },
      ) => {
        await new Promise((resolve) => setTimeout(resolve, 400))
        if (failChance.value > 0 && Math.random() < failChance.value) {
          throw new Error("Simulated save failure — transaction rolled back")
        }
        await saves.set(
          JSON.stringify({
            cardName: args.cardName ?? "",
            cardCvc: args.cardCvc ?? "",
            at: Date.now(),
          }),
        )
      },
    },
  },
)
