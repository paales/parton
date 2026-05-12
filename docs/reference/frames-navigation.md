# Frames + navigation

A **frame** is a server-iframe — a region of the page whose URL
scope is independent of the window URL. Wrap a subtree in `<Frame
name initialUrl>` to open a frame scope. Partials inside see the
frame-resolved request via their normal `vary` (the framework
swaps the request URL via the ambient frame chain).

```tsx
const CartContent = ReactCms.partial(CartContentRender, {
  selector: "#cart",
  vary: ({ pathname }) => ({ state: parseCartState(pathname) }),
})

<Frame name="cart" initialUrl="/cart/closed" parent={parent}>
  {(p) => <CartContent parent={p} />}
</Frame>
```

`<Frame>` is a plain React component — no constructor. It extends
`parent.frameChain` with its name, writes `initialUrl` to the
session-frame-URL store (so descendants find it via session lookup),
and provides the `useNavigation("cart")` context to client
descendants. The render-prop child receives the extended
`PartialCtx`; thread it as `parent` to every spec inside.

Multiple sibling partials can live in one frame:

```tsx
<Frame name="cart" initialUrl="/cart/closed" parent={parent}>
  {(p) => (
    <>
      <CartHeader parent={p} />
      <CartBody parent={p} />
      <CartFooter parent={p} />
    </>
  )}
</Frame>
```

## Resolution order

For a frame at path `[outer, inner]` (joined as `"outer.inner"`):

1. Server session entry for that path (cookie-backed; survives
   nav).
2. The spec's `frameUrl` option (cold-session default).
3. The page request (frame and page agree — no-op frame).

## Nested frames

Nest a `<Frame>` inside another to extend the frame chain:

```tsx
<Frame name="cart" initialUrl="/cart/closed" parent={parent}>
  {(p) => (
    <CartContent parent={p}>
      <Frame name="tab" initialUrl="/items" parent={p}>
        {(tabParent) => <CartTab parent={tabParent} />}
      </Frame>
    </CartContent>
  )}
</Frame>
```

The inner `<Frame>` extends `parent.frameChain` from `["cart"]` to
`["cart", "tab"]`. Inside `CartTab`, `useNavigation("tab")` binds to
the nested frame and resolves against the `cart.tab` session entry.
A second `tab` frame nested under `menu` resolves to `menu.tab` —
independent state.

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

### Targeted refetch with explicit props

Both `navigate` and `reload` accept an optional `props` bag that
threads JSX-style call-site props into the targeted refetch:

```tsx
nav.navigate(url, {
  selector: "#slow",
  props: { slow: { flavor: "chocolate" } },
})
```

Keys are partial ids (the selector token without the leading `#`).
On the server, these props override the snapshot-replayed call-site
props in `partialFromSnapshot`, so a deep partial-refetch can carry
fresh values without re-running the parent wrapper. The values land
in `Render`'s prop bag alongside any vary-derived keys (vary still
wins on collision). Cached specs that should react to a prop change
need to read the same value from the URL in their own `vary` — a
cache-mode refetch derives its key from `vary`'s output, not from
the threaded prop.

The wire format is `?partialProps={"<id>":{<propName>:<value>}}`.
`<WhenStored>` and the other activators all funnel through this
same surface — `useActivate(...).fire({ props })` calls
`nav.reload({ selector, props })` internally, so there's exactly
one public refetch path.

### Other commit knobs

| Option | Effect |
|---|---|
| `disableTransition: true` | Commit without `startTransition`, so Suspense fallbacks paint and Flight chunks reveal per-row. Default is transition-wrapped (atomic swap, no fallback flash). |
| `silent: true` | Update the URL without firing any refetch. Wins over `selector` if both are set. Ignored on frame handles. `navigate`-only. |
| `props` | See above. |
| `cookies` | Write client-side cookies before the refetch fires. `navigate`-only — `reload` does not accept it. |

### Cookies

`navigate` accepts a `cookies` option that writes `document.cookie`
synchronously before the refetch fetch is issued, so the new values
travel in the upcoming request's `Cookie` header:

```tsx
nav.navigate(window.location.pathname + window.location.search, {
  cookies: { theme: "dark" },
  selector: "#theme-aware",
})
```

The example above passes the current URL, so `history: "auto"` (the
default) resolves to **replace** — no new history entry, just a
refetch with the new cookie. To navigate AND set a cookie, pass a
different URL:

```tsx
nav.navigate("/checkout", { cookies: { currency: "EUR" } })
```

Here `auto` resolves to **push** and the cookie rides along into
the navigation.

`reload` deliberately does NOT accept `cookies` — cookies represent
a client-state change, and that change implies a `navigate`. The
`navigate(currentUrl, { cookies })` form is the canonical
"refetch with new cookies" call.

`cookies` is a plain `Record<string, string>`. An empty string
deletes the cookie (`max-age=0`); any other value writes it with
defaults `path=/`, `samesite=lax`, `max-age=31536000` (one year).
Frame handles also write to `document.cookie` — a global write, the
same any other handle would do. There is no per-frame cookie scope
today.

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
- **`initialUrl` is a fallback, not an override.** `<Frame>` writes
  it to session on first render only if the session has no entry for
  the frame path. Once the user navigates the frame, the session URL
  takes over. Use `clearSessionFrame(path)` to drop it.
- **Nested frames need explicit threading.** The inner `<Frame>` must
  receive its `parent` from the outer render-prop callback (not
  `ROOT`); passing `ROOT` strips the ambient frame chain.
