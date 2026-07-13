/**
 * Snapshot trailer — the registration payload on an embed-flagged
 * page response.
 *
 * An embedded page renders inside its own request scope (separate
 * from the host). PartialBoundary's `registerPartial` side effect
 * runs against the EMBEDDED render's request registry — so the
 * host's snapshot map never sees the embedded partons, and
 * `nav.reload({selector: "<id>"})` would resolve to a registry miss.
 *
 * Fix: after the embedded render completes, the producer collects
 * the snapshots it produced and appends them as one trailer entry
 * after the Flight bytes:
 *
 *   <Flight bytes…>
 *   \n\xFF[parton:snapshots:N]\n
 *   <N bytes of UTF-8 JSON {id → serialized snapshot}>
 *
 * The same `buildMarker` grammar as the fp / url / settled trailer
 * entries — so the host's `<RemoteFrame>` reads it off the segment's
 * trailer map (`splitSegments` strips every `\xFF` entry out of the
 * body and resolves them as tag → bytes) with no dedicated splitter.
 * `\xFF` is invalid UTF-8, so the marker can't occur inside Flight
 * payload bytes.
 */

import type { PartialSnapshot } from "./partial-registry.ts"
import { buildMarker } from "./fp-trailer-marker.ts"

/** Trailer-entry tag for the snapshot registration payload. */
export const TAG_SNAPSHOTS = "snapshots"

// ─── Snapshot serialization ────────────────────────────────────────────

/**
 * The PartialSnapshot interface carries a few fields that can't
 * (or shouldn't) cross the wire:
 *
 * - `fallback: ReactNode` — arbitrary JSX. Drop it; a refetch
 *   re-embeds the page, which renders its own fallbacks.
 * - `cache: CacheOptions` — drop it; cache decisions are made by
 *   the rendering side, not the embedding side.
 * - `source` — drop it; each hop of a nested embed chain stamps its
 *   OWN fetch URL when registering, which is exactly the hop a
 *   refetch must retrace.
 *
 * Everything else serializes as JSON.
 */
export interface SerializedSnapshot {
  type: string
  labels: string[]
  framePath: readonly string[]
  parentFrameChain: readonly string[]
  parentPath: readonly string[]
  props?: Record<string, unknown>
  varyKey?: string
  matchKey?: string
  emittedFp?: string
}

export function serializeSnapshot(snap: PartialSnapshot): SerializedSnapshot {
  const out: SerializedSnapshot = {
    type: snap.type,
    labels: [...snap.labels],
    framePath: [...snap.framePath],
    parentFrameChain: [...snap.parentFrameChain],
    parentPath: [...snap.parentPath],
  }
  if (snap.props !== undefined) out.props = snap.props
  if (snap.varyKey !== undefined) out.varyKey = snap.varyKey
  if (snap.matchKey !== undefined) out.matchKey = snap.matchKey
  if (snap.emittedFp !== undefined) out.emittedFp = snap.emittedFp
  return out
}

export function deserializeSnapshot(ser: SerializedSnapshot): PartialSnapshot {
  return {
    type: ser.type,
    fallback: null,
    labels: ser.labels,
    framePath: Object.freeze([...ser.framePath]),
    parentFrameChain: Object.freeze([...ser.parentFrameChain]),
    parentPath: Object.freeze([...ser.parentPath]),
    ...(ser.props !== undefined ? { props: ser.props } : {}),
    ...(ser.varyKey !== undefined ? { varyKey: ser.varyKey } : {}),
    ...(ser.matchKey !== undefined ? { matchKey: ser.matchKey } : {}),
    ...(ser.emittedFp !== undefined ? { emittedFp: ser.emittedFp } : {}),
  }
}

/**
 * Build the snapshot trailer bytes. Returns a single Uint8Array
 * containing the marker + JSON body, ready to enqueue. Exported so
 * test fixtures can construct wire bytes directly.
 */
export function buildSnapshotTrailer(snapshots: Map<string, PartialSnapshot>): Uint8Array {
  const serializable: Record<string, SerializedSnapshot> = {}
  for (const [id, snap] of snapshots) {
    serializable[id] = serializeSnapshot(snap)
  }
  const json = JSON.stringify(serializable)
  const jsonBytes = new TextEncoder().encode(json)
  const header = buildMarker(TAG_SNAPSHOTS, jsonBytes.byteLength)
  const out = new Uint8Array(header.byteLength + jsonBytes.byteLength)
  out.set(header, 0)
  out.set(jsonBytes, header.byteLength)
  return out
}

// ─── Server-side wrap ──────────────────────────────────────────────────

/**
 * Appends a snapshot trailer to the source stream. The snapshots
 * come from `getSnapshots()` at flush time — typically the embedded
 * request registry's `pendingWrites` after render completes, read
 * LATE so nested embeds' own trailer registrations (which land via
 * commit-defer inside the upstream wrapper's flush) are included.
 *
 * Pass-through: every source chunk forwards immediately. The
 * trailer is only emitted on stream close.
 */
export function wrapStreamWithSnapshotTrailer(
  source: ReadableStream<Uint8Array>,
  getSnapshots: () => Map<string, PartialSnapshot>,
): ReadableStream<Uint8Array> {
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk)
      },
      flush(controller) {
        controller.enqueue(buildSnapshotTrailer(getSnapshots()))
      },
    }),
  )
}
