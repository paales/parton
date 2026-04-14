"use client";

import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { usePartial, usePartialParams } from "../../lib/partial-client.tsx";

/**
 * Search toggle buttons for the header.
 *
 * Two variants to demonstrate the difference:
 * - "Search (URL)": opens overlay via ?search=url, search term goes in ?q= (bookmarkable)
 * - "Search (Partial)": opens overlay via ?search=partial, term uses usePartial (ephemeral)
 */
export function SearchToggle({ isOpen }: { isOpen: boolean }) {
  const [isPending, startTransition] = useTransition();

  function open(searchMode: "url" | "partial") {
    startTransition(() => {
      const url = new URL(window.location.href);
      url.searchParams.set("search", searchMode);
      history.pushState(null, "", url.toString());
    });
  }

  function close() {
    startTransition(() => {
      const url = new URL(window.location.href);
      url.searchParams.delete("search");
      url.searchParams.delete("q");
      history.pushState(null, "", url.toString());
    });
  }

  const buttonStyle = (active: boolean) => ({
    background: active ? "#4a5568" : "#2d3748",
    color: "#ededed",
    border: "1px solid #4a5568",
    padding: "0.4rem 0.8rem",
    borderRadius: 6,
    cursor: "pointer" as const,
    fontSize: "0.85rem",
    display: "inline-flex" as const,
    alignItems: "center" as const,
    gap: "0.4rem",
  });

  const spinner = (
    <span
      style={{
        display: "inline-block",
        width: 14,
        height: 14,
        border: "2px solid #888",
        borderTopColor: "#ededed",
        borderRadius: "50%",
        animation: "spin 0.6s linear infinite",
      }}
    />
  );

  if (isOpen) {
    return (
      <button type="button" onClick={close} style={buttonStyle(true)}>
        {isPending ? (
          spinner
        ) : (
          <span style={{ fontSize: "1rem" }}>&#x2715;</span>
        )}
        Close
      </button>
    );
  }

  return (
    <div style={{ display: "flex", gap: "0.5rem" }}>
      <button
        type="button"
        onClick={() => open("url")}
        style={buttonStyle(false)}
      >
        {isPending ? (
          spinner
        ) : (
          <span style={{ fontSize: "1rem" }}>&#x1F50D;</span>
        )}
        Search (URL)
      </button>
      <button
        type="button"
        onClick={() => open("partial")}
        style={buttonStyle(false)}
      >
        {isPending ? (
          spinner
        ) : (
          <span style={{ fontSize: "1rem" }}>&#x1F50D;</span>
        )}
        Search (Partial)
      </button>
    </div>
  );
}

/**
 * Dialog wrapper for the search overlay.
 * Uses the native <dialog> element with showModal() for proper
 * focus trapping, backdrop, and Escape to close.
 */
export function SearchDialog({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  function handleClose() {
    startTransition(() => {
      const url = new URL(window.location.href);
      url.searchParams.delete("search");
      url.searchParams.delete("q");
      history.pushState(null, "", url.toString());
    });
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={handleClose}
      onClick={(e) => {
        // Close when clicking the backdrop (the dialog itself, not its content)
        if (e.target === dialogRef.current) handleClose();
      }}
      style={{
        background: "#111118",
        border: "1px solid #2d3748",
        padding: "1.25rem",
        borderRadius: 12,
        maxWidth: 720,
        width: "calc(100vw - 2em)",
        maxHeight: "80vh",
        overflow: "auto",
        display: "grid",
        top: "15vh",
        justifySelf: "center",
      }}
    >
      {children}
    </dialog>
  );
}

/**
 * Search input with live partial refetch.
 *
 * Both modes use usePartial("search") with serial dispatch.
 *
 * Dispatches immediately on first change, then waits for the response
 * before sending the next. If the user typed more while waiting, the
 * latest value is dispatched on completion — no parallel requests,
 * no arbitrary debounce timer.
 *
 * URL mode additionally updates ?q= silently for bookmarkability
 * (same pattern as PageSentinel in load-more.tsx).
 */
export function SearchInput({
  query,
  mode,
}: {
  query: string;
  mode: "partial" | "url";
}) {
  const [value, setValue] = useState(query);
  const [dispatchStage1] = usePartial("stage-1");
  const [dispatchStage2] = usePartial("stage-2");
  const [dispatchStage3] = usePartial("stage-3");
  const setTransientParams = usePartialParams();

  // Imperative serial queue — refs for synchronous flow control.
  // No useEffect, no reliance on React state timing.
  const latestRef = useRef(query);
  const dispatchedRef = useRef(query);
  const inFlightRef = useRef(false);

  async function sendLatest() {
    if (inFlightRef.current) return;
    const q = latestRef.current;
    if (q === dispatchedRef.current) return;

    inFlightRef.current = true;
    dispatchedRef.current = q;

    if (mode === "url") {
      const url = new URL(window.location.href);
      if (q) {
        url.searchParams.set("q", q);
      } else {
        url.searchParams.delete("q");
      }
      History.prototype.replaceState.call(
        history,
        history.state,
        "",
        url.toString(),
      );
    } else {
      // Partial mode: send ?q= only on the refetch URL, never in history.
      // The server reads searchQuery from url.searchParams.get("q") just
      // like URL mode, so the JSX gate for stages 2/3 works without the
      // query becoming bookmarkable.
      setTransientParams({ q: q || null });
    }

    // Dispatch all three stages in the same tick — they batch into one request
    dispatchStage1({ query: q });
    dispatchStage2({ query: q });
    await dispatchStage3({ query: q });
    inFlightRef.current = false;
    // Re-check: user may have typed more while request was in flight
    sendLatest();
  }

  function handleChange(next: string) {
    setValue(next);
    latestRef.current = next;
    sendLatest();
  }

  const isStale = value !== dispatchedRef.current || inFlightRef.current;

  return (
    <div style={{ position: "relative" }}>
      <input
        type="text"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="Search pokemon by name..."
        autoFocus
        style={{
          width: "100%",
          padding: "0.75rem 1rem",
          paddingRight: "2.5rem",
          background: "#1a1a2e",
          border: "1px solid #4a5568",
          borderRadius: 8,
          color: "#ededed",
          fontSize: "1rem",
          outline: "none",
        }}
      />
      {isStale && (
        <span
          style={{
            position: "absolute",
            right: 12,
            top: "50%",
            transform: "translateY(-50%)",
            display: "inline-block",
            width: 16,
            height: 16,
            border: "2px solid #888",
            borderTopColor: "#ededed",
            borderRadius: "50%",
            animation: "spin 0.6s linear infinite",
          }}
        />
      )}
      <span
        style={{
          position: "absolute",
          right: 12,
          bottom: -20,
          fontSize: "0.65rem",
          color: "#555",
        }}
      >
        {mode === "partial" ? "usePartial (ephemeral)" : "URL (bookmarkable)"}
      </span>
    </div>
  );
}
