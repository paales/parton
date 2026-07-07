# The channel — the attach + upstream envelopes

The client-states-facts half of the live connection. Two request
shapes carry the statements: the ATTACH — the heartbeat's live fire
as a POST whose body is the full client statement, answered by the
held segmented stream — and the coalesced envelopes of frames a page
POSTs to the session that stream opened. Visibility flips are the
first frame kind; the grammar is built to grow (url / ack / telemetry
are designed but unshipped — the roadmap and the full design
rationale live in
[`../notes/channel-design.md`](../notes/channel-design.md)). The
downstream half — segments, lanes, markers — is
[`streaming.md`](./streaming.md).

## The attach — the connection's opening statement

Opening the channel IS a discrete request: the heartbeat's live fire
is a POST to the page's own `_.rsc` URL, marked by an explicit
request header and carrying the client statement as its JSON body
(`AttachStatement` in `framework/src/lib/channel-protocol.ts`):

```
POST /<page>_.rsc?live=1&streaming=1
x-parton-attach: 1

{ "cached": [...], "since": {"epoch","ts"} | null, "visible": [...] | null }
```

- `cached` — the manifest: the client's `id:matchKey:fp` tokens,
  stating WHAT it holds. UNCAPPED — the body has no request line to
  protect, so the 96-entry `CACHED_MANIFEST_CAP` and the parked-id
  priority walk apply only to the `?cached=` URL form, which survives
  unchanged for every discrete request (targeted refetches,
  navigations, preloads, action POSTs). The body manifest is
  structurally bounded by the client pool itself — at most
  `CLIENT_POOL_CAP` ids, each variant capped at `FP_CAP_PER_VARIANT`
  fps (`getAllCachedPartialTokens` in `partial-client-state.ts`).
  `PartialRoot` and the catch-up override install read the statement
  where a discrete request's read the URL param; verdicts are
  transport-identical.
- `since` — the catch-up anchor, stating WHEN the client last heard:
  the document's registry anchor, take-once. The honor checks are
  unchanged (a live subscription, the epoch names the CURRENT
  registry timeline, the route still has snapshots): honored, the
  driver skips the whole-route initial segment and opens straight
  into lanes; refused, it falls through to the full render —
  over-fetch, never stale. The anchor rides ONLY the attach body; no
  `?since=` URL form exists.
- `visible` — the viewport seed, stating what the client SEES.
  `null` is the unmeasured state (no statement); `[]` is a
  measurement. The `?visible=` URL param survives as the no-session
  fallback carrier (`readVisible`'s discrete cull-in reloads).

Dispatch is by explicit marker, never body shape: `parseRenderRequest`
keys an `_.rsc` POST on `x-parton-attach` (the attach — the full
segmented drive + fp-trailer path, exactly a live GET's) vs
`x-rsc-action` (an action — one commit-only segment). An action POST
whose body happens to be statement-shaped stays an action and never
opens a drive; an attach never decodes as an action; a POST claiming
both markers is ill-formed. A malformed statement answers `400`. The
statement lands on the request store (`applyAttachStatement` — the
seam the entry and the in-process live-drive harness share) before
any render runs, and unknown statement fields are IGNORED — the
statement grows by adding fields (the ack watermark seeds here in the
ack package).

The attach is also the CREDENTIAL REBIND point: every attach binds
its OWN request's scope + session identity into the connection
session (`openLiveConnectionSession`), so a session cookie minted
mid-connection — which 404s envelopes for the rest of that
connection — starts working the moment the next attach presents it.

## Wire shape

One fire-and-forget POST per coalesced batch:

```
POST /__parton/channel
{ connection: string, seq: number, frames: Frame[] }
```

- `connection` — the SERVER-MINTED id of the live connection this
  envelope addresses (see §The id handshake). Never inferred, never a
  URL param.
- `seq` — per-connection monotonic, minted by the client transport,
  restarting at each establishment. The session applies a `visible`
  frame's snapshot only from envelopes at or past the last applied
  seq (`>=`, so a later frame in the SAME envelope stands), so a
  stale envelope can't regress newer state; per-id flip statements
  order by seq independently (a stale envelope's flips still queue —
  statement semantics in [`streaming.md`](./streaming.md) §Visibility
  rides the connection).
- `frames` — ordered within the envelope. A discriminated union on
  `kind`; UNKNOWN kinds are SKIPPED, never errors (the same
  extensibility rule the downstream marker grammar follows), while a
  malformed KNOWN kind is a protocol violation (`400`).

Frame kinds shipped:

| Kind | Carries | Server effect |
|---|---|---|
| `visible` | `{changed, visible, cached?}` — the visibility statement: flipped ids, the wholesale snapshot, the client's actual holdings for the changed ids | Applied to the connection session; flipped-IN partons lane on the EXISTING stream (never on this response) |
| `detach` | nothing | Explicit close: the parked driver wakes, the drive loop exits, the session closes. Best-effort by nature (sent on `pagehide` via keepalive fetch); the keepalive timeout remains the backstop |

Responses carry no body: `204` applied; `400` malformed; `403`
cross-site; `404` connection gone — see §Security. The envelope is
**loss-tolerant by design**: no retransmit buffer, no delivery acks.
Only frame kinds whose statements are re-established by the next
heartbeat fire's seed may ride the channel today; the reliable class
(`url`, `ack`) waits on the ack machinery (design note § Wire shape).

Shared grammar + decoder: `framework/src/lib/channel-protocol.ts`
(import-safe on both sides).

## The endpoint runs in a request scope

`createRscHandler` dispatches `POST /__parton/channel` before app
routing — but INSIDE `runWithRequestAsync`. No render runs; the point
is the scope: the test scope resolves through the ALS
(`getScope()`), cookies parse through the same context every render
uses, and the response is the ONE place a channel interaction can
mint Set-Cookie (the held stream's headers are long gone by the time
a frame arrives — the entry appends the scope's accumulated cookies
to this response). Endpoint body: `handleChannelPost` in
`framework/src/lib/connection-session.ts`.

## Security

Three checks gate every envelope, in order:

1. **Same-origin provenance** (`403`). A present `Sec-Fetch-Site`
   must testify `same-origin` (or `none`); a present `Origin` must
   equal the request's own. The JSON content-type is not a defense —
   cross-site pages can POST JSON with credentials. Requests carrying
   neither header (non-browser clients, the in-process harness) pass:
   the cookie binding below is the credential check; this check only
   stops cross-site pages from riding a victim's cookies.
2. **Scope binding** (`404`). The session records the attach's scope;
   the envelope's resolved scope must match. Isolation is the
   globally-unique connection id — the scope check is an ASSERT,
   never a lookup key, so a scope can never be used to reach another
   scope's session. (e2e workers stamp `x-test-scope` on the whole
   browser context, so beacons carry the same scope the attach did.)
3. **Cookie binding** (`404`). The session records the attach's
   session identity (`getSessionId() ?? ""`); every envelope must
   present the same one — beacons carry cookies anyway. Anonymous
   pages bind the empty identity and keep working. A session cookie
   minted mid-connection fails the check until the next attach
   rebinds (§The attach); the transport's 404 fallback covers the
   gap.

Binding mismatches answer `404` — byte-identical to "connection
gone" — so a hostile beacon can't distinguish wrong-creds from gone.

## The id handshake

The connection id is SERVER-minted: the segment driver creates it at
session open (a client-chosen id would invite fixation and leak the
addressable token into access logs) and ships it downstream ONCE per
connection as a `conn` entry in the `\xFF` marker grammar
([`fp-trailer-marker.ts`](../../framework/src/lib/fp-trailer-marker.ts)):

- full path — ahead of the first segment's Flight rows (entries
  interleave; the body keeps flowing);
