import { Partial } from "../../lib/partial.tsx";
import { getSearchParam } from "../../framework/context.ts";
import { ChatMessage } from "./piece.tsx";
import {
  AutoScrollToBottom,
  ChatClosePill,
  ChatOpenPill,
  NewMessageLink,
  ResetChatButton,
} from "./chat-controls.tsx";

/**
 * Ordered pool of notes files streamable into the chat. `AA_CHAT_STREAMING`
 * is first so it's the default initial stream (when `?msgs=` is unset) and
 * the first candidate appended by the "stream next note" link.
 */
export const AVAILABLE_FILES = [
  "AA_CHAT_STREAMING",
  "README",
  "STREAMING_CHAT",
  "PARTIAL_ARCHITECTURE",
  "SELECTOR_API",
  "NAVIGATE_UNIFIED",
  "AUTO_TRACKED_CACHE_KEYS",
  "DYNAMIC_PARTIAL_REGISTRY",
  "DEFER_ACTIVATORS",
  "SERVER_ISOLATION",
  "FRAME_SCOPING",
  "FRAMES",
  "CACHE_SCOPING",
  "IDEAS",
];

const DEFAULT_MSG = "AA_CHAT_STREAMING";

function parseMsgs(param: string | null): string[] {
  if (param == null) return [DEFAULT_MSG];
  return param
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && AVAILABLE_FILES.includes(s));
}

function computeNextHref(msgIds: string[]): string | null {
  const next = AVAILABLE_FILES.find((f) => !msgIds.includes(f));
  if (!next) return null;
  // Query-only — resolves against the current pathname so the overlay
  // works unchanged on any host page.
  const params = new URLSearchParams();
  params.set("msgs", [...msgIds, next].join(","));
  params.set("chat", "open");
  return `?${params.toString()}`;
}

/**
 * Global chat overlay. Mounted inside every page's `<body>`.
 *
 * Collapsed by default — renders a small "💬 notes stream" pill at
 * bottom-right. Clicking the pill sets `?chat=open` and the full box
 * expands, seeded with `AA_CHAT_STREAMING` when no `?msgs=` is present.
 *
 * `defaultOpen` (used on `/chat-notes`) flips the default so the full
 * box is the zero-config state on the dedicated demo page. The user's
 * `?chat=` preference always wins when set.
 *
 * Wiring the streaming machinery behind the open/closed gate is load-
 * bearing: when collapsed, no `<ChatMessage>` renders, no log producer
 * starts, no `<ResumeTail>` writes cursor params to the URL. That
 * keeps the overlay from interfering with other pages' interactions
 * and URL state until the user asks for it.
 */
export function ChatOverlay({
  defaultOpen = false,
  frameUrl,
}: {
  defaultOpen?: boolean;
  /**
   * Initial URL for the overlay's "chat-overlay" frame. Only applied
   * before the session has state for the frame. Used by /chat-notes to
   * project its own `?msgs=` + `?chat=` onto the frame at first render
   * so `page.goto("/chat-notes?msgs=IDEAS")` still drives the overlay.
   */
  frameUrl?: string;
}) {
  return (
    <Partial
      selector="#chat-overlay"
      frame="chat-overlay"
      frameUrl={frameUrl ?? "/"}
    >
      <ChatOverlayBody defaultOpen={defaultOpen} />
    </Partial>
  );
}

function ChatOverlayBody({ defaultOpen }: { defaultOpen: boolean }) {
  const chatParam = getSearchParam("chat");
  const open = chatParam != null ? chatParam === "open" : defaultOpen;

  if (!open) return <ChatOpenPill />;

  const msgsParam = getSearchParam("msgs");
  const msgIds = parseMsgs(msgsParam);
  const nextHref = computeNextHref(msgIds);

  return (
    <aside
      data-testid="chat-box"
      style={{
        position: "fixed",
        right: "1rem",
        bottom: "1rem",
        width: 600,
        maxHeight: "70vh",
        background: "#0f0f1a",
        border: "1px solid #2d3748",
        borderRadius: 12,
        boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
        display: "flex",
        flexDirection: "column",
        zIndex: 100,
      }}
    >
      <header
        style={{
          padding: "0.6rem 0.75rem",
          borderBottom: "1px solid #2d3748",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        <strong style={{ fontSize: "0.85rem" }}>notes stream</strong>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          <ResetChatButton />
          <ChatClosePill />
        </div>
      </header>
      <AutoScrollToBottom containerTestId="chat-list" />
      <Partial selector="#chat-list">
        <div
          data-testid="chat-list"
          style={{
            padding: "0.6rem 0.75rem",
            overflowY: "auto",
            flex: 1,
            minHeight: 120,
          }}
        >
          {msgIds.length === 0 ? (
            <div
              data-testid="chat-empty"
              style={{ color: "#666", fontSize: "0.8rem", fontStyle: "italic" }}
            >
              No messages. Click “stream next note” to start.
            </div>
          ) : (
            msgIds.map((fileId) => (
              <Partial
                key={`chat-msg-${fileId}`}
                selector={`#chat-msg-${fileId}`}
              >
                <ChatMessage fileId={fileId} />
              </Partial>
            ))
          )}
        </div>
      </Partial>
      <footer
        style={{
          padding: "0.6rem 0.75rem",
          borderTop: "1px solid #2d3748",
        }}
      >
        <NewMessageLink nextHref={nextHref} />
      </footer>
    </aside>
  );
}
