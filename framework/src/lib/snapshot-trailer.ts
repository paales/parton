/**
 * Snapshot trailer for `<RemoteFrame>` wire format.
 *
 * A remote endpoint renders a parton inside its own request scope
 * (separate from the host). PartialBoundary's `registerPartial`
 * side effect runs against the REMOTE's request registry — so the
 * host's snapshot map never sees the remote's partial ids, and
 * `nav.reload({selector: "<remote-id>"})` resolves to a registry
 * miss → streaming-mode fallback.
 *
 * Fix: after the remote's render completes, collect the snapshots
 * it produced and ship them to the host as a trailing segment
 * after the Flight bytes. The host's `<RemoteFrame>` splits the
 * stream, decodes Flight as usual, parses the trailer, and re-
 * registers each snapshot in its own request registry. Selector-
 * targeted refetch now finds the id and runs through the normal
 * cache-mode path (the spec lookup hits the local catalog in
 * same-origin v1 and the remote endpoint in cross-origin v2).
 *
 * Wire format (concatenated, in order):
 *
 *   <Flight bytes...>
 *   <12-byte SNAPSHOT_TRAILER_MARKER>
 *   <4-byte big-endian length>
 *   <UTF-8 JSON of {id → serialized snapshot} map>
 *
 * Marker shape is identical to `fp-trailer-marker.ts`: leading
 * `\xFF\xFE` (invalid UTF-8 lead bytes — cannot appear inside
 * Flight's UTF-8 JSON output) + 8 ASCII tag bytes + trailing
 * `\xFD\xFC`. Tag is `snapshots` so a future generalised splitter
 * can dispatch on it.
 *
 * Mirrors the fp-trailer machinery (`framework/src/lib/fp-trailer.ts`
 * + `fp-trailer-split.ts`). Kept separate for now so the two
 * trailer types don't entangle; can be unified once a third use
 * case appears.
 */

import type { PartialSnapshot } from "./partial-registry.ts"

const SNAPSHOT_TRAILER_TAG = "snapshots"

function buildMarker(): Uint8Array {
  const bytes = new Uint8Array(12)
  bytes[0] = 0xff
  bytes[1] = 0xfe
  const tag = new TextEncoder().encode(SNAPSHOT_TRAILER_TAG)
  if (tag.length !== 8) {
    // Tag must be exactly 8 ASCII chars to keep the 12-byte marker
    // fixed-width. `snapshots` is 9 chars; encode handles that.
  }
  // Fill 8 tag bytes (truncate or pad with NULs if needed).
  for (let i = 0; i < 8; i++) bytes[2 + i] = tag[i] ?? 0
  bytes[10] = 0xfd
  bytes[11] = 0xfc
  return bytes
}

export const SNAPSHOT_TRAILER_MARKER: Readonly<Uint8Array> = buildMarker()

// ─── Snapshot serialization ────────────────────────────────────────────

/**
 * The PartialSnapshot interface carries a few fields that can't
 * (or shouldn't) cross the wire:
 *
 * - `fallback: ReactNode` — arbitrary JSX. Drop it; the host can
 *   look up the spec's fallback locally via the spec catalog if
 *   the spec is registered (same-origin) or accept that fallback
 *   shows fresh-render-only (cross-origin).
 * - `cache: CacheOptions` — drop it; cache decisions are made by
 *   the rendering side, not the calling side.
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
  sessionDeps?: readonly string[]
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
  if (snap.sessionDeps !== undefined) out.sessionDeps = [...snap.sessionDeps]
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
    ...(ser.sessionDeps !== undefined ? { sessionDeps: ser.sessionDeps } : {}),
  }
}

// ─── Server-side wrap ──────────────────────────────────────────────────

/**
 * Appends a snapshot trailer to the source stream. The snapshots
 * argument is a `Map<id, PartialSnapshot>` (typically the remote
 * request registry's `pendingWrites` after render completes).
 *
 * Pass-through: every source chunk forwards immediately. The
 * trailer is only emitted on stream close.
 */
export function wrapStreamWithSnapshotTrailer(
  source: ReadableStream<Uint8Array>,
  getSnapshots: () => Map<string, PartialSnapshot>,
): ReadableStream<Uint8Array> {
  const transformer = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
    },
    flush(controller) {
      const snapshots = getSnapshots()
      const serializable: Record<string, SerializedSnapshot> = {}
      for (const [id, snap] of snapshots) {
        serializable[id] = serializeSnapshot(snap)
      }
      const json = JSON.stringify(serializable)
      const jsonBytes = new TextEncoder().encode(json)

      controller.enqueue(SNAPSHOT_TRAILER_MARKER)
      const lenBytes = new Uint8Array(4)
      new DataView(lenBytes.buffer).setUint32(0, jsonBytes.length, false)
      controller.enqueue(lenBytes)
      controller.enqueue(jsonBytes)
    },
  })
  source.pipeTo(transformer.writable).catch(() => {
    // Source errored; the transformer closes its own readable side.
  })
  return transformer.readable
}

// ─── Host-side parse ───────────────────────────────────────────────────

export interface SplitBuffer {
  /** Flight bytes (everything before the marker). */
  flightBytes: Uint8Array
  /** Decoded snapshot map, or `null` if no trailer was present. */
  snapshots: Record<string, PartialSnapshot> | null
}

