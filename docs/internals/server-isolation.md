# Server isolation

The framework holds module-global state that needs bucketing so
parallel test workers don't contend:

| State                                                                            | Module                                           |
| -------------------------------------------------------------------------------- | ------------------------------------------------ |
| `<Cache>` render-output store                                                    | `framework/src/lib/cache.tsx`                    |
| Partial registry (variant store + per-route hint LRU)                            | `framework/src/lib/partial-registry.ts`          |
| Session store (frame URLs)                                                       | `framework/src/runtime/session.ts`               |
| Cell storage (per-scope value buckets; only the default scope persists to disk)  | `framework/src/runtime/cell-storage.ts`          |
| Invalidation registry (entry store + wake index; see the confinement rule below) | `framework/src/runtime/invalidation-registry.ts` |
| Scheduled-task dedup keys                                                        | `framework/src/runtime/context.ts`               |
| App-level producers (e.g. the chat log)                                          | `e2e-testing/src/app/chat/log.ts`                |

Each one keys its top-level map by `getScope()`:

```ts
const scopes = new Map<string, ScopeState>()

function bucket(scope: string = getScope()): ScopeState {
  let s = scopes.get(scope)
  if (!s) {
    s = makeFresh()
    scopes.set(scope, s)
  }
  return s
}
```

## Scope derivation

`framework/src/runtime/context.ts::deriveScope`:

- Production: every request → `"default"`.
- Dev with `x-test-scope: <value>` header → `<value>` (the header
  is honoured only under `import.meta.env.DEV`).

The Playwright fixtures (`e2e-testing/e2e/fixtures.ts`) stamp every
page and API-request context with `x-test-scope: worker-<N>` via
`setExtraHTTPHeaders`, so parallel test runs map to per-worker
buckets; state can't cross-contaminate. `<RemoteFrame>` forwards the
header on its internal fetch, so remote renders land in the host
request's bucket. The `/__test/clear-caches` endpoint wipes the
calling scope's buckets (`?all=1` wipes every scope).

## Invalidation confinement

`refreshSelector` bumps ride the same seam. The registry's entry
store AND its inverted wake index bucket per scope, and the rule is:

- A bump committed under a scope (the ambient `getScope()` of the
  writing request — a spec worker's action POST, a scheduled task
  re-entering its originating scope) is **confined**: it delivers
  only to that scope's wake registrations, and only that scope's fp
  folds (`queryMatchingTs`) read its ts. One worker's tag/cell bump
  can neither wake another worker's held connections nor move their
  fingerprints.
- A **scope-less** bump (ambient scope `default` — production always,
  and any commit outside a request context: a bench driver's direct
  `refreshSelector`, the cross-process bridge's inbound apply) is
  global: every scope's registrations receive it and every scope's
  queries fold it.

Scoped readers fold their own bucket plus the default bucket; a
default-scope reader — production's only shape — reads exactly its
one bucket, so the production path is the one-bucket process-global
registry it always was. The timestamp counter (`nextTs`) and the
epoch stay global: folds need monotonicity, not a per-scope clock,
and one timeline keeps every cursor comparable across buckets. The
soak bench (`bench/server/soak-runner.ts`) leans on both halves: its
connections attach under per-connection scopes while its bumps fire
scope-less, reaching every connection whose selector matches — the
disjoint per-connection selectors are what make a bump miss the
other N−1.

## CMS draft store

`cms/data/draft.json` is on-disk and shared across processes —
per-process scoping doesn't extend to the file system.
`/__test/clear-caches` deletes it only when explicitly asked
(`?cms=1`, or the wholesale `?all=1`). Tests that write to draft
must run serially within one worker, or accept that draft state
leaks across them.
