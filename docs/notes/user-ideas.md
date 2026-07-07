- [ ] Reiterate: Redirects / status codes and rewrites as a router iterator. Ideally we should be able to handle URL rewrites where pretty URL's will be rewritten into internal routing URL's etc. The current route matcher should have an ergnomic to do an internal rewrite.

- [ ] A <Frame /> is the encapsulated page with it's own URL, what if nothing matches, shoudl a frame automatically be a route matcher as well that can iterate, interally rewrite, redirect or be a 404?

- [ ] Migrate to a more classic monorepo setup with a packages and examples directory. Have a better usage guide for /client and /server exports so that they dont conflict. Should each package have both exports?

- [ ] InfiniteScroll: The current example in the frontend is highly incomplete and doesn't allow scrolling back, restoring state on refresh, not tested that scroll positions restore, doesn't reserve space further below the fold, doesn't accept async iterators as a streaming primitive, can't handle grid items etc.

- [ ] Make sure the ViewTransitions are properly documented.

- [ ] MediaQuery / LazyHydrate: Should render the DOM fully on the server but doesn't but it is stale. This is a primitive to strongly reduce the TBT on initial render while keeping SEO indexability for 'dumb' components working. Maybe this is the react Activity component but forced to be visible? Might that be possible? Activity renders on a very low priority. Worth discussing if this makes sense in a modern situation.

- [ ] So the CMS is a template builder that allows us to fix the strings of the templates and confiure the layout. However we also need to render those templates for the content, right? So is a sitemap created and how is the CMS section working here. Building a sitemap builds the available routes? Not completely because certain information might be private and completely arbitrary. But we do define routes with the match props and these props and it's vary options to render the variants of these sections.

- [ ] So the page template editor ALSO can be the content of a wysiwyg editor, we don't want to build a wysiwyg editor, but there is overlap. In Shopify for example you quickly need to create separate blog templates to do something special because the wysiwyg editor doesn't give you enough leverage. Sooo, the block editor should be able to do recursive block editors? Where a template nests in another template?

- [ ] Should gqlCell also get a batch resolver, this is a common prmitive in building resolvers and this situation looks similar, right? Or is this something a graphql server should just efficiently handle?

- [ ] Optimize the streams and connection paradigms with websockets or the new QUIC network channel.

Re: Server context:

- [ ] Should and can we make a new server context API available to the user? The tracing of the parent/child relation is the threading that allows us to do create server context, but does this also mean we can get `const MyContext = createServerContext(null) > <MyContext value={xyz}/> + use(MyContext)?`

---

For the demo website I'd like to make a grid with chunks that are 512x512 in size. Each chunk consists of 32x32 tiles, making each tile 16x16px in size.
This whole page is a infinite scroller to the left/right/top/bottom. For this to work we need our infinite scroller working perfectly.
To achieve a large infinite scroller we can create larger bigChunks of 8x8 chunks so that we do not output all chunks all the time. Lets add 8x8 bigChunks on the page.
Make sure with the correct scroll position we start at the center.
Each tile has a coordinate in the top left 0,0, 1,1, etc.
Each tile should get a light on the top right that flashes different colors depending on the frequency (green>blue>white), like a network light in the top left.
The background of the tiles is a checkboard patter OR a line grid split up into prominent and less prominent lines
Navigation should be possible with WASD but also draggable on mobile.
In this demo I want to showcase all possible features that are in the framework and how they are supposed to work.
I perhaps want to start out with a single chunk and progressively expand the world, exlaining every new information piece.
I want to tell this in a story form, like you are embarking on a new adventure through the world of frameworks.
This is clearly drawing inspiration from Factorio in the UI department and I want to target fellow developers deeply with this.

```

+------------------------------------+------------------------------------+
| 0,0                              ⊙ | 0,1                              ⊙ |
| Parton: An RSC native framework    | This was a navigation              |
|                                    |                                    |
| A parton is an enhanced component  | A new parton was rendered.         |
| One part on the client             | The first parton was untouched     |
| One part on the server             | Not only by the client             |
|                                    |                                    |
| Partons can talk over the network  | But also by the server             |
|                                    |                                    |
| On each navigation the parton      | Partons can also                   |
| communicates it's own existence    |                                    |
| [`navigate('?page=2`)]             | [`navigate('?page=2&variant=2')]   |
|                                    |                                    |
+------------------------------------+------------------------------------+
```

When navigating to variant=2 we change the content of 0,0 and not 0,1:

+---
| Each navigation is a full rerender
| by the server, but only the parts
| that need rerendering are.
|
| if(searchParam('variant') === 2){}
| return <>Each navigation...
| else
| return <>Parton: An RSC
|
|

---

Keepalive+Activity
Cache
Loading+Fallback
Streaming vs Transition

Cells
Actions + Atomic cells
