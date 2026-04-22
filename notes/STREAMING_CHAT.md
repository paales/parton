# Streaming chat — bounded `<Piece>` + compaction — design note

**Added:** 2026-04-22
**Status:** implemented as a demo at `/chat-notes`.
**Files:** `src/app/chat/log.ts`, `src/app/chat/piece.tsx`, `src/app/chat/resume-tail.tsx`, `src/app/chat/chat-controls.tsx`, `src/app/pages/chat-notes.tsx`, `e2e/chat-notes.spec.ts`.
**Origin:** `user-ideas.md:35` — "continuously streaming content, AI chat trickle, recursive `<Piece>`".

---

## One-liner

Stream an arbitrarily long message into a single Partial by recursing through `<Piece>` server components — each chunk is its own Suspense boundary and arrives as an independent Flight reveal. Cap the recursion depth; when the chain hits the cap, a client-side `ResumeTail` fires a targeted refetch with a bumped cursor. The server re-renders the message as a synchronous `<FlatPrefix>` of chunks `[0..cursor)` plus a fresh depth-0 Piece chain. Net effect: content grows unbounded while fiber depth stays bounded. A durable append-only log per message makes resume and reload cheap.

## Why not the obvious alternatives

**Unbounded recursive `<Piece>`.** Works for short streams but each chunk adds a Suspense fiber and a stack frame. A 500-chunk message is 500 nested Suspense boundaries — reconciler walk cost, memory, and debugger UX all degrade linearly. The Vercel AI SDK recursion pattern has the same issue; it just doesn't show up at typical chat lengths.

**Polling (`setInterval` refetch).** Every poll tears down and re-renders the whole Partial. Loses the per-chunk reveal; every tick is an atomic swap. Also wasteful when the source hasn't produced anything new.

**One long HTTP stream / SSE.** Works, but fights the framework. The whole point of the Partials architecture is that every client-initiated render is a navigation (see `NAVIGATE_UNIFIED.md`). A persistent SSE connection is a second, parallel client→server channel with its own lifecycle, reconnect policy, backpressure story, and URL-state-sync problem. We already have all of that inside `useNavigation().navigate` — the bounded-Piece pattern reuses it.

**Multipart response / redirect-at-EOF trick.** Clever, but inverts control: the server decides when to hand the client another stream, the client can't easily reconnect at a specific cursor, and browsers don't expose multipart bodies in a form RSC can consume. Targeted refetch is a cleaner API for the same outcome.

**GraphQL `@defer`.** Complementary, not a substitute. `@defer` is Suspense-stitched multiple awaits inside one request — perfect for a query with a slow field, but has no continuation beyond that single response. Bounded-`<Piece>` composes *many* requests into one growing message.

## Mechanics

### Durable log (the sink)

`src/app/chat/log.ts` owns a per-file in-memory log:

```ts
interface MessageLog {
  chunks: string[];
  done: boolean;
  error: Error | null;
  waiters: Set<() => void>;
}
```

`ensureLog(fileId)` lazily spawns a producer (`runProducer`) that reads `notes/<fileId>.md`, slices into 100-char chunks with a 100 ms delay per chunk, and pushes into `log.chunks`. Every push wakes any readers parked in `waiters`.

`readLog(fileId, cursor)` is the reader entrypoint. It returns `{ text, done }` for the chunk at `cursor`, or awaits a waiter promise if the producer hasn't caught up. When the producer drains the file, subsequent reads return `{ text: "", done: true }`.

`readLogPrefix(fileId, cursor)` is the synchronous sibling: returns chunks `[0, cursor)` for the FlatPrefix render. Never blocks — if the producer fell behind, it returns a shorter array and the depth-0 Piece will suspend on the missing chunks.

The log **outlives individual requests**. A `ResumeTail` reload, a full page reload, or a navigation that lands back on `/chat-notes` all replay from the same log without re-reading the source. This decouples the source rate-of-production from any one client's consumption.

`_clearLogs()` is test-only and wired into `/__test/clear-caches` so the dev reset button flushes logs alongside the `<Cache>` store and partial registry.

### Recursion (the source shape)

```tsx
// MAX_DEPTH = 12
export async function Piece({ fileId, cursor, depth }) {
  const read = await readLog(fileId, cursor);
  if (read.done) return <span data-testid={`chat-done-${fileId}`}>✓ stream complete</span>;
  const nextCursor = cursor + 1;
  const nextDepth = depth + 1;
  return (
    <>
      <ChunkText text={read.text} />
      {nextDepth >= MAX_DEPTH
        ? <ResumeTail fileId={fileId} cursor={nextCursor} />
        : <Suspense fallback={null}>
            <Piece fileId={fileId} cursor={nextCursor} depth={nextDepth} />
          </Suspense>}
    </>
  );
}
```

