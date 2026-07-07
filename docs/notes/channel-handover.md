# Handover — the channel work, and finishing W7

Written 2026-07-07. Audience: an agent (or engineer) picking this up cold.
Read this top to bottom before touching anything. The single most
important lesson from this arc is at the end under **Working discipline**:
*verify every "it's done / it's pre-existing" claim yourself against
master — do not trust it.* That habit is what caught the two real bugs
that would otherwise have shipped.

---

## 0. TL;DR — current state

- The **channel** (one persistent client↔server protocol that replaces
  the old per-request GET/POST partial transport) is **built and shipped
  on `master`** through work packages W0–W6 plus fixes. Master is
  `f73da02`, green on all suites.
- **One package is NOT merged: W7 — "retire the partial `_.rsc` GET
  path."** It lives on a worktree branch (see §4). W7 only *deletes the
  now-redundant GET path*; it adds no capability. The channel already
  does everything without it.
- W7 is **~95% done but not mergeable.** Its hard bugs are fixed and
  verified, but it introduced **one confirmed probabilistic regression**:
  `search-heartbeat-keeps-dialog.spec.ts` flakes ~25% on the W7 branch
  and is 6/6 clean on master. That is the blocker. Full repro + diagnosis
  in §5.
- **Recommendation on the table:** either fix that one flake (scoped,
  bisect-first — §5) and land W7, or park W7 indefinitely (master loses
  nothing — the GET path just sits there unused). The user is deciding.

Nothing about W7 is on master. If you do nothing, master is a complete,
green, channel-primary framework that also still contains the old GET
code.

---

## 1. What this project is

`parton` — a React Server Components framework (React 19.3 canary +
`@vitejs/plugin-rsc`, Vite 8/Rolldown). The primitive is
`parton(Render, options)`: server-owned state, Flight as the wire,
independently addressable/cacheable/live-updatable subtrees ("partons")
as the unit. Research project; the bet is *dynamic range* — one
primitive from a lean static storefront to a realtime streaming
dashboard. **Read `CLAUDE.md` at the repo root first** — it is the
authoritative orientation (mental model, spec-authoring rules, working
rules). Then the docs below.

Docs that matter for the channel work:
- `docs/notes/channel-design.md` — the channel's design contract (the
  bet, the invariant, the wire shape, the landing sequence W0→W7, open
  questions). **This is the design source of truth.**
- `docs/internals/channel.md` — the *shipped* channel surface (endpoint,
  envelope, frame kinds, mirror, acks). Present-tense "how it works now."
- `docs/internals/streaming.md` — the segment/lane driver, fp-trailer,
  wake arms.
- `docs/internals/render-pipeline.md`, `docs/reference/partial.md` — the
  parton render pipeline, fp-skip, matchKey/variants.
- `docs/reference/prior-art.md` — positioning (the LiveView section was
  rewritten in W6 around state-authority/degradation/wire-model).

---

## 2. Workspaces (Yarn 4 monorepo)

Cross-package imports go through workspace names (`@parton/<pkg>`), never
relative paths. Workspaces: `["framework","cms","copies","e2e-testing",
"e2e-magento","website","docs"]`.

| Path | Package | Role |
|---|---|---|
| `framework/` | `@parton/framework` | **The runtime.** All channel code lives here. `src/lib/` = partials + client merge + channel; `src/runtime/` = RSC plumbing (context/ALS, session, invalidation); `src/entry/` = rsc/ssr/browser entry factories; `src/test/` = in-process Flight harness. Public barrel `framework/index.ts`. |
| `cms/` | `@parton/cms` | CMS editor UI (three-pane shell). Content store `cms/data/content.json` (committed) + `draft.json` (gitignored). |
| `copies/` | `@parton/copies` | Vendored shadcn UI primitives, `cn` helper. |
| `e2e-testing/` | `@parton/e2e-testing` | **The main example app + Playwright suite (`e2e/`).** Real backends: PokeAPI (Hasura) + GraphCommerce Magento. `src/app/root.tsx` renders ~29 pages in one tree (match gates existence). This is where most channel behavior is exercised. |
| `e2e-magento/` | `@parton/e2e-magento` | Companion origin (canonical port 5181) hosting remote partons at `/__remote/<id>` for cross-origin `<RemoteFrame>` tests. |
| `website/` | `@parton/website` | The Factorio-inspired demo (canonical port 5183): a quadtree tile world, each chunk a parton. Has `validate-world.mjs` — a **standing prod-build gate** (boot wire budgets, catch-up, culling, beacon cadence). Run it after any streaming/channel change. |
| `docs/` | `@parton/docs` | Docs only. |
| `bench/` | (not a workspace) | Server warm-tick + `soak` CPU benchmark. `bench/README.md` is the contract. |

