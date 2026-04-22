# Hi — I'm a streaming message.

Every character you're watching land right now travels from a server component, through React's Flight stream, and into your browser as a separate chunk reveal. No polling. No websocket. One HTTP response that trickles.

The trick is a recursive server component called `<Piece>`. Each Piece awaits the next chunk from a durable per-message log, renders its text, and wraps the **next** Piece in a `<Suspense>` boundary. React's Flight protocol treats every Suspense boundary as an independent unit of work — so as each awaited chunk resolves, it gets its own frame in the stream.

Linear recursion in a React tree has a cost, though. A thousand nested Suspense boundaries is a thousand fibers. So the recursion is bounded: at depth twelve, the chain ends in a tiny client component called `<ResumeTail>`. On mount, it fires a targeted refetch of the enclosing Partial with a bumped cursor in the URL. The server re-renders the message as a synchronous prefix (everything produced so far, pulled straight from the log) plus a fresh depth-zero Piece chain for the tail. Fiber depth resets. Content keeps growing.

Because the log outlives individual requests, disconnects are cheap. A full page reload, a navigation away and back, a `<ResumeTail>` compaction — all of them just continue reading from the log at the cursor you left off at. The URL carries the cursor, so bookmarks resume correctly too.

A couple of lessons fell out of the build. React reuses fibers across targeted refetches, so a plain `useRef(false)` "have I fired yet" guard inside `<ResumeTail>`'s effect would block every compaction after the first — the guard has to key on the cursor prop, not on a boolean. And the default transition wrapper that `navigate` uses will hold the whole refetch until every nested Piece resolves, which defeats the per-chunk reveal. Passing `disableTransition: true` puts each Piece's Flight frame back on its own commit.

Open `/chat-notes` to read about the whole architecture, or click "+ stream next note" below to start streaming another notes file in parallel. Multiple messages stream side by side without crossing wires — each has its own cursor, its own Piece chain, its own slot in the log.

That's the demo. You can close this any time; the reset button wipes all the server-side logs and URL params in one shot.
