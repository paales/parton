"use client";

import { useNavigation } from "../../lib/partial-client.tsx";

/**
 * Per-frame navigation bar — Back / Forward / Reload buttons +
 * current URL readout + entry-state preview. Uses `useNavigation()`
 * without an argument, so the bar binds to whichever frame wraps it
 * in the server tree. Drop it inside any `<Partial frame="X">` and
 * it just works.
 *
 *   <Partial frame="cart" frameUrl="/cart/closed">
 *     <FrameNavigationBar />
 *     <CartContent />
 *   </Partial>
 */
export function FrameNavigationBar() {
  const f = useNavigation();
  const state = f.entryState;

  const style = {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.4rem 0.6rem",
    background: "#111118",
    border: "1px solid #2d3748",
    borderRadius: 6,
    fontSize: "0.75rem",
    fontFamily: "ui-monospace, monospace",
    marginBottom: "0.75rem",
  } as const;

  const btn = {
    background: "#1a1a2e",
    color: "#ededed",
    border: "1px solid #2d3748",
    borderRadius: 4,
    padding: "0.2rem 0.5rem",
    cursor: "pointer",
    fontSize: "0.8rem",
  } as const;

  const disabledBtn = {
    ...btn,
    opacity: 0.35,
    cursor: "default",
  };

  return (
    <div
      data-testid={`frame-navbar-${f.name ?? "window"}`}
      data-frame={f.name ?? "window"}
      style={style}
    >
      <span style={{ color: "#8bd", fontWeight: 600 }}>{f.name ?? "window"}</span>
      <button
        type="button"
        data-testid={`navbar-${f.name ?? "window"}-back`}
        onClick={() => void f.back()}
        disabled={!f.canGoBack}
        style={f.canGoBack ? btn : disabledBtn}
      >
        ← Back
      </button>
      <button
        type="button"
        data-testid={`navbar-${f.name ?? "window"}-forward`}
        onClick={() => void f.forward()}
        disabled={!f.canGoForward}
        style={f.canGoForward ? btn : disabledBtn}
      >
        Forward →
      </button>
      <button
        type="button"
        data-testid={`navbar-${f.name ?? "window"}-reload`}
        onClick={() => void f.reload()}
        style={btn}
      >
        ↻ Reload
      </button>
      <code
        data-testid={`navbar-${f.name ?? "window"}-url`}
        style={{ color: "#ededed", flex: 1 }}
      >
        {f.currentUrl ?? "—"}
      </code>
      <code
        data-testid={`navbar-${f.name ?? "window"}-state`}
        style={{ color: "#888", fontSize: "0.7rem" }}
      >
        state: {state ? JSON.stringify(state) : "∅"}
      </code>
    </div>
  );
}
