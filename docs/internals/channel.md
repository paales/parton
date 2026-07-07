# The channel — upstream envelopes

The upstream half of the live connection: the client STATES facts
about itself to the server session its held stream opened, as
coalesced envelopes of frames. Visibility flips are the first frame
kind; the grammar is built to grow (url / ack / telemetry are designed
but unshipped — the roadmap and the full design rationale live in
[`../notes/channel-design.md`](../notes/channel-design.md)). The
downstream half — segments, lanes, markers — is
[`streaming.md`](./streaming.md).

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
   minted mid-connection fails the check until the heartbeat's next
   fire rebinds; the transport's 404 fallback covers the gap.

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
- `?since=` catch-up path — immediately after the `lanes` marker, as
  the region's first framed entry.

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
  semantics through the envelope, against a real drive).
- node tier: `channel-client.test.ts` (coalescing, seq, serialization,
  the fallback signal, pagehide detach).
- The live-drive harness (`framework/src/test/live-drive.tsx`) reads
  the minted id off its own wire (`DriveHandle.connectionId`) — the
  emission-point proof rides every drive-based test.
