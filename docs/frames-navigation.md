# Frames + navigation

A **frame** is a server-iframe — a region of the page whose URL
scope is independent of the window URL. A spec opens a frame by
declaring `frame: "name"` in its options. Descendants' `vary`
callbacks see the frame-resolved request, not the page request.

```tsx
const CartFramePartial = ReactCms.partial(CartFrameRender, {
  selector: "#cart",
  frame: "cart",
  frameUrl: "/cart/closed",
  vary: ({ request }) => ({
    state: parseCartState(new URL(request.url).pathname),
  }),
})
```

The `request` arg here resolves against the frame's URL (e.g.
`/cart/open`), not the window URL.

## Resolution order

For a frame at path `[outer, inner]` (joined as `"outer.inner"`):

1. Server session entry for that path (cookie-backed; survives
   nav).
2. The spec's `frameUrl` option (cold-session default).
3. The page request (frame and page agree — no-op frame).

## Nested frames

```tsx
const CartTabPartial = ReactCms.partial(CartTabRender, {
  selector: "#cart-tab",
  frame: "tab",
  frameUrl: "/items",
  vary: ({ request }) => ({ pathname: new URL(request.url).pathname }),
})

// Inside the cart frame's render:
function CartFrameRender({ parent }) {
  return <CartTabPartial parent={parent} />
}
```

The cart-tab spec inherits the cart frame from `parent.frameChain`,
appends its own `tab` name, and resolves against the `cart.tab`
session entry. A second `tab` frame nested under `menu` resolves to
`menu.tab` — independent state.

## Navigation

Client-side: `useNavigation(frameName?)` returns a handle.

```tsx
const nav = useNavigation()              // window scope
const cartNav = useNavigation("cart")    // cart frame scope

cartNav.navigate("/cart/open")
nav.navigate("/products?page=2")
nav.reload({ selector: "#cart" })
```

`navigate` accepts a string, a `URL`, or an updater function
`(url: URL) => URL | void`. `reload` accepts an options bag with
`selector` (CSS-style `#unique` / `.shared` tokens, space-joined)
and various lifecycle flags.

When called with no name, `useNavigation()` looks up the closest
ambient frame from the React context (set by the spec's frame
wrapper) and falls back to the window. Buttons inside a framed
spec naturally navigate that frame; buttons outside drive the
window.

## Frame URL on the wire

```
?__frame=<dotted-path>&__frameUrl=<url>
```

`PartialRoot` reads these on every request and writes the URL into
the session before any spec runs. Subsequent specs that open the
named frame pick up the new URL via `getSessionFrameUrl()`.

## Sharp edges

- **Frame URL is shared per session.** Two tabs viewing the same
  app see each other's frame state through the session cookie.
  Per-tab frame state would require per-tab session ids (not yet
  implemented).
- **`frameUrl` is a fallback, not an override.** Once the session
  has a URL for the frame, the option is ignored. Use
  `clearSessionFrame(path)` to drop it.
- **Nested frames need explicit threading.** A nested frame spec
  must receive its `parent` from the host spec's render args
  (`<CartTabPartial parent={parent} />`); placing it with `ROOT` as
  parent strips the ambient frame chain.