Each recursion is one `await readLog` + one Suspense wrap. React's Flight stream reveals each `<Piece>`'s resolved output as an independent chunk, so the browser paints one chunk at a time as fast as the producer can emit.

### Compaction (the bound)

At depth `MAX_DEPTH`, the tail is a client component instead of another `<Suspense>`:

```tsx
"use client";
export function ResumeTail({ fileId, cursor }) {
  const nav = useNavigation();
  const lastFiredCursor = useRef<number | null>(null);
  useEffect(() => {
    if (lastFiredCursor.current === cursor) return;
    lastFiredCursor.current = cursor;
    void nav.navigate(
      (url) => { url.searchParams.set(`cursor-${fileId}`, String(cursor)); return url; },
      { history: "replace", selector: `#chat-msg-${fileId}`, disableTransition: true },
    );
  }, [fileId, cursor, nav]);
  return <span data-testid={`resume-tail-${fileId}`} data-cursor={cursor} hidden />;
}
```

On mount, it writes `?cursor-<fileId>=<N>` to the URL and fires a targeted refetch of the message's Partial. The server re-renders:

```tsx
<article data-testid={`chat-msg-${fileId}`} data-cursor={startCursor}>
  <FlatPrefix fileId={fileId} cursor={startCursor} />
  <Suspense fallback={<span>streaming…</span>}>
    <Piece fileId={fileId} cursor={startCursor} depth={0} />
  </Suspense>