Load-bearing code: `framework/src/`, `cms/src/`, `copies/src/`,
`e2e-testing/src/`. `dist/`, `test-results/`, `scripts/` are ignorable.

---

## 3. How to run things (all from repo root unless noted)

```bash
yarn typecheck          # tsc --noEmit across every workspace
yarn test               # typecheck + node + rsc + rsc-prod (the unit bar)
yarn test:node          # jsdom tier, fast
yarn test:rsc           # in-process Flight (react-server condition)
yarn test:rsc:prod      # production Flight build
yarn test:e2e           # Playwright (auto-starts dev servers — see pitfalls)
yarn build:website && node website/validate-world.mjs   # the world gate (prod build)
yarn bench:server --only=soak --warmup=5 --measure=20    # connection-cost gates
yarn bench:server --only=scaling --warmup=5 --measure=20 # fp-skip scaling gates
```

**Both `yarn test` AND `yarn test:e2e` must be green before anything is
"done."** They cover disjoint suites. The world validator and bench
gates are additional load-bearing checks for channel/streaming changes.

Run a single e2e spec:
`cd e2e-testing && yarn playwright test --workers=1 <spec-substring>`
(add `--repeat-each=N` for flakes).

---

## 4. The channel arc — what shipped, and W7's exact state

The channel replaced five request shapes (nav GETs, `?partials=` refetch
GETs, action POSTs, visibility beacons, the held `?live=1` stream) with:
**upstream** = a coalesced envelope of frames (`visible`/`url`/`ack`/
`telemetry`/`cancel`/`detach`) to `POST /__parton/channel`; **downstream**
= the held segmented/lane stream. The invariant: *the channel carries
freshness, never semantics* — every upstream frame is a statement
replayable on a discrete request, and a dead channel degrades to a
working request/response site.

**Shipped on master (`f73da02`), all green:**
- W0 driver hardening; W0.5 visibility burst-race; W1 envelope + endpoint
  + server-minted connection id; W2 attach-body statement (`POST` with
  `{url,cached,since,visible,applied}`); W3 soak bench; W4 delivery
  seqs + acks + evidenced mirror + backpressure + degrade + reconcile;
  W4.5 wake-arm leak (~0 B/wake); W4.6 acks-as-passengers cadence;
  W5a window nav over the channel (`url` frames, as-of correlation);
  W5b frame nav + producer lanes + `cancel` + action consequence seqs;
  W6 telemetry frames + world warm-projection + prior-art rewrite;
  V1 column-batched visibility; V3 cull-park stale-prime.

**W7 — PARKED, not merged:**
- **Worktree:** `/Users/paulhachmang/Sites/react-cms/.claude/worktrees/agent-a51e173c0e54d07bf`
- **Branch:** `worktree-agent-a51e173c0e54d07bf`, tip `2c581bb`, based on
  master `f73da02` (16 commits). Tree is clean.
- **What it does:** deletes the partial `_.rsc` GET transport. Attach
  moves to `POST /__parton/live` (page URL in the body). Degraded mode
  becomes browser-native document navigation. `?cached=`/`?partials=`/
  `?visible=`/`?__cullFlip`/`__frame`/`__frameUrl` and the guard twins
  retire. Preload rides the channel; pre-attach interactions fold into
  the attach. (`?cached=` survives ONLY on action POSTs — actions stay
  discrete by design.)
