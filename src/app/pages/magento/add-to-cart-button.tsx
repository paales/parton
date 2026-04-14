"use client";

import { useState, useTransition } from "react";
import { addToCart } from "./cart-actions.ts";

export function AddToCartButton({ sku }: { sku: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      try {
        await addToCart(sku, 1);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        style={{
          background: "#48bb78",
          color: "#1a1a2e",
          border: "none",
          padding: "0.5rem 1rem",
          borderRadius: 6,
          cursor: isPending ? "wait" : "pointer",
          fontWeight: 600,
          fontSize: "0.85rem",
        }}
      >
        {isPending ? "Adding..." : "Add to Cart"}
      </button>
      {error && (
        <div
          role="alert"
          style={{
            marginTop: "0.5rem",
            padding: "0.4rem 0.6rem",
            background: "#2a1a1a",
            border: "1px solid #5a2a2a",
            borderRadius: 6,
            color: "#f56565",
            fontSize: "0.75rem",
            lineHeight: 1.3,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
