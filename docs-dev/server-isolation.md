# Server isolation

Module-scoped mutable state is a request-scoping question. Each
`let` / `Map` / `Set` either has to die with its request or
deliberately persist across them. Blindly wrapping every container
in `AsyncLocalStorage` would break the intentional caches (a cache
that dies with its request is not a cache); blindly leaving them
shared without scope buckets breaks parallel test workers (concurrent
requests trample each other's state).

The framework slots every piece of mutable state into one of four
categories. New state has to declare a category and justify it.

## The four categories

### A — Server request-scoped (concurrent-unsafe, never OK)

A `let` or mutable container on the server that's read/written
*during a single request*. Two concurrent requests would see each
other's writes. **No instances today.** If you find yourself wanting
one, the fix is always "put it in ALS" — use `requestContext` in
`framework/context.ts` as the pattern.

### B — Client-only (safe, per-browser-tab)

File carries `"use client"` or is only loaded by the browser entry.
Module state is per-tab; concurrent server requests never see it.

| File:Line | Container |
|---|---|
| `src/lib/partial-client.tsx` | `_cache: Map<string, ReactNode>` |
| `src/lib/partial-client.tsx` | `_fingerprints: Map<string, string>` |
| `src/lib/partial-client.tsx` | `_template: ReactNode` |
| `src/lib/partial-client.tsx` | `_frameUrls: Map<string, string>` |
| `src/lib/partial-client.tsx` | `_batchRef`, `_batchPromise` (refetch microtask batch) |
| `src/app/components/load-more.tsx` | `visiblePages: Set<number>` |

### C — Intentional server-shared (safe, atomic ops, scope-bucketed)

Deliberately process-wide. Reads / writes rely on the fact that
`Map#get` / `Map#set` / `Set#add` / `Set#delete` each complete
atomically in single-threaded Node — no torn reads even when
multiple requests touch the same key concurrently.

Every container in this category is **bucketed by `getScope()`**.
Outer map is `Map<scope, <the original container>>`. Production
maps every request to `"default"` → one bucket → same cache-hit
behavior as if the bucket weren't there. Dev with `x-test-scope`
header (Playwright `workers > 1`) gets per-worker buckets so
parallel tests don't contend.

| Container | Purpose |
|---|---|
| `src/lib/cache.tsx :: ScopeState.store` | Render-output cache (Flight bytes) |
| `src/lib/cache.tsx :: ScopeState.snapshotIndex` | Dynamic-partial snapshots per cache key |
| `src/lib/cache.tsx :: ScopeState.manifestStore` | Auto-tracked cache-key manifests |
| `src/lib/cache.tsx :: ScopeState.refreshing` | SWR in-flight guard |
| `src/lib/cache.tsx :: ScopeState.inFlightMiss` | Cold-miss dedupe |
| `src/lib/partial-cache.ts :: scopes` | GraphQL response cache |
| `src/lib/partial-registry.ts :: scopes` | Route-scoped partial registry (snapshots) |
| `src/lib/partial-registry.ts :: previousScopes` | Previous-render snapshots (for descendant manifest fold) |
| `src/framework/session.ts :: scopes` | Frame-session store (cookie session-id → frame URLs) |
| `src/framework/cms-runtime.ts :: publishedSlot, draftSlot` | CMS store cache (NOT scope-bucketed — file-backed; mtime-cached, single-instance OK) |
| `src/framework/cms-runtime.ts :: blockRegistry` | Block catalog (set at module init; not per-request) |
| `src/app/chat/log.ts :: scopes` | Chat streaming log (per fileId → MessageLog) |
| `src/app/pages/cache-demo.tsx :: slowRenderCounts` | Demo-page render counter |

Public clear functions (`clearCache`, `clearRegistry`,
`_clearAllSessions`, `_clearLogs`, `_clearCache`) accept an optional
scope argument:

- No argument or `"all"` → clears every scope. HMR dispose hooks
  use this; the debug toolbar's flush button uses `?all=1`.
- A specific scope → clears just that bucket. The
  `/__test/clear-caches` endpoint reads `x-test-scope` from the
  request and forwards it.

The `refreshing` Set deserves a note. It's a loose "is anyone
refreshing this key right now" flag. Two concurrent requests can
both see `!has(key)` before either adds, kicking off two background
refreshes. Cache *reads* return the stale bytes in both cases, so
correctness is preserved; the cost is extra refresh work in a
millisecond-wide race window. **Intentional trade-off for
simplicity** — don't "fix" it with a mutex.

### D — Already ALS-scoped (safe, per-request)

| File:Line | ALS |
|---|---|
| `src/framework/context.ts` | `requestContext` — request + cookies + scope token |
| `src/framework/context.ts` | `manifestContext` — per-`<Cache>` access manifest |
| `src/framework/context.ts` | `cmsPrerenderContext` — block-catalog prerender override |
| `src/lib/partial-request-state.ts` | `als` — per-request Partial state (requestedIds, explicitIds, fingerprints, seenIds, seenUniqueTokens) |

These are the model for any new Category A → ALS migration. The
pattern: open the ALS at the request entry (`runWithRequestAsync`
in `entry.rsc.tsx`), let it propagate via `async_hooks` through the
render. Tests that need to fake the request use `runWithRequestAsync`
with a synthetic Request.

## Scope buckets

```ts
const scopes = new Map<string, Map<string, Entry>>();

function bucket(scope = getScope()): Map<string, Entry> {
  let b = scopes.get(scope);
  if (!b) scopes.set(scope, (b = new Map()));
  return b;
}
```

`getScope()` reads `requestContext.getStore()?.scope` which was set
at request entry from `deriveScope(request)`:

```ts
function deriveScope(request: Request): string {
  if (import.meta.env?.DEV) {
    const h = request.headers.get("x-test-scope");
    if (h) return h;
  }
  return DEFAULT_SCOPE;  // "default"
}
```

In prod the header is ignored — every request maps to `"default"`,
so a malicious caller can't cause cache-miss amplification or state
exfiltration by spoofing scopes.

In dev, Playwright's per-worker fixture stamps `x-test-scope:
worker-<N>` on every request. Each worker reads and writes its own
bucket; concurrent `clearCache()` calls don't trample each other.

## Adding new state

When you add module-scoped mutable state to anything that might run
on the server, annotate it with a one-line comment stating the
category and why:

```ts
// CATEGORY C — intentional shared. Keyed by request manifest, so
// entries are safe across users. Bucketed by scope() for test-worker
// isolation.
const scopes = new Map<string, Map<string, Entry>>();
```

A PR that adds a server-side `let x = …` without that annotation
should be treated as suspect. If the answer turns out to be Category
A, the fix is to move the state into an ALS scope (follow
`requestContext` / `manifestContext`), never to leave it as-is. If
Category C, add the scope bucket — ungated Category C state breaks
`workers > 1` reliability in e2e tests.

## Why not just wrap everything in ALS

ALS is a *request-scoped* container. Entries die with the request.
The caches in Category C have to survive across requests — that's
the whole point. Wrapping them in ALS would make every request a
cold miss, defeating the cache.

The separation is correct. The audit only confirmed it.

## Why a scope bucket and not ALS for parallel tests

A scope bucket is a `Map<scope, container>` *inside* a Category C
container. Lifetime is still "until the process restarts". Production
collapses to `"default"` — one bucket — so cache hits work as before.
The bucket only matters when two concurrent requests arrive tagged
with different scope tokens: each sees its own slice of the cache,
neither evicts the other's entries.

That's what Playwright's per-worker fixture gives us — each worker
writes and clears its own slice, so concurrent
`/__test/clear-caches` calls don't collide.

## `isTestMode()`

```ts
export function isTestMode(): boolean {
  return getStore().scope !== DEFAULT_SCOPE;
}
```

Returns `true` whenever the current request's scope is anything
other than `"default"`. In prod the `x-test-scope` header is
ignored, so the predicate is `false` everywhere — no way for a real
user to flag a request as "test".

Use it to narrow hand-crafted latency in demo code so e2e runs
don't burn wall time on artificial delays. Currently used by the
chat log producer (`src/app/chat/log.ts`); the chunk delay drops
from 100 ms to 5 ms and the budget from 10 s to 3 s under test
mode, cutting `chat-notes.spec` runtime ~3×.

**Don't apply globally.** Some specs assert on absolute-latency
behavior (Suspense fallback visible before its resolved content).
Uniformly shrinking demo delays breaks those assertions. Narrow
per-call only.
