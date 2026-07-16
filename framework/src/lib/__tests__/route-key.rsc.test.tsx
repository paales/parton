/**
 * routeKey derivation — the registered-pattern set `computeRouteKey`
 * hashes, and the pattern registry feeding it.
 *
 * The routeKey is a hash of WHICH registered URLPatterns match a
 * URL's BASE — scheme + host + pathname, search and hash stripped
 * before matching (see `computeRouteKey` in partial.tsx). The
 * registry's hint table, fold-base snapshot reads, and the fp-trailer
 * all bucket by it. Two properties are load-bearing:
 *
 *  - Registration is deduplicated by pattern signature, so an HMR
 *    module re-execution (the constructor runs again with the same
 *    `match`) doesn't append a duplicate — a dup signature changes
 *    the hashed signature list and shifts every affected routeKey
 *    across the edit.
 *
 *  - Route identity is a pure function of the URL base. A pattern
 *    that constrains search (`match: { search: "*q=:query" }` — the
 *    documented URLPatternInit dict form, used by pokemon.tsx's
 *    stage-3 search parton) gates its spec's rendering but never
 *    splits its page's bucket: the search overlay's `?q=` refetches
 *    must find the snapshots and hints the page's earlier renders
 *    committed, and the key must never depend on request arrival
 *    order (the failure mode of a first-seen-wins cache).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  _clearRouteKeyCache,
  _resetMatchPatterns,
  computeRouteKey,
  getRegisteredMatchPatterns,
  parton,
} from "../partial.tsx"

/** A real HMR re-execution is always preceded by the code-version
 *  bump (`vite:beforeUpdate` fires before the module re-evaluates —
 *  see lib/code-version.ts), and the spec catalog's collision gate
 *  keys on that generation. Simulated re-executions below must carry
 *  the same signal, or the re-defined spec reads as a same-generation
 *  duplicate id and throws. */
function bumpCodeGeneration(): void {
  globalThis.__partonCodeVersion = (globalThis.__partonCodeVersion ?? 0) + 1
}

const initialCodeVersion = globalThis.__partonCodeVersion

beforeEach(() => {
  _resetMatchPatterns()
})

afterEach(() => {
  globalThis.__partonCodeVersion = initialCodeVersion
})

describe("pattern registration dedup (HMR re-execution)", () => {
  it("re-registering the same match pattern doesn't append a duplicate", () => {
    // Simulate HMR: the spec module executes twice, running the
    // constructor with the identical options both times.
    const defineSpec = () =>
      parton(
        Object.assign(
          function HmrSpecRender() {
            return null
          },
          { displayName: "route-key-hmr-spec" },
        ),
        {
          match: "/hmr/:id",
        },
      )

    defineSpec()
    expect(getRegisteredMatchPatterns()).toHaveLength(1)

    bumpCodeGeneration()
    defineSpec()
    expect(getRegisteredMatchPatterns()).toHaveLength(1)
  })

  it("routeKeys stay stable across a re-registration", () => {
    const defineSpec = () =>
      parton(
        Object.assign(
          function HmrStableRender() {
            return null
          },
          { displayName: "route-key-hmr-stable" },
        ),
        {
          match: "/hmr-stable/:id",
        },
      )

    defineSpec()
    const before = computeRouteKey("http://t/hmr-stable/1")

    bumpCodeGeneration()
    defineSpec()
    // Recompute from scratch — a cache hit would mask a shifted hash.
    _clearRouteKeyCache()
    expect(computeRouteKey("http://t/hmr-stable/1")).toBe(before)
  })

  it("two specs sharing one pattern contribute a single signature", () => {
    parton(
      Object.assign(
        function SharedARender() {
          return null
        },
        { displayName: "route-key-shared-a" },
      ),
      {
        match: "/shared/:id",
      },
    )
    parton(
      Object.assign(
        function SharedBRender() {
          return null
        },
        { displayName: "route-key-shared-b" },
      ),
      {
        match: "/shared/:id",
      },
    )
    expect(getRegisteredMatchPatterns()).toHaveLength(1)
  })

  it("distinct patterns register side by side and split routeKeys", () => {
    parton(
      Object.assign(
        function DistinctARender() {
          return null
        },
        { displayName: "route-key-distinct-a" },
      ),
      {
        match: "/distinct-a/:id",
      },
    )
    parton(
      Object.assign(
        function DistinctBRender() {
          return null
        },
        { displayName: "route-key-distinct-b" },
      ),
      {
        match: "/distinct-b/:id",
      },
    )
    expect(getRegisteredMatchPatterns()).toHaveLength(2)
    expect(computeRouteKey("http://t/distinct-a/1")).not.toBe(
      computeRouteKey("http://t/distinct-b/1"),
    )
  })
})

