# Bare-key Suspense refetches

**Added:** 2026-04-16
**Supersedes:** the version-stamping mechanism described inline in
`src/lib/partial.tsx` and cross-referenced from `STREAMING_DEBUG_NOTES.md`.
**Why this matters:** client state (form focus, selection, scroll,
`useState` inside a partial) now survives a refetch.

---

## 1. What changed

Previously, `<Partial fallback={…}>` was wrapped in
`<Suspense key={`${id}#${streamVersion}`}>` where `streamVersion`
changed on every server render. React saw the version-stamped Suspense
as a new element, unmounted the old boundary, and mounted a fresh one —
producing the fallback flash and progressive reveal on refetch.

That remount also destroyed every client component inside the
boundary: a typed-in search field lost focus, a `useRef` counter
reset, scroll position was wiped, `useTransition`'s `isPending` on a
refresh button flickered off.

The version stamping is gone. Suspense keys are now always the bare
partial `id`. React reconciles each boundary in place. Client state
inside survives.

## 2. Why it still streams

The question that blocked this change last time: "without a key
change, React will batch the update into a transition and wait for the
whole new subtree before committing, so we lose per-chunk streaming."

That isn't what React 19 actually does. The commit path decides:

- **Inside a transition** (`React.startTransition`,
  `useTransition`): React preserves the current UI until the new
  render is fully ready. No fallback flash, no per-chunk streaming.
- **Outside a transition** (synchronous update, `flushSync`): when
  a Suspense boundary's children suspend, React switches to the
  fallback immediately. As each pending child resolves, React
  commits that subtree — which is the per-chunk streaming we want.

We commit partial refetches with `flushSync` already
(`entry.browser.tsx#fetchRscPayload`). So bare-key + flushSync still
gives progressive streaming AND in-place reconciliation. Both
behaviors we used to trade between, now available together.

The earlier note hedged with "flushSync mode: inner fallbacks still
flash, but the outer subtree reconciles in place — might work, but
less predictable." It turns out it just works — we tested it
empirically against React 19.3 canary with three staggered-delay
Suspense boundaries and observed per-boundary commits at ~0s, ~1s,
~2s matching the server-side delays.

## 3. Where the fallback goes

When a Suspense boundary re-suspends on update, React 19 keeps the
**old children** in the DOM, hidden (via an internal
display-style wrapper), and renders the fallback alongside them. When
the new content resolves, the fallback is removed and the new
children are revealed.

This has a real consequence for tests:

```ts
// BAD: old observers reported "content" whenever the content DIV
// existed, even while it was hidden behind a fallback.
if (content) parts.push(`S${i}:content`);
else if (fallback) parts.push(`S${i}:fallback`);

// GOOD: fallback-first. If the fallback element is in the DOM, the
// user is seeing the loading state regardless of whether the
// old content element is still hanging around hidden.
if (fallback) parts.push(`S${i}:fallback`);
else if (content) parts.push(`S${i}:content`);
```

Three e2e observers had this bug; all fixed alongside the refactor.

## 4. Default is preserve-UI; streaming is opt-in

The client wraps the default refetch commit in `React.startTransition`,
so React holds the current UI visible until the new content is fully
ready — no Suspense fallback flash, no per-chunk streaming. This is
the better default for "refresh the value in place" UX (cart badges,
live prices, hero panels).

Per-refetch opt-in: pass `disableTransition: true` to get a plain
commit that shows Suspense fallbacks and streams chunks as they
arrive:

```tsx
// Default — preserve UI, atomic swap.
usePartial("cart").refetch();

// Opt-in streaming for search / filter results.
usePartial("results").refetch(props, { disableTransition: true });
```

Under the hood the option sets `?disableTransition=1` on the refetch
URL; `fetchRscPayload` branches on that flag between `setPayloadRaw`
(plain setState) and `setPayload` (wraps in `startTransition`). The
`?revalidate=1` flag from the previous iteration is gone.

Server actions (setServerCallback in `entry.browser.tsx`) commit
action responses via `setPayload` unconditionally, so an
`invalidate` or `revalidate` directive from an action has the same
client-side commit behavior (preserve-UI). The
`invalidate` vs `revalidate` distinction in action return values is
currently a no-op — kept as an alias, removable or re-purposeable
later.

## 5. What was deleted

- `streamVersion` computation in `partial.tsx`.
- The `version` parameter threaded through `transformForStreaming`.
- The `isRevalidate ? id : `${id}#${streamVersion}`` branches in
  both streaming and cache-mode wrappers.
- The `renderRequest.url.searchParams.set("revalidate", "1")` block
  in `entry.rsc.tsx`. The `isExplicitInvalidate` / `isExplicitRevalidate`
  distinction is gone since neither changes server behavior.
- The `hashIdx = keyStr.indexOf("#")` key-splitting logic in three
  spots in `partial-client.tsx` (`substituteNested`,
  `cacheFromStreamingChildren`, and the cache-mode `Children.forEach`
  block). Keys are always partial ids now.
- The "key adoption" logic that cloned incoming children with a
  previously-cached key — redundant when keys are stable.

## 6. Regression test

`e2e/client-state-preservation.spec.ts` tags every
`RefreshPriceButton` with a random `__instanceId` on its DOM node
before a refetch, clicks one button, waits for the refetch to land,
then asserts every button's `__instanceId` is unchanged. With
version-stamped keys this failed because the outer Suspense remounted
and destroyed the DOM node.
