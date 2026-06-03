/**
 * `<Frame>` — scope opener for a per-name URL space.
 *
 * A frame is a region of the page whose URL is independent of the
 * window URL. Partials inside a frame see the frame-resolved request
 * via their `vary({request})` — the framework resolves the request URL
 * through the frame chain to look up the session-bound frame URL.
 *
 * `<Frame>` is a plain component, not a constructor: nothing about a
 * frame needs define-time work beyond capturing its name + initialUrl.
 *
 *     <Frame name="cart" initialUrl="/cart/closed">
 *       <CartHeader />
 *       <CartBody />
 *     </Frame>
 *
 * Partons inside the frame inherit its name (appended to their frame
 * chain) via server context — no threading. `<Frame>` reads its own
 * parent the same way, so it just needs a `name` (+ optional initialUrl).
 *
 * `useNavigation("cart").navigate(...)` writes the new URL to the
 * session-frame-URL store and triggers a refetch of every partial
 * whose snapshot's `framePath` includes "cart".
 *
 * See `docs/reference/frames-navigation.md`.
 */

import type { ReactNode } from "react"
import { FrameNameProvider } from "./partial-client.tsx"
import {
  captureCurrentTask,
  getAmbientParent,
  setTaskChildContext,
  type PartialCtx,
} from "./partial-context.ts"
import { getSessionFrameUrl, setSessionFrameUrl } from "../runtime/session.ts"

interface FrameProps {
  /** Local frame name. Joined with the ambient frame chain to form the
   *  canonical session/wire key (`"products.list"` etc.). */
  name: string
  /** Cold-session default URL the frame resolves to before any
   *  client-side navigation. Optional — without it, descendants see the
   *  page request until the client navigates the frame. */
  initialUrl?: string
  /** Frame content. Partons inside it inherit this frame's chain via
   *  server context — no threading needed. */
  children: ReactNode
}

export function Frame({ name, initialUrl, children }: FrameProps): ReactNode {
  // Parent comes from server context (the ambient parton), not a prop.
  const task = captureCurrentTask()
  const parent = getAmbientParent()
  const ourFrameChain = Object.freeze([...parent.frameChain, name]) as readonly string[]

  // Cold-session: write initialUrl so descendants' frame-resolution
  // (and cache-mode re-renders that don't see the <Frame> ancestor)
  // find a URL via `getSessionFrameUrl`. Mirrors `PartialRoot`'s
  // handling of `?__frame=&__frameUrl=` URL params.
  if (initialUrl != null && getSessionFrameUrl(ourFrameChain) == null) {
    setSessionFrameUrl(ourFrameChain, initialUrl)
  }

  const effectiveUrl = getSessionFrameUrl(ourFrameChain) ?? initialUrl ?? ""

  const childCtx: PartialCtx = {
    path: parent.path,
    frameChain: ourFrameChain,
  }
  // Scope descendants: partons rendered inside the frame inherit this
  // frame-extended context as their ambient parent via the task graph.
  setTaskChildContext(task, childCtx)

  return (
    <FrameNameProvider path={ourFrameChain} initialUrl={effectiveUrl}>
      {children}
    </FrameNameProvider>
  )
}
