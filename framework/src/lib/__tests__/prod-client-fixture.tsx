"use client"

import type { ReactNode } from "react"

/**
 * Minimal `"use client"` passthrough for `server-context.rsc-prod.test.tsx`.
 * In the rsc harness it's stamped as a client reference, so its `children`
 * (a server consumer) serialise as a CLIENT-COMPONENT PROP — React's deferred
 * pass, the path the frames-demo bug lost the context on. Not a test file
 * (name doesn't match the rsc-prod glob).
 */
export function ClientWrap({ children }: { children: ReactNode }) {
  return children
}
