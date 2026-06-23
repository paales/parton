/**
 * Classification guard for <NavigationErrorBoundary>.
 *
 * The boundary recovers from transient navigation stream tears and
 * rethrows everything else to <GlobalErrorBoundary>. That split rides
 * entirely on `isTransientNavError`'s message/name matching, so this
 * pins the set: a regression here either strands the user on the error
 * page (a tear stops being recoverable) or masks a genuine app bug (a
 * real error gets silently swallowed as "transient").
 */

import { describe, expect, it } from "vitest"
import { isTransientNavError } from "../error-boundary.tsx"

describe("isTransientNavError", () => {
  it("treats navigation stream tears as recoverable", () => {
    // A superseding navigation tears the in-flight Flight stream.
    expect(isTransientNavError(new Error("Connection closed."))).toBe(true)
    // A newer navigation aborts the prior one (normal lifecycle).
    expect(isTransientNavError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(
      true,
    )
    // The server couldn't finish a streamed Suspense boundary.
    expect(
      isTransientNavError(new Error("The server could not finish this Suspense boundary")),
    ).toBe(true)
    expect(isTransientNavError(new Error("BodyStreamBuffer was aborted"))).toBe(true)
    // Concurrent-commit DOM reconciliation races during rapid nav.
    expect(isTransientNavError(new Error("Failed to execute 'removeChild' on 'Node'"))).toBe(true)
    expect(isTransientNavError(new Error("Failed to execute 'insertBefore' on 'Node'"))).toBe(true)
  })

  it("does NOT swallow genuine app / render errors", () => {
    expect(isTransientNavError(new Error("Cannot read properties of undefined"))).toBe(false)
    expect(isTransientNavError(new TypeError("x is not a function"))).toBe(false)
    expect(isTransientNavError(new Error("GraphQL request failed"))).toBe(false)
    expect(isTransientNavError("a bare string")).toBe(false)
    expect(isTransientNavError(null)).toBe(false)
    expect(isTransientNavError(undefined)).toBe(false)
  })
})
