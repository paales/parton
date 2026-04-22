# Server request isolation — module state audit

**Added:** 2026-04-19
**Updated:** 2026-04-22 — Category C is now *scope-bucketed* so Playwright `workers > 1` works. Every Category C container lives behind a `Map<scope, …>` keyed by `getScope()`; production still collapses to a single `"default"` bucket so semantics are unchanged.

**Question from `user-ideas.md`:** *"How is the 'server' doing? I assume each module scoped variable should be request scoped? We can wrap everything in a ALS to get this isolation right?"*

**Short answer:** Not every module variable needs ALS. Blindly wrapping every container in `AsyncLocalStorage` would break the intentional caches (they're *supposed* to persist across requests — that's what makes them caches). The correct framing is: every piece of module-scoped mutable state has to sit in one of four categories, and a new one can't be added without picking a category and justifying it.

## The four categories

### A — Server request-scoped (**concurrent-unsafe**, never OK)

A `let` or mutable container on the server that's read/written *during a single request*. Two concurrent requests would see each other's writes. **No instances today.** If you find yourself wanting one, the fix is always "put it in ALS" — use `requestContext` in `src/framework/context.ts` as the pattern.

### B — Client-only (safe, per-browser-tab)

File carries `"use client"` or is only loaded by the browser entry. Module state is per-tab — concurrent *server* requests never see it.

| File:Line | Container |
| --- | --- |
| `src/lib/partial-client.tsx:419` | `_cache: Map<string, ReactNode>` |
| `src/lib/partial-client.tsx:420` | `_fingerprints: Map<string, string>` |
| `src/lib/partial-client.tsx:421` | `let _debug: PartialDebugEntry[]` |
| `src/lib/partial-client.tsx:433` | `let _template: ReactNode` |
| `src/lib/partial-client.tsx:434` | `let _templateRoute: string \| null` |
| `src/lib/partial-client.tsx:458` | `let _transientParams: Record<string, …> \| null` |
| `src/app/components/load-more.tsx:12` | `visiblePages: Set<number>` |

### C — Intentional server shared (safe, atomic Map/Set ops, scope-bucketed)

Deliberately process-wide. Reads/writes rely on the fact that `Map#get`/`Map#set`/`Set#add`/`Set#delete` each complete atomically in a single-threaded Node runtime — no torn reads even when multiple requests touch the same key concurrently.

Every container below is bucketed by `getScope()` from `src/framework/context.ts` — the outer map is `Map<scope, <the original container>>`. Production always maps to `"default"` → one bucket → same cache-hit behavior as pre-scoping. In dev, an `x-test-scope` request header chooses the scope (Playwright fixtures stamp `worker-<N>` per worker so `fullyParallel: true` is safe).

| Container | Purpose |
| --- | --- |
| `src/lib/cache.tsx` — `ScopeState.store` (`MemoryCacheStore`) | Render-output cache (Flight bytes). |
| `src/lib/cache.tsx` — `ScopeState.snapshotIndex` | Dynamic-partial snapshots per cache key. |
| `src/lib/cache.tsx` — `ScopeState.manifestStore` | Auto-tracked cache-key manifests. |
| `src/lib/cache.tsx` — `ScopeState.refreshing` | SWR in-flight guard. Benign race — see note below. |
| `src/lib/cache.tsx` — `ScopeState.inFlightMiss` | Cold-miss dedupe. |
| `src/lib/partial-cache.ts` — `scopes` | GraphQL response cache. |
| `src/lib/partial-registry.ts` — `scopes` | Route-scoped Partial registry (`scope → route → id → snapshot`). |
| `src/framework/session.ts` — `scopes` | Frame-session store (cookie session-id → frame URLs). |
| `src/app/chat/log.ts` — `scopes` | Chat streaming log (per fileId → MessageLog). |
| `src/app/pages/cache-demo.tsx` — `slowRenderCounts` | Demo page render counter. |

