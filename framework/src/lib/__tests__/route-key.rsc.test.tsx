/**
 * routeKey derivation — the registered-pattern set `computeRouteKey`
 * hashes, and the pattern registry feeding it.
 *
 * The routeKey is a hash of WHICH registered URLPatterns match a URL
 * (see `computeRouteKey` in partial.tsx); the registry's hint table
 * and the byte cache key off it. Two properties are load-bearing:
 *
 *  - Registration is deduplicated by pattern signature, so an HMR
 *    module re-execution (the constructor runs again with the same
 *    `match`) doesn't append a duplicate — a dup signature changes
 *    the hashed signature list and shifts every affected routeKey
 *    across the edit.
 */
import { beforeEach, describe, expect, it } from "vitest"
import {
  _clearRouteKeyCache,
  _resetMatchPatterns,
  computeRouteKey,
  getRegisteredMatchPatterns,
  parton,
} from "../partial.tsx"

beforeEach(() => {
  _resetMatchPatterns()
})

describe("pattern registration dedup (HMR re-execution)", () => {
  it("re-registering the same match pattern doesn't append a duplicate", () => {
    // Simulate HMR: the spec module executes twice, running the
    // constructor with the identical options both times.
    const defineSpec = () =>
      parton(function HmrSpecRender() { return null }, {
        match: "/hmr/:id",
        selector: "route-key-hmr-spec",
      })

    defineSpec()
    expect(getRegisteredMatchPatterns()).toHaveLength(1)

    defineSpec()
    expect(getRegisteredMatchPatterns()).toHaveLength(1)
  })

  it("routeKeys stay stable across a re-registration", () => {
    const defineSpec = () =>
      parton(function HmrStableRender() { return null }, {
        match: "/hmr-stable/:id",
        selector: "route-key-hmr-stable",
      })

    defineSpec()
    const before = computeRouteKey("http://t/hmr-stable/1")

    defineSpec()
    // Recompute from scratch — a cache hit would mask a shifted hash.
    _clearRouteKeyCache()
    expect(computeRouteKey("http://t/hmr-stable/1")).toBe(before)
  })

  it("two specs sharing one pattern contribute a single signature", () => {
    parton(function SharedARender() { return null }, {
      match: "/shared/:id",
      selector: "route-key-shared-a",
    })
    parton(function SharedBRender() { return null }, {
      match: "/shared/:id",
      selector: "route-key-shared-b",
    })
    expect(getRegisteredMatchPatterns()).toHaveLength(1)
  })

  it("distinct patterns register side by side and split routeKeys", () => {
    parton(function DistinctARender() { return null }, {
      match: "/distinct-a/:id",
      selector: "route-key-distinct-a",
    })
    parton(function DistinctBRender() { return null }, {
      match: "/distinct-b/:id",
      selector: "route-key-distinct-b",
    })
    expect(getRegisteredMatchPatterns()).toHaveLength(2)
    expect(computeRouteKey("http://t/distinct-a/1")).not.toBe(
      computeRouteKey("http://t/distinct-b/1"),
    )
  })
})
