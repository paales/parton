# Transient client state — the un-URL-able middle

> Live design doc. Captured 2026-04-29 as part of the IDEAS backlog
> and split out 2026-05-12 for room to grow. Decision still open.

The framework's load-bearing position is that **state lives in URLs**:
page URL for shareable, frame URL for subtree-scoped. Combined with
`vary` purity, this gives the strong promise that a Partial's render
is reproducible from its URL alone. The cost: there is no first-class
story for state that is **not yet authoritative** and **not appropriate
for a URL**. Today this falls on the floor between client components
(which can hold any state but can't influence a Partial's render) and
server actions (which only commit authoritative state).

## Failure cases

1. **Drag-to-reorder with debounced save.** User drags item 5 above
   item 2 in a 50-item list; visual reorder must be instant, save
   debounced. The new ordering doesn't belong in a URL (you're not
   serializing a 50-item permutation in a query string), and `vary`
   has no client-state input. Best you can do today is a client-only
   visual layer that diverges from the server tree until the action
   commits — the very split-state the "one primitive" thesis wants
   to avoid.
2. **Multi-step form draft restoration.** User starts filling a long
   checkout / CMS authoring form, navigates away, comes back. Draft
   lives in `localStorage` (or wants to). Today the Partial that
   renders the form has no way to read that draft on the server; the
   form re-renders blank from server state, and a client effect has
   to repopulate. Hydration-time flip.
3. **Optimistic UI on a server-rendered region.** User clicks
   favorite; UI shows favorited instantly; server confirms. React's
   `useOptimistic` works inside a client component, but the
   surrounding Partial re-renders authoritatively from server state
   only after the action commits. The optimistic value is invisible
   to anything that renders through the Partial pipeline.
4. **Cross-tab leak via session-scoped frame URL.** Two tabs viewing
   the same app share the frame URL through the session cookie
   ([`../reference/frames-navigation.md`](../reference/frames-navigation.md) §Sharp-edges).
   Tab A opens a drawer, tab B's drawer also opens on next render.
   Already a known leak; a per-tab-id channel would fix it but that
   channel doesn't exist.

A server-side `getLocalStorage()` / `getMousePosition()` accessor
that bails a server component's render on a client-state read is the
wrong answer here: implicit subscription, hidden control flow,
per-client cache keys, SSR fallback flips. That critique stands. The
directions below try to address the gap **without** reinstating that
DSL.

## Direction A — Durable draft as a server entity (Partial reads it)

The CMS layer already has the precedent: `content.json` (published) +
`draft.json` (gitignored), with `lookupCmsNode(id, request)`
checking draft first when `cms-draft=1` is set. Generalize that shape
to **app draft state**:

```tsx
const CheckoutForm = parton(CheckoutFormRender, {
  match: "/checkout",
  draft: { kind: "checkout", scope: "session" }, // new option
  vary: ({ request, draft }) => ({
    step: new URL(request.url).searchParams.get("step") ?? "shipping",
    values: draft.fields(), // sync read like cms.*
  }),
})
```

`draft.fields()` reads from a per-session draft store keyed by
`(sessionId, kind)`. A `useDraft()` hook in client code writes to the
same store via a narrow server action. The store is the single
authoritative place; the Partial reads it like it reads CMS fields;
the cache key derives correctly because the read appears in `vary`.

