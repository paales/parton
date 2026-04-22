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
export function ResetChatButton() {
  const nav = useNavigation();

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