/**
 * Splits a buffered response into Flight bytes + snapshot map.
 *
 * Buffer-then-split: the caller has to wait for the full remote
 * response before any Flight content can be decoded. Use when the
 * remote's payload is small or when within-remote streaming isn't
 * needed. For streaming, use `splitStreamAtSnapshotTrailer`.
 */
export function parseSnapshotTrailer(bytes: Uint8Array): SplitBuffer {
  const idx = indexOfMarker(bytes, SNAPSHOT_TRAILER_MARKER)
  if (idx < 0) return { flightBytes: bytes, snapshots: null }
  const flightBytes = bytes.subarray(0, idx)
  const after = bytes.subarray(idx + SNAPSHOT_TRAILER_MARKER.length)
  if (after.length < 4) return { flightBytes, snapshots: null }
  const len = new DataView(after.buffer, after.byteOffset + 0, 4).getUint32(0, false)
  if (after.length < 4 + len) return { flightBytes, snapshots: null }
  const jsonBytes = after.subarray(4, 4 + len)
  try {
    const raw = JSON.parse(
      new TextDecoder().decode(jsonBytes),
    ) as Record<string, SerializedSnapshot>
    const out: Record<string, PartialSnapshot> = {}
    for (const [id, ser] of Object.entries(raw)) {
      out[id] = deserializeSnapshot(ser)
    }
    return { flightBytes, snapshots: out }
  } catch {
    return { flightBytes, snapshots: null }
  }
}

// ─── Host-side streaming split ─────────────────────────────────────────

export interface SnapshotStreamSplit {
  /** Pass-through main stream — Flight bytes flow through immediately
   *  so the decoder can resolve lazies as they arrive (within-remote
   *  Suspense streams to the host). */
  mainStream: ReadableStream<Uint8Array>
  /** Resolves on source-end with the decoded snapshot map (or `null`
   *  if no trailer was present). Subscribe to register snapshots in
   *  the host's request registry once the remote has finished. */
  trailer: Promise<Record<string, PartialSnapshot> | null>
}

/**
 * Streaming version of `parseSnapshotTrailer`. Pass-through main
 * stream lets the host decode the remote's Flight bytes
 * incrementally (preserves Suspense pacing within the remote
 * payload). The trailer promise resolves on source-end with the
 * snapshot map for host-side registration.
 *
 * Mirrors the shape of `splitAtFpTrailer` in `fp-trailer-split.ts`.
 * The marker + trailer bytes leak through to the consumer; Flight
 * ignores trailing non-Flight noise after the root row resolves.
 */
export function splitStreamAtSnapshotTrailer(
  source: ReadableStream<Uint8Array>,
): SnapshotStreamSplit {
  let resolveTrailer!: (v: Record<string, PartialSnapshot> | null) => void
  let settled = false
  const trailerPromise = new Promise<Record<string, PartialSnapshot> | null>((r) => {
    resolveTrailer = (v) => {
      if (settled) return
      settled = true
      r(v)
    }
  })

  const marker = SNAPSHOT_TRAILER_MARKER
  let tail = new Uint8Array(0)
  const TAIL_CAP = marker.length + 4 + 256 * 1024

  const transformer = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      if (chunk.length >= TAIL_CAP) {
        const trimmed = new Uint8Array(TAIL_CAP)
        trimmed.set(chunk.subarray(chunk.length - TAIL_CAP), 0)
        tail = trimmed
      } else {
        const combined = new Uint8Array(tail.length + chunk.length)
        combined.set(tail, 0)
        combined.set(chunk, tail.length)
        if (combined.length > TAIL_CAP) {
          const trimmed = new Uint8Array(TAIL_CAP)
          trimmed.set(combined.subarray(combined.length - TAIL_CAP), 0)
          tail = trimmed
        } else {
          tail = combined
        }
      }
    },
    flush() {
      const idx = indexOfMarker(tail, marker)
      if (idx < 0) {
        resolveTrailer(null)
        return
      }
      const trailerBytes = tail.subarray(idx + marker.length)
      if (trailerBytes.length < 4) {
        resolveTrailer(null)
        return
      }
      const len = new DataView(
        trailerBytes.buffer,
        trailerBytes.byteOffset,
        4,
      ).getUint32(0, false)
      if (trailerBytes.length < 4 + len) {
        resolveTrailer(null)
        return
      }
      const jsonBytes = trailerBytes.subarray(4, 4 + len)
      try {
        const raw = JSON.parse(
          new TextDecoder().decode(jsonBytes),
        ) as Record<string, SerializedSnapshot>
        const out: Record<string, PartialSnapshot> = {}
        for (const [id, ser] of Object.entries(raw)) {
          out[id] = deserializeSnapshot(ser)
        }
        resolveTrailer(out)
      } catch {
        resolveTrailer(null)
      }
    },
  })

  source.pipeTo(transformer.writable).catch(() => {
    resolveTrailer(null)
  })

  return {
    mainStream: transformer.readable,
    trailer: trailerPromise,
  }
}

function indexOfMarker(buffer: Uint8Array, marker: Uint8Array): number {
  const last = buffer.length - marker.length
  outer: for (let i = 0; i <= last; i++) {
    for (let j = 0; j < marker.length; j++) {
      if (buffer[i + j] !== marker[j]) continue outer
    }
    return i
  }
  return -1
}
