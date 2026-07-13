# Frame scope internals

A parton reads its frame chain from server context — the ambient
parton's `frameChain` (see [`server-context.md`](./server-context.md)).
It opens no frame of its own; `<Frame>` is what extends the chain. The
tracked server-hooks read from the frame-resolved `Request`, so a
framed spec keys on its frame's URL.

```ts
// inside createSpecComponent (framework/src/lib/partial.tsx):
const parent = __injectedParent ?? getServerContext(ParentContext)
const ourFrameChain = parent.frameChain
const ourRequest =
  ourFrameChain.length > 0 ? resolveFrameRequest(ourFrameChain) : getRequest()
```

`<Frame name>` reads the same ambient parent, appends `name` to the
chain, and sets that as its descendants' context, so they inherit the
extended chain. `resolveFrameRequest` looks the URL up via
`getSessionFrameUrl(path)` (a `<Frame>`'s `initialUrl` is written there
on cold render) and falls back to the page request.

## Why server context, not an ALS cell

RSC sibling interleaving makes a per-request mutable cell unsafe: a
sibling spec's body can overwrite the cell between an ancestor's
setup and its descendant's body. The frame chain rides server context
instead — threaded through the parton ALS frame — which survives
`await` and isolates siblings, so the chain propagates without any
per-request cell drift. Each spec invocation resolves its request
once; the tracked hooks read from that resolved request.

## Wire protocol

Attached, a frame navigation is a frame-scoped `url` frame on a
channel envelope — the endpoint writes the frame URL into the
session and the driver lanes the frame's subtrees on the held stream
(see [`channel.md`](./channel.md) §Frames ride the channel). The
document carrier `?__frame=<dotted-path>&__frameUrl=<url>` exists
for renders with no channel — a degraded page's frame navigation and
the CMS preview iframe; `PartialRoot` reads the params off the
document URL and writes the same session store before any spec runs.
The session is
cookie-backed (`__frame_sid`); state lives behind the pluggable
`SessionStore` interface in `framework/src/runtime/session.ts` —
`MemorySessionStore` by default (per-process, gone on restart), or
`setSessionStore(new SqliteSessionStore(path))` from
`runtime/session-store-sqlite.ts` when sessions must survive restarts
(pass the SQLite cell adapter's `db` to share one database file; see
[`cell-internals.md`](./cell-internals.md#the-adapter-matrix)). The
expiry policy is backend-independent and lives above the store:
entries expire on inactivity — every read or write refreshes the
session's idle clock, so an active session's frame URLs never vanish
under the user; sessions idle past the TTL (default 30 minutes,
`configureSessionStore({ idleTtlMs })`) are dropped by a rate-limited
sweep, bounding the store in a long-lived process.

## Client-side handle

`useNavigation(name?)` returns the navigation handle for the named
frame, or for the closest ambient frame in the React context (set
by `FrameNameProvider` from `framework/src/lib/frame-client.tsx`,
re-exported through `partial-client.tsx`). Buttons inside a framed
spec naturally drive that frame.

## Frames-tree writes are serialised

Client-side frame state lives on the window navigation entry as one
`state.__frames` tree; every frame nav is a clone-and-patch cycle
(read the entry state, `writeFrameNode` a new snapshot, hand it to
the Navigation API). `updateCurrentEntry` applies synchronously, but
an explicit `history: "push" | "replace"` frame nav bakes its
snapshot into `nav.navigate(...)`, whose entry commits
asynchronously — a second frame's write inside that window would
clone a snapshot missing the pending node, and the last commit would
silently drop the other frame's update.

`runFrameTreeWrite` (`frame-client.tsx`) closes that window with a
write queue: a cycle whose commit is still pending holds the tree,
and every later cycle queues behind it, re-reading the then-current
entry when its turn comes. Uncontended cycles (the common path) run
synchronously. All frames-tree mutations go through it — `navigate`
(both modes), in-state `back`/`forward`, `updateCurrentEntry`, and
`FrameNameProvider`'s seed. Interleavings are pinned by
`framework/src/lib/__tests__/frame-write-race.test.ts`.

## Sharp edges

- **Same-name frames at different depths.** Two `<Frame name="tab">`
  under different ancestors (e.g. `cart.tab` and `menu.tab`) coexist
  because the framework keys every frame by its full dotted path.
- **`initialUrl` as cold-session default.** Once the session has a
  URL for the frame, the prop is ignored; clear the entry with
  `clearSessionFrame(path)` to reset.
