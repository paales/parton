"use client";

import { usePartial } from "../../lib/partial-client.tsx";

/**
 * Client component demonstrating partial-level re-fetching via usePartial.
 *
 * Each button calls refetch() — no server action needed. The framework
 * re-renders just that partial with fresh data. isPending tracks
 * whether the server is still rendering.
 */
export function PartialControls() {
  const hero = usePartial("hero");
  const stats = usePartial("stats");
  const species = usePartial("species");

  return (
    <div className="partial-controls">
      <span style={{ color: "#888", fontSize: "0.8rem", alignSelf: "center" }}>
        usePartial.refetch():
      </span>
      <button type="button" onClick={() => hero.refetch()} disabled={hero.isPending}>
        {hero.isPending ? "Refreshing..." : "Refresh Hero"}
      </button>
      <button type="button" onClick={() => stats.refetch()} disabled={stats.isPending}>
        {stats.isPending ? "Refreshing..." : "Refresh Stats"}
      </button>
      <button type="button" onClick={() => species.refetch()} disabled={species.isPending}>
        {species.isPending ? "Refreshing..." : "Refresh Species"}
      </button>
    </div>
  );
}
