# The inverted wake index — bump → dependents

Design note for replacing the pull-model wake filter with a
subscription index: a bump names its selector, so the commit should
deliver the wake to exactly the connections (and the exact parton ids)
that depend on it — instead of waking every parked driver and letting
each re-derive relevance from scratch. Three pressures converge on
this one structure.

## The three pressures

1. **The corner residual.** After the keyed-probe fix
   ([`../internals/registry-internals.md`](../internals/registry-internals.md)),
   one idle client at the world's corner still costs ~12% CPU vs a ~3%
   origin baseline (`bench/results/world-idle-cpu.json`): every bump
   wakes the driver, which rebuilds the route snapshot map
   (`_readSnapshotsForRoute`) and re-arms the wake race — per bump,
   forever, even when nothing is relevant.
2. **The dense-world wall.** `?chunk=128` at 4K (~540 chunks in view,
   ~1,700 ticker writes/s process-wide) saturates a full core with ONE
   client: ~80% of busy self-time is relevance re-evaluation
   (`_queryCompiledMatchingTs` ~42%, `_readSnapshotsForRoute` ~30%).
   Attribution is clean: the write path alone (browser closed, tickers
   still firing) costs ~4–5% — the burn is per-connection filtering of
   mostly-irrelevant bumps. Worse, saturation **starves lane
   production**: scrolling into a new region streams nothing — the
   filter outcompetes the lanes users are waiting for.
3. **Multi-viewer scaling.** The filter runs per connection, so N
   viewers multiply it. And the broadcast direction (render a
   viewer-independent lane once, fan bytes to every subscriber) needs a
   selector → subscribers map anyway. The wake index IS that map.

## As-built (what makes it O(everything))

- The registry (`invalidation-registry.ts`) stores entries per
  `(name, constraintsKey)` — already a keyed map — but its wake side is
  a flat `Set<Waiter>`: `_onNextBump(sinceTs, cb)` registers a bare
  callback, and `commitOne` wakes **all** waiters on **any** bump. The
  bump's selector is not part of the waiter contract.
- The woken driver re-derives relevance per wake
  (`waitForSegmentWake` → `routeHasRelevantBump` →
  `_readSnapshotsForRoute` → per snapshot `surfaceQueryOf` →
  `_queryCompiledMatchingTs`). The keyed probes made the per-snapshot
  check O(probe keys), but the per-wake cost is still O(all route
  snapshots), and wakes are O(all process bumps).
- Net: cost ≈ bumps/s × snapshots × probes, per connection. Every
  factor grows with world exploration; none ever shrinks.

## Design

**Registration is the compiled probe set.** `constraintProbeKeys`
already enumerates, for a snapshot's constraint surface, exactly the
`stableStringify(constraints)` keys under which a matching registry
entry can live (bare `"{}"` included). Those same keys are the
subscription keys: register the snapshot under
`name → constraintsKey → {connection, partonId}` and a commit for
`(name, key)` delivers to precisely the subset-matching dependents —
the probe-key equivalence proven for the query holds unchanged for the
subscription (entryKey ∈ probeKeys(surface) ⇔ the old
`matchesConstraints` walk).

**Subscription lifetime is the connection, not the park.** Re-registering
the full interest set on every park would just move the O(snapshots)
work. Instead each live connection holds one persistent subscription,
diffed when its snapshot set actually changes (a render adding or
dropping partons, labels, or constraint args). The park's wake arm
degenerates to draining a per-connection **pending set** that
`commitOne` pushes matched parton ids into:

- Irrelevant bump → no lookup hit for this connection → the driver
  never wakes. The idle tax goes to zero.
- Relevant bump → `(name, key)` lookup → push the matched ids into the
  connection's pending set, settle its wake arm. The driver lanes
  exactly those ids — `_readSnapshotsForRoute` and the per-wake filter
  leave the hot path entirely.
- Coalescing is intrinsic and better than today: the pending set dedupes
  ids across bumps between wakes, and each lane renders current state.

