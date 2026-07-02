# Per-parton subtree settlement — the task-done moment in Flight

**The research question:** is there a moment in React's Flight server where
we KNOW a task is done, so a parton's trailer entry can be emitted the moment
ITS subtree settles instead of waiting for the whole request?

**The answer: yes.** Every Flight task has a definitive terminal transition,
in both builds, and — because the server-context patch already outlines every
parton's `ParentContext` provider into a dedicated task — every fully-rendered
parton has a task subgraph whose completion is observable. The shipped
mechanism is a per-parton refcount (`SettleScope`) maintained by the vendored
Flight-server patch; the framework exposes it as
`_onPartonSettled(cb)` (`framework/src/lib/server-context.ts`). Proven against
BOTH builds by `task-settle.rsc.test.tsx` / `task-settle.rsc-prod.test.tsx`
(shared bodies in `task-settle-scenarios.tsx`).

## 1. The task lifecycle in the vendored Flight server

Files: `@vitejs/plugin-rsc`'s
`dist/vendor/react-server-dom/cjs/react-server-dom-webpack-server.edge.{development,production}.js`
(v0.5.24, as installed with the patch applied — line numbers below are
orientation only, the function names are the stable citation). Task `status`
codes: `0` pending/suspended, `1` COMPLETED, `3` ABORTED/HALTED, `4` ERRORED,
`5` RENDERING.

**Birth — `createTask` (prod ~1273, dev ~1976).** The single constructor for
every task: the request's root task (`RequestInstance` constructor), a
provider marker's outlined subtree, `serializeThenable` (every promise in a
model, async components included), `serializeReadableStream` /
`serializeAsyncIterable` / `serializeBlob`, `outlineModel…`, and the
suspend-and-retry path in `renderModel`'s catch. Every call site passes
`request.abortableTasks` as the abort set; `createTask` ends with
`abortSet.add(task)`. So `createTask` is the one choke point where a unit of
future model work is announced.

**Terminal transitions — the complete set.** A task is definitively done at
exactly one of:

1. **`retryTask` success** — after `emitChunk`/`emitModelChunk`:
   `task.status = 1; request.abortableTasks.delete(task);
   callOnAllReadyIfReady(request)` (prod ~1944, dev ~3540). This is THE
   instruction for the common case. Crucially, `emitChunk` (which runs the
   `stringify(model, task.toJSON)` serialization pass, and may synchronously
   `createTask` children for suspended/outlined values) completes BEFORE the
   status flips — children are announced before the parent retires.