describe("route identity — the URL base", () => {
  it("same page collapses to one routeKey across query changes", () => {
    parton(
      Object.assign(
        function PathOnlyRender() {
          return null
        },
        { displayName: "route-key-path-only" },
      ),
      {
        match: "/p/:slug",
      },
    )
    // Per-segment streaming URLs differ only in framework query params
    // (`?partials=…`) — same base, same routeKey, one cache entry.
    const first = computeRouteKey("http://t/p/pikachu")
    const second = computeRouteKey("http://t/p/pikachu?partials=hero")
    expect(second).toBe(first)
  })

  it("a search-bearing pattern never splits its page's bucket", () => {
    parton(
      Object.assign(
        function MixedPathRender() {
          return null
        },
        { displayName: "route-key-mixed-path" },
      ),
      {
        match: "/search{/*}?",
      },
    )
    parton(
      Object.assign(
        function SearchMatchRender() {
          return null
        },
        { displayName: "route-key-search-match" },
      ),
      {
        match: { search: "*q=:query" },
      },
    )
    // The typing session: /search → ?q=p → ?q=po. Every shape must
    // land in the SAME bucket so refetches find the page's snapshots
    // and hints — the warm-fp lockstep the search overlay relies on.
    const bare = computeRouteKey("http://t/search")
    expect(computeRouteKey("http://t/search?q=p")).toBe(bare)
    expect(computeRouteKey("http://t/search?q=po")).toBe(bare)
    // Distinct pages still split.
    expect(computeRouteKey("http://t/elsewhere?q=p")).not.toBe(bare)
  })

  it("routeKey is a pure function of the URL, not of arrival order", () => {
    const define = () => {
      parton(
        Object.assign(
          function OrderPathRender() {
            return null
          },
          { displayName: "route-key-order-path" },
        ),
        {
          match: "/order{/*}?",
        },
      )
      parton(
        Object.assign(
          function OrderSearchRender() {
            return null
          },
          { displayName: "route-key-order-search" },
        ),
        {
          match: { search: "*q=:query" },
        },
      )
    }
    // Arrival order A: bare page first (the cold-load-then-type flow).
    define()
    const bareFirst = computeRouteKey("http://t/order")
    const queryAfter = computeRouteKey("http://t/order?q=x")
    // Arrival order B: query URL first (reload mid-search).
    _resetMatchPatterns()
    bumpCodeGeneration()
    define()
    const queryFirst = computeRouteKey("http://t/order?q=x")
    const bareAfter = computeRouteKey("http://t/order")
    expect(queryFirst).toBe(queryAfter)
    expect(bareAfter).toBe(bareFirst)
    expect(bareFirst).toBe(queryFirst)
  })

  it("host is part of the base — hostname patterns split per host", () => {
    parton(
      Object.assign(
        function HostRender() {
          return null
        },
        { displayName: "route-key-host" },
      ),
      {
        match: { hostname: "shop.example", pathname: "/p/:slug" },
      },
    )
    const shop = computeRouteKey("http://shop.example/p/x")
    const other = computeRouteKey("http://other.example/p/x")
    expect(shop).not.toBe("__no-pattern")
    expect(other).toBe("__no-pattern")
  })
})
