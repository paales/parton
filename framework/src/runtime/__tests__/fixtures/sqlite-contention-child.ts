/**
 * Child-process worker for the multi-process SQLite gates
 * (`cell-storage-sqlite-contention.test.ts`). Runs under PLAIN `node`
 * (native type stripping — no vitest, no vite): a REAL second process
 * against the shared database file, exercising the same `casUpdateRow`
 * loop `updateOneCell` runs and the same adapter the framework uses.
 *
 * Modes (argv):
 *
 *   hammer <dbPath> <cellId> <partitionKey> <count>
 *     Barrier on stdin ("go\n" after printing "ready"), then `count`
 *     compare-and-retry increments of one shared row. Prints a JSON
 *     result line: {writes, attempts, startedAt, endedAt}.
 *
 *   burst <dbPath> <cellId> <count>
 *     Sequential acknowledged writes: for i = 1.. — write row `k<i>`
 *     = i AND the shared "counter" row = i, then print "acked <i>".
 *     The parent SIGKILLs mid-burst; every printed ack MUST be
 *     readable after reopen (acks are printed strictly AFTER write()
 *     returned, so acked ⊆ committed).
 */

import { casUpdateRow } from "../../cell-cas.ts"
import { SqliteCellStorage } from "../../cell-storage-sqlite.ts"

const [, , mode, dbPath, ...rest] = process.argv

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

if (mode === "hammer") {
  const [cellId, partitionKey, countRaw] = rest
  const count = Number(countRaw)
  if (!dbPath || !cellId || !partitionKey || !Number.isFinite(count)) {
    fail("hammer: expected <dbPath> <cellId> <partitionKey> <count>")
  }
  const storage = new SqliteCellStorage(dbPath)
  // Barrier: both hammers start their loops together, so the two
  // processes genuinely overlap instead of running back to back.
  process.stdout.write("ready\n")
  process.stdin.setEncoding("utf8")
  let buffered = ""
  process.stdin.on("data", (chunk: string) => {
    buffered += chunk
    if (!buffered.includes("go")) return
    process.stdin.pause()
    const startedAt = Date.now()
    let attempts = 0
    for (let i = 0; i < count; i++) {
      attempts += casUpdateRow(storage, "default", cellId, partitionKey, (current) => {
        return (typeof current === "number" ? current : 0) + 1
      })
    }
    const endedAt = Date.now()
    process.stdout.write(`${JSON.stringify({ writes: count, attempts, startedAt, endedAt })}\n`)
    process.exit(0)
  })
} else if (mode === "burst") {
  const [cellId, countRaw] = rest
  const count = Number(countRaw)
  if (!dbPath || !cellId || !Number.isFinite(count)) {
    fail("burst: expected <dbPath> <cellId> <count>")
  }
  const storage = new SqliteCellStorage(dbPath)
  const run = async (): Promise<void> => {
    for (let i = 1; i <= count; i++) {
      storage.write("default", cellId, `k${i}`, i)
      storage.write("default", cellId, "counter", i)
      // Printed strictly AFTER both writes returned — an ack the
      // parent observes names writes the store has committed.
      process.stdout.write(`acked ${i}\n`)
      // Brief yield every few writes so the piped acks actually flush
      // while the burst runs (the parent kills us mid-stream).
      if (i % 25 === 0) await new Promise((r) => setImmediate(r))
    }
    process.exit(0)
  }
  void run()
} else {
  fail(`unknown mode ${JSON.stringify(mode)}`)
}
