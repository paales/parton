- <MediaQuery></MediaQuery>
- <LazyHydrate></LazyHydrate>
- <ViewTransition>
- <InfiniteScroll />

- Redirects
- Status codes
- Server Timing API
- If the Partial is the fundamental building block of the application, should (fake) 'Status Codes' and 'Redirects' also apply to Partials? A redirect would mean a state-change of the client.
- Implement a Partial debugging component to get a great debugging experience. Ideally this would function as an overlay like how the 'css grid' chrome inspector overlay works for example. Not affect the layouting of the page layout. css position-anchor?
- Global loading state and loading bubbling ideally, if there is something already possible from React it'sself that is fine as well, just create a demo.

- State storage locations
  - Request (URL, Cookie, Headers. etc.)
  - Extended Redis session storage
  - Browser state locations + a deferred Partial
    - SessionStorage / LocalStorage / IndexedDB /
    - IntersectionObserver / ResizeObserver (Fragment refs)

- Remote rendered: Should an instsance of the framework be able to just output RSC and let a second instance of the RSC pick that up. That means that we'd effectively get server side iframes?
  - Evaluate of building a ServiceWorker compatible renderer makes sense here as well.
  - Allow defining security semantics to implement this.

- The refetch policy of a Partial and how it should fall back should depend on the Partial and not the caller I think. By default everything should resolve synchronously without any additional configuration.

- Question, not a discredit: I'm unclear why we are still using stripPartials and statically walking the children tree, this doesn't scale and needs to be abolished if possible. Its ok for now, but It remains unclear what subtle bugs this is causing, because how do opaque children work, we need those as well? If we've got Dynamic Partial holes, why can't all Partials by dynamic, what is the tradeoff?

- Later: GraphQL @defer support in combination with Suspense.
- Later: GraphQL response cache and query caching. Add a product to the cart and dont need to refetch the cart because the same normalized cache is shared between the two requests, creating a faster roundtrip.

- In a client information first scenario we could send much more information to the server based on the browser context they are in; So for example we'd build a MediaQuery component that shows content conditionally based on the browsers viewport we could upgrade this component on the next fetch to not even return it.

- In a multiplayer game what is actually send to the server and what state is returned, the DOM can be thought of the positions of other entities in a game, streamed over the network. Client components are the local bit. This loop is quick and streaming both directions simultaneously we should dig into multiple streams happening at the same time.

- I was thinking how to implement continuously streaming content and how to implement this. The fake way is to do continous polling but push is another paradigm not fully expored. Lets say we're building an AI chat where the responses trickle in. The chat window clearlly is an InfiniteScroll situation, now dissimilar from a infinitely scrolling product listing, the difference is that it can be continuously appended with new information. I think a Vercel AI chat does a recursive <Piece/> where the <Piece/> renders the <Suspense><Piece /></Suspense> and it unifies this with some form of generator function or something? What are options here. I thouhgt about doing a redirect at the end of the render and let the GET request be a multipart stream so we split the stream into multiple streams? Altough that isn't really a push stream on the server, it is from a client perspective?

- Sharp edge: By default I dont want the frame's navigation to always influence the page's history state. So by default a navigate should be a replace on the window instead of a push? So NavigationHistoryBehavior auto should be replace for a frame and the browsers default for the window. The frame's navigation state should be push on auto. Does that make sense? -> claude -r for the research.

- Don't care but I'm unsure: Should cache be directly rolled insto Partial, would that offer any benefit?
- Don't care but I'm unsure: Should all Partial always be cached once that only serves as a template so we can very quickly traverse to the Partial? It's not clear to me how the ProductPrice now gets accessed in a performant way.

- Can data based cache register a cache tag so cache can be flushed based on this tag?
