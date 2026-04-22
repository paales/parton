"use client";

import { useEffect, useRef, type MouseEvent } from "react";
import { useNavigation } from "../../lib/partial-client.tsx";

/**
 * "New message" link. Rendered as an anchor so a click before the client JS
 * bundle has hydrated still works (browser follows the href for a full
 * page nav). After hydration the `onClick` preempts and fires
 * `nav.navigate` for a client-side transition.
 *
 * `nextHref` is computed on the server (from the current `?msgs=` and the
 * available pool) so the `href` is always up-to-date with the current URL
 * state. No `window.location` reads on the client; no pre-hydration stale
 * reads from a captured prop.
 */
export function NewMessageLink({ nextHref }: { nextHref: string | null }) {
  const nav = useNavigation();

  if (nextHref == null) {
    return (
      <span
        data-testid="new-message-disabled"
        style={{
          display: "block",
          color: "#555",
          fontSize: "0.8rem",
          textAlign: "center",
          padding: "0.4rem",
        }}
      >
        (all notes streaming)
      </span>
    );
  }

  const onClick = (ev: MouseEvent<HTMLAnchorElement>) => {
    // Let cmd/ctrl/shift-click open in a new tab / window.
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
    ev.preventDefault();
    void nav.navigate(nextHref, { history: "push" });
  };

  return (
    <a
      href={nextHref}
      data-testid="new-message-btn"
      onClick={onClick}
      style={{
        display: "block",
        textAlign: "center",
        background: "#2d3748",
        color: "#ededed",
        border: "1px solid #4a5568",
        padding: "0.4rem 0.8rem",
        borderRadius: 6,
        cursor: "pointer",
        fontSize: "0.8rem",
        textDecoration: "none",
      }}
    >
      + Stream next note
    </a>
  );
}

/**
 * Keeps the chat-list scrolled to the bottom as new chunks arrive.
 * MutationObserver on the scrollable container: any DOM mutation inside
 * (new chunk, FlatPrefix reflow after compaction) sticks the scroll to
 * the bottom unless the user has scrolled away.
 *
 * Stickiness: if the user scrolls up by more than STICKY_THRESHOLD from
 * the bottom, auto-follow disengages. Scrolling back within the
 * threshold re-engages it. Standard terminal/chat behavior.
 */
const STICKY_THRESHOLD = 80;

export function AutoScrollToBottom({
  containerTestId,
}: {
  containerTestId: string;
}) {
  const stuck = useRef(true);

  useEffect(() => {
    const container = document.querySelector<HTMLElement>(
      `[data-testid="${containerTestId}"]`,
    );
    if (!container) return;

    const isNearBottom = () =>
      container.scrollHeight - container.scrollTop - container.clientHeight <
      STICKY_THRESHOLD;

    const onScroll = () => {
      stuck.current = isNearBottom();
    };

    const mo = new MutationObserver(() => {
      if (stuck.current) {
        container.scrollTop = container.scrollHeight;
      }
    });

    container.addEventListener("scroll", onScroll, { passive: true });
    mo.observe(container, { childList: true, subtree: true, characterData: true });

    // Initial pin to the bottom.
    container.scrollTop = container.scrollHeight;

    return () => {
      container.removeEventListener("scroll", onScroll);
      mo.disconnect();
    };
  }, [containerTestId]);

  return null;
}

/**
 * "Reset" button — clears all messages and the server-side logs via the
 * dev-only cache-clear endpoint. Useful for manual testing; in production
 * you'd just drop the `?msgs=` param.
 */
/**
 * Collapsed-state pill at bottom-right. Sets `?chat=open` and triggers a
 * targeted refetch of `#chat-overlay` so the full overlay expands in
 * place without re-rendering the host page.
 */
export function ChatOpenPill() {
  const nav = useNavigation();

  const onClick = (ev: MouseEvent<HTMLAnchorElement>) => {
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
    ev.preventDefault();
    void nav.navigate(
      (url) => {
        url.searchParams.set("chat", "open");
        return url;
      },
      { history: "replace", selector: "#chat-overlay" },
    );
  };

  // Server-rendered href so a pre-hydration click still opens the chat.
  return (
    <a
      href="?chat=open"
      data-testid="chat-open-pill"
      onClick={onClick}
      style={{
        position: "fixed",
        right: "1rem",
        bottom: "1rem",
        zIndex: 100,
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        padding: "0.45rem 0.8rem",
        background: "#0f0f1a",
        color: "#ededed",
        border: "1px solid #2d3748",
        borderRadius: 999,
        boxShadow: "0 6px 20px rgba(0,0,0,0.4)",
        fontSize: "0.8rem",
        textDecoration: "none",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <span aria-hidden>💬</span>
      <span>notes stream</span>
    </a>
  );
}

/**
 * Collapses the overlay — inverse of `ChatOpenPill`. Targeted refetch of
 * `#chat-overlay` with `?chat=closed` so the host page is untouched.
 */
export function ChatClosePill() {
  const nav = useNavigation();

  const onClick = () => {
    void nav.navigate(
      (url) => {
        url.searchParams.set("chat", "closed");
        return url;
      },
      { history: "replace", selector: "#chat-overlay" },
    );
  };

  return (
    <button
      type="button"
      data-testid="chat-close-pill"
      onClick={onClick}
      aria-label="Collapse chat"
      style={{
        background: "transparent",
        color: "#888",
        border: "1px solid #4a5568",
        padding: "0.3rem 0.55rem",
        borderRadius: 6,
        cursor: "pointer",
        fontSize: "0.75rem",
        lineHeight: 1,
      }}
    >
      ×
    </button>
  );
}

export function ResetChatButton() {
  const onClick = async () => {
    await fetch("/__test/clear-caches", { method: "POST" });
    const url = new URL(window.location.href);
    url.search = "";
    window.location.href = url.toString();
  };

  return (
    <button
      type="button"
      data-testid="reset-chat-btn"
      onClick={onClick}
      style={{
        background: "transparent",
        color: "#888",
        border: "1px solid #4a5568",
        padding: "0.3rem 0.6rem",
        borderRadius: 6,
        cursor: "pointer",
        fontSize: "0.75rem",
      }}
    >
      reset
    </button>
  );
}