2. **`erroredTask`** — `task.status = 4; emitErrorChunk(…);
   abortableTasks.delete(task)` (prod ~1912, dev ~3497). Reached from
   `retryTask`'s catch (non-thenable throw), rejected thenables
   (`serializeThenable`'s `.then` reject arm), and stream/iterator/blob error
   arms.
3. **`abortTask` / `haltTask`** — `0 === task.status && (task.status = 3)`
   (prod ~2009/2018, dev ~3609/3620). Reached from the request-level
   `abort()` sweep (`abortableTasks.forEach(abortTask)` — note: the sweep
   does NOT `.delete()` per task, so the delete call is not a usable
   done-signal), and from `retryTask`'s catch when
   `request.status === ABORTING (12)`.
4. **Stream done-sites** — `serializeReadableStream.progress` and
   `serializeAsyncIterable.progress` on `entry.done` set
   `streamTask.status = 1` DIRECTLY (prod ~941/1009, dev ~1291/1367),
   bypassing `retryTask` entirely. Any hook that only instruments
   `retryTask` misses streams.

Suspension is NOT terminal: `retryTask`'s catch on a thenable sets
`task.status = 0` and re-pings — the task stays in `abortableTasks` and will
retry. One transient wrinkle: `toJSON`'s catch under an aborting request
assigns `task.status = 3` directly, then serialization continues and
`retryTask` still flips the same task to `1` — a per-task latch
(`task.settleDone`) makes the decrement idempotent across that path.

**Request close** — `callOnAllReadyIfReady` fires `onAllReady` when
`abortableTasks.size === 0`; `flushCompletedChunks` closes the destination at
`pendingChunks === 0`. That's the whole-request "done" — what the fp-trailer's
`TransformStream.flush` observes today. The per-task moments above are strictly
earlier and strictly finer.

**Dev vs prod.** The transitions are the same shape but live in separately
minified code with different formatting, extra debug bookkeeping
(`markOperationEndTime`, `forwardDebugInfoFromAbortedTask`), and extra
`createTask` debug args; scheduling also differs (dev interleaves debug-chunk
work). Each patched site therefore has its own anchor per build, and the
`rsc-prod` test tier exists to catch a prod-only divergence.

## 2. Why every parton already has a hookable task

The server-context patch outlines every `PARTON_CTX` provider marker into its
own task (`renderModelDestructive` marker branch → `createTask` + `pingTask` +
`$L` ref — see `docs/internals/server-context.md`). Since every fully-rendered
parton returns `<ParentContext value={childCtx}>…</ParentContext>`
(`partial.tsx`), every such parton owns a dedicated task whose model is its
entire rendered subtree.

The subtlety that makes own-task-completion insufficient: a task's completion
means its MODEL serialized — but any promise, suspended child, stream, or
nested provider in that model was outlined into a separate task (`$L` ref)
that completes later. A parton whose `Render` is async has its body behind a
`serializeThenable` task; a nested parton is behind its own marker task.
"Parton subtree settled" therefore needs subtree tracking across the whole
task subgraph, not one task's status. (The nesting test asserts exactly this:
the parent's own model serializes immediately, yet its settle waits for the
nested child's loader.)

## 3. The refcount design

A **settle scope** is a framework-created object
`{ parent, pending, settled, onSettled }` (`SettleScope` in
`server-context.ts`). It rides the SAME per-render ALS frames the context map
rides — `frame.settle`, snapshotted onto tasks as `task.settleScope` in
`createTask`, re-entered by `retryTask`, inherited by the render site's fresh
frames, and re-seeded through the provider marker (`_scope`) exactly like
`_ctx`. A provider without `_scope` (user contexts, `<Frame>`) passes the
ambient scope through, so the chain never breaks at intermediate providers.

**Counting model: per ALL enclosing scopes,** not nearest-scope with drain
propagation. `createTask` walks `task.settleScope.parent…` incrementing every
scope's `pending`; each terminal transition walks the same chain decrementing
(`__partonSettleUp` / `__partonSettleDown` in the patch). A scope whose count
crosses zero latches `settled` and fires `onSettled` once. Chosen over
nearest-scope + propagate-on-drain because it needs no inter-scope completion
protocol — a drained child doesn't have to know whether its parent still has
own-tasks in flight, since the parent's counter already includes everything.
Cost is O(parton nesting depth) per task instead of O(1); nesting depth in
practice is 2–5, and the ops are integer increments. If the warm-tick bench
ever shows this walk, nearest-scope propagation is the known optimization.

**Why zero can't be transient.** A task only creates child tasks
synchronously during its own render/serialize pass, which strictly precedes
its terminal transition (`emitChunk` before `status = 1`; a stream's per-entry
`tryStreamTask` while the stream task is still pending). And a scope's first
increment — its parton's marker task — happens inside the parent task's
serialization, before any decrement can exist. So `pending` is strictly
positive from marker creation until the true last decrement: zero ⇒ settled,
no resurrection.

**"Own-task-complete + counter-at-zero" is folded into one condition** by
counting the marker task itself in its own scope: zero implies the marker
completed.

**Callback dispatch** (`_onPartonSettled`): registrations attach to the
NEAREST enclosing parton's scope via the rendering frame (so plain server
components under a parton can register too). The patch calls `onSettled`
synchronously at the zero-crossing — inside `retryTask` / the abort sweep — so
the framework defers each callback with `queueMicrotask`, keeping consumer
code (and its throws) out of the Flight scheduler's stack. Registration after
settlement fires on the next microtask.

### Edge cases (discovered + tested, or documented)

- **Error path** (tested): a rejected descendant hits `erroredTask` →
  decrement → the parton settles. Settlement means "no more work", not
  "success"; consumers that care can carry their own success flag.
- **Abort path** (tested): `abort()`'s sweep calls `abortTask` per pending
  task (status 0→3) → decrements cascade → every open scope settles exactly
  once. The mid-render aborting path (`retryTask` catch → delete + status 0 →
  `abortTask`/`haltTask`) funnels into the same two functions.
