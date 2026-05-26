# Cell dimensionality

> Live design doc. Captured 2026-05-22. Exploring axes along which
> cells could be parameterised beyond today's single-value-per-
> partition shape. Decision open; not currently shipping.

## Premise

A cell today stores **one value per partition**, where the
partition key is `hash(stableStringify(cell.vary(scope)))`. The
storage layer is exact-match: read with partition K, return the
stored value at K, else the cell's `default`. No fallback chain
between partitions.

That model handles the vast majority of cases: a per-user counter,
a per-cart total, a per-route drawer state. But several real cases
want something different from exact-match — they want partitions
arranged in an **inheritance order**, with reads walking back
through more general partitions until a stored value appears.

This note is an inventory of those cases and a sketch of what an
inheritance-shape declaration on a cell could look like.

## Out of scope

- **Optimistic shadow as a separate axis.** Already collapsed into
  `useCell.value` (server value when no writes pending, latest
  local write while pending). Not splitting further.
- **Broadcast / multi-tab dimensions.** Already works as a
  side-effect of the invalidation registry — when one tab's action
  bumps a selector, every connected client picks up the new
  fingerprint on its next render. No cell-shape change needed.
- **Cell persistence to browser storage.** Different concern —
  about durability of unsaved optimistic state, not about server-
  side storage shape. Tracked in [`IDEAS.md`](./IDEAS.md) as
  "persist optimistic unsaved cell values."

## Cases that want inheritance

### Translations

A localised string. The partition key is `{ locale }`. Editorial
ships content for `en-US` and falls back to `en` if a region-
specific value isn't present; falls back further to the cell's
default if neither is set. The fallback chain is:

```
en-US  →  en  →  (default)
```

Today an author either has to write `en-US` and `en` separately
(missing the inheritance) or stuff the fallback logic into the
cell's `read` callback. Neither is great.

### Currency / pricing zone

A price quoted in the user's currency. The partition key is
`{ currency }`. Unlike translations, there's typically NO
inheritance — `EUR` ≠ `USD`. But sometimes there is: a "global"
price denominated in USD with a per-currency override falls back
to USD for any currency without a specific value. The author
should be able to declare which shape they want — exact-match or
fallback-to-base.

### Domain / brand

A multi-tenant cell where each tenant can override a default. The
partition key is `{ domain }`; the fallback is `(default)`. Same
structure as translations but flat (one level).

### Draft vs published (CMS storage)

A CMS field has two states: published (canonical) and draft
(per-author overlay during editing). The partition key is
`{ stage }`. Reads in the editor context want the draft if
present, falling back to published. Reads in the public context
want only published.

```
stage=draft  →  stage=published  →  (default)
```

This is the closest case to "we need this now" — moving the CMS
storage layer behind cells (eventually) requires this. Until
cells get an inheritance declaration, CMS storage stays as its
own custom store with its own draft/published resolution logic.

### Time (history / undo / scheduled)

A cell with a version axis. The partition key is `{ at }` where
`at` is a timestamp or version id. Reads default to the latest
version; explicit `at=` reads return historical state. Inheritance
shape:

```
at=<specific>  →  at=latest  →  (default)
```

Plus a write-time concern not present in the other cases: writes
either replace the latest value (overwrite history) or push a new
entry. That's a separate axis — *write behaviour* — not just a
read fallback.

## The pattern

All five cases share the same shape:

- One or more partition keys are *partition* dimensions (storage keys).
- One or more of those keys have a *fallback ordering* the cell
  declares.
- Reads walk the ordering until a stored value appears, then
  return it; otherwise fall through to the cell's `default`.

Today's cell sits at the trivial end of this spectrum — no
fallback, all partition keys are exact-match. The cases above
each want a different fallback shape for a different partition key.

## Sketch of an API

Strawman, not committed:

```ts
const translation = localCell({
  id: "translation",
  shape: "string",
  initial: "",
  vary: ({ cookies: { locale } }) => ({ locale }),
  fallback: {
    // For the `locale` key: walk en-US → en → default.
    locale: (value) => {
      if (value.includes("-")) return value.split("-")[0]
      return null  // stop walking; fall through to default
    },
  },
})
```

For CMS draft/published:

```ts
const cmsField = localCell({
  id: "cms-field",
  shape: "string",
  initial: "",
  vary: ({ cookies: { __editor } }) => ({
    stage: __editor ? "draft" : "published",
  }),
  fallback: {
    stage: ["draft", "published"],  // ordered list form
  },
})
```

For time:

```ts
const versioned = localCell({
  id: "versioned",
  shape: "string",
  initial: "",
  vary: ({ search }) => ({ at: search.at ?? "latest" }),
  fallback: {
    at: "latest",  // any `at=X` not found falls back to `at=latest`
  },
  write: "append",  // separate axis — pushes a new entry per set
})
```

The shape of `fallback` matters less than the discipline: the
*cell* declares the inheritance, not the read site. The author
writes `useCell(translation)` and the cell handles the walk.

## Open questions

1. **Multi-key inheritance.** If a cell has two fallback keys
   (`locale` AND `currency`), does the read walk them
   independently (each key falls back on its own axis) or as a
   product (every combination tried in some priority order)? The
   first is simpler and probably correct for most cases; the
   second is what some real CMS systems need.
2. **Fp folding under inheritance.** Today a cell's read folds
   into the reading parton's fp via the partition key. Under
   inheritance, the *effective* partition key is whichever level
   the read resolved to. The fp needs to capture that, or two
   readers at different levels could collide on fp despite
   reading different stored values.
3. **Invalidation fan-out.** When `cell.set(v)` at partition
   `(locale=en-US)` happens, do partons reading at partition
   `(locale=en-US)` re-render? Yes. Do partons reading at
   `(locale=en-GB)` (which fall back to `en`) re-render? Today
   they would not, because `en-US` doesn't contribute to their
   resolution. Inheritance doesn't change this — set-at-leaf
   doesn't affect siblings.
4. **Write target under inheritance.** Reads walk a chain; writes
   target one partition. Which one? The exact partition the
   reader was resolving against (so a write "specialises" the
   value at that leaf), or the partition the author specified
   explicitly? Probably the latter — implicit specialisation
   feels surprising.
5. **CMS storage migration.** When does the CMS draft/published
   store move behind cells? Blocking on: inheritance declaration
   (this doc), an answer to (1)–(4), and the operational story
   for migrating existing draft data into cell partitions. None
   of those is urgent; CMS as-is works.

## Related

- [`../reference/cells.md`](../reference/cells.md) — the current
  cell surface.
- [`../internals/cell-internals.md`](../internals/cell-internals.md)
  — storage backends, partition keying.
- [`./replicated-state.md`](./replicated-state.md) — broader
  state-model lens; links here for the dimensionality side.
- [`../reference/cms.md`](../reference/cms.md) — the storage layer
  most likely to migrate behind a dimensional cell shape.