</article>
```

`<FlatPrefix>` dumps chunks `[0, cursor)` synchronously from the log; the fresh depth-0 Piece chain picks up from `cursor`. Fiber depth resets; the message grows by another `MAX_DEPTH` before the next compaction.

### `disableTransition: true` is load-bearing

The default `nav.navigate` wraps the commit in `React.startTransition`. For a normal refetch that's correct (atomic swap, no fallback flash). For this pattern it's wrong: the transition holds the commit until all nested Pieces resolve, so the whole next `MAX_DEPTH`-chunk batch lands in one bulk paint instead of streaming chunk-by-chunk. Passing `disableTransition: true` puts each Piece's reveal back on its own commit.

### URL as the cursor source

`ChatMessage` reads its cursor from `getSearchParam('cursor-' + fileId)`, not from a prop:

```tsx
export function ChatMessage({ fileId }: { fileId: string }) {
  const cursorParam = getSearchParam(`cursor-${fileId}`);
  const startCursor = Math.max(0, Number(cursorParam) || 0);
  // …
}
```

This is the CLAUDE.md discipline in action (`notes/NAVIGATE_UNIFIED.md` §State rules). If the cursor rode as a prop from the page component, the route-scoped partial registry snapshot would capture the closure at first render (`cursor=0`) and re-play it on every targeted refetch — the Partial would refetch forever at cursor 0. Reading through the tracked accessor keeps the body live: each refetch reads the *current* URL, not a frozen snapshot.

Bookmarkability is a free side effect. Reloading `/chat-notes?msgs=README&cursor-README=36` resumes that message at chunk 36.

## Lessons that fell out of the build

### React reuses the `ResumeTail` fiber across refetches

The first implementation guarded the `useEffect` with a plain `const fired = useRef(false)`. The first compaction fired; the second never did. Cause: after the targeted refetch, React sees the new payload still has a `<ResumeTail>` at the same tree position with the same component type — it *updates the existing fiber* with new props instead of unmounting/remounting. The `fired.current = true` from the first compaction persisted and blocked every subsequent trigger.

Fix: guard on `lastFiredCursor.current === cursor` instead. Each unique cursor value fires exactly once; same-value double-invoked (React 19 strict-mode dev behavior) is absorbed because `ref.current` already equals the prop.

General rule: in `useEffect` inside a client component that can be **updated in place** by a server refetch, "have I fired yet" guards must key on the props that would identify a new firing, not a plain boolean.

### Pre-hydration clicks — anchor fallback

The "new message" button was originally a `<button onClick>`. In an e2e test where the durable log happened to be warm, the SSR hit emitted a fully-rendered page before React hydrated — Playwright clicked instantly, before `onClick` was wired up, and nothing happened. Fix: render an `<a href={nextHref}>` so the browser's native click path follows the href pre-hydration, with an `onClick` that preempts to `nav.navigate` after hydration.

`nextHref` is computed on the server (`computeNextHref(msgIds)` in `src/app/pages/chat-notes.tsx`) so the anchor always points at an up-to-date URL — no stale `window.location` reads, no prop-captured URL going stale across refetches.

### Durable log + demo reset tension

A log that outlives requests makes the source stream cheap to rejoin, but also means "load the page, see a full warm message appear instantly" when the log was already drained by a previous test run. Two hedges:

- `/__test/clear-caches` calls `_clearLogs()` alongside the other stores.
- The chat box header has a visible `reset` button that hits `/__test/clear-caches` then does a top-level `window.location.href = origin` to wipe both server state and client URL params in one shot.

In production you'd replace the in-memory log with Redis + a TTL and drop the reset button.

## Demo — `/chat-notes`

`?msgs=README,IDEAS,FRAMES` — comma-separated list of notes files to stream, in order. Each file is one message.

`?cursor-<fileId>=N` — the compaction cursor for that message. Zero on initial load; bumped by `MAX_DEPTH` each time the Piece chain hits its bound.

The page is a `<PartialRoot>` with a fixed-position aside. The list is `<Partial selector="#chat-list">`; each message is `<Partial selector="#chat-msg-<fileId>">`. `AutoScrollToBottom` runs a `MutationObserver` on the list and sticks `scrollTop` to `scrollHeight` while the user hasn't scrolled away (80 px threshold).

Seven e2e specs in `e2e/chat-notes.spec.ts` pin the invariants:

- Initial render stops at `MAX_DEPTH` with a `<ResumeTail>` carrying `cursor = k * MAX_DEPTH`.
- After compaction, the `data-cursor` on the message and the URL param both advance in `MAX_DEPTH` strides.
- Rendered chunk count is monotonic across compaction seams (the flat prefix must re-emit everything the previous chain had).
- Terminal state reaches `chat-done-<fileId>` when the producer drains, with no `<ResumeTail>` left.
- Auto-scroll pins the bottom as chunks stream in.
- Adding a message appends to `?msgs=` and starts a second parallel stream.
- Anchor href is server-computed and clickable pre-hydration.

## Known sharp edges

- **In-memory log** — process-wide, unbounded. Fine for a demo; production wants Redis + TTL + a max-size eviction.
- **Producer can't be cancelled** — once `runProducer` kicks off, it drains the file even if every client has disconnected. For a demo that's the point (reconnect is cheap). For a real chat, wire an abort signal keyed on "no waiters and no active subscribers for N seconds."
- **Compaction seam race** — if the producer gets ahead of the client between when the `ResumeTail` fires and when the refetch payload lands, the new depth-0 Piece chain may have more than `MAX_DEPTH` chunks immediately available. That's harmless — the chain just streams faster. But it means `MAX_DEPTH` is a minimum between compactions, not a maximum.
- **Cursor accounting is client-fired, not server-validated** — a crafted `?cursor-<fileId>=999999` skips ahead past the log's tail. `FlatPrefix` just returns an empty slice and Piece suspends waiting for chunks that may never exist. Not a correctness bug in the demo, but a real app wants a server-side clamp against `log.chunks.length`.
- **One source per fileId** — two clients hitting `?msgs=README` share the same log and the same producer. Different clients wanting independent streams of the same source would need a session-scoped or client-scoped log key.

## Future shape

- **True push source** — today the producer is a file-read with a simulated per-chunk delay. Swap in an `AsyncIterable` from an LLM API and the rest of the pipeline is unchanged; `runProducer` just `for-await-of`s instead of slicing a string.
- **Multiple source producers per log** — for a realtime doc where several writers append to the same stream. Trivial extension: `appendChunk(fileId, text)` that calls `wakeAll`. Readers already handle the single-shared-log case.
- **Backpressure** — not addressed. If a client is much slower than the producer, the log grows without bound and the FlatPrefix render gets bigger on every compaction. A client cursor lower-bound + a bounded ring buffer would cap memory; the client would see `"stream dropped earlier chunks"` on reconnect.
- **`@defer`-on-top composition** — a `<Piece>` whose chunk contains a GraphQL query with `@defer` would stream the chunk first and the deferred field afterwards, inside the same chunk boundary. Already supported by the runtime; not demoed.
- **Source sharing with cache keys** — an LLM response to a given prompt is stable. Keying the log by `hash(prompt)` (not `fileId`) lets many clients asking the same question share one producer + one log, with response-cache semantics on top of the streaming shape.
