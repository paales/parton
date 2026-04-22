import { Suspense } from "react";
import { readLog, readLogPrefix } from "./log.ts";
import { ResumeTail } from "./resume-tail.tsx";
import { getSearchParam } from "../../framework/context.ts";

/**
 * Bounded linear recursion that emits a streaming message. The key insight
 * is that each <Piece> is its own Suspense boundary from React's POV, so
 * every chunk arrives as an independent Flight reveal. But linear recursion
 * in a React tree is O(N) fibers; unbounded it's a memory + reconciler
 * walk-cost leak.
 *
 * Hence the bound: `MAX_DEPTH`. At the bound, the chain ends with a
 * client-side <ResumeTail> that re-opens the whole partial with a bumped
 * `?cursor-${fileId}=` — the server then dumps the prefix as a single
 * synchronous <FlatPrefix> and restarts the <Piece> chain at depth 0.
 * The full message is accumulated in a durable server-side log (src/app/
 * chat/log.ts) so the reload can render the prefix cheaply.
 *
 * Why a span-per-chunk and not string concatenation: keeps Suspense
 * boundaries as siblings that React reconciles independently — adding a
 * new tail Piece is an O(1) mount, not a string-prop reallocation of the
 * growing whole message.
 */
const MAX_DEPTH = 12;

export async function Piece({
  fileId,
  cursor,
  depth,
}: {
  fileId: string;
  cursor: number;
  depth: number;
}) {
  const read = await readLog(fileId, cursor);
  if (read.done) {
    return (
      <span data-testid={`chat-done-${fileId}`} style={{ color: "#588", fontSize: "0.75rem", display: "block", marginTop: "0.25rem" }}>
        ✓ stream complete ({cursor} chunks)
      </span>
    );
  }
  const nextCursor = cursor + 1;
  const nextDepth = depth + 1;
  return (
    <>
      <ChunkText text={read.text} />
      {nextDepth >= MAX_DEPTH ? (
        <ResumeTail fileId={fileId} cursor={nextCursor} />
      ) : (
        <Suspense fallback={null}>
          <Piece fileId={fileId} cursor={nextCursor} depth={nextDepth} />
        </Suspense>
      )}
    </>
  );
}

function ChunkText({ text }: { text: string }) {
  // Inline so 100-char slices flow as a growing paragraph rather than
  // stacking as a list of fragments. `pre-wrap` preserves newlines
  // inside a chunk (markdown line breaks show up as actual breaks).
  return (
    <span
      data-chunk
      style={{
        whiteSpace: "pre-wrap",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: "0.75rem",
        lineHeight: 1.4,
      }}
    >
      {text}
    </span>
  );
}

/**
 * Synchronously rendered prefix for a message resumed past cursor > 0.
 * Pulled straight from the server-side log — all chunks that were already
 * produced by the time the refetch landed are flushed in one go, so the
 * new Piece chain only has to stream from `cursor` onward.
 *
 * If the producer is behind the cursor (slow disk, rare — the log is read
 * eagerly), this returns fewer chunks and the Piece at depth 0 will
 * suspend on `readLog(cursor)` until the producer catches up. That gap is
 * narrow in practice.
 */
export function FlatPrefix({
  fileId,
  cursor,
}: {
  fileId: string;
  cursor: number;
}) {
  if (cursor <= 0) return null;
  const chunks = readLogPrefix(fileId, cursor);
  return (
    <>
      {chunks.map((text, i) => (
        <ChunkText key={i} text={text} />
      ))}
    </>
  );
}

/**
 * Everything above `<Piece>` for one message: the header row and the
 * streaming body. Split from the page component so the `<Partial>` body
 * has a single component type (keeps fingerprinting / snapshot resolution
 * clean).
 */
/**
 * Reads its own cursor from `?cursor-${fileId}` so the state driving
 * refetches lives in the URL, not a closure-captured prop. That means the
 * route-scoped partial registry can snapshot this element once (on the
 * initial streaming render) and re-render it fresh on every targeted
 * refetch — the ResumeTail-driven cursor bump shows up in the URL and the
 * body re-reads it.
 */
export function ChatMessage({ fileId }: { fileId: string }) {
  const cursorParam = getSearchParam(`cursor-${fileId}`);
  const startCursor = Math.max(0, Number(cursorParam) || 0);
  return (
    <article
      data-testid={`chat-msg-${fileId}`}
      data-cursor={startCursor}
      style={{
        background: "#111",
        border: "1px solid #2d3748",
        borderRadius: 8,
        padding: "0.6rem 0.75rem",
        marginBottom: "0.5rem",
      }}
    >
      <header
        style={{
          color: "#9ae6b4",
          fontSize: "0.7rem",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: "0.4rem",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {fileId}.md
      </header>
      <div data-testid={`chat-body-${fileId}`}>
        <FlatPrefix fileId={fileId} cursor={startCursor} />
        <Suspense
          fallback={
            <span
              data-testid={`chat-pending-${fileId}`}
              style={{ color: "#666", fontSize: "0.75rem", fontStyle: "italic" }}
            >
              streaming…
            </span>
          }
        >
          <Piece fileId={fileId} cursor={startCursor} depth={0} />
        </Suspense>
      </div>
    </article>
  );
}
