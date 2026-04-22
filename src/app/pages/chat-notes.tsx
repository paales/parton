import { PartialRoot, Partial } from "../../lib/partial.tsx";
import { AppNav } from "../components/app-nav.tsx";
import { getSearchParam } from "../../framework/context.ts";
import { ChatMessage } from "../chat/piece.tsx";
import {
  AutoScrollToBottom,
  NewMessageLink,
  ResetChatButton,
} from "../chat/chat-controls.tsx";

/**
 * Exercises the bounded-Piece + compaction streaming architecture from
 * user-ideas.md:35.
 *
 *   - Each `notes/*.md` file is a "message" whose paragraphs stream as
 *     chunks (paragraph = token analog; see `src/app/chat/log.ts`).
 *   - Each chunk is its own Suspense boundary inside a recursive
 *     `<Piece>` server component. React's Flight protocol reveals each
 *     chunk as it resolves.
 *   - Recursion is bounded at MAX_DEPTH. When the chain hits the bound,
 *     the tail is a client-side `<ResumeTail>` that calls
 *     `nav.navigate({ selector: "#chat-msg-${fileId}" })` with a bumped
 *     cursor. The server re-renders the message as `<FlatPrefix>` + a
 *     fresh depth-0 Piece chain. Steady-state fiber count stays bounded
 *     while the message grows unbounded.
 *
 * URL state:
 *   ?msgs=README,FRAMES                — ordered list of active messages
 *   ?cursor-README=24&cursor-FRAMES=8  — per-message compaction cursor
 */

const AVAILABLE_FILES = [
  "README",
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

export function ChatNotesPage() {
  const msgsParam = getSearchParam("msgs") ?? "";
  const msgIds = msgsParam
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && AVAILABLE_FILES.includes(s));

  return (
    <PartialRoot>
      <html lang="en">
        <Partial selector="#head">
          <head>
            <meta charSet="UTF-8" />
            <meta
              name="viewport"
              content="width=device-width, initial-scale=1.0"
            />
            <title>Chat Notes — streaming demo</title>
            <style>{`
              * { box-sizing: border-box; margin: 0; padding: 0; }
              body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #ededed; padding: 2rem; max-width: 900px; margin: 0 auto; min-height: 100vh; }
              a { color: #58a6ff; text-decoration: none; }
              a:hover { text-decoration: underline; }
              h1 { font-size: 1.75rem; margin-bottom: 1rem; }
              h2 { font-size: 1.1rem; margin: 1rem 0 0.5rem; color: #ccc; }
              p { margin-bottom: 0.75rem; color: #bbb; line-height: 1.5; }
              code { background: #2d3748; padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.85rem; }
              nav { margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid #2d3748; }
              @keyframes spin { to { transform: rotate(360deg); } }
            `}</style>
          </head>
        </Partial>
        <body>
          <AppNav />
          <main style={{ paddingBottom: "60vh" }}>
            <h1>
              Chat — streaming the <code>notes/</code> directory
            </h1>
            <p>
              Each message below streams one markdown file from{" "}
              <code>notes/</code>, paragraph by paragraph, through a bounded
              recursive <code>&lt;Piece&gt;</code> server component. When the
              Piece chain hits its depth bound it compacts via a targeted{" "}
              <code>reload</code> — the message re-renders as a synchronous flat
              prefix plus a fresh depth-0 Piece chain for the tail. Watch the
              message keep growing while the Suspense depth stays bounded.
            </p>
            <h2>How it works</h2>
            <p>
              The server-side log (<code>src/app/chat/log.ts</code>) holds all
              produced chunks. Every refetch rehydrates its prefix from the log
              synchronously, so reconnects are cheap. Cursors live in the URL (
              <code>?cursor-&lt;fileId&gt;=N</code>) so page reloads and browser
              back/forward resume correctly.
            </p>
            <p>
              Open a new message with the button in the chat box (bottom-right).
              Multiple messages stream in parallel.
            </p>
          </main>

          <ChatBox msgIds={msgIds} />
        </body>
      </html>
    </PartialRoot>
  );
}

function computeNextHref(msgIds: string[]): string | null {
  const next = AVAILABLE_FILES.find((f) => !msgIds.includes(f));
  if (!next) return null;
  // Use a pathname-relative URL so the browser preserves existing non-
  // msgs search params (none today, but cheap future-proofing).
  const params = new URLSearchParams();
  params.set("msgs", [...msgIds, next].join(","));
  return `/chat-notes?${params.toString()}`;
}

function ChatBox({ msgIds }: { msgIds: string[] }) {
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
        }}
      >
        <strong style={{ fontSize: "0.85rem" }}>notes stream</strong>
        <ResetChatButton />
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
              No messages yet. Click “stream next note” to start.
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
