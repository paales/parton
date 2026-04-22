"use client";

import { useNavigation } from "../../lib/partial-client.tsx";
import { Button } from "@/components/ui/button";

/**
 * Per-frame navigation bar — Back / Forward / Reload buttons +
 * current URL readout + entry-state preview.
 */
export function FrameNavigationBar() {
  const f = useNavigation();
  const state = f.currentEntry?.getState() ?? null;
  const entryUrl = f.currentEntry?.url;
  const displayUrl = entryUrl
    ? (() => {
        const u = new URL(entryUrl);
        return u.pathname + u.search;
      })()
    : null;

  const name = f.name ?? "window";

  return (
    <div
      data-testid={`frame-navbar-${name}`}
      data-frame={name}
      className="mb-3 flex items-center gap-2 rounded-lg border bg-muted/40 px-2 py-1.5 font-mono text-xs"
    >
      <span className="font-semibold text-sky-400">{name}</span>
      <Button
        type="button"
        size="xs"
        variant="outline"
        data-testid={`navbar-${name}-back`}
        onClick={() => void f.back()}
        disabled={!f.canGoBack}
      >
        ← Back
      </Button>
      <Button
        type="button"
        size="xs"
        variant="outline"
        data-testid={`navbar-${name}-forward`}
        onClick={() => void f.forward()}
        disabled={!f.canGoForward}
      >
        Forward →
      </Button>
      <Button
        type="button"
        size="xs"
        variant="outline"
        data-testid={`navbar-${name}-reload`}
        onClick={() => void f.reload()}
      >
        ↻ Reload
      </Button>
      <code
        data-testid={`navbar-${name}-url`}
        className="flex-1 truncate text-foreground"
      >
        {displayUrl ?? "—"}
      </code>
      <code
        data-testid={`navbar-${name}-state`}
        className="truncate text-[0.7rem] text-muted-foreground"
      >
        state: {state ? JSON.stringify(state) : "∅"}
      </code>
    </div>
  );
}
