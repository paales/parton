/**
 * Route wake subscription — the pointer-diff sync between a live
 * connection's index registration and its route's snapshot map, and
 * the parity oracle. Pins: registration + delivery through real
 * snapshots, no-op re-syncs, surface-change re-registration, removal
 * of dropped ids, the covered-record probe (a record registered after
 * its bump landed still lanes), carrier escalation baked into the wake
 * gate, and `_assertWakeParity` agreeing with the retired pull filter.
 */

import { afterEach, describe, expect, it } from "vitest"
import {
  _clearInvalidationRegistry,
  _currentTs,
  _takeWakeSubscriptionPending,
  _wakeIndexStats,
  buildCellSelector,
  refreshSelector,
  type WakeSubscriberContext,
} from "../../runtime/invalidation-registry.ts"
import type { PartialSnapshot } from "../partial-registry.ts"
import {
  _assertWakeParity,
  _closeRouteWakeSubscription,
  _escalateToLaneCarriers,
  _openRouteWakeSubscription,
  _syncRouteWakeSubscription,
  type RouteWakeSubscription,
} from "../segment-relevance.ts"

function snap(
  labels: string[],
  opts: {
    constraintArgs?: Record<string, unknown>
    emittedFp?: string | undefined
    parentPath?: string[]
    cullGated?: string
  } = {},
): PartialSnapshot {
  const deps =
    opts.cullGated !== undefined ? new Set([`visible:${opts.cullGated}?seed=1`]) : undefined
  return {
    type: "x",
    fallback: null,
    labels,
    framePath: [],
    parentFrameChain: [],
    parentPath: opts.parentPath ?? [],
    constraintArgs: opts.constraintArgs,
    emittedFp: "emittedFp" in opts ? opts.emittedFp : "fp",
    matchKey: "mk",
    deps,
  }
}

const openSubs: RouteWakeSubscription[] = []

function open(context?: Partial<WakeSubscriberContext>): {
  rws: RouteWakeSubscription
  wokeCount: () => number
} {
  const rws = _openRouteWakeSubscription({
    visible: context?.visible ?? (() => null),
    hasAssignedSeq: context?.hasAssignedSeq ?? (() => false),
  })
  openSubs.push(rws)
  let woke = 0
  rws.sub.wakes.add(() => {
    woke++
  })
  return { rws, wokeCount: () => woke }
}

afterEach(() => {
  for (const rws of openSubs.splice(0)) _closeRouteWakeSubscription(rws)
  _clearInvalidationRegistry()
})

describe("route wake subscription — sync diff", () => {
  it("registers the route's snapshots; a partition bump delivers the matched id", () => {
    const { rws } = open()
    const route = new Map([
      ["cart-badge", snap(["cell:cart"], { constraintArgs: { cartId: "A" } })],
      ["other", snap(["cell:other"], { constraintArgs: { cartId: "A" } })],
    ])
    _syncRouteWakeSubscription(rws, route, _currentTs())
    refreshSelector("cell:cart?cartId=A")
    expect([..._takeWakeSubscriptionPending(rws.sub)]).toEqual(["cart-badge"])
  })

  it("re-syncing unchanged snapshot objects is a no-op (pointer-diff)", () => {
    const { rws } = open()
    const route = new Map([["a", snap(["cell:a"], { constraintArgs: { k: "1" } })]])
    _syncRouteWakeSubscription(rws, route, _currentTs())
    const before = _wakeIndexStats()
    _syncRouteWakeSubscription(rws, route, _currentTs())
    expect(_wakeIndexStats()).toEqual(before)
    refreshSelector("cell:a?k=1")
    expect([..._takeWakeSubscriptionPending(rws.sub)]).toEqual(["a"])
  })

  it("a replaced snapshot re-registers: the old partition stops matching, the new one delivers", () => {
    const { rws } = open()
    _syncRouteWakeSubscription(
      rws,
      new Map([["badge", snap(["cell:cart"], { constraintArgs: { cartId: "A" } })]]),
      _currentTs(),
    )
    _syncRouteWakeSubscription(
      rws,
      new Map([["badge", snap(["cell:cart"], { constraintArgs: { cartId: "B" } })]]),
      _currentTs(),
    )
    refreshSelector("cell:cart?cartId=A")
    expect(_takeWakeSubscriptionPending(rws.sub)).toEqual([])
    refreshSelector("cell:cart?cartId=B")
    expect([..._takeWakeSubscriptionPending(rws.sub)]).toEqual(["badge"])
  })

  it("a dropped id is unregistered", () => {
    const { rws } = open()
    _syncRouteWakeSubscription(
      rws,
      new Map([["gone", snap(["cell:gone"], { constraintArgs: {} })]]),
      _currentTs(),
    )
    _syncRouteWakeSubscription(rws, new Map(), _currentTs())
    expect(_wakeIndexStats().registrations).toBe(0)
    refreshSelector("cell:gone")
    expect(_takeWakeSubscriptionPending(rws.sub)).toEqual([])
  })

  it("seeds a newly-covered record whose bump landed before the sync (the covered-record probe)", () => {
    const { rws } = open()
    const since = _currentTs()
    // The bump lands FIRST — a foreign render (another connection's
    // request) registered this parton into the shared route bucket,
    // and its selector bumped before this connection ever subscribed.
    refreshSelector(buildCellSelector("late", { k: "1" }))
    _syncRouteWakeSubscription(
      rws,
      new Map([["late-parton", snap(["cell:late"], { constraintArgs: { k: "1" } })]]),
      since,
    )
    // Delivered by the sync's probe, not by the index (the bump
    // predates the registration).
    expect([..._takeWakeSubscriptionPending(rws.sub)]).toEqual(["late-parton"])
  })

  it("does NOT seed a record whose bumps the cursor already covers", () => {
    const { rws } = open()
    refreshSelector(buildCellSelector("old", { k: "1" }))
    const since = _currentTs()
    _syncRouteWakeSubscription(
      rws,
      new Map([["old-parton", snap(["cell:old"], { constraintArgs: { k: "1" } })]]),
      since,
    )
    expect(_takeWakeSubscriptionPending(rws.sub)).toEqual([])
  })
})