- catch-up path (an honored attach anchor) — immediately after the
  `lanes` marker, as the region's first framed entry.

Receiving the entry IS establishment: the driver only mints ids for
sessions it has opened, so the client can address the session the
moment the handshake arrives — while the first whole-tree render is
still draining. The splitter surfaces entries progressively
(`splitSegments`' `onEntry`) precisely so this handshake doesn't wait
for the segment's trailer map to resolve at settle; the browser entry
feeds every wire entry to `_channelWireEntry`
(`channel-client.ts`), which establishes on `conn`. The id never
appears in the DOM — `data-parton-live` is presence-only — and never
in a URL.

## ChannelClient — the transport

`framework/src/lib/channel-client.ts` owns everything between a
producer's statement and the envelope on the wire:

- **Producers.** A producer registers once
  (`registerChannelProducer`) and is consulted per flush:
  `collect(connection)` contributes at most one frame; `collect(null)`
  (no connection established) is the cue to deliver via the
  producer's own discrete fallback. `deliveryFailed(frame)` hands a
  frame back when its envelope didn't land — the transport has
  already cleared the published id, so the re-owned statements (and
  everything after them, until the heartbeat re-establishes) ride the
  fallback. The visibility controller (`visibility.tsx`) is the first
  producer; its reload-fallback semantics are unchanged behind this
  seam.
- **Coalescing + serialization.** Flushes coalesce per animation
  frame and serialize — one envelope in flight; a flush requested
  mid-flight re-fires when it lands.
- **Lifecycle.** Establishment (from the wire handshake) restarts the
  per-connection seq, sets `data-parton-live`, and notifies
  establishment listeners (the visibility controller arms its
  full-set first-measurement sync there). The heartbeat calls
  `_channelConnectionClosed()` when its fire settles.
- **Detach.** `pagehide` sends a final `detach` frame via keepalive
  fetch and clears the id (a bfcache restore re-establishes via the
  next heartbeat fire).

## Testing

- rsc tier: `channel-endpoint.rsc.test.tsx` (decode, HTTP mapping,
  origin/scope/cookie checks, unknown-kind skip, in-envelope frame
  ordering, the mint handshake, detach ending a held drive),
  `connection-visibility.rsc.test.tsx` (visibility statement
  semantics through the envelope, against a real drive),
  `live-catchup.rsc.test.tsx` (the attach statement: anchor catch-up,
  attach-only anchor, body-manifest/URL-manifest verdict equivalence,
  the uncapped body manifest), `attach-rebind.rsc.test.tsx` (the
  mid-connection-login → reattach → beacons-work-again flow).
- node tier: `channel-client.test.ts` (coalescing, seq, serialization,
  the fallback signal, pagehide detach), `attach-dispatch.test.ts`
  (statement decoder grammar; attach/action marker dispatch),
  `refetch-attach.test.ts` (the manifest cap split by transport).
- The live-drive harness (`framework/src/test/live-drive.tsx`) reads
  the minted id off its own wire (`DriveHandle.connectionId`) — the
  emission-point proof rides every drive-based test — and drives
  attaches through the entry's own statement seam
  (`LiveDriveInit.attach`).
