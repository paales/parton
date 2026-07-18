# The delivery plane — deadlines and broadcast as one layer

Follow-on to [`../archive/wake-index.md`](../archive/wake-index.md)
(bumps are delivered, not derived) and
[`../archive/leases.md`](../archive/leases.md) (L1's finding: the expiry
arm is still a pull-model scan). The consolidation claim: a live
connection's driver should drain **one pending set**, and everything
that wakes it is a _delivery_ from an indexed source — never a scan.
Two sources exist today, one delivered and one derived; this note
designs the missing delivery and the fan-out that the same structure
enables.

| Event source            | Today                      | Target                             |
| ----------------------- | -------------------------- | ---------------------------------- |
| Bumps (writes)          | delivered — wake index     | shipped                            |
| Deadlines (`expires()`) | delivered — deadline wheel | shipped (D1)                       |
| Flips / cookies         | session-scoped wakes       | unchanged (already per-connection) |
| Fan-out (N viewers)     | broadcast lanes            | shipped (D2)                       |

## D1 — the deadline wheel · ✅ Landed 2026-07-12

Shipped as designed (details as-built:
[`../internals/streaming.md`](../internals/streaming.md) §How a live
update lands — the expiry arm;
[`../internals/registry-internals.md`](../internals/registry-internals.md)
§The parent→children index). The wheel lives on the route wake
subscription (`segment-relevance.ts`), maintained by the same
pointer-diff sync that registers index entries and closed wholesale
with it; slot firings deliver through the bump path's park gating
(`_deliverToWakeSubscription`) into the one pending set, and the
drain is literally the bump drain — the `expiry` wake kind,
`computeNextExpiresAtDelay`, and the park re-classification walk are
deleted. The parent→children index rides the `_readSnapshotsForRoute`
memo (`_readRouteDescendants`), diffed incrementally per rebuild;
`foldUpdates` and `promoteSnapshotsToCachedOverride` consume it. The
wake-parity oracle now derives the due-boundary set too — coverage
(never under-deliver; extras park/dedup) spans both sources.

**Gate results (same machine, one day):**

- 4K `?chunk=128` cornerIdle **left saturation**: 57–106%
  non-converging → 58.3 / 68.5% across two runs, browser-side
  saturated (~500%) while the server holds headroom; baseline
  (origin view) 50% → **19.5 / 19.9%**; afterClose 0%. Profile
  attribution of the residual busy time: the two scan terms are gone
  (wheel firing 0.2%, subtree filters absent) — what remains is real
  lane production + Flight encode (~31%), the route-map memo rebuild
  (~22% of busy — the known ~9%-of-total class D1 scoped out), and
  the subscription pointer-diff sync (~11%).
- 1440p holds: baseline 3.0 / cornerIdle 2.3 / afterClose 0.1%;
  zero-client floor 0.0%.
- `bench:server --only=soak` gates ok — B/wake ≈ 0 (−40…93 B, gc
  noise), idle 3–4 µs/bump at N≥1000, zero idle renders, zero early
  closes; `--only=pulse` rows equal (p50 ~21/15 ms, 43–50 ticks/s).
- `PARTON_WAKE_PARITY=1 yarn test` fully green (oracle armed across
  both sources); `yarn test:e2e` 185 passed; validate-world / -ws /
  -upgrade ALL GREEN (pulses-advance rides the wheel; eastBurst stop
  clean).

Original design note (kept for the rationale):

**The problem, measured** (L1 gate data, 4K `?chunk=128`, ~540
cadences over an ~8K-snapshot route bucket): `computeNextExpiresAtDelay`
plus park-classification re-walk all snapshots and re-classify
thousands of parked, forever-past-due boundaries per wake (~14% of
busy time); every lane settle/drain pays O(route-bucket) subtree
filters in `foldUpdates` / `promoteSnapshotsToCachedOverride`
(`parentPath.includes` over the whole bucket, ~19%); each commit
invalidates the route-map memo (~9%). Corner saturates in both the
ticker and derivation worlds — the scan shape, not the producer, is
the wall.

**Design.** Per-connection timer wheel, slotted on the existing 25ms
coalescing grid (`EXPIRY_COALESCE_MS`):

- **Maintained at snapshot commit.** When the driver commits a
  render, each snapshot's declared boundary inserts `(slot → id)`
  into the connection's wheel; a re-render moves the id to its new
  slot; drops remove it. No global scan ever recomputes "the next
  deadline" — the wheel's head IS the next deadline, and the wake arm
  is one timer to the head slot.
- **Park-aware by construction** (the wake-index lesson: parking
  gates only the WAKE). A parked id's boundary stays in the wheel but
  its slot firing only records into the pending set — no wake. The
  flip-in that unparks it drains pending, catching the id up in the
  same lane pass. Forever-past-due parked boundaries cost exactly
  nothing: fired once into pending, deduped thereafter.