- **Commit list** (oldest→newest), grouped:
  - `df7e936` feat: retire the partial `_.rsc` GET — the channel is the transport ← **the big one; also the commit that introduced the frame + heartbeat regressions**
  - `66f7b77` `1fddfd2` `7eaa63b` `4299e17` — attach-intent/forces/docs/e2e-observables (pre-interruption)
  - `f0f620f` feat: mirror slot rule, cookie-change reattach, fire supersession ← *three correctness fixes the retirement surfaced*
  - `e7dd068` fix: **client-reported drops replace the inferred mirror eviction** ← *the keystone fp-skip fix (see §6)*
  - `8cb054c` fix: the descendant fold excludes a nav's force-refetched targets ← *second fp-skip root cause*
  - `160b73a` fix: force-refetch lanes stream progressively when the caller asks ← **prime suspect for the search-heartbeat flake (§5)**
  - `569ac31` `e5ce25a` `1ac4c14` `05fba70` `6822693` — e2e migrations + docs + validator observing the channel
  - `9e13ef7` fix: **frame-nav warm heals join their slot, not the mirror at large** ← *the frames-demo:55 regression fix (§6)*
  - `2c581bb` docs

**W7 verification status (what I personally re-ran, not agent reports):**
- `yarn test` (typecheck + node 315 + rsc 349 + rsc-prod 17): **green.**
- `yarn build:website` + `validate-world.mjs`: **all green.**
- `yarn bench:server --only=soak` and `--only=scaling`: **gates ok.**
- `yarn test:e2e`: **181 passed, 2 failed.** Of the 2:
  `editor-magento-refresh` → census (external Magento backend; 3/3 in
  isolation). `search-heartbeat-keeps-dialog` → **the real blocker (§5).**
- Keystone guardrail: `fingerprint-skip` return-nav segment 52KB vs 304KB
  cold — fp-skip firing correctly.
- `frames-demo-back-and-nested-tab:55` — now passes (was the regression
  fixed by `9e13ef7`).

---

## 5. THE BLOCKER — the search-heartbeat flake (unfixed)

**Spec:** `e2e-testing/e2e/search-heartbeat-keeps-dialog.spec.ts` (one
test, "rapid typing keeps the search dialog alive"). **Untouched by W7**
(same assertions as master), so this is a pure behavioral regression.

**What it asserts:** with the live connection held and the search dialog
open, typing many keystrokes (each flips `?q`, i.e. a rapid sequence of
same-page navigations) must NOT tear the dialog and must produce **zero**
`"Connection closed"` console errors. The abort-on-navigate of the held
stream must be *cooperative* — held until the in-flight segment's
`settled` marker — so the body always closes cleanly.

**Confirmed regression (measured, not assumed):**
- On master `f73da02`: `--repeat-each=6` → **6/6 pass.**
- On the W7 branch: `--repeat-each=8` → **2 failed** (~25%). Also 1/3 in
  a separate isolation run. So W7 introduced a ~25% probabilistic
  teardown during rapid same-page navigation.

**Reproduce:**
```bash
cd /Users/paulhachmang/Sites/react-cms/.claude/worktrees/agent-a51e173c0e54d07bf/e2e-testing
lsof -ti :5347 :5447 | xargs -r kill -9    # clear strays first
yarn playwright test --workers=1 --repeat-each=8 search-heartbeat-keeps-dialog
```

**Diagnosis (hypothesis, NOT yet confirmed by bisect):** W7 reworked
exactly the path this guards. Under rapid typing, many force-refetch
lanes / `url` frames fire and supersede each other on the held stream.
The failure is either a `"Connection closed"` leak (a superseded/aborted
render rejecting already-committed pending references) or the dialog
tearing through its error boundary. Suspects, in order:
1. **`160b73a` (progressive force-refetch lanes)** — it changed force
   lanes to announce their seq early and commit progressively when
   `_channelNavPrefersStreaming`. Progressive commit × rapid supersession
   is the most likely source of a mid-render teardown. **Bisect here
   first.**
2. `f0f620f`'s `liveFireGen` supersession guard and `_channelCookiesChanged`
   reattach (a superseded fire must *drain but not commit*; if a drain/
   abort races the cooperative-settled abort, a "Connection closed" can
   leak).
