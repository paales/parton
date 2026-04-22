"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";

/**
 * Minimal dev-only toolbar for flushing server-side state — the
 * `<Cache>` store, the partial-data cache, and the route-scoped
 * partial registry — by calling `/__test/clear-caches` and then
 * triggering a fresh navigation to repopulate everything.
 */
export function DebugToolbar() {
  const [isPending, startTransition] = useTransition();
  const [flashMessage, setFlashMessage] = useState<string | null>(null);

  function flushAll() {
    startTransition(async () => {
      try {
        const res = await fetch("/__test/clear-caches");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setFlashMessage("flushed — reloading");
        window.location.reload();
      } catch (err) {
        setFlashMessage(
          `failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        setTimeout(() => setFlashMessage(null), 3000);
      }
    });
  }

  return (
    <div
      data-testid="debug-toolbar"
      className="fixed bottom-4 left-4 z-[9999] flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs text-card-foreground shadow-lg"
    >
      <span className="text-muted-foreground">debug</span>
      <Button
        type="button"
        data-testid="debug-flush-cache"
        onClick={flushAll}
        disabled={isPending}
        variant="destructive"
        size="xs"
        className="rounded-full"
      >
        {isPending ? "flushing…" : "flush cache"}
      </Button>
      {flashMessage && (
        <span className="text-muted-foreground">{flashMessage}</span>
      )}
    </div>
  );
}
