"use client";

import { useState } from "react";
import { useNavigation } from "../../../lib/partial-client.tsx";

/**
 * Refreshes every product's live-price partial in a single request.
 *
 * Works via shared-token refetch: each `<Partial selector={[`#price-${sku}`, ".price"]}>…</Partial>`
 * registers its tokens on the server, so `reload({selector: ".price"})`
 * resolves (through the route registry) to the full set of currently-
 * known price Partials — one roundtrip, one cache-mode render.
 */
export function RefreshAllPricesButton() {
  const nav = useNavigation();
  const [isPending, setIsPending] = useState(false);

  async function refreshAll() {
    setIsPending(true);
    try {
      await nav.reload({ selector: ".price" }).finished;
    } finally {
      setIsPending(false);
    }
  }

  return (
    <button
      type="button"
      data-testid="refresh-all-prices"
      onClick={refreshAll}
      disabled={isPending}
      style={{
        background: "#2d3748",
        color: "#ededed",
        border: "1px solid #4a5568",
        padding: "0.5rem 1rem",
        borderRadius: 6,
        cursor: isPending ? "wait" : "pointer",
        fontSize: "0.9rem",
        marginBottom: "1rem",
      }}
    >
      {isPending ? "Refreshing all prices…" : "Refresh all prices"}
    </button>
  );
}