Public clear APIs (`clearCache`, `clearRegistry`, `_clearAllSessions`, `_clearLogs`, `_clearCache`) accept an optional scope argument. No argument — or `"all"` — clears every scope (HMR dispose + debug-toolbar flush). A specific scope clears just that worker's bucket (the `/__test/clear-caches` endpoint reads `x-test-scope` from the request and forwards it). This means `beforeEach` clears in one Playwright worker don't wipe another worker's cache.

The `refreshing` Set is a loose "is anyone refreshing this key right now" flag. Two concurrent requests can both see `!has(key)` before either adds — resulting in two background refresh kicks instead of one. Cache *reads* still return the stale bytes in both cases, so correctness is preserved; the cost is extra refresh work in a millisecond-wide race window. Intentional trade-off for simplicity; documented here so nobody tries to "fix" it with a mutex.

### D — Already ALS-scoped (safe, per-request)

| File:Line | ALS |
| --- | --- |
| `src/framework/context.ts:23` | `requestContext` — request + cookies |
| `src/framework/context.ts:50` | `manifestContext` — per-Partial cache-access manifest |
| `src/lib/partial-request-state.ts` | `als` — per-request Partial state (requestedIds, inputs, fingerprints, seenIds) |

## The rule for future additions

When you add module-scoped mutable state to anything that might run on the server, annotate it with a one-line comment stating the category and why:

```ts
// CATEGORY C — intentional shared. Keyed by request manifest, so entries
// are safe across users. Bucketed by scope() for test-worker isolation.
const scopes = new Map<string, Map<string, Entry>>();
function bucket(scope = getScope()) {
  let b = scopes.get(scope);
  if (!b) scopes.set(scope, (b = new Map()));
  return b;
}
```

A PR that adds a server-side `let x = …` without that annotation should be treated as suspect. If the answer turns out to be Category A, the fix is to move the state into an ALS scope (follow `requestContext` / `manifestContext`), never to leave it as-is. If Category C, add the scope bucket — ungated Category C state kills `workers > 1` reliability in e2e tests.

## Why not just wrap everything in ALS?

ALS is a *request-scoped* container. Entries die with the request. The caches in Category C have to survive across requests — that's the whole point. Wrapping them in ALS would make every request a cold miss, defeating the cache. The separation in this codebase is already correct; the audit only confirmed it.

## Why a scope bucket, not ALS, for parallel tests?

A scope bucket is the map *inside* Category C, keyed by an opaque token the request carries in `x-test-scope`. Lifetime is still "until the process restarts" — production requests all collapse to `"default"` so cache hits work as before. The bucket only matters when two concurrent requests arrive tagged with different scope tokens: each gets its own view of the same cache, and neither can see or evict the other's entries. That's what Playwright's per-worker fixture gives us — each worker writes and clears its own slice, so concurrent tests that both hit `/__test/clear-caches` don't trample each other.

## `isTestMode()` — tighten hand-written demo delays under Playwright

Added 2026-04-23 to `src/framework/context.ts`. Returns `true` when
the current request's scope is anything other than `"default"`. In
prod the `x-test-scope` header is ignored, so the predicate is
`false` everywhere — no way for a real user to tag a request as
"test".

Use it to narrow hand-crafted latency in demo code. The chat-stream
producer (`src/app/chat/log.ts`) is the current caller: its 100 ms
× 10 s budget would dominate e2e runtime otherwise — under test
mode the chunk delay drops to 5 ms and the budget to 3 s, keeping
the compaction seam observable while cutting the `chat-notes.spec`
wall time roughly 3×.

**Not** wired up in the Pokemon/Magento/cache-demo simulated
delays. Tried a shared `simulatedDelay(ms)` helper that scaled
everything down; it broke `search-streaming.spec.ts` and
`search-open-first-keystroke.spec.ts` — those specs assert that a
Suspense fallback is visible before its resolved content, and at
test-scaled latencies the fallback flashes too fast for the
observer to catch it. Conclusion: don't globally shrink demo
latency; reduce per-spec only where the spec isn't asserting on
latency-sensitive behaviour.
