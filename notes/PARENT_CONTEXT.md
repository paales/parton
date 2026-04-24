# Parent context — tracking the tree across RSC async boundaries

**Status:** implemented.
**Files:** `src/lib/partial-context.ts` (canonical implementation),
`src/lib/partial-component.tsx` (validation + cell mutation),
`src/lib/partial-registry.ts` (`parentPath` storage).
**Related:** `FRAMES.md` (frame-chain nesting consumes `parent`),
`DYNAMIC_PARTIAL_REGISTRY.md` (why the registry stores `parentPath`),
`AUTO_TRACKED_CACHE_KEYS.md` (same "read/capture before `await`"
discipline).

---

## One-liner

`<Partial parent={…}>` is a **required** prop that carries the
author's server-side tree position. It's what lets the framework
track the Partial hierarchy even when React's async server-component
renderer reorders sibling work across `await`s.

```tsx
import { Partial, ROOT, capturePartialContext } from "./lib";

function Page() {
  return (
    <Partial parent={ROOT} selector="#products">
      <ProductGrid parent={capturePartialContext()} />
    </Partial>
  );
}

async function ProductGrid({ parent }: { parent: PartialCtx }) {
  const items = await fetchProducts();                // async boundary
  return items.map((p) => (
    <Partial parent={parent} selector=".product">     // parent survives the await
      <ProductCard p={p} />
    </Partial>
  ));
}
```

## Why it has to be explicit

React server components don't render in the traversal order the JSX
tree suggests. When a server component hits `await`, React moves on
to sibling subtrees; resumes happen as promises resolve, which is
effectively breadth-first / arbitrary. Any per-request cell tracking
"who is the current parent" drifts between write and read whenever
an async sibling interleaves. Until TC39 AsyncContext lands, there's
no language-level way to pin a per-call-stack token through an
`await`.

The framework works around this by making the author thread the
parent token explicitly. Two supported shapes:

1. **Top-level:** pass `ROOT` (a frozen sentinel — empty `path`,
   empty `frameChain`).
2. **Nested:** pass `capturePartialContext()` read from the enclosing
   `<Partial>` body BEFORE any `await`, or accept `parent` as a prop
   from the caller and forward it.

Inside a sync component body (no `await` between the enclosing
`<Partial>` and the callsite), `capturePartialContext()` reads a
`React.cache`-backed cell and returns the current parent chain —
safe because nothing has drifted. Inside an async component, the
rule is the same one as tracked request accessors
(`getSearchParam`, `getCookie`, …): capture at the top of the body,
use the captured value after the `await`.

## What the token carries

```ts
interface PartialCtx {
  readonly path: readonly string[];          // ancestor effective ids, outer-first
  readonly frameChain: readonly string[];    // ancestor frame names, outer-first
}
```

- `path` drives the **registry's parent edge** — every snapshot in
  `src/lib/partial-registry.ts` stores its ancestor chain as
  `parentPath`, so a future cache-mode refetch can reconstruct the
  Partial's context without re-executing ancestors.
- `frameChain` is the dotted-path identity for nested frames
  (`"products.list"` vs `"blog.list"`). See `FRAMES.md` §Nesting.

Both chains are frozen on construction; a child's chains are
`parent.chain ++ self`, never mutated in place.

## Where it's consumed

1. **Validation** — `<Partial>`'s body throws synchronously if
   `parent` is missing or malformed (see `partial-component.tsx`
   around the `parent == null || !Array.isArray(parent.path)` check).
   The error message points authors at `ROOT` / `capturePartialContext`.
2. **Registry** — the `parentPath: parent.path` is recorded on
   `<PartialBoundary>` so each snapshot remembers its place in the
   tree for refetch-time reconstruction.
3. **Frame-chain derivation** — `frame != null ? [...parent.frameChain, frame] : parent.frameChain`
   is folded into the Partial's fingerprint so the frame scope
   influences both skip logic and cache keys.
4. **Per-request cell** — before rendering children, `<Partial>`
   writes its own `_childContext(parent, id, frame)` into the cell
   so synchronous descendants can pick it up via
   `capturePartialContext()`. The cell is authoritative only for
   sync reads; async descendants must thread `parent` explicitly.

## What `parent` does NOT do

- It doesn't feed into the cache key. Cache keys derive from the
  tracked accessors in the Partial body plus `cache.vary`.
- It doesn't feed into the refetch decision. Streaming-vs-cache mode
  is driven by `requestedIds` + registry presence; see
  `DYNAMIC_PARTIAL_REGISTRY.md` §Refetch modes.
- It doesn't participate in selector resolution. Tokens are resolved
  purely by scanning snapshot `uniqueTokens` / `sharedTokens`.

The token is **infrastructure for the registry**, not gating logic
on the hot path.

## Sharp edges

1. **Capturing after an `await` is silently wrong.** The cell may
   have drifted to a sibling's context, so a refetch reconstructs
   the Partial under the wrong ancestor chain. Same failure mode as
   reading tracked accessors post-`await`. Rule: capture at the top.
2. **`ROOT` is only for the outermost Partials.** Passing `ROOT` to
   a nested Partial bypasses the ancestor chain — the snapshot
   thinks it's top-level, and nested-frame addressing (dotted path)
   breaks. Always prefer `parent = capturePartialContext()` or a
   threaded prop, unless you're at the tree root.
3. **Sync captures are fine, but still verbose.** Inside a synchronous
   component body that doesn't await anything, `capturePartialContext()`
   at the top works even though the cell wouldn't drift — authors
   typically still write it for consistency with async siblings.
