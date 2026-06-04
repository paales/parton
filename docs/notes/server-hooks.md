# Server hooks

Status: active. Foundation landed (`getCurrentParton`, `tag`); the rest is a
staged plan with open architectural decisions flagged per step below.

## Thesis

The server-context patch — a per-component `AsyncLocalStorage` the Flight
render site enters per component, riding React's task graph (see
[`../internals/server-context.md`](../internals/server-context.md)) — gave
Server Components a value that flows down the render tree, survives `await`,
and isolates siblings. `createServerContext` was the first use (downward
*provision*). This note is the second: **server-hooks** — free functions,
called anywhere in a parton's render, that read or register against the
*current parton* via the same ALS. It's the client-hook ergonomic
(`useState`-style ambient binding) on the server, without the rules-of-hooks
fragility — every server-hook is explicitly keyed, never positional, so it's
safe in conditionals, loops, and after awaits.

## Why now — the 2d607fc reversal

An earlier version had exactly this: `<Partial>` + "tracked accessors" that
auto-derived a parton's dependency surface from what it read. It was abandoned
(commit `2d607fc`) for ONE reason: the tracker pointed at "the current partial"
through a request-level cell that **drifted across awaits and under sibling
interleaving** — the framework couldn't reliably attribute a read back to the
parton that did it. The fix was to move reads into an explicit, eager, pure
`vary` callback and the module-scope `parton(Render, options)` constructor,
which made attribution unnecessary.

The per-component ALS makes attribution **reliable** — a read lands on the
right parton before/after any await, and siblings don't cross-contaminate
(probed in `current-parton.rsc.test.tsx`, the exact drift case). So the reason
for the explicit era is gone and the tracked direction is open again, on a
sounder mechanism.

## The mechanism — `getCurrentParton`

`framework/src/lib/current-parton.ts`. The parton wrapper stamps its own
effective id (plus a per-render tag accumulator) onto the rendering task;
`getCurrentParton()` reads it back. Rides the same `__partonStorage` ALS the
server-context reader uses — no new ALS, no patch change. Unlike
`createServerContext` (a provider scopes DESCENDANTS and deliberately never
reads its own overlay), this is read-your-OWN-value, so it's a direct task
field, not a context entry, and is not inherited by descendant tasks — each
parton stamps its own; a non-parton child reads `undefined`.

## The two-axis fingerprint model

A parton's fp already folds two kinds of dependency. Server-hooks populate both
ambiently instead of via the `vary` / `selector` declarations:

- **Derived inputs** — `cookie` / `session` / `param` / … . Re-evaluated from
  the request every nav; their VALUES fold in (`|vary=`); a value change
  re-renders. Re-derivable, value-compared. (Today: `vary`.)
- **Tags** — `tag(name)`. NOT re-derived, NOT value-compared; a write-only
  subscription whose bump-TIMESTAMP folds in (`|inv=` via `queryMatchingTs`).
  Only an explicit `revalidate(name)` moves it. (Today: `selector`, but static;
  `tag()` is per-render dynamic — e.g. a GraphQL `__typename:id` entity key.)

The fp FORMULA is unchanged (`partial.tsx` ~1612). Server-hooks only swap the
front door from declarations to ambient calls.

### Fold the tag, not the value