3. The attach-moved-to-`POST /__parton/live` reattach path interacting
   with per-keystroke navigation.

**Approach for whoever fixes it:**
1. **Bisect the flake across W7's commits** (`df7e936` → `2c581bb`) with a
   high `--repeat-each` (≥8, workers=1) at each point. A ~25% flake needs
   enough iterations to trust a verdict. This pins the culprit commit and
   turns a vague concurrency bug into a targeted one.
2. Fix only that, matching the cooperative-abort invariant (the transport
   holds an abort until the segment's `settled` marker — `splitSegments`
   in `framework/src/lib/fp-trailer-split.ts` and the driver's settle
   emission). No heuristics/timers.
3. **Verify with a high bar:** `--repeat-each=20`+ green on the branch,
   and confirm you didn't regress the keystone (`fingerprint-skip`) or the
   mirror rsc suites (`channel-navigation`, `channel-acks`,
   `connection-visibility`, `frame-toggle-slot`, `frame-nested-create-toggle`).
   Probabilistic bugs demand probabilistic proof.

---

## 6. Key mechanisms you must understand before editing the mirror/nav

The channel's correctness lives in a few tightly-coupled ideas. Getting
these wrong is how the bugs in this arc happened.

**The connection mirror (server's model of what the client holds).**
Two layers on the per-connection `CachedOverride`
(`framework/src/runtime/context.ts`): an **optimistic** layer (promoted
at emit via `promoteSnapshotsToCachedOverride`) over an **acked** layer
(`session.ackedFps`, folded on ack). fp-skip verdicts consult
optimistic-first. On reattach the acked layer resets and the mirror is
re-seeded from the attach manifest only.

**The slot rule.** The client keeps **one content per `(id, matchKey)`
slot** — a fresh commit evicts the slot's prior fps. The server mirror
MUST mirror this exactly, or an A→B→A cycle fp-skips against a slot the
client overwrote → phantom/stale content. Delivery tokens are
`(id, matchKey, fp)` triples; `promoteSlotFpToOverride` evicts a slot's
old fps when a new fp lands. `session.ackedSlots` is the acked layer's
slot bookkeeping.

**Warm-heal fold ordering (the frames-demo:55 fix, `9e13ef7`).** A lane's
fp-trailer emits a warm heal `from→to`. This MUST fold into the mirror
**after** the drain promote establishes the slot for `from`, and `to`
joins that slot (never a slotless `fingerprints.add`). A slotless heal is
stranded/un-evictable → phantom fp-skip. This mirrors the client's
`_applyFpUpdates`. See `promoteFpUpdatesToCachedOverride` + the deferred
`laneHeals` in `segmented-response.ts`.

**Client-reported drops (the keystone fp-skip fix, `e7dd068`).** The
server must NOT *infer* which deliveries the client dropped. Old code
inferred it from `asOf < statedNavSeq`, which cannot distinguish "client
committed then navigated" (HELD) from "client navigated then dropped"
(NOT held) — so it evicted held base content and fp-skip died across
navigation. Fix: the client's rule is
`_channelDeliveryCommittable(asOf) = asOf >= navPoint` (evaluated at
arrival, permanent once committed); when it as-of-drops a delivery it
reports the seq in `AckFrame.dropped: number[]`; the server folds every
acked delivery EXCEPT reported drops. `pruneDeliveriesBeforeNav` and the
`asOf >= statedNavSeq` gate were removed. **Do not reintroduce
inference.**

**As-of correlation.** Every segment/lane carries the upstream envelope
seq it was rendered as-of. The client drops commits whose as-of predates
its own navigation point (the pageUrlKey guard generalized into the
protocol). This is why the client's URL can advance ahead of the stream
safely.

**Connection lifecycle.** Server-minted connection id shipped downstream
as the `conn` marker (`fp-trailer-marker.ts`). Attach = `POST
/__parton/live`. The abort-on-navigate must be cooperative (held until
`settled`). Wake arms in the driver are **disposer-registered listeners
with entry-latches — never `.then` on a promise that outlives one race
iteration** (that was the W4.5 heap-leak class; re-introducing it leaks).

---

## 7. Working discipline & pitfalls (read this — it's where time was lost)

- **VERIFY, don't trust.** Multiple agents in this arc declared W7 "done"
  or a failure "pre-existing" when it wasn't. Two real, mergeable-blocking
  bugs (`frames-demo:55` regression, the `search-heartbeat` flake) were
  caught ONLY by re-running the exact failing spec **on master** and
  comparing. Any "pre-existing/census" claim about an e2e failure: prove
  it by running that spec on `master` (`f73da02`) yourself, with
  `--repeat-each` for flakes. If it's clean on master and flaky on the
  branch, it's yours.
- **Flake census (CLAUDE.md).** These wobble under full-suite load but
  pass in isolation: `defer-concurrent-refetches:76`, `chat-streaming`,
  `cms-edit` (various), `remote-frame-crossorigin` (companion cold-start),
  and external-Magento specs (`editor-magento-refresh`,
  `cart-line-mutations`). Protocol: rerun alone; if it passes in isolation
  AND behaves identically on master, it's census. A NEW failure that
  reproduces in isolation is yours.
- **Worktree e2e ports.** The W7 worktree remaps
  `e2e-testing/playwright.config.ts` `PORT`/`MAGENTO_PORT` to `5347`/`5447`
  (canonical is `5179`/`5181`). That file is `git update-index
  --skip-worktree`'d — it must NOT be committed. If you make a new
  worktree, remap to fresh `53xx/54xx` ports and skip-worktree it, or
  `reuseExistingServer: true` will silently run your specs against another
  checkout's servers.
- **Kill strays before every e2e run:** `lsof -ti :<port> | xargs -r kill
  -9`. Leftover dev servers get silently reused.
- **Never hand-start the e2e dev servers.** Playwright injects env
  (`MAGENTO_REMOTE_ORIGIN` etc.); let `yarn test:e2e` own them.
- **Background parking bug.** The subagents in this arc repeatedly stopped
  when they `await`ed a long background command and "parked" on a
  notification — the run then terminated silently. **Run long commands in
  the foreground** with generous timeouts; finish in one pass.
- **Comments describe the present; no change-narration in source.** Design
  rationale goes in commit messages / `docs/notes`. No heuristics — add
  the real signal.
- **Other worktrees** `agent-a2f8c388…` and `agent-a93af612…` in
  `.claude/worktrees/` predate this arc and are unrelated/ignorable.
- The main checkout has uncommitted `docs/notes/user-ideas.md` and
  `bench/results/server-warm-tick.json` — the user's, leave them.

---

## 8. The decision (for the user / whoever resumes)

W7 adds no capability — it deletes the vestigial GET path. So:

1. **Park it (my recommendation).** Master stays green and complete. Land
   W7 later in a focused session aimed only at the connection-abort flake.
2. **Fix the one flake and land W7.** Scoped work: bisect the flake (§5),
   fix the culprit commit, prove it with high `--repeat-each`, then
   merge. This is the only thing between W7 and done.
3. **Merge with the flake documented.** Not advised — a 25%
   connection-teardown under rapid interaction is a real user-facing bug.

To land W7 once green: from the main checkout,
`git merge --no-ff worktree-agent-a51e173c0e54d07bf`, then remove the
worktree + branch. Re-run `yarn test` + `yarn test:e2e` + the world
validator on the merged master before calling it done.

## 9. Follow-ups unrelated to W7 (untouched, on the backlog)

- **V2** — lane-commit transition batching: the per-frame visibility
  commit dribble on the world page is decode/commit-bound (one lane commit
  per React frame re-measures its subtree). Batch same-arrival non-producer
  lane commits into one transition. See the V1 findings in git log.
- **Multi-instance bus** — a cell write on process A waking a lane on
  process B has no design yet; required for multi-process production.
  Sticky sessions are accepted. This is the big open item for scale.
- **WebTransport** — the designated transport upgrade (Baseline since
  Safari 26.4). Swaps in behind the envelope grammar; needs a Node HTTP/3
  story. Not scheduled.
