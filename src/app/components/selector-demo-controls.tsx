"use client";

import { usePartial } from "../../lib/partial-client.tsx";

/**
 * Client-side button that fires `usePartial(selector).refetch()` on
 * click. Lives in userspace; the framework only ships the selector
 * API itself (`parseSelector` + `resolveSelector` in `partial-client.tsx`).
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
  const [refetch, isPending] = usePartial(selector);
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => void refetch()}
      disabled={isPending}
    >
      {isPending ? "…" : label}
    </button>
  );
}