describe("route wake subscription — carrier escalation in the wake gate", () => {
  it("a non-addressable child's entry carries its addressable ancestor; the ancestor's park gates decide waking", () => {
    const visible = new Set<string>(["elsewhere"])
    const { rws, wokeCount } = open({ visible: () => visible })
    const route = new Map([
      ["parent", snap(["parent-label"], { cullGated: "parent" })],
      [
        "child",
        snap(["cell:line"], {
          constraintArgs: { itemId: "X" },
          emittedFp: undefined,
          parentPath: ["parent"],
        }),
      ],
    ])
    _syncRouteWakeSubscription(rws, route, _currentTs())
    // The child's update can only ride the parent's lane, and the
    // parent is parked → delivery records silently.
    refreshSelector("cell:line?itemId=X")
    expect(wokeCount()).toBe(0)
    expect([...rws.sub.pending]).toEqual(["child"])
    // Parent flips in → the same delivery now wakes.
    visible.add("parent")
    refreshSelector("cell:line?itemId=X")
    expect(wokeCount()).toBe(1)
    // The drain maps the matched child onto its carrier.
    expect(_escalateToLaneCarriers(rws.sub.pending, route)).toEqual(["parent"])
  })
})

describe("wake parity — the filter's post-park lane set is covered by delivery", () => {
  const unparked = () => false

  it("passes for a delivered pending set and throws for an under-delivery", () => {
    const { rws } = open()
    const route = new Map([
      ["a", snap(["cell:a"], { constraintArgs: { k: "1" } })],
      ["b", snap(["cell:b"], { constraintArgs: { k: "2" } })],
    ])
    const since = _currentTs()
    _syncRouteWakeSubscription(rws, route, since)
    refreshSelector("cell:a?k=1")
    refreshSelector("cell:b?k=999") // wrong partition — matches nothing
    expect(() => _assertWakeParity(route, since, rws.sub.pending, unparked)).not.toThrow()
    // Delivered ids whose snapshot vanished are excluded on both sides,
    // and an extra delivered id is NOT a violation (a label-shrink race
    // — a cull-out re-registration — legitimately over-delivers; the
    // lane renders current state and dedups/parks downstream).
    rws.sub.pending.add("vanished")
    rws.sub.pending.add("b")
    expect(() => _assertWakeParity(route, since, rws.sub.pending, unparked)).not.toThrow()
    // A genuinely missing delivery is the staleness direction — throw.
    rws.sub.pending.clear()
    expect(() => _assertWakeParity(route, since, rws.sub.pending, unparked)).toThrow(/parity/)
    // …unless the missed id is PARKED at drain time: the drain would
    // drop it anyway (the flip-in revalidation is its catch-up).
    expect(() => _assertWakeParity(route, since, rws.sub.pending, (id) => id === "b")).toThrow(
      /parity/,
    )
    expect(() => _assertWakeParity(route, since, rws.sub.pending, (id) => id === "a")).not.toThrow()
  })
})