A tag is a pure revalidation target — it deliberately does NOT carry the
fetched value into the fp (the value isn't re-derivable later anyway). Read
side: `tag()` the entities a query touched (`Cart:1234`). Write side: a
mutation `revalidate()`s the entities it changed. GraphQL is free here —
`__typename + id` is the entity key. This is the Apollo/Relay
normalized-invalidation model, applied to RSC fp-skip rather than a client
cache. Open knob: granularity (tag the root entity only, or every entity
reachable in the response).

## Direction split — what this does and does NOT change

- **Downward** (ancestor→descendant, known before the descendant renders):
  server-hooks + `createServerContext`. This is what's unlocked.
- **Upward** (descendant→ancestor fp): unchanged. Still the fp-trailer (warm
  descendant fold). Server-hooks are downward-only and do not eliminate it.
- **Auto-track is reactivity**, and its cost/benefit flips across the dynamic
  range: a warm long-lived process amortizes and fp-skips cheaply; a cold/edge
  process can't fp-skip a variant it never rendered, so it degrades to a full
  render — an OVER-FETCH, never stale (fp-skip needs a positive fp match;
  missing state → render). So "survive a process switch losslessly" is a later
  shared-store optimization, not a correctness requirement.

## Decision rule — where a downward value lives

- Request-invariant (whole request/process) → request ALS
  (`runtime/context.ts`): the Request, scope, capability.
- Per-subtree, known before render → `createServerContext`: theme, locale,
  principal, the parton parent.
- Must move cache identity / re-render on change → fold into the fp: derived
  inputs (`vary` / tracked reads) and tags (`selector` / `tag()`).
- Known only after render (bubbles up) → fp-trailer. Intrinsic.

## Status

- ✅ **Self-context** (`getCurrentParton`) — commit `e927c5a`. Probe
  `current-parton.rsc.test.tsx`: own-id survives an await, a nested child reads
  the child not the parent, staggered siblings stay isolated (the drift case).
- ✅ **`tag()` + fp-fold** (schema phase) — folds into `expandedLabels`
  alongside cell labels; a `refreshSelector(name)` shifts the fp; byte-identical
  (no-op) for any spec that doesn't call it. Probe `tag-fp.rsc.test.tsx`.

Both kept internal (not in the public barrel) — no app consumer yet.

## Roadmap + open decisions

Each step touches the fp/skip path, the action/refetch reconstruction, or the
public API. The flagged decision should be made before it's safe to land —
which is why this autonomous pass stopped here.

### 1. Render-phase `tag()` / tracked reads (store-and-reread)
`tag()` is effective only in the schema phase today (it runs before the fp). A
render-body `tag()` lands after the fp. To fold it, the parton's discovered
tag/dep set must be STORED per `(id, matchKey)` after the render and RE-READ
before the next render's fp. **Decision:** where to store (registry vs
snapshot). The first-render-has-no-stored-set lag is fine — a tag only matters
once bumped, and the bump post-dates the first render.

### 2. Auto-tracked vary (`vary` becomes implicit)
Reads via tracked hooks (`cookie()`, `session()`, `param()`, cells) accumulate
the dependency surface; `vary`'s bail role becomes a plain early `return` in
Render. **Decisions:** (a) value→label fold for cells (don't resolve a cell to
compute the fp — check its version/label, so a nav can fp-skip without the
GraphQL round-trip the schema phase does today); (b) the stateless-cold-skip
tradeoff — a captured/generated vary is STATEFUL (a cold process must render),
an explicit vary is request-reproducible. **Likely outcome:** explicit `vary`
stays the default, auto-track is an opt-in mode — the dynamic-range hedge.

### 3. Inline `localCell` (server-hook cells) — BLOCKED on action enumeration
The descriptor pattern already makes a free-import `localCell` trivial (the
framework supplies parton id + key from the schema-return object — but that's
cosmetic, it reads nothing ambiently). The REAL inline form
(`const x = localCell('k', …)` in Render) removes the schema callback — but the
schema callback is the **replayable shape** the action dispatcher re-runs
WITHOUT a render (`resolveSchemaForAction`, `parton-actions.ts`) to resolve a
parton's cells, and the same shape a cold refetch would need. So inline cells
need a way to enumerate a parton's cells without rendering it. **Decision:**
keep a declared shape, or solve render-discovers-then-replay (the §4 knot). The
partition source also moves to an ambient `session()`-style read. NB:
forms-demo is a poor first target precisely because its `save` action depends
on this enumeration.

### 4. `<Parton>` component (retire the constructor) — BLOCKED on a kernel
With drift solved, the constructor's only SURVIVING justification is that it
registers `id → {Component, match, vary}` at module-load, so any process —
including a cold one handling a refetch — can reconstruct a parton it never
rendered. The catalog's three consumers (`spec-catalog.ts`): cold refetch
(`partialFromSnapshot`), the descendant fold (`descendantContribution` re-runs
`vary`), and match-key walking (`deriveMatchKey`). `<Parton>` pushes all three
onto per-instance snapshot/runtime data.

**Kernel question:** can a cold process reconstruct `{Component-ref, match,
dep-record}` for a parton it never rendered, from the client's snapshot alone?
`match` + `dep-record` are data and can ride the snapshot; the hard one is the
**Component reference** — re-invoking THIS server function in a process that
never evaluated the JSX. Flight mints stable cross-process ids for
`"use client"` refs and `"use server"` actions via the bundler; does
`@vitejs/plugin-rsc` expose the same for an arbitrary server function (a
parton's Render)? If yes, the constructor dies and identity falls out of
placement (the "Abolish id" endgame, `IDEAS.md`). If no, the constructor
survives as a thin module-load anchor and `<Parton>` is sugar. **Investigate
this before building §3–§4.** (Positional ids also need stable per-level keys,
not ordinals.)

## Non-goals
- Eliminating the fp-trailer (upward; intrinsic).
- Removing explicit `vary` outright — keep as default; auto-track is opt-in.
- Patching global `fetch` for tracking — opt-in wrappers only; raw `fetch`
  stays the no-reactivity escape (an untracked read just doesn't reload on
  nav, a fine default).
