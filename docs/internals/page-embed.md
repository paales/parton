# Page embed — the slice pipeline

How `<RemoteFrame>` turns an ordinary page response into a spliceable
subtree. The author-facing contract is
[`../reference/remote-frame.md`](../reference/remote-frame.md); this
page is the mechanism. Code: `framework/src/lib/page-embed.ts` (wire
protocol + rewriter + identity helpers), `lib/remote-frame.tsx` (the
consumer), the embed branches in `lib/partial.tsx` (`PartialRoot`,
the id mint, `partialFromSnapshot`) and `entry/rsc.tsx`
(`handleEmbedRender`), `lib/snapshot-trailer.ts` (the registration
payload).

## The request — explicit headers, an ordinary URL

An embed fetch targets the page URL with three headers; nothing is
ever inferred from URL shape:

| Header                 | Value           | Meaning                                                                                                                                                                                                         |
| ---------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x-parton-render`      | `1`             | Return Flight, not an HTML document. `parseRenderRequest` classifies a GET carrying it as an RSC render, so the URL stays the page URL — match gates, tracked reads, and route keying evaluate the page itself. |
| `x-parton-embed-depth` | `hostDepth + 1` | This render is an embed at depth N. `PartialRoot` branches on it; the recursion guard counts with it.                                                                                                           |
| `x-parton-embed-ns`    | `e~<hash>`      | The placement namespace the producer folds into every effective parton id it mints (see Identity below).                                                                                                        |

Plus `x-parton-capability` when the call site declares one, and the
test harness's `x-test-scope` forward. `credentials: "omit"` always.
All `x-parton-*` headers are stripped from the vary-facing header
surface, so app code (and `headers` match gates) never see them.

## The producer

`handleEmbedRender` in `entry/rsc.tsx` answers every header-marked
Flight GET. Two shapes, one response contract:

- **Whole page** — the ordinary `<Root/>` render. `PartialRoot` sees
  `embedDepthOf(headers) > 0` and, after entering the request
  registry + partial state as usual, returns the app tree wrapped in
  the slice-marker element instead of the page shell:

  ```
  ["$","parton-embed-body",null,{"children": …app tree…}]
  ```

  The marker is the wire signal the consumer slices on — the producer
  writes it; nothing is guessed from page structure. It never reaches
  a DOM.

- **Focused** (`?partials=<id>[,<id>…]` present on an embed-flagged
  request — the refetch protocol): the entry enters its own registry
  context on the page's routeKey (`computeRouteKey` keys on the URL
  base, so the transport param can't shift the bucket; `partials` is
  also in match's `TRANSPORT_PARAMS`), looks each id up with
  `lookupPartial`, and renders `partialFromSnapshot(id, snap)` per
  target inside a lane-shaped partial state (`isPartialRefetch`,
  `explicitIds`) — the exact isolated-render path a local forced lane
  takes. Any registry miss falls back to the whole page (over-fetch,
  never fail).

Both shapes decode the capability header into `getCapability()`
scope (`runWithCapability` around the stream build), and both wrap
the stream as:

```
renderToReadableStream({ root })
  → wrapStreamWithCommitOnly        (defers drained, registry commit)
  → wrapStreamWithSnapshotTrailer   (the `snapshots` entry)