- **Double-decrement hazards**: the `toJSON` transient `status = 3`-then-`1`
  under abort, and delete-then-abortTask sequences — all made idempotent by
  the per-task `settleDone` latch; the per-scope `settled` latch guarantees
  exactly-once firing (both asserted by the error/abort tests' exact-count
  checks after a grace delay).
- **No marker, no settlement**: a parton that throws before returning its
  tree, or takes the fp-skip / defer early-return paths (which don't render
  `ParentContext`), never attaches its scope to a task — the callback is
  dropped with the scope. Registration only happens inside `Render`, which
  only runs on the full path, so in practice this is the thrown-mid-render
  case. Consumers get "settled ⇔ a full render's subtree finished".
- **Cache-isolated subtrees**: a `<Cache>` hole renders in its own isolated
  render (its own Flight request) — those tasks belong to that render's task
  graph, not the outer request's. The outer parton settles when its own
  stream's tasks settle (the hole splice is a stream-level concern). Fine for
  trailer emission (the trailer describes the outer stream); revisit if a
  consumer needs "hole content settled".
- **Fire-and-forget async work** inside a component (not awaited, not in the
  model) is invisible to Flight and to the refcount — by design, matching
  what "the stream is done" means today.

## 4. What this unlocks

### (a) Per-parton trailer emission at settle time

Today `fp-trailer.ts` recomputes at whole-stream flush: the
`TransformStream.flush` callback drains deferred registry writes, commits,
re-reads ALL route snapshots, precomputes descendant folds for the whole map,
and diffs every emitted fp (`computeFpUpdates`). Correct, but monolithic: the
slowest parton gates every entry, and per-tick the whole route is recomputed.

The incremental shape (sketch — deliberately not built here):

- during a parton's render, the framework registers
  `_onPartonSettled(emitEntryFor(id))` alongside today's snapshot
  registration;
- at settle, that parton's snapshot is final AND its descendants' snapshots
  are final (settlement is subtree-inclusive — exactly what the descendant
  fold needs), so its warm fp can be recomputed from the committed snapshot
  subtree and a `TAG_FP_UPDATES` entry with just `{ [id]: {from, to} }`
  emitted immediately onto the trailer channel;
- the flush-time pass shrinks to a safety net for anything that never settled
  (aborted renders) — or disappears once every consumer reads incremental
  entries. The client already merges fp updates additively, so many small
  trailer entries are protocol-compatible with today's one big one.

Two knots to untangle before building it: the registry commit currently
happens once at flush (per-parton emission needs the snapshot subtree readable
at settle time — either read pendingWrites pre-commit or commit
incrementally), and the emission needs a handle onto the response's trailer
controller from inside a settle callback (the segmented driver already owns
such a controller; the plain wrap's TransformStream would need to expose its
controller to the request context).

### (b) Per-parton gating for the live segment driver

`segmented-response.ts` today emits `TAG_SEGMENT_SETTLED` only after the WHOLE
segment's stream drains — a fast-ticking parton's update sits behind a slow
sibling's loader every tick, and the client's cooperative abort gates on the
whole-segment milestone. With per-parton settlement the driver can know "the
partons this bump touched have settled" before the full drain, enabling
per-parton settled milestones on the wire and a finer client commit/abort
protocol. A sibling agent is exploring that wire side; the server-side signal
it needs is exactly `_onPartonSettled` — reference here, not built here.

## 5. Where the mechanism lives

| Piece | Location |
|---|---|
| Task lifecycle instrumentation (both builds) | `scripts/patch-plugin-rsc-server-context.mjs` — `SETTLE_HELPERS`, `CTX_CAPTURE` (`settleScope`/`settleDone` snapshot), `__partonSettleUp` at `createTask`'s tail, `__partonSettleDown` at the six terminal sites; regenerated into `.yarn/patches/@vitejs-plugin-rsc-*.patch` via the workflow in `docs/internals/server-context.md` |
| Scope object + registration API | `framework/src/lib/server-context.ts` — `SettleScope`, `_openPartonSettleScope()`, `_onPartonSettled(cb)` |
| Per-parton wiring | `framework/src/lib/partial.tsx` — scope opened before `Render`, handed to `<ParentContext _settle={…}>` |
| Proof (dev + prod Flight builds) | `framework/src/lib/__tests__/task-settle{-scenarios.tsx,.rsc.test.tsx,.rsc-prod.test.tsx}` |
