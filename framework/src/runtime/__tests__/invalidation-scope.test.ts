/**
 * Scope confinement of the invalidation registry — the dev-mode
 * `x-test-scope` seam applied to bumps. Locks the matching rule:
 *
 *   - a bump committed under scope A moves scope A's `queryMatchingTs`
 *     and delivers to scope A's wake registrations only — scope B (and
 *     the default scope) never read it as fp movement, never wake;
 *   - a scope-less bump (no request context / no header — production's
 *     only shape) is global: every scope's queries fold it and every
 *     scope's registrations receive it, exactly the one-bucket
 *     process-global behavior;
 *   - two scopes bumping the SAME selector hold separate compacted
 *     entries — confinement never loses a bump to same-key overwrite.
 */

import { afterEach, describe, expect, it } from "vitest"
import { runWithRequestAsync } from "../context.ts"
import {
  _clearInvalidationRegistry,
  _closeWakeSubscription,
  _compileSurfaceQuery,
  _openWakeSubscription,
  _setWakeSubscriptionEntry,
  _takeWakeSubscriptionPending,
  queryMatchingTs,
  refreshSelector,
  type WakeSubscription,
} from "../invalidation-registry.ts"

const openSubs: WakeSubscription[] = []

afterEach(() => {
  for (const sub of openSubs.splice(0)) _closeWakeSubscription(sub)
  _clearInvalidationRegistry()
})

/** Run `fn` under a request carrying `x-test-scope: <scope>` — the
 *  seam the Playwright fixtures (and the soak bench) stamp. */
async function inScope<T>(scope: string, fn: () => Promise<T> | T): Promise<T> {
  const request = new Request("http://localhost/scoped", {
    headers: { "x-test-scope": scope },
  })
  const { result } = await runWithRequestAsync(request, async () => await fn())
  return result
}

/** A subscription registered under `scope`, with one keyed entry for
 *  `id` matching bare `label` bumps. */
async function openScopedSub(scope: string, id: string, label: string): Promise<WakeSubscription> {
  return await inScope(scope, () => {
    const sub = _openWakeSubscription({ visible: () => null, hasAssignedSeq: () => false })
    _setWakeSubscriptionEntry(sub, id, {
      labels: [label],
      query: _compileSurfaceQuery({}),
      carrier: id,
      carrierParkGates: null,
    })
    openSubs.push(sub)
    return sub
  })
}

describe("scoped bumps are confined to their scope", () => {
  it("a bump in scope A never moves scope B's (or the default scope's) fold", async () => {
    await inScope("worker-a", () => refreshSelector("cart"))
    expect(await inScope("worker-a", () => queryMatchingTs(["cart"], {}))).toBeGreaterThan(0)
    expect(await inScope("worker-b", () => queryMatchingTs(["cart"], {}))).toBe(0)
    expect(queryMatchingTs(["cart"], {})).toBe(0) // scope-less reader
  })

  it("a bump in scope A never wakes scope B's registrations", async () => {
    const subA = await openScopedSub("worker-a", "cart-a", "cart")
    const subB = await openScopedSub("worker-b", "cart-b", "cart")
    let wokeB = 0
    subB.wakes.add(() => wokeB++)

    await inScope("worker-a", () => refreshSelector("cart"))

    expect(_takeWakeSubscriptionPending(subA)).toEqual(["cart-a"])
    expect(_takeWakeSubscriptionPending(subB)).toEqual([])
    expect(wokeB).toBe(0)
  })

  it("same selector bumped in two scopes keeps two entries — no cross-scope overwrite", async () => {
    await inScope("worker-a", () => refreshSelector("cart"))
    const tsA = await inScope("worker-a", () => queryMatchingTs(["cart"], {}))
    await inScope("worker-b", () => refreshSelector("cart"))
    // B's later (higher) ts must not leak into A, and must not have
    // evicted A's own entry.
    expect(await inScope("worker-a", () => queryMatchingTs(["cart"], {}))).toBe(tsA)
    expect(await inScope("worker-b", () => queryMatchingTs(["cart"], {}))).toBeGreaterThan(tsA)
  })

  it("confines partition-scoped selectors too", async () => {
    await inScope("worker-a", () => refreshSelector("price?sku=A"))
    const surface = { sku: "A" }
    expect(await inScope("worker-a", () => queryMatchingTs(["price"], surface))).toBeGreaterThan(0)
    expect(await inScope("worker-b", () => queryMatchingTs(["price"], surface))).toBe(0)
  })
})

describe("scope-less bumps stay global", () => {
  it("moves every scope's fold", async () => {
    refreshSelector("cart")
    expect(queryMatchingTs(["cart"], {})).toBeGreaterThan(0)
    expect(await inScope("worker-a", () => queryMatchingTs(["cart"], {}))).toBeGreaterThan(0)
    expect(await inScope("worker-b", () => queryMatchingTs(["cart"], {}))).toBeGreaterThan(0)
  })

  it("delivers to every scope's registrations", async () => {
    const subA = await openScopedSub("worker-a", "cart-a", "cart")
    const subB = await openScopedSub("worker-b", "cart-b", "cart")

    refreshSelector("cart")

    expect(_takeWakeSubscriptionPending(subA)).toEqual(["cart-a"])
    expect(_takeWakeSubscriptionPending(subB)).toEqual(["cart-b"])
  })
})