- **One pending set.** Slot firings push ids into the SAME
  per-connection pending set bump deliveries use; the drain path is
  shared and already proven (escalation, park-checks, coalescing).
  `waitForSegmentWake` keeps exactly three arms: pending-set latch,
  keepalive, degrade.
- **Release discipline**: the wheel dies with the connection
  (session close removes it wholesale); soak B/wake ≈ 0 is the
  regression gate, as ever.

**The parent→children index** rides with D1: route buckets keep
`parentPath` (child → ancestors); settle/drain needs the inverse
(ancestor → descendants) to scope `foldUpdates` /
`promoteSnapshotsToCachedOverride` to the actual subtree instead of
filtering the whole bucket. Maintained at snapshot registration
(same commit hook as the wheel), invalidated by the same diffs.

**Gates**: 4K `?chunk=128` cornerIdle leaves saturation (both scan
terms disappear; target well under a core with headroom attributable
to real lane renders); 1440p and zero-client floors hold; soak/pulse
benches hold; wake-parity oracle green (deliveries must still cover
the retired scan's lane sets — the oracle already encodes coverage,
extend it to expiry-sourced deliveries); validators + e2e.

## D2 — broadcast lanes (multiplayer's read side) · ✅ Landed 2026-07-12

Shipped as designed (details as-built:
[`../internals/streaming.md`](../internals/streaming.md) §How a live
update lands — the "Viewer-independent lanes render once and fan out"
block; the slot store + eligibility classifier live in
`framework/src/lib/broadcast.ts`). The as-built refinements over the
sketch below:

