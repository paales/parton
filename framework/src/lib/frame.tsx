/**
 * `<Frame>` — scope opener for a per-name URL space.
 *
 * A frame is a region of the page whose URL is independent of the
 * window URL. Partials inside a frame see the frame-resolved request
 * via their `vary({request})` — the framework resolves the request URL
 * through `parent.frameChain` to look up the session-bound frame URL.
 *
 * `<Frame>` is a plain component, not a constructor: nothing about a
 * frame needs define-time work beyond capturing its name + initialUrl.
 * The author owns placement and child threading.
 *
 *     <Frame name="cart" initialUrl="/cart/closed" parent={parent}>
 *       {(p) => (
 *         <>
 *           <CartHeader parent={p} />
 *           <CartBody parent={p} />
 *         </>
 *       )}
 *     </Frame>
 *
 * The render-prop child receives the extended `PartialCtx` (with this
 * frame's name appended to `frameChain`). Pass it as `parent` to every
 * spec inside.
 *
 * `useNavigation("cart").navigate(...)` writes the new URL to the
 * session-frame-URL store and triggers a refetch of every partial
 * whose snapshot's `framePath` includes "cart".
 *
 * See `docs/reference/frames-navigation.md`.
 */

import type { ReactNode } from "react"
import { FrameNameProvider } from "./partial-client.tsx"
import { type PartialCtx } from "./partial-context.ts"
import { getSessionFrameUrl, setSessionFrameUrl } from "../runtime/session.ts"

interface FrameProps {
  /** Local frame name. Joined with `parent.frameChain` to form the
   *  canonical session/wire key (`"products.list"` etc.). */
  name: string
  /** Cold-session default URL the frame resolves to before any
   *  client-side navigation. Optional — without it, descendants see the
   *  page request until the client navigates the frame. */
  initialUrl?: string
  parent: PartialCtx
  /** Render-prop. Receives a `PartialCtx` with this frame's name
   *  appended to `frameChain`; thread it to descendant specs via their
   *  `parent` prop. */
  children: (parent: PartialCtx) => ReactNode
}

export function Frame({ name, initialUrl, parent, children }: FrameProps): ReactNode {
  const ourFrameChain = Object.freeze([...parent.frameChain, name]) as readonly string[]

  // Cold-session: write initialUrl so descendants' frame-resolution
  // (and cache-mode re-renders that don't see the <Frame> ancestor)
  // find a URL via `getSessionFrameUrl`. Mirrors `PartialRoot`'s
  // handling of `?__frame=&__frameUrl=` URL params and the old
  // `partial({frame, frameUrl})` spec's render-time fallback.
  if (initialUrl != null && getSessionFrameUrl(ourFrameChain) == null) {
    setSessionFrameUrl(ourFrameChain, initialUrl)
  }

  const effectiveUrl = getSessionFrameUrl(ourFrameChain) ?? initialUrl ?? ""

  const childCtx: PartialCtx = {
    path: parent.path,
    frameChain: ourFrameChain,
  }

  return (
    <FrameNameProvider path={ourFrameChain} initialUrl={effectiveUrl}>
      {children(childCtx)}
    </FrameNameProvider>
  )
}