**Delivery replaces derivation.** Today's wake says "something changed
since ts, go look"; the indexed wake says "these ids changed". The
driver keeps `sinceTs` only as the DEV cross-check during landing (see
below) and for the pending-selector reservation path
(`_routeMatchingSelectorIds`), which stays scan-based — it runs inside
an action transaction against un-flushed selectors, a different, cold
surface.

**Scheduling lesson, kept explicit.** The starvation finding
(bookkeeping outcompeting lanes) is fixed structurally here — filtering
disappears — but the invariant it exposed is worth pinning: a
connection's wake work must be bounded per wake and lane production
must never wait on relevance evaluation. The pending-set drain
satisfies both by construction.

**What this sets up.** The index is the subscriber list the broadcast
primitive needs: a lane whose dep record is viewer-independent can
render once and fan its bytes to every connection subscribed to the
same `(name, key)` — same structure, second consumer. And the future
multi-process bus stays thin: it ships selector bumps between
processes; each process's index stays local.

## Open questions

- **Over-cap surfaces.** Surfaces past `PROBE_SUBSET_CAP` fall back to
  the linear scan in the query; the subscription equivalent is a small
  per-connection scan-set (snapshots that could not be key-registered),
  checked per bump only against those. Expected rare — assert/count in
  DEV.
- **Registry compaction interplay.** Entries and subscriptions share
  the `(name, constraintsKey)` keying, so compaction (one entry per
  pair) needs no change; a subscription outliving its entries is fine
  (lookup miss = no delivery).
- **Memory + release invariant.** The index is bounded by
  Σ per-connection (snapshots × probe keys); it must inherit the
  wake-arm release discipline (the soak bench's B/wake ≈ 0 gate):
  connection close removes the whole subscription, snapshot diffs
  remove per-id keys. `bench:server --only=soak` is the regression
  probe.
- **Time and flips are untouched.** `expires()` deadlines stay timer
  arms; visibility flips and cookie changes stay session-scoped wakes
  (they already never ride the process-global bump path).

## Landing packages

- **W1 — index beside the filter.** ✅ Landed (with W2, one change).
  Gates: all suites green with the parity assert enabled;
  `bench:server --only=soak` idle µs collapsed — N=1000 2502→3.5–22,
  N=5000 19924→16–29 µs/bump (independent of N; B/wake ≈ 0);
  `world-idle-cpu` cornerIdle (512, 1440p) 12.3% → 6% against a 3.9%
  same-run baseline.
- **W2 — delivery is authoritative.** ✅ Landed: the bump path carries
  no per-wake filter and no `_readSnapshotsForRoute` rebuild — the
  drain takes the pending set, escalates against current snapshots,
  and park-checks (the reservation path keeps its scan). The old
  filter survives only as the parity oracle (`_assertWakeParity`,
  opt-in via `PARTON_WAKE_PARITY=1`). Gates:
  `world-idle-cpu --query=chunk=128` at 4K left saturation —
  cornerIdle 99–103% → 10.6%, afterClose ~100% → 10.7%, baseline
  56–67% → 33.8% — and the starvation scenario streams again: one
  viewport east after the origin fill, the new center chunk lands in
  ~8s and the region fills (+137 chunks, quiet ~16s) where before
  nothing ever arrived; pulse rows equal (p50 ~52→~21 ms, 40
  ticks/s); e2e + validate-world/ws/upgrade green (validate-world
  also green with the oracle ARMED). Delivery-time details the design
  left open: parking gates only the WAKE (a parked carrier's delivery
  still records into the pending set — drained park-checked at the
  next real wake), and an assigned consequence seq wakes even parked
  so voiding stays prompt. The oracle's contract is post-park
  COVERAGE, not pre-park equality: a cull-out re-registration shrinks
  an id's labels between delivery and drain (the culled variant drops
  cell labels), so delivery legitimately over-covers the drain-time
  filter — extras park or dedup, never staleness; the armed world run
  is what surfaced this.
- **W3 — broadcast.** ✅ Shipped as delivery-plane D2
  ([`delivery-plane.md`](./delivery-plane.md) §D2): viewer-independent
  lane bytes render once and fan across subscribers; the index's
  delivery is the fan-out, the slot only caches the encode.