What this buys: zero new primitives, zero URL pollution, draft
restoration across reloads, multi-tab consistency (it's server state),
SSR works (no client state read at render time). The Partial re-renders
on every draft mutation because the action invalidates by selector.

What it costs: every keystroke in the form costs a server round-trip
to write the draft. Acceptable for checkout / CMS authoring; too heavy
for an autosave-on-every-keystroke text editor. For the heavy case,
client-side debouncing inside the `useDraft` hook brings round-trips
down to one-per-pause without changing the contract.

Open question: scope key. `session` cookie works for anonymous flows;
authenticated flows want the user id. Probably a `scope:
(req) => string` callback.

## Direction B — Optimistic overlay channel (one-shot, narrow)

The "no client→server prop-override channel" rule was about preventing
arbitrary client state from leaking into `vary`. A narrower channel —
**optimistic overlays attached to a specific in-flight server action**
— doesn't have the cache-key explosion problem because the overlay
exists only for the duration of the action's lifetime.

```tsx
// Client component inside a Partial render:
const [optimistic, addOptimistic] = useOptimistic(items)
function onReorder(next) {
  addOptimistic(next)
  reorderItemsAction(next) // server action
}

// Server action returns a directive the framework already understands:
async function reorderItemsAction(next) {
  await db.saveOrder(next)
  return { invalidate: { selector: "#item-list" } }
}
```

Today this works for the client component itself but the Partial body
re-renders from authoritative state. Proposal: when an action is
in-flight against a Partial, the framework holds the previous render's
output and lets the Partial's _client_ descendants read an optimistic
overlay via `useOptimisticPartial(partialId)`. On commit, the new
server render replaces both. No new server-side accessor; no `vary`
input from client state; the channel is one-shot per action.

This is roughly "Inertia visit progress events" + `useOptimistic`
glued together at the Partial boundary.

## Direction C — Per-tab session axis

The cross-tab leak (#4 above) and the "where does drag-reorder
intermediate state live" question (#1) both want the same thing: a
**per-tab** state cell the server can read sync. Today's session is
cookie-backed and shared across tabs.

A per-tab id stamped at first paint (e.g., a `sessionStorage`-backed
nonce sent in a header on every request) gives a third URL-like axis:

- Page URL — shareable, browser back/forward.
- Frame URL — subtree-scoped, browser back/forward.
- **Tab-scoped session** — per-tab transient state, no back/forward,
  not shareable, not URL-visible.

`vary` could read it: `vary: ({ tab }) => ({ draftOrder: tab.get("order") })`.
Client writes via `useTabState("order", value)` which posts to a
narrow framework action. This is closer to URL-discipline than
Direction B (still server-authoritative, still appears in `vary`,
still cache-keys correctly) but solves the multi-tab case Direction A
doesn't.

Risk: tab session becomes the dumping ground for "state I didn't
want to think about." A sharp constraint — values must be
JSON-serializable and under N bytes — keeps it honest.

## Direction D — `<PartialForm>` with first-class draft

Pull A + B together into a form-specific primitive:

```tsx
<PartialForm
  partial="#checkout"
  action={submitCheckout}
  draft={{ kind: "checkout", debounce: 500 }}
>
  <Field name="email" />
  <Field name="address" />
</PartialForm>
```

Behaviour:

- Field values write to the server-side draft store (Direction A) on
  blur / debounce.
- `submitCheckout` runs against the draft + final field values.
- On in-flight submit, the optimistic-overlay channel (Direction B)
  holds the form's "submitting" state visible to client descendants.
- Cancel / abandon clears the draft.

Most of the unhappy paths in the four failure cases above collapse
into known-good behaviour: refresh restores the draft, multi-tab sees
the same draft, optimistic state is scoped to the submission, and
the partial's `vary` appears in cache keys.

## What to NOT build

- A server-side `getLocalStorage()` / `getClientState()` accessor.
  The rejection critique still applies: hidden control flow, every
  read is a subscription, cache-key explosion, SSR fallback flips.
- Implicit synchronization of arbitrary client state into `vary`.
  The whole point of `vary` purity is that the cache key is
  predictable; admitting any client value defeats it.
- A "Partial-aware Redux." If the answer is a global store with
  selectors, we're rebuilding what RSC was supposed to delete.

## Decision the framework still owes

Pick one of A / B / C / D as the _opinionated_ path, document the
others as escape hatches, and ship it before anyone tries to build a
real form on this. Today the docs are silent on transient state;
that silence will turn into a pile of bespoke client-side workarounds
that are hard to reverse later. The CMS draft pattern (Direction A
generalized) is the most architecturally consistent — it reuses the
existing draft/published cascade and stays inside the
"vary purity + URL-discipline" frame — and is probably the right
default. B and C are additive on top.
