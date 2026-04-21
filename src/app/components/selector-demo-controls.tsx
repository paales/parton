"use client";

import { useState } from "react";
import { useNavigation } from "../../lib/partial-client.tsx";

/**
 * Button that fires a targeted reload via `useNavigation().reload()`.
 * The selector string follows CSS grammar:
 *   - `#foo`           — unique token; single Partial
 *   - `.foo`           — shared label; union across every Partial with it
 *   - `#hero .price`   — mix: refetches `#hero` AND every `.price`
 *
 * Selector tokens resolve server-side against the route-scoped
 * registry (`partial.tsx:resolveSelectorToIds`), so dynamic Partials
 * that only exist after a render (prices inside `.map()`, etc.) are
 * addressable the same as static ones.
 */
export function SelectorRefetchButton({
  selector,
  label,
  testId,
}: {
  selector: string;
  label: string;
  testId: string;
}) {
  const nav = useNavigation();
  const [isPending, setIsPending] = useState(false);

  async function fire() {
    setIsPending(true);
    try {
      await nav.reload({ selector }).finished;
    } finally {
      setIsPending(false);
    }
  }

  return (
    <button
      type="button"
      data-testid={testId}
      onClick={fire}
      disabled={isPending}
    >
      {isPending ? "…" : label}
    </button>
  );
}
