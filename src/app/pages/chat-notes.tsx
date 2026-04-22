import { PartialRoot, Partial } from "../../lib/partial.tsx";
import { AppNav } from "../components/app-nav.tsx";
import { ChatOverlay } from "../chat/chat-overlay.tsx";
import { getSearchParam } from "../../framework/context.ts";

/**
 * Documentation page for the streaming-chat demo. The actual streaming
 * UI now lives in `<ChatOverlay>`, which is mounted on every page — this
 * page just narrates how the architecture works. See
 * `notes/STREAMING_CHAT.md` for the long-form write-up.
 *
 * `/chat-notes` is unique in projecting its window-URL query onto the
 * overlay's frame URL so `?msgs=README` and friends drive the overlay
 * on initial render. Other host pages don't project — the overlay
 * starts from session / default state and is driven by clicks.
 */
function chatOverlayFrameUrl(): string {
  const msgs = getSearchParam("msgs");
  const chat = getSearchParam("chat");
  const params = new URLSearchParams();
  if (msgs != null) params.set("msgs", msgs);
  if (chat != null) params.set("chat", chat);
  return params.size > 0 ? `/?${params.toString()}` : "/";
}

export function ChatNotesPage() {
  const frameUrl = chatOverlayFrameUrl();
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
              The box in the bottom-right streams one markdown file from{" "}
              <code>notes/</code>, character by character, through a bounded
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
              back/forward resume correctly. The producer runs on a ten-second
              budget so even long files stop on their own.
            </p>
            <p>
              The chat box is mounted on every page — navigate around and
              messages in progress keep streaming. Click "+ stream next note"
              to start another file in parallel.
            </p>
          </main>
          <ChatOverlay defaultOpen frameUrl={frameUrl} />
        </body>
      </html>
    </PartialRoot>
  );
}
