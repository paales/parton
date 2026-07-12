"use client"

/**
 * The chunk's network light — a REAL wire-activity indicator. A chunk
 * that receives fresh bytes commits a new element tree, so this
 * component mounts again; the mount effect is therefore exactly "an
 * update arrived over the wire" (an fp-skip serves from cache, commits
 * nothing, and stays dark). Flash frequency picks the color — the
 * per-chunk arrival history survives remounts at module scope:
 * green (occasional) → blue (busy) → white (hot).
 */

import { useEffect, useRef, useState, type CSSProperties } from "react"

const WINDOW_MS = 10_000
const history = new Map<string, number[]>()

function recordArrival(ck: string): number {
  const now = performance.now()
  const arr = history.get(ck) ?? []
  const recent = arr.filter((t) => now - t < WINDOW_MS)
  recent.push(now)
  history.set(ck, recent)
  return recent.length
}

export function ActivityLight({ ck, stamp }: { ck: string; stamp?: unknown }) {
  const [pulse, setPulse] = useState<{ tone: string; seq: number }>({ tone: "idle", seq: 0 })
  const mounted = useRef(false)
  // A lane commit reconciles this element in place (identity-stable by
  // design), so a value arrival is "the stamp changed" on a LIVE
  // instance — frequency-colored. A MOUNT flashes RED: it means this
  // subtree was freshly committed (expected on scroll-in loads,
  // suspicious anywhere else), so remounts are visible at a glance.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      setPulse((p) => ({ tone: "red", seq: p.seq + 1 }))
      return
    }
    const n = recordArrival(ck)
    setPulse((p) => ({ tone: n >= 5 ? "white" : n >= 2 ? "blue" : "green", seq: p.seq + 1 }))
  }, [ck, stamp])
  // The span is identity-stable across pulses: alternating --flash
  // between two identical keyframe names restarts the compositor-driven
  // glow animation in place — no remount, no per-arrival DOM churn.
  return (
    <span
      className={`chunk__light chunk__light--${pulse.tone}`}
      style={{ "--flash": pulse.seq % 2 ? "light-flash-b" : "light-flash-a" } as CSSProperties}
      data-testid={`light-${ck}`}
      aria-hidden
    />
  )
}
