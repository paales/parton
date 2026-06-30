import { useSyncExternalStore } from "react"

const emptySubscribe = () => () => {}

/**
 * Returns `true` on the server and during hydration, `false` afterwards — so a
 * component can defer reading client-only values (sessionStorage, matchMedia,
 * a generated id) until past hydration, without a setState-in-effect and
 * without risking a hydration mismatch.
 */
export function useIsSSR(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => false,
    () => true,
  )
}
