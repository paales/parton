# Partial architecture — the north star

**Last updated:** 2026-04-18

This is the intended end-state of the `<Partial>` system. It's the
contract the runtime should uphold; the current implementation is
converging on it (see **Implementation status** at the bottom for
what's left).

---

## The goal, in one paragraph

The Partial system is a uniform, fully dynamic rendering primitive:
`<Partial id="…">` can be declared anywhere in the JSX tree — at the
root, nested inside another Partial, or produced deep inside a `.map()`
or any opaque server component — and every declaration is treated
identically, with no structural invariants and no static analysis.
Each Partial discovers itself by running: the moment its body
executes, it registers its content, fingerprint, and tags into a
route-scoped registry. A full request renders the tree once and
streams it to the client, which in a single walk populates a per-id
cache and derives the structural template it will reconcile against
on subsequent refetches. A targeted refetch — triggered by
`usePartial().refetch()`, a server-action invalidation directive, or
a tag — renders only the requested Partials directly from their
registered snapshots, skipping every ancestor; the client merges the
fresh entries into its cache and re-renders against its persisted
template, so the surrounding layout stays structurally identical
while targeted content swaps in place. Because every rendered
Partial contributes a fingerprint back to the client — whether it
was declared at the root or generated deep inside a loop — each
refetch tells the server precisely what the client already has, and
the server skips anything whose shape hasn't changed; the
skip-on-unchanged optimization applies uniformly to the entire tree,
not just its static roots.

---

## What follows from the goal

**No static walker on the server.** Every decision — render fresh,
emit placeholder, apply `__inputs`, register in the registry — is
made inside the `<Partial>` body when it runs. There is no
pre-walk of the JSX tree.

**One primitive, one rule.** `<Partial>` behaves the same whether
it's at the top of a page, nested inside another Partial, or
generated inside a `.map()`. Authors never have to know whether a
Partial is "static" or "dynamic" — the framework doesn't track that
distinction.

**The client owns the template.** The structural layout skeleton is
derived on the client from the first full-payload render and
persisted in module state. Refetches carry only the refetched
partials over the wire — layout bytes don't repeat.

**Fingerprints cover everything.** Every rendered Partial registers
its fingerprint client-side; the client reports all of them to the
server on every refetch. The server skips unchanged subtrees
uniformly — a deep `.map()` row gets the same fingerprint-skip
treatment as a top-level nav.

**Server work is proportional to what's asked for.** A refetch for
one partial renders one partial. Ancestor components do not
execute; the registry provides the snapshot and the `<Partial>`
body renders it directly.

---

## Mental model

**Server state:** a route-scoped registry of `{id → {content,
fallback, errorWith, tags}}` snapshots. Populated as Partials run;
consulted on refetch.

**Client state (module-level, survives refetch remounts):**
- `_cache`: rendered wrappers by partial id.
- `_fingerprints`: fingerprint by partial id (every Partial, including
  deep ones — populated as wrappers mount).
- `_template`: the structural layout skeleton with placeholders;
  derived on each full-payload render, persisted across refetches.

**Request lifecycle:**

1. **Full request** — server renders the whole tree; Partials
   self-register. Client walks the payload once: populates `_cache`,
   derives `_template`, stores it. Wrappers mount → `_fingerprints`
   fills in.
2. **Refetch** (`?partials=…` or `?tags=…`) — server renders just
   the requested Partials from their snapshots, skipping all
   ancestors. Client merges into `_cache` and re-renders against
   the persisted `_template`.
3. **Server action with `{invalidate}`** — server rewrites the URL
   with `?partials=` / `?tags=` and runs the refetch path. If the
   client has no cache, falls back to a full render with
   `__populateCache=1` to seed.

**Skip pipeline:** on every refetch, the client sends `?cached=id:fp`
for every entry in `_fingerprints`. If a requested (or ambient)
Partial's fingerprint matches, the server emits a placeholder
instead of rendering. The client keeps its existing entry.

---

## What does not exist (and why)

- **`buildTemplate` / `seedRegistry`** — static JSX walks on the
  server. Not needed: the client derives the template, and every
  Partial self-registers at render time.
- **"Opaque component contains Partial" invariant** — gone.
  `<AppNav/>` can hold a `<Partial>` inside and live anywhere in the
  JSX tree; render-time registration doesn't care about JSX
  topology.
- **Mode distinction** in `PartialsClient` — one code path handles
  both full-tree and partial-list payloads. The shape of the
  payload tells the client which it is.

---

## Implementation status

| Part | Status |
|---|---|
| Route-scoped registry, `<PartialBoundary>` self-registration | ✅ shipped |
| `<Partial>` body handles all decisions at render time | ✅ shipped |
| Client `_cache` + `_fingerprints` populated from rendered payload | ✅ shipped |
| Cache-mode refetch renders from registry snapshots, bypassing ancestors | ✅ shipped |
| `getCachedPartialIds()` reports deep Partials (fingerprint-skip covers entire tree) | ⬜ todo — currently iterates `_cache` |
| Client-derived `_template`, persisted across refetches | ⬜ todo — currently server-built via `buildTemplate` |
| `buildTemplate` + `seedRegistry` removed | ⬜ todo — follows from client-derived template |
| No "opaque component" invariant; `<AppNav/>` can be declared freely | ⬜ todo — follows from `buildTemplate` removal |
| One unified `PartialsClient` code path (no `mode="streaming"` vs `mode="cache"`) | ⬜ todo — follows from above |

When the ⬜ items are done, the architecture in this doc matches the
code. Until then, `DEFER_ACTIVATORS.md` §Known sharp edges #6 remains
a real-but-temporary constraint.
