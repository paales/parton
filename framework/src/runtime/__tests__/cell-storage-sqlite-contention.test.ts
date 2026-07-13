/**
 * Multi-process gates for the SQLite cell storage — the in-tree
 * successor to the multi-process harness's scenario D (two processes
 * silently clobbering cells.json wholesale; see
 * `feat/multi-process-harness`). REAL child processes (plain `node`,
 * native type stripping) run the same `casUpdateRow` loop
 * `updateOneCell` uses, against the same adapter, on one shared
 * database file:
 *
 *   1. CONTENTION — two processes hammer one (cell, partition) with
 *      compare-and-retry increments. Gate: ZERO lost updates (the
 *      final counter is exactly the sum of both processes' writes).
 *      Scenario D's JSON shape loses whole batches here.
 *
 *   2. SIGKILL DURABILITY — a process is killed mid-write-burst; on
 *      reopen every ACKNOWLEDGED write (ack printed strictly after
 *      `write()` returned) is present and the file passes
 *      integrity_check. WAL gives this; the test proves it instead of
 *      claiming it. The JSON adapter's debounce window loses the tail
 *      by design.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { SqliteCellStorage } from "../cell-storage-sqlite.ts"

// cwd-relative rather than import.meta.url — vitest serves this module
// from a non-file URL, and the workspace root is where vitest runs.
const CHILD = resolve(
  process.cwd(),
  "framework/src/runtime/__tests__/fixtures/sqlite-contention-child.ts",
)

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "parton-sqlite-mp-"))
  dbPath = join(dir, "cells.db")
  // Parent creates the schema first so the children never race the DDL.
  new SqliteCellStorage(dbPath).close()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function spawnChild(args: string[]): ChildProcessWithoutNullStreams {
  // process.execPath = the running node; .ts loads via native type
  // stripping (the child fixture and its imports are JSX-free).
  return spawn(process.execPath, [CHILD, ...args], { stdio: ["pipe", "pipe", "pipe"] })
}

/** Collect stdout lines as they arrive; resolves waiters promptly. */
function lineReader(child: ChildProcessWithoutNullStreams): {
  lines: string[]
  waitForLine: (predicate: (line: string) => boolean, timeoutMs?: number) => Promise<string>
} {
  const lines: string[] = []
  const waiters: Array<{ predicate: (line: string) => boolean; resolve: (line: string) => void }> =
    []
  let buffered = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk
    for (;;) {
      const nl = buffered.indexOf("\n")
      if (nl < 0) break
      const line = buffered.slice(0, nl)
      buffered = buffered.slice(nl + 1)
      lines.push(line)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(line)) {
          const [w] = waiters.splice(i, 1)
          w.resolve(line)
        }
      }
    }
  })
  return {
    lines,
    waitForLine(predicate, timeoutMs = 20_000) {
      const hit = lines.find(predicate)
      if (hit !== undefined) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for a child stdout line`)),
          timeoutMs,
        )
        waiters.push({
          predicate,
          resolve: (line) => {
            clearTimeout(timer)
            resolve(line)
          },
        })
      })
    },
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)))
}

interface HammerResult {
  writes: number
  attempts: number
  startedAt: number
  endedAt: number
}

describe("two-process contention (scenario D's shape, per-key store)", () => {
  it(
    "two processes hammering one (cell, partition) with update(fn) lose ZERO updates",
    { timeout: 60_000 },
    async () => {
      const WRITES = 500
      const a = spawnChild(["hammer", dbPath, "mp.counter", "pk", String(WRITES)])
      const b = spawnChild(["hammer", dbPath, "mp.counter", "pk", String(WRITES)])
      const stderr: string[] = []
      a.stderr.on("data", (d: Buffer) => stderr.push(`A: ${d}`))
      b.stderr.on("data", (d: Buffer) => stderr.push(`B: ${d}`))
      const readA = lineReader(a)
      const readB = lineReader(b)

      // Barrier: release both loops together so the runs overlap.
      await Promise.all([
        readA.waitForLine((l) => l === "ready"),
        readB.waitForLine((l) => l === "ready"),
      ])
      a.stdin.write("go\n")
      b.stdin.write("go\n")

      const [exitA, exitB] = await Promise.all([waitForExit(a), waitForExit(b)])
      // Real errors only — Node may emit process warnings (e.g. type
      // stripping on older versions) that are not the child failing.
      const errors = stderr
        .join("")
        .split("\n")
        .filter((l) => l.includes("Error"))
      expect.soft(errors).toEqual([])
      expect(exitA).toBe(0)
      expect(exitB).toBe(0)

      const resultA = JSON.parse(readA.lines.find((l) => l.startsWith("{"))!) as HammerResult
      const resultB = JSON.parse(readB.lines.find((l) => l.startsWith("{"))!) as HammerResult

      // The barrier makes the two loops genuinely concurrent — a
      // sequential run would prove nothing about contention.
      expect(resultA.startedAt).toBeLessThanOrEqual(resultB.endedAt)
      expect(resultB.startedAt).toBeLessThanOrEqual(resultA.endedAt)

      // THE GATE: zero lost updates. Every one of the 2×WRITES
      // read-modify-writes composed; scenario D's whole-file adapter
      // reverts one process's batch here.
      const storage = new SqliteCellStorage(dbPath)
      expect(storage.read("default", "mp.counter", "pk")).toBe(2 * WRITES)
      // Attempts ≥ writes; the surplus is the CAS retry loop engaging
      // on genuine cross-process conflicts (reported, not gated — the
      // exact count is scheduling-dependent).
      expect(resultA.attempts).toBeGreaterThanOrEqual(WRITES)
      expect(resultB.attempts).toBeGreaterThanOrEqual(WRITES)
      console.log(
        `[contention] A: ${resultA.attempts} attempts / ${WRITES} writes, ` +
          `B: ${resultB.attempts} attempts / ${WRITES} writes ` +
          `(${resultA.attempts + resultB.attempts - 2 * WRITES} conflicts retried)`,
      )
      storage.close()
    },
  )
})

describe("SIGKILL durability (the debounce-window loss, closed)", () => {
  it(
    "kill -9 mid-burst: every acknowledged write is present after reopen",
    { timeout: 60_000 },
    async () => {
      const child = spawnChild(["burst", dbPath, "mp.burst", String(100_000)])
      const reader = lineReader(child)

      // Let a healthy burst build up, then kill it mid-write with no
      // chance to flush anything.
      await reader.waitForLine((l) => l === "acked 200")
      child.kill("SIGKILL")
      await waitForExit(child)

      // Acks observed BEFORE the kill; more may have committed after
      // the last one we read — the invariant direction is
      // acked ⊆ stored, never the reverse.
      const acked = reader.lines
        .filter((l) => l.startsWith("acked "))
        .map((l) => Number(l.slice("acked ".length)))
      expect(acked.length).toBeGreaterThanOrEqual(200)
      const lastAcked = acked[acked.length - 1]

      const storage = new SqliteCellStorage(dbPath)
      // The DB reopened cleanly (WAL replay, no corruption).
      expect(storage.db.pragma("integrity_check", { simple: true })).toBe("ok")
      // Every acknowledged write is present.
      for (const i of acked) {
        expect(storage.read("default", "mp.burst", `k${i}`)).toBe(i)
      }
      // The sequentially-written counter is at (or past) the last ack.
      expect(storage.read("default", "mp.burst", "counter")).toBeGreaterThanOrEqual(lastAcked)
      storage.close()
    },
  )
})
