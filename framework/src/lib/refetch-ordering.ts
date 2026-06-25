/**
 * Monotonic commit ordering for window-scoped selector refetches.
 *
 * Every search keystroke fires an independent `.search-results` refetch
 * (`navigate({selector})`). Superseded fires are NOT aborted — aborting
 * one mid-decode would reject the whole Flight document and crash the
 * page — so they drain and commit. Their responses can therefore arrive
 * OUT OF ORDER, and a naive "last commit wins" lets an older-issued
 * ("po") tree clobber a newer one ("pokemo"): the "stage-1 committed a
 * tree for a stale query" bug.
 *
 * The window URL was the only arbiter, and it's a proxy — it lags rapid
 * input and can't tell two fires for the same query apart. The real
 * signal is an explicit monotonic issue sequence per selector: stamp
 * each fire at dispatch (`nextRefetchSeq`), then let a segment commit
 * only if its seq is not older than the newest already committed for
 * that selector (`claimRefetchCommit`). Last ISSUED wins, regardless of
 * arrival order.
 *
 * Selector identity is the key — the sorted, comma-joined label set, as
 * on the wire's `?partials=` (see `inFlightKey` in `partial-client.tsx`).
 * Pure module state, no browser coupling, so the ordering contract is
 * unit-testable in isolation.
 */

const _issueSeq = new Map<string, number>()
const _committedSeq = new Map<string, number>()

/** Next monotonic issue sequence for a selector key. Called once per
 *  dispatched refetch so issue order is recorded. */
export function nextRefetchSeq(key: string): number {
  const next = (_issueSeq.get(key) ?? 0) + 1
  _issueSeq.set(key, next)
  return next
}

/**
 * Gate a refetch segment's commit. Returns `false` when a newer fire
 * for this selector key has already committed — i.e. this segment
 * belongs to a superseded fire whose response arrived late, so
 * committing it would clobber the newer tree. A `true` result advances
 * the key's high-water mark, so any older fire that lands later is
 * dropped.
 *
 * Equal seq passes: the multiple segments of one streaming refetch
 * share an issue seq and must all commit (stage 1 → 2 → 3).
 */
export function claimRefetchCommit(key: string, seq: number): boolean {
  if (seq < (_committedSeq.get(key) ?? 0)) return false
  _committedSeq.set(key, seq)
  return true
}