- **The generation IS the recomputed warm fp** — no new fold was
  invented. `_recomputeSubtreeWarmFp` (fp-trailer.ts, the same core the
  trailer's cold→warm heal computes) folds re-read dep values, live
  invalidation timestamps, props, and the descendant contributions;
  the publisher stamps it at publish and every consumer recomputes it
  under its OWN request at consume. Equal folds ⇒ equal bytes — the
  soundness contract fp-skip already stands on — and a newer bump
  moves the fold, so an older slot can never serve past it. Time rides
  separately (`expires()` boundary + a one-drain-window TTL).
- **The per-connection fp-skip verdict moved BEFORE the slot consult**:
  a connection whose mirror holds the generation (inside the
  snapshot's freshness) takes the normal render, whose own verdict
  ships the skip placeholder — deterministic today-parity (pinned by
  the expiry-round test: one body render, the mirror-holding viewer's
  wire carries the placeholder).
- **Cell classification got a real signal**: `_cellBroadcastSafe` —
  process-global persistent storage AND a partition that cannot derive
  from request scope (a partition CALLBACK can bake a session/cookie
  identity into the partition without a tracked read, so only
  absent/fixed partitions classify safe). Ephemeral-storage cells,
  `visible:` gates (all cullable partons — the world), frames, remote
  sources, `fpSkip: false`, and custom dep kinds are ineligible.
- **Single-viewer routes bypass the slot entirely** (`count < 2`) —
  their wire stays byte-identical to the per-connection path, which is
  what keeps the world validators' budgets untouched.
- **Producer bodies** (`markConnectionLive()` mid-render) abandon the
  publish and remember the id per route; every connection renders its
  own producer lane, as today.
- Subscriber enumeration stayed the wake index (the bump's delivery IS
  the fan-out; consumers pull the slot at their own drain); the slot
  refcount handle rides the route wake subscription's lifecycle
  (acquired at drive start, moved at a navigation consume, released
  with `_closeRouteWakeSubscription`).

**Gate results (same machine, one day — dev Flight, node v24,
`bench:server --only=shared`, committed baseline → broadcast):**

| N × M   | renders/tick | cpu/tick          | wall p50          | bytes/tick      |
| ------- | ------------ | ----------------- | ----------------- | --------------- |
| 10 × 1  | 10 → **1**   | 2.2 ms → 1.4 ms   | 1.8 ms → 0.53 ms  | 53 → 52 KiB     |
| 100 × 1 | 100 → **1**  | 11.9 ms → 4.0 ms  | 9.1 ms → 2.2 ms   | 320 → 520 KiB   |
| 500 × 1 | 500 → **1**  | 87.1 ms → 15.4 ms | 59.3 ms → 11.7 ms | 1849 → 1600 KiB |
| 10 × 4  | 40 → **4**   | 7.0 ms → 2.1 ms   | 6.3 ms → 1.5 ms   | 188 → 208 KiB   |
| 100 × 4 | 400 → **4**  | 55.0 ms → 9.0 ms  | 38.5 ms → 6.6 ms  | 1399 → 1275 KiB |
| 500 × 4 | 2000 → **4** | 399 ms → 56.8 ms  | 248 ms → 43.6 ms  | 7436 → 9154 KiB |

Renders/tick is exactly M, independent of N (the gate pins it), with
the delivery gates still holding (every connection settles every wake
round, zero idle renders, zero early closes). CPU and wall collapse
correspondingly — 7×/5.7× at 500×4; the residual per-viewer cost is
framing + mirror bookkeeping (µs/lane 199.5 → 28.4 at 500×4). Bytes
stay O(N×M) BY DESIGN (per-viewer bytes; each wire still carries every
lane) — per-lane bytes sit at ~2.6–5.2 KB in both worlds, with
dev-Flight per-lane variance across N in the baseline and this run
alike. Other categories in family: isolated soak untouched (its
connections never share a route — the `count < 2` bypass), idle
3–22 µs/bump, B/wake ≈ 0; `world-idle-cpu` holds (1440p 2.4/1.8/0.2;
4K `?chunk=128` 22.4/65.4/0 — in the D1-era 19.5–28.9 / 58.3–68.5
family). `PARTON_WAKE_PARITY=1 yarn test` fully green;
`yarn test:e2e` 185 passed; validate-world / -ws / -upgrade ALL GREEN;
the two-browser proof (`website/validate-two-viewers.mjs`, standalone
so validate-world's single-viewer fetch budgets stay honest) ALL
GREEN — both viewers' pulses advance concurrently, scrolling one never
disturbs the other.

Original design sketch (kept for the rationale):

**Prerequisite · ✅ landed 2026-07-12: the `shared` bench category.**
The soak bench prices N connections × N _distinct_ worlds; the
"N viewers, ONE world" number now exists as
`yarn bench:server --only=shared` (bench/README.md §shared): N live
connections in ONE scope bucket on one route (8 live + 2 static
leaves, 1 wrapper), M cells bumped per tick, every bump relevant to
all N. Gated exactly — a tick renders N×M bodies (each bumped leaf
lanes once PER connection), every connection's own wire settles every
wake round, irrelevant bumps render nothing.

**The baseline broadcast must beat** (dev Flight, node v24, from the
committed `bench/results/server-warm-tick.json`):

| N × M   | renders/tick | cpu/tick | wall p50 | bytes/tick |
| ------- | ------------ | -------- | -------- | ---------- |
| 10 × 1  | 10           | 2.2 ms   | 1.8 ms   | 53 KiB     |
| 100 × 1 | 100          | 11.9 ms  | 9.1 ms   | 320 KiB    |
| 500 × 1 | 500          | 87.1 ms  | 59.3 ms  | 1.85 MiB   |
| 10 × 4  | 40           | 7.0 ms   | 6.3 ms   | 188 KiB    |
| 100 × 4 | 400          | 55.0 ms  | 38.5 ms  | 1.4 MiB    |
| 500 × 4 | 2000         | 399.0 ms | 248.3 ms | 7.3 MiB    |

Renders/tick is exactly N×M (the gate pins it); CPU follows roughly
linearly at ~120–200 µs/lane, drifting SUPER-linear at the top cell
(µs/lane 137.6 at 100×4 → 199.5 at 500×4 — allocation/GC pressure at
2000 lanes and 7 MiB per tick). At 500 viewers a 4-cell tick costs a
quarter-second of wall clock per wake round today. Broadcast's win
condition: renders/tick → M (independent of N), leaving per-viewer
marginal cost ≈ framing + bytes.

**Design sketch** (to be firmed against the baseline):

- **Eligibility is the dep record.** A lane is broadcastable iff its
  snapshot's recorded reads contain no per-viewer axis (no
  `session()`, no `cookie()`, no per-connection cell partition). The
  read set already exists per render; eligibility is a derived flag
  on the snapshot, recomputed when deps change. No declaration, no
  heuristic — the read is the proof.
- **Render once, personalize framing.** The first driver to drain an
  eligible id renders and encodes once, publishing the Flight bytes
  into a per-`(id, matchKey, fp)` slot with a generation tied to the
  invalidation ts. Other connections holding the same id pending
  consume the slot instead of rendering — but framing stays
  per-connection (delivery seqs, mux frames, fp-trailer entries wrap
  the shared body). A connection whose cached-override says the
  client already holds the fp still fp-skips as today — broadcast
  only replaces the RENDER, never the per-connection skip decision.
- **Subscriber list is the wake index** — the same
  `(name, constraintsKey)` entry that delivered the bump/deadline
  enumerates the connections to offer the slot to. No second
  registry.
- **Slot lifecycle**: generation-checked (a newer bump invalidates
  the slot), TTL'd to one drain window, dropped on last-subscriber
  exit. Slots hold encoded bytes only — never React state — so
  eviction is always safe (a consumer that misses re-renders; the
  framework bias: over-fetch, never stale).

**Gates**: the `shared` bench scenario shows per-viewer marginal
cost ≈ bytes (renders/tick independent of N for eligible lanes,
against the baseline table above); single-viewer paths byte-identical
(the oracle + validators); a two-browser world demo (the leases
note's multiplayer first slice) as the e2e proof.

## Sequencing

D1 landed first — self-contained, its gate was already red (the
saturated dense corner), and its commit hook (the subscription sync
at snapshot registration) is where D2's eligibility flag and
subscriber enumeration also live. D2 follows on the settled hook
with its bench scenario in hand.
