"use client"

import type { ReactNode } from "react"
import { useNavigation } from "@react-cms/framework/lib/partial-client.tsx"
// `EDITOR_COOKIE` is a plain const re-exported through the
// server-side barrel — importing it from a `"use client"` file via
// the barrel mis-resolves the Flight reference (same caveat as the
// `useNavigation` / `setSessionValue` cases). Deep-import keeps the
// const as a literal string at bundle time.
import { EDITOR_COOKIE } from "@react-cms/framework/runtime/cms-runtime.ts"

/**
 * Closes design mode by flipping `EDITOR_COOKIE` off via the
 * navigation API's client-side `cookies` option. One round trip
 * (the refetch fetch ships the new cookie value); no server
 * action, no `setCookie` side-effect in render.
 */
export function EditorCloseLink({
  className,
  title,
  testId,
  children,
}: {
  className?: string
  title?: string
  testId?: string
  children: ReactNode
}) {
  const nav = useNavigation()
  function onClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return
    }
    e.preventDefault()
    void nav.navigate(window.location.pathname + window.location.search, {
      history: "replace",
      cookies: { [EDITOR_COOKIE]: "" },
      selector: "#editor-shell",
    })
  }
  return (
    <a
      href="#"
      onClick={onClick}
      className={className}
      title={title}
      aria-label="Close editor"
      data-testid={testId}
    >
      {children}
    </a>
  )
}
