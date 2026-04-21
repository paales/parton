# Server request isolation — module state audit

**Added:** 2026-04-19
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

### C — Intentional server shared (safe, atomic Map/Set ops)

Deliberately process-wide. Reads/writes rely on the fact that `Map#get`/`Map#set`/`Set#add`/`Set#delete` each complete atomically in a single-threaded Node runtime — no torn reads even when multiple requests touch the same key concurrently.

| File:Line | Container | Purpose |
| --- | --- | --- |
| `src/lib/cache.tsx` (`store`) | `CacheStore` impl | Render-output cache (Flight bytes). |
| `src/lib/cache.tsx:143` | `snapshotIndex: Map<string, Map<string, PartialSnapshot>>` | Dynamic-partial snapshots per cache key. |
| `src/lib/cache.tsx:164` | `manifestStore: Map<string, Set<string>>` | Auto-tracked cache-key manifests. |
| `src/lib/cache.tsx:166` | `refreshing: Set<string>` | SWR in-flight guard. Benign race — see note below. |
| `src/lib/cache.tsx:685` | `inFlightMiss: Map<string, Promise<…>>` | Cold-miss dedupe. |
| `src/lib/partial-cache.ts:26` | `cache: Map<string, CacheEntry>` | GraphQL response cache. |
| `src/lib/partial-registry.ts:52` | `registry: Map<string, Map<string, PartialSnapshot>>` | Route-scoped Partial registry. |

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
// CATEGORY C — intentional shared. Key includes request variants via the
// manifest, so entries are safe to share across users.
const cacheStore = new Map<string, Entry>();
```

A PR that adds a server-side `let x = …` without that annotation should be treated as suspect. If the answer turns out to be Category A, the fix is to move the state into an ALS scope (follow `requestContext` / `manifestContext`), never to leave it as-is.

## Why not just wrap everything in ALS?

ALS is a *request-scoped* container. Entries die with the request. The caches in Category C have to survive across requests — that's the whole point. Wrapping them in ALS would make every request a cold miss, defeating the cache. The separation in this codebase is already correct; the audit only confirmed it.
