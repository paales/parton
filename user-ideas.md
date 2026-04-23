- Redirects
- Status codes
- Server Timing API
- If the Partial is the fundamental building block of the application, should (fake) 'Status Codes' and 'Redirects' also apply to Partials? A redirect would mean a state-change of the client.

- [ ] Remote rendered: Should an instsance of the framework be able to just output RSC and let a second instance of the RSC pick that up. That means that we'd effectively get server side iframes?
  - Evaluate of building a ServiceWorker compatible renderer makes sense here as well.
  - Allow defining security semantics to implement this.
  - This seems to look like cache, but the current cache solution doesn't allow streaming, right? OR is the partial stream cached here and we just don't see the stream?

- The refetch policy of a Partial and how it should fall back should depend on the Partial and not the caller I think. By default everything should resolve synchronously without any additional configuration.

- [ ] Later: GraphQL @defer support in combination with Suspense.

- [ ] Later: GraphQL response cache and query caching. Add a product to the cart and dont need to refetch the cart because the same normalized cache is shared between the two requests, creating a faster roundtrip.

- [ ] In a client information first scenario we could send much more information to the server based on the browser context they are in; So for example we'd build a MediaQuery component that shows content conditionally based on the browsers viewport we could upgrade this component on the next fetch to not even return it.

- [ ] In a multiplayer game what is actually send to the server and what state is returned, the DOM can be thought of the positions of other entities in a game, streamed over the network. Client components are the local bit. This loop is quick and streaming both directions simultaneously we should dig into multiple streams happening at the same time.

- [ ] Migration to a monorepo so we reduce the context that LLM's have to spit through so it can remain more focussed.

- [ ] InfiniteScroll: The current example in the frontend is highly incomplete and doesn't allow scrolling back, restoring state on refresh, not tested that scroll positions restore, doesn't reserve space further below the fold, doesn't accept async iterators as a streaming primitive, can't handle grid items etc.

- [ ] ViewTransition: Show and explain how view transitions are supposed to work in the application in combination with partials of course.

- [ ] MediaQuery / LazyHydrate: Should render the DOM fully on the server but doesn't but it is stale. This is a primitive to strongly reduce the TBT on initial render while keeping SEO indexability for 'dumb' components working. Maybe this is the react Activity component but forced to be visible? Might that be possible? Activity renders on a very low priority.

- [ ] I've noticed a scope creep throughout the years, people solve the problems they see, they don't solve the problems they don't see. So for example the dialog component is imperfect and complex UI developers will choose to

- [ ] Global/Frame loading states; Render the loading and receiving state like the browser spinner does. statend loading bubbling ideally, if there is something already possible from React it'sself that is fine as well, just create a demo.

- [ ] I really like our approach that we are taking. Rerender the whole page with all these Partial and frames and be able to stream in changes from multiple frames at the same time, all intertwined, multiple requests in parallel and you decide whether is is using startTransition or not, is everything popping in and falling back to loading states or are we do it nicely in one go. But from a technical perspective we rerender the whole tree and strip out everything the client knows. 'Rerender the whole world, but make it fast' imo. I _think_ the amount of server components / partials a page loads is limited so we won't run into big performance hits. What is a test harness to validate that we transfer the minimal amount of tree from the server to the client to rerender the specific parts?

- [x] Partial+Frame debugging component — landed 2026-04-24 as `src/lib/partial-debug.tsx` (`<PartialsDebug/>` mounted once at the end of `<body>` in dev mode). Exposes one row per active Partial with reload pills (hashed-HSL per token, dim on `reload({selector})` in flight), frame back/forward (hidden when the handle is the window), the partial's frame-or-page URL, and the frame entry state with the framework-internal `__frames` / `__frameHistory` buckets stripped. Replaces the old `DebugToolbar` + `PartialDebugPanel` surface (both removed) and the `FrameNavigationBar` demo widget (also removed). Tradeoff: the spec called for an outlined rect overlay anchored to each Partial's DOM range; the attempted implementations (Fragment ref in a `"use client"` wrapper around children, `<span hidden>` start/end markers, `<div style="display:contents">` wrap) all broke cache-mode refetch reconciliation in Partials with nested content (notably the Magento cart-in-header refetch) — any injected client-component boundary or fragment-with-extra-siblings around a Partial subtree interferes with `cacheFromStreamingChildren` / `renderTemplate`. Registry-only metadata (passed through `PartialErrorBoundary`'s new `debugUniqueTokens` / `debugSharedTokens` / `debugFramePath` props and published via `queueMicrotask` to avoid setState-in-render) was the workable shape. The rect overlay is filed under future work — pending either a non-injecting DOM-discovery technique or a partials-architecture change that tolerates a wrap.
