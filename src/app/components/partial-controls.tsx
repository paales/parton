"use client";

import { usePartial } from "../../lib/partial-client.tsx";

/**
 * Client component demonstrating partial-level re-fetching.
 *
 * Each usePartial binds to one partial — like useActionState binds to one action.
 * Multiple dispatches in the same tick are batched into one RSC request.
 */
export function PartialControls() {
  const [refreshHero, heroPending] = usePartial("hero");
  const [refreshStats, statsPending] = usePartial("stats");
  const [refreshSpecies, speciesPending] = usePartial("species");

  return (
    <div className="partial-controls">
      <span style={{ color: "#888", fontSize: "0.8rem", alignSelf: "center" }}>
        dispatch():
      </span>
      <button type="button" onClick={() => refreshHero()} disabled={heroPending}>
        {heroPending ? "Refreshing..." : "Refresh Hero"}
      </button>
      <button type="button" onClick={() => refreshStats()} disabled={statsPending}>
        {statsPending ? "Refreshing..." : "Refresh Stats"}
      </button>
      <button type="button" onClick={() => refreshSpecies()} disabled={speciesPending}>
        {speciesPending ? "Refreshing..." : "Refresh Species"}
      </button>
    </div>
  );
}
