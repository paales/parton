import { localCell, type LocalCell } from "@parton/framework"
import type { WorldGeometry } from "./constants.ts"

/**
 * The world's pulse — one counter cell PER GEOMETRY, partitioned per
 * chunk coordinate. Server-owned state: it keeps counting whether or
 * not any client has the chunk's content in view, which is exactly
 * what a returning (re-culled-in) chunk demonstrates by showing the
 * caught-up value. Each geometry gets its own cell id
 * (`geo.pulseCellId`) so a 128px chunk's {cx,cy} partition never
 * collides with the 512 default's.
 *
 * Per-chunk background ticker: increments the chunk's pulse partition
 * at random intervals. Each chunk draws a BASE rate from its
 * coordinates (deterministic spatial variety — some neighborhoods are
 * hot, some sleepy) and jitters every tick, clamped to 0.1–5s, so the
 * network lights' frequency colors mean something. Tickers start on a
 * chunk's first content render and are LRU-capped per geometry
 * (`geo.tickerCap` — density-scaled): past the cap the oldest ticker
 * dies (its chain checks membership), so a public instance can't
 * accumulate unbounded timers.
 */
export interface ChunkPulse {
  cell: LocalCell<number>
  ensureTicker(cx: number, cy: number): void
}

export function definePulse(geo: WorldGeometry): ChunkPulse {
  const cell = localCell({ id: geo.pulseCellId, shape: "number", initial: 0 })

  // Survives HMR module replacement: a reloaded module reuses the same
  // set, so running chains stay owned and chunks don't double-tick.
  const tickers = ((globalThis as Record<string, unknown>)[`__worldPulseTickers${geo.suffix}`] ??=
    new Set<string>()) as Set<string>

  const ensureTicker = (cx: number, cy: number): void => {
    const key = `${cx},${cy}`
    if (tickers.has(key)) return
    if (tickers.size >= geo.tickerCap) {
      const oldest = tickers.values().next().value
      if (oldest !== undefined) tickers.delete(oldest)
    }
    tickers.add(key)

    const base = 400 + ((((cx * 7 + cy * 13) % 9) + 9) % 9) * 500
    const started = Date.now()
    const schedule = (): void => {
      const jitter = 0.5 + Math.random()
      const delay = Math.min(5_000, Math.max(100, base * jitter))
      setTimeout(() => {
        if (!tickers.has(key)) return
        // The value is milliseconds-alive since this server boot first
        // loaded the chunk — time-shaped, not an opaque count, and fresh
        // each run rather than resuming a persisted number.
        void cell.set(Date.now() - started, { partition: { cx, cy } }).then(schedule, schedule)
      }, delay)
    }
    void cell.set(0, { partition: { cx, cy } }).then(schedule, schedule)
  }

  return { cell, ensureTicker }
}