```

The inner flush drains the commit-defer list first, so a NESTED
embed's trailer registrations land before the outer flush reads the
snapshot set. The snapshots getter never reads ALS-at-flush (fragile
across stream runtimes — the same reason the fp-trailer captures
scope + routeKey at wrap time): the focused path captures its own
registry ctx (`pendingWrites`); the whole-page path reads
`_readSnapshotsForRoute(scope, routeKey)` — fully populated by the
render's eager-publish + commit — **filtered to the inbound
namespace**. The committed route set is a union across placements
(same-origin embeds share the process store), and a foreign
placement's id shipped here would get re-stamped with this
placement's namespace on the host; its next refetch would then
replay the wrong namespace into the producer and mint a
double-prefixed id the host's template can never match. Every id
this render minted carries the inbound namespace, so the prefix IS
the filter.

## The trailer

`\xFF[parton:snapshots:N]\n` + N bytes of UTF-8 JSON
`{id → SerializedSnapshot}` — the same `buildMarker` grammar as the
fp/url/settled entries, so the consumer reads it off `splitSegments`'
trailer map with no dedicated splitter. Serialization drops
`fallback` (JSX), `cache` (producer-side decision), and `source`
(each hop re-stamps with ITS fetch URL — exactly the hop a refetch
must retrace).

## The consumer

`RemoteFrame` resolves the URL, mints the placement namespace, and
`embedPage` fetches. The response is segmented Flight (the same wire
the browser client reads); the consumer takes the FIRST segment only
and cancels the iterator after its trailers resolve — an embedded
page holding a live connection would otherwise park it open.

Trailer handling registers each snapshot into the HOST's request
registry — labels prefixed with the human `namespace` when given, and
`source: {kind: "page", url, ns, namespace?, capability?}` stamped —
under `deferCommitUntil`, so the host's stream wrappers hold commit
until registration lands (route-hint writes visible before the
response goes out; selector refetch never hits a registry miss).
The source stamp is part of the registry's VARIANT KEY
(`variantKeyOf` in partial-registry.ts): same-origin, host and
producer share one canonical store, and both register the SAME id
with the same parent path — the sourced variant stores beside the
producer's local one instead of clobbering it, so the producer's
focused `?partials=` lookup keeps resolving its own local snapshot
(a sourced snapshot there would recurse the embed into itself until
the depth cap).

The body streams through `pageEmbedRewriter`, a row-local
`RowRewriter` on `rewriteFlightStream`:

| Row / element           | Action                      | Why                                                                                                                                            |
| ----------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `parton-embed-body`     | unwrap → children           | The slice marker.                                                                                                                              |
| `html`, `body`          | unwrap → children           | React 19 document singletons — rendered anywhere they attach to the host DOCUMENT; an embedded `<body className>` would restyle the host page. |
| `head`                  | drop                        | The embedded document head, wholesale.                                                                                                         |
| `title`, `meta`, `link` | drop                        | Hoistables — React hoists them into the head from anywhere; embedded metadata must not hijack the host's head.                                 |
| `:H<code>` hint rows    | drop                        | Wire-level preload/preinit directives aimed at the document head.                                                                              |
| everything else         | pass through byte-identical | Content rows, `I` imports, Suspense refs, symbol rows — within-embed Suspense pacing survives.                                                 |

The classification mirrors react-dom's own singleton + hoistable
sets — an element typed `head` in a Flight row IS the document head.
The transform is row-local (no cross-row graph walk, no buffering):
the reference graph stays intact and rows orphaned by a drop (the
head's outlined content) are simply never reached by the host's
re-encode. Unwrap with outlined props (dedup) drops the element —
the safe direction for a singleton.

The payload's root row is the entry contract `{root, …}`; the
consumer decodes and returns `.root`. Cross-origin, the pipeline
composes `moduleRefRewriter` after the slice (same-origin skips it —
origin equality, not URL shape).

## Recursion — a marker, never a throw

Each hop writes `hostDepth + 1`; at depth > `MAX_EMBED_DEPTH` (3) the
frame renders `<div hidden data-parton-embed-limit="<url>">` instead
of fetching. A thrown rejection's containment is timing-dependent: an
encoder reaching the embedded lazy while pending outlines it to its
own row (deep containment), but an already-rejected lazy throws
synchronously into the enclosing task row and surfaces at the nearest
OUTER boundary — on a warm self-embed that replaced the whole page.
Position-stable termination requires a value.

## Identity — the placement namespace

`embedNamespaceFor` hashes `[hostNs, hostParentPath, urlKey,
occurrence]`:

- `hostNs` — the host render's own inbound `x-parton-embed-ns`
  (`null` on an ordinary render). This is what separates the LEVELS
  of a self-embedding page, whose frames sit at the same tree
  position on every level.
- `hostParentPath` — the ambient parton path
  (`getServerContext(ParentContext)`), unique per placement under
  distinct partons.
- `urlKey` — origin + pathname (no search: a `?step=` frame-driven
  embed keeps one identity).
- `occurrence` — a per-request counter on the partial state
  (`embedSeq`), keyed by parent-path + urlKey, separating same-URL
  siblings in tree order (deterministic across renders of the same
  page).

The producer applies it at the single id-mint choke point in
`createSpecComponent`: after `effectiveIdForInstance`, an embed
render prefixes the id (`applyEmbedNamespace` — idempotent, so a
focused refetch's `__instanceId` ids, already prefixed, pass through
while the descendants it spawns mint bare ids that gain the prefix).
The prefixed id flows everywhere ids flow: the boundary's client
props, placeholders, wire tokens, both registries, the trailer.
`deriveMatchKey`'s ancestor walk strips the namespace
(`stripEmbedNamespace`) before catalog lookups — the catalog is
keyed by bare spec ids. The `~` in the grammar is framework-reserved,
which is what makes both the idempotence check and the strip a
protocol signal rather than a guess.

Labels are deliberately NOT placement-prefixed (class-level fan-out;
producer invalidation selectors must keep matching). The human
`namespace` prefix on labels is applied host-side at trailer
registration.

## Refetch routing

`partialFromSnapshot` on a `source.kind === "page"` snapshot returns
`_pageEmbedRefetch(id, source)` — a focused re-embed of
`source.url + ?partials=<id>` with the STORED `ns` (never re-derived:
the refetch runs outside the placement's tree position) and stored
capability, at `embedDepthOf(current) + 1`. Host lanes, broadcast
probes, and the entry's own focused path all route through
`partialFromSnapshot`, so every refetch consumer gets embed routing
for free. Same-origin, this means producer-side invalidations
(shared process registry) lane focused re-embeds onto held host
connections with zero extra machinery.

## Isolation

The embedded render runs in its own request scope (`fetch` →
`runWithRequestAsync` server-side): `getRequest()` inside the
embedded page sees the embedded URL, nested cleanly inside the
host's in-flight ALS context — no scope bleed either direction
(covered by `page-embed.rsc.test.tsx`, whose fetch stub renders the
requested page through the same harness in-process — genuine
self-embedding). Session/cookies never cross (`credentials: "omit"`);
the capability header is the one explicit channel.

## Test-harness note

The bare vitest rsc worker has no client-module loader, so a decoded
client-reference lazy can never resolve through the vendored Flight
runtime. `page-embed.rsc.test.tsx`'s producer stub therefore rewrites
`I` rows to a literal `"client-ref"` element type before the host
consumes them — decode→re-encode works, `partialId` props survive
verbatim for wire assertions. Production embeds resolve refs through
the real plugin runtime; the shim exists only below the app-runtime
line.
