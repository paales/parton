# Auto-tracked manifest fingerprinting

**Added 2026-04-27.** Replaces declarative `<Partial varyOn>` (introduced and removed same week) with auto-tracking via the existing tracked-accessor manifest. Closes the editor's "config tab click leaves the form stale" regression at the framework level.

## TL;DR

Every `<Partial>` body opens a manifest scope on a per-request mutation cell. `getSearchParam`, `getCookie`, `getHeader`, `getPathname` write the keys they read into the active scope. After the render, the scope's key set lives on the snapshot. The NEXT render resolves those keys against the current request and folds the values into the structural fingerprint — so a same-route nav that changes any read input invalidates the fp-skip handshake.

```tsx
<Partial selector="#cms-edit-fields">
  <FieldPanel />
</Partial>

async function FieldPanel() {
  // Hoisted to the sync top of the body — required.
  const config = getSearchParam("config");
  const select = getSearchParam("select");
  // ... rest of body
}
```

No declarative deps. No `varyOn` prop. Same contract as `<Cache>` already had, lifted from "only inside Cache" to "every Partial".

## The two leaky cells, and the fix

The framework historically had two per-request mutation cells with the same sibling-leak shape:

- **Frame scope cell** (`frameScopeCell`). Mutated by `<Partial frame=…>`'s `FrameWrapper`. Sibling Partials would read the leaked frame URL after the framed Partial had run — that's why FieldPanel had to use `getRequest()` instead of `getSearchParam` (the tracked accessor would resolve against the preview frame's URL).
- **Manifest scope cell** (new — `partialManifestCell`). Mutated by every `<Partial>` body to mark "I am the current Partial". Tracked accessors record into it.

Both leak via React 19 RSC's sibling interleaving: between when a Partial body sets the cell and when its descendant reads it, another Partial may have run and overwritten the cell.

The fix uses the same explicit-set-on-entry pattern in both places, leveraging the framework's existing **`parent` prop discipline** (authors thread `parent={capturePartialContext()}` across awaits — the prop is reliable where the cell is not):

- **Frame scope**: every Partial body resets the cell on entry. If `frame=` is set, `FrameWrapper` will set it. If `parent.frameChain` is non-empty, restore the ambient frame from session (or trust the cell if it already matches `parent.frameChain`, preserving outer's `frameUrl` on first render). Otherwise clear to null. Sibling leaks no longer reach descendants.
- **Manifest scope**: every Partial body opens a fresh scope and installs it on the cell. Writes to both the ALS-based `manifestContext` (for `<Cache>`) and the cell-based `partialManifestCell` (for the Partial's structural fp).

## Hoisting discipline — required, enforced

Tracked accessor calls **must happen at the synchronous top of a server component body, before any `await`**. This is the same discipline `<Cache>` enforced (via `HoistingViolationError`); now extended to every Partial.

Why hoisting works: when the framework calls a server component, the sync portion of its body runs IMMEDIATELY, before React can yield to siblings. The cell at that moment still points at the Partial that scheduled this render (the parent's body was the most recent `setCurrentPartialManifest` call, and React processes children depth-first). Reads attribute correctly.

After an `await`, sibling Partials may have run and overwritten the cell. A read here attributes to whoever set the cell most recently — typically a sibling, not the original ancestor.

```ts
// ✅ Hoisted — works
async function FieldPanel() {
  const config = getSearchParam("config");  // sync top
  await fetchSomething();
  return <div>{config}</div>;
}

// ❌ Post-await — attributes to whatever sibling Partial set the cell last
async function CartPartial() {
  await new Promise((r) => setTimeout(r, 100));
  const cartId = getCookie("cart_id");  // cell has drifted to a sibling
  ...
}
```

The strict `HoistingViolationError` catches the second case on the next render (the previous render's manifest didn't include the new key). The error message names BOTH causes (conditional read + cell drift) and tells you to look at where the read actually happens, since cell-drift attributions can be misleading.

## Ancestor fp captures descendant manifests

If only the descendant's fp folded its own manifest, an ancestor whose JSX is unchanged would still fp-match its cached fp, emit a placeholder, and the client would reuse the cached subtree — descendants whose URL deps changed would never re-render.

So every Partial's body folds in the manifests of its descendants, looked up via two walks:

1. **Static JSX walk** of `rawContent` — finds `<Partial>` elements directly visible in the children JSX (no opaque function component in between). Looks up each Partial's previous-render snapshot from the registry and resolves its manifest against the descendant's effective request.
2. **Previous-render registry walk** — finds snapshots whose `parentPath` includes this Partial's id. Catches dynamic Partials (`.map()`-generated, function-component-wrapped) when the author threaded `parent={capturePartialContext()}` so the registry knows the parent edge.

Contributions deduped by descendant effective id. Empty contribution on first render (no previous snapshots to fold). Over-folding bias: a stale snapshot from a Partial that no longer exists still contributes — extra re-renders, never stale subtrees.

## What this replaces

The week's earlier iterations:

- **`<Partial varyOn>` (introduced + removed 2026-04-26 → 2026-04-27).** Declarative URL/cookie deps the author listed by hand. Brittle (one missed key = silent stale content), against the framework's "no redeclare your dependencies" principle. Only existed as a workaround for the frame-scope leak; gone now that the leak has an actual fix.
- **`pageSearchParam` helper in `cms-edit.tsx` (removed).** Read URL via `getRequest()` to dodge the frame leak. With the leak fixed, `getSearchParam` works correctly even when the editor's preview frame is a sibling.
- **`CmsEditConfigTab` client wrapper (removed earlier).** Forced selector-targeted nav so the field panel's fp didn't matter. With auto-tracking, plain `<a href>` works.

## Cost

Tiny. Each Partial body now allocates a `ManifestScope` object and writes to a per-request React.cache cell. Tracked accessors do one extra Set lookup + add. No Flight round-trip overhead — the cell propagates information through the synchronous render path, not through ALS.

The cost trade-off vs `<Cache>`'s Flight round-trip: Cache buffers its content to populate ALS-extended manifests for descendants past awaits. Per-Partial auto-tracking only catches reads at descendants' SYNC TOPS — anything past an await needs to be hoisted (or the framework throws). Cheaper, but discipline-dependent.

## Architectural limits

The hoisting discipline closes one specific case: descendants whose first sync line reads accessors. Two cases the per-cell scheme can't catch safely without Flight round-trip:

- **Conditional reads inside descendants** (`if (x) getSearchParam("y")`). Caught by the strict `HoistingViolationError` on the next render — discipline violation.
- **Reads after awaits in descendants past intermediate awaits**. Cell drift attributes to wrong Partial. Caught by the strict `HoistingViolationError`.

Both manifest as the throw. If the Partial named in the error doesn't actually do that read, look elsewhere — it's almost always cell drift from another Partial's post-await read. Hoist that read, throw goes away.

For Partials that genuinely need post-await tracking (e.g. an async server component that depends on a value resolved by an upstream fetch), wrap the relevant subtree in `<Cache>` — its Flight round-trip extends the manifest scope through awaits. Cost: progressive reveal inside the cached region is gone.

## Tests

- `src/lib/__tests__/partial-vary-on.rsc.test.tsx` — pins the four invariants: tracked-key change differs fp, untracked-key change doesn't, ancestor fp folds descendant manifest, frame-bound Partial resolves against frame URL.
- `e2e/cms-edit-config-tab.spec.ts` — the original repro that drove this work. Now passes via auto-tracking, no `varyOn` declared.
