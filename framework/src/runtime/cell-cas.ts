/**
 * The store-level compare-and-retry loop behind `cell.update(fn)` on
 * versioned storage adapters (`CellStorage.readVersioned` /
 * `writeIfVersion` — the SQLite adapter).
 *
 * In-process, the update pipeline's synchronous read→updater→write
 * section needs no concurrency control beyond the event loop. Across
 * processes there is no shared event loop — the store's per-row write
 * counter is the arbiter: read the row + version, compute the next
 * value, commit only if the version is unchanged. A failed commit
 * means ANOTHER PROCESS advanced the row between our read and our
 * write; re-read and recompute against its result, so both updates
 * compose instead of the later write clobbering the earlier one.
 *
 * Progress: a CAS failure implies some other writer succeeded, so the
 * system as a whole always advances (lock-free). Per-caller starvation
 * is theoretically possible under adversarial contention; the attempt
 * cap converts a pathological store (or a livelock nobody has ever
 * produced) into a loud error instead of a hang.
 *
 * Kept free of framework imports so plain `node` can load it — the
 * multi-process contention tests run THIS code in child processes
 * against a shared database file.
 */

/** The structural slice of `CellStorage` the loop needs. */
export interface VersionedCellStore {
  readVersioned(
    scope: string,
    cellId: string,
    partitionKey: string,
  ): { value: unknown; version: number } | undefined
  writeIfVersion(
    scope: string,
    cellId: string,
    partitionKey: string,
    value: unknown,
    expectedVersion: number,
  ): boolean
}

export const CAS_MAX_ATTEMPTS = 1000

/**
 * Read-compute-commit until the commit lands. `compute` receives the
 * RAW stored value (`undefined` on a missing row or an invalidated
 * slot) and returns the value to store — callers bake coercion,
 * validation, and canonicalisation into it. Returns the number of
 * attempts (1 = no contention); throws the compute's own errors
 * through, and a descriptive error past `CAS_MAX_ATTEMPTS`.
 */
export function casUpdateRow(
  store: VersionedCellStore,
  scope: string,
  cellId: string,
  partitionKey: string,
  compute: (current: unknown) => unknown,
): number {
  for (let attempt = 1; attempt <= CAS_MAX_ATTEMPTS; attempt++) {
    const row = store.readVersioned(scope, cellId, partitionKey)
    const next = compute(row?.value)
    if (store.writeIfVersion(scope, cellId, partitionKey, next, row?.version ?? 0)) {
      return attempt
    }
  }
  throw new Error(
    `cell-cas: cell "${cellId}" @ ${partitionKey}: compare-and-swap failed ${CAS_MAX_ATTEMPTS} ` +
      `times — every attempt found the row's version moved between read and write. That means ` +
      `either pathological cross-process contention on this one row or a storage adapter whose ` +
      `writeIfVersion never succeeds.`,
  )
}
