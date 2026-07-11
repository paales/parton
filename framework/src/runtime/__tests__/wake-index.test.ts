/**
 * The inverted wake index — bump-time delivery to subscribed
 * connections. These tests pin the registry-side primitives: keyed
 * subset-match delivery (the probe-key equivalence), bare-name
 * broadcast, the over-cap scan fallback, registration replacement and
 * close, pending-set coalescing between drains, and the parked-carrier
 * wake gate (record silently; an assigned consequence seq still
 * wakes).
 */

import { afterEach, describe, expect, it } from "vitest"
import {
  _clearInvalidationRegistry,
  _closeWakeSubscription,
  _compileSurfaceQuery,
  _openWakeSubscription,
  _removeWakeSubscriptionEntry,
  _setWakeSubscriptionEntry,
  _takeWakeSubscriptionPending,
  _wakeIndexStats,
  buildCellSelector,
  refreshSelector,
  type WakeSubscriberContext,
  type WakeSubscription,
} from "../invalidation-registry.ts"

const openSubs: WakeSubscription[] = []

function openSub(context?: Partial<WakeSubscriberContext>): {
  sub: WakeSubscription
  wokeCount: () => number
} {
  const sub = _openWakeSubscription({
    visible: context?.visible ?? (() => null),
    hasAssignedSeq: context?.hasAssignedSeq ?? (() => false),
  })
  openSubs.push(sub)
  let woke = 0
  sub.wakes.add(() => {
    woke++
  })
  return { sub, wokeCount: () => woke }
}

function register(
  sub: WakeSubscription,
  id: string,
  labels: string[],
  surface: Record<string, unknown>,
  over: { carrier?: string | null; gates?: readonly string[] | null } = {},
): void {
  _setWakeSubscriptionEntry(sub, id, {
    labels,
    query: _compileSurfaceQuery(surface),
    carrier: over.carrier === undefined ? id : over.carrier,
    carrierParkGates: over.gates ?? null,
  })
}

afterEach(() => {
  for (const sub of openSubs.splice(0)) _closeWakeSubscription(sub)
  _clearInvalidationRegistry()
})

describe("wake index — keyed delivery", () => {
  it("delivers a subset-matching partition bump and fires the wake", () => {
    const { sub, wokeCount } = openSub()
    register(sub, "cart-badge", ["cell:cart"], { cartId: "A" })
    refreshSelector("cell:cart?cartId=A")
    expect([..._takeWakeSubscriptionPending(sub)]).toEqual(["cart-badge"])
    expect(wokeCount()).toBe(1)
  })

  it("does NOT deliver a different partition (another viewer's cart)", () => {
    const { sub, wokeCount } = openSub()
    register(sub, "cart-badge", ["cell:cart"], { cartId: "A" })
    refreshSelector("cell:cart?cartId=B")
    expect(_takeWakeSubscriptionPending(sub)).toEqual([])
    expect(wokeCount()).toBe(0)
  })

  it("does NOT deliver a name nothing registered", () => {
    const { sub, wokeCount } = openSub()
    register(sub, "cart-badge", ["cell:cart"], { cartId: "A" })
    refreshSelector("cell:something-else?cartId=A")
    expect(_takeWakeSubscriptionPending(sub)).toEqual([])
    expect(wokeCount()).toBe(0)
  })

  it("a bare-name bump delivers to constrained entries (broadcast)", () => {
    const { sub } = openSub()
    register(sub, "cart-badge", ["cell:cart"], { cartId: "A" })
    refreshSelector("cell:cart")
    expect([..._takeWakeSubscriptionPending(sub)]).toEqual(["cart-badge"])
  })

  it("type-tagged partitions stay distinct: a number bump misses a string surface", () => {
    const { sub } = openSub()
    register(sub, "num", ["cell:c"], { uid: 123 })
    register(sub, "str", ["cell:c"], { uid: "123" })
    refreshSelector(buildCellSelector("c", { uid: 123 }))
    expect([..._takeWakeSubscriptionPending(sub)]).toEqual(["num"])
    refreshSelector(buildCellSelector("c", { uid: "123" }))
    // The string-loose branch: a bare string token matches BOTH the
    // string surface and (via String(v)) the number surface — the same
    // equivalence `matchesConstraints` implements.
    expect(new Set(_takeWakeSubscriptionPending(sub))).toEqual(new Set(["num", "str"]))
  })

  it("coalesces across bumps between drains (the pending set dedupes)", () => {
    const { sub, wokeCount } = openSub()
    register(sub, "ticker", ["cell:pulse"], { cx: 1, cy: 2 })
    refreshSelector("cell:pulse?cx=" + "1&cy=" + "2")
    refreshSelector(buildCellSelector("pulse", { cx: 1, cy: 2 }))
    refreshSelector(buildCellSelector("pulse", { cx: 1, cy: 2 }))
    expect([..._takeWakeSubscriptionPending(sub)]).toEqual(["ticker"])
    expect(wokeCount()).toBeGreaterThanOrEqual(2)
    // Drained — the next bump delivers afresh.
    refreshSelector(buildCellSelector("pulse", { cx: 1, cy: 2 }))
    expect([..._takeWakeSubscriptionPending(sub)]).toEqual(["ticker"])
  })

  it("delivers to every matching subscription independently", () => {
    const a = openSub()
    const b = openSub()
    register(a.sub, "badge", ["cell:cart"], { cartId: "A" })
    register(b.sub, "badge", ["cell:cart"], { cartId: "A" })
    refreshSelector("cell:cart?cartId=A")
    expect([..._takeWakeSubscriptionPending(a.sub)]).toEqual(["badge"])
    expect([..._takeWakeSubscriptionPending(b.sub)]).toEqual(["badge"])
  })
})

