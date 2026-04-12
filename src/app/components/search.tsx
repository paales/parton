"use client";

import {
  useRef,
  useEffect,
  useState,
  useTransition,
  type ReactNode,
} from "react";

/**
 * Search toggle button for the header.
 * Pushes ?search=open to trigger the overlay section.
 */
export function SearchToggle({ isOpen }: { isOpen: boolean }) {
  const [isPending, startTransition] = useTransition();

  function toggle() {
    startTransition(() => {
      const url = new URL(window.location.href);
      if (isOpen) {
        url.searchParams.delete("search");
        url.searchParams.delete("q");
      } else {
        url.searchParams.set("search", "open");
      }
      history.pushState(null, "", url.toString());
    });
  }

  return (
    <button
      type="button"
      onClick={toggle}
      style={{
        background: isOpen ? "#4a5568" : "#2d3748",
        color: "#ededed",
        border: "1px solid #4a5568",
        padding: "0.4rem 0.8rem",
        borderRadius: 6,
        cursor: "pointer",
        fontSize: "0.85rem",
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
      }}
    >
      {isPending ? (
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
      ) : (
        <span style={{ fontSize: "1rem" }}>&#x1F50D;</span>
      )}
      {isOpen ? "Close" : "Search"}
    </button>
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
        background: "transparent",
        border: "none",
        padding: 0,
        maxWidth: 720,
        width: "calc(100% - 2rem)",
        maxHeight: "80vh",
        overflow: "visible",
        marginTop: "10vh",
        placeItems: "center",
      }}
    >
      <div
        style={{
          background: "#111118",
          border: "1px solid #2d3748",
          borderRadius: 12,
          padding: "1.25rem",
          maxHeight: "80vh",
          overflow: "auto",
        }}
      >
        {children}
      </div>
    </dialog>
  );
}

/**
 * Search input inside the overlay.
 * Navigates with ?q=... via startTransition so the old results
 * stay visible while the server fetches new ones.
 */
export function SearchInput({ query }: { query: string }) {
  const [value, setValue] = useState(query);
  const [isPending, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    setValue(next);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      startTransition(() => {
        const url = new URL(window.location.href);
        if (next) {
          url.searchParams.set("q", next);
        } else {
          url.searchParams.delete("q");
        }
        // replaceState so typing doesn't create back-history per keystroke.
        // The section caching system handles partial updates — the client
        // sends ?cached= with all cached section IDs, so only the search
        // section (whose fingerprint changed due to the new query prop)
        // gets re-rendered by the server.
        history.replaceState(null, "", url.toString());
      });
    }, 200);
  }

  return (
    <div style={{ position: "relative" }}>
      <input
        type="text"
        value={value}
        onChange={handleChange}
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
      {isPending && (
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
    </div>
  );
}