describe("wake index — over-cap scan fallback", () => {
  const wideSurface = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 } // 7 > PROBE_SUBSET_CAP

  it("registers past the probe cap as a scan entry and still subset-matches", () => {
    const { sub, wokeCount } = openSub()
    register(sub, "wide", ["cell:wide"], wideSurface)
    expect(_wakeIndexStats().scanEntries).toBe(1)
    expect(_wakeIndexStats().registrations).toBe(0)
    refreshSelector(buildCellSelector("wide", { a: 1, g: 7 }))
    expect([..._takeWakeSubscriptionPending(sub)]).toEqual(["wide"])
    expect(wokeCount()).toBe(1)
    refreshSelector(buildCellSelector("wide", { a: 999 }))
    expect(_takeWakeSubscriptionPending(sub)).toEqual([])
    refreshSelector(buildCellSelector("other-name", { a: 1 }))
    expect(_takeWakeSubscriptionPending(sub)).toEqual([])
  })

  it("removing the last scan entry retires the subscription from the scan set", () => {
    const { sub } = openSub()
    register(sub, "wide", ["cell:wide"], wideSurface)
    _removeWakeSubscriptionEntry(sub, "wide")
    expect(_wakeIndexStats().scanEntries).toBe(0)
    refreshSelector("cell:wide")
    expect(_takeWakeSubscriptionPending(sub)).toEqual([])
  })
})

describe("wake index — registration lifecycle", () => {
  it("replacing an entry drops the old registration (a changed surface stops matching its old partition)", () => {
    const { sub } = openSub()
    register(sub, "badge", ["cell:cart"], { cartId: "A" })
    register(sub, "badge", ["cell:cart"], { cartId: "B" })
    refreshSelector("cell:cart?cartId=A")
    expect(_takeWakeSubscriptionPending(sub)).toEqual([])
    refreshSelector("cell:cart?cartId=B")
    expect([..._takeWakeSubscriptionPending(sub)]).toEqual(["badge"])
  })

  it("close removes every index registration", () => {
    const { sub, wokeCount } = openSub()
    register(sub, "badge", ["cell:cart"], { cartId: "A" })
    register(sub, "wide", ["cell:wide"], { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 })
    expect(_wakeIndexStats().subscriptions).toBe(1)
    _closeWakeSubscription(sub)
    const stats = _wakeIndexStats()
    expect(stats.registrations).toBe(0)
    expect(stats.names).toBe(0)
    expect(stats.scanEntries).toBe(0)
    expect(stats.subscriptions).toBe(0)
    refreshSelector("cell:cart?cartId=A")
    expect(sub.pending.size).toBe(0)
    expect(wokeCount()).toBe(0)
  })
})

describe("wake index — the parked-carrier wake gate", () => {
  it("a parked carrier's delivery records WITHOUT waking; the pending set holds it", () => {
    const visible = new Set(["elsewhere"])
    const { sub, wokeCount } = openSub({ visible: () => visible })
    register(sub, "chunk", ["cell:pulse"], { cx: 1 }, { gates: ["chunk"] })
    refreshSelector(buildCellSelector("pulse", { cx: 1 }))
    expect(wokeCount()).toBe(0)
    expect([...sub.pending]).toEqual(["chunk"])
  })

  it("a visible carrier's delivery wakes", () => {
    const visible = new Set(["chunk"])
    const { sub, wokeCount } = openSub({ visible: () => visible })
    register(sub, "chunk", ["cell:pulse"], { cx: 1 }, { gates: ["chunk"] })
    refreshSelector(buildCellSelector("pulse", { cx: 1 }))
    expect(wokeCount()).toBe(1)
  })

  it("an unmeasured session (visible: null) parks nothing — every delivery wakes", () => {
    const { sub, wokeCount } = openSub({ visible: () => null })
    register(sub, "chunk", ["cell:pulse"], { cx: 1 }, { gates: ["chunk"] })
    refreshSelector(buildCellSelector("pulse", { cx: 1 }))
    expect(wokeCount()).toBe(1)
  })

  it("a parked carrier holding an assigned consequence seq STILL wakes (prompt voiding)", () => {
    const visible = new Set<string>()
    const { sub, wokeCount } = openSub({
      visible: () => visible,
      hasAssignedSeq: (id) => id === "chunk",
    })
    register(sub, "chunk", ["cell:pulse"], { cx: 1 }, { gates: ["chunk"] })
    refreshSelector(buildCellSelector("pulse", { cx: 1 }))
    expect(wokeCount()).toBe(1)
  })

  it("a carrier-less entry records without ever waking (nothing could lane it)", () => {
    const { sub, wokeCount } = openSub()
    register(sub, "orphan", ["cell:x"], {}, { carrier: null })
    refreshSelector("cell:x")
    expect(wokeCount()).toBe(0)
    expect([...sub.pending]).toEqual(["orphan"])
  })
})
