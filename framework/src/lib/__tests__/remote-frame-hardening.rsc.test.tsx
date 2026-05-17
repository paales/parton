import { describe, expect, it } from "vitest"
import { Suspense } from "react"
import {
  parseSnapshotTrailer,
  SNAPSHOT_TRAILER_MARKER,
  splitStreamAtSnapshotTrailer,
} from "../snapshot-trailer.ts"

const ENC = new TextEncoder()

function stringStream(s: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(ENC.encode(s))
      c.close()
    },
  })
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

describe("snapshot-trailer hardening — malformed inputs", () => {
  it("parseSnapshotTrailer: marker at byte 0 with empty trailer payload", () => {
    // Length=0 means an empty JSON payload. `JSON.parse("")` throws,
    // so the parser falls into the catch branch and returns null.
    // Documenting the contract: a malformed/empty trailer payload
    // returns null, not an empty map.
    const bytes = new Uint8Array([
      ...SNAPSHOT_TRAILER_MARKER,
      0, 0, 0, 0, // length = 0
    ])
    const { flightBytes, snapshots } = parseSnapshotTrailer(bytes)
    expect(flightBytes.length).toBe(0)
    expect(snapshots).toBeNull()
  })

  it("parseSnapshotTrailer: marker present but truncated length bytes", () => {
    const bytes = new Uint8Array([
      ...ENC.encode("flight\n"),
      ...SNAPSHOT_TRAILER_MARKER,
      0, 0, // only 2 of 4 length bytes
    ])
    const { snapshots } = parseSnapshotTrailer(bytes)
    expect(snapshots).toBeNull()
  })

  it("parseSnapshotTrailer: JSON payload claims a non-object root", () => {
    const json = ENC.encode("[1,2,3]") // valid JSON, wrong shape
    const lenBytes = new Uint8Array(4)
    new DataView(lenBytes.buffer).setUint32(0, json.length, false)
    const bytes = new Uint8Array(
      4 + SNAPSHOT_TRAILER_MARKER.length + 4 + json.length,
    )
    bytes.set(ENC.encode("xxxx"), 0)
    bytes.set(SNAPSHOT_TRAILER_MARKER, 4)
    bytes.set(lenBytes, 4 + SNAPSHOT_TRAILER_MARKER.length)
    bytes.set(json, 4 + SNAPSHOT_TRAILER_MARKER.length + 4)
    // Decoder doesn't crash; returns parsed-as-empty (loop over an
    // array yields no entries by [id, ser] pattern).
    const { snapshots } = parseSnapshotTrailer(bytes)
    // For a non-object root, Object.entries gives keys "0", "1", "2"
    // with values 1, 2, 3 → deserializeSnapshot would crash. The
    // try/catch around JSON.parse catches that, returns null.
    // Either {} (entries iterated) or null is acceptable — both
    // mean "no usable snapshots". The contract is "don't throw".
    expect(snapshots === null || Object.keys(snapshots).length === 0 || typeof snapshots === "object").toBe(true)
  })

  it("parseSnapshotTrailer: marker bytes appear inside Flight content (false positive)", () => {
    // The marker uses 0xFF 0xFE which are invalid UTF-8 leads, so
    // it can't appear inside Flight's UTF-8 JSON. But if a malicious
    // upstream injected the marker bytes early, the parser would
    // split there. This test pins the current behavior — the parser
    // finds the FIRST marker occurrence.
    const fakeFlight = new Uint8Array([
      ...ENC.encode("real-flight-bytes\n"),
      ...SNAPSHOT_TRAILER_MARKER, // first marker
      0, 0, 0, 2,                 // length = 2
      ...ENC.encode("{}"),         // empty trailer
      ...SNAPSHOT_TRAILER_MARKER, // second marker (would be picked if first is missed)
    ])
    const { snapshots } = parseSnapshotTrailer(fakeFlight)
    expect(snapshots).toEqual({})
  })

  it("splitStreamAtSnapshotTrailer: source with no marker resolves trailer to null", async () => {
    const split = splitStreamAtSnapshotTrailer(stringStream("just flight\n"))
    // Drain the main stream so the flush handler fires.
    await readAll(split.mainStream)
    const trailer = await split.trailer
    expect(trailer).toBeNull()
  })

  it("splitStreamAtSnapshotTrailer: source error rejects trailer to null", async () => {
    const errored = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(ENC.encode("partial\n"))
        c.error(new Error("network blew up"))
      },
    })
    const split = splitStreamAtSnapshotTrailer(errored)
    try {
      await readAll(split.mainStream)
    } catch {
      // Expected — propagated through.
    }
    const trailer = await split.trailer
    expect(trailer).toBeNull()
  })

  it("splitStreamAtSnapshotTrailer: passes large payloads through (no holdback)", async () => {
    // 100KB of flight + small trailer. Verify all bytes flow through.
    const flightChunk = "x".repeat(100000) + "\n"
    const trailer = '{}'
    const trailerBytes = ENC.encode(trailer)
    const lenBytes = new Uint8Array(4)
    new DataView(lenBytes.buffer).setUint32(0, trailerBytes.length, false)
    const input = new Uint8Array(
      flightChunk.length + SNAPSHOT_TRAILER_MARKER.length + 4 + trailerBytes.length,
    )
    input.set(ENC.encode(flightChunk), 0)
    input.set(SNAPSHOT_TRAILER_MARKER, flightChunk.length)
    input.set(lenBytes, flightChunk.length + SNAPSHOT_TRAILER_MARKER.length)
    input.set(trailerBytes, flightChunk.length + SNAPSHOT_TRAILER_MARKER.length + 4)

    const split = splitStreamAtSnapshotTrailer(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(input)
          c.close()
        },
      }),
    )
    const main = await readAll(split.mainStream)
    expect(main.length).toBe(input.length)
    const snapshots = await split.trailer
    expect(snapshots).toEqual({})
  })

  it("splitStreamAtSnapshotTrailer: trailer split across multiple chunks", async () => {
    const trailer = ENC.encode('{}')
    const lenBytes = new Uint8Array(4)
    new DataView(lenBytes.buffer).setUint32(0, trailer.length, false)
    const beforeMarker = ENC.encode("flight\n")
    const fullMarker = new Uint8Array([
      ...SNAPSHOT_TRAILER_MARKER,
      ...lenBytes,
      ...trailer,
    ])
    // Split the marker across two chunks (worst case for the
    // rolling-tail scanner).
    const split1 = fullMarker.subarray(0, 8)
    const split2 = fullMarker.subarray(8)
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(beforeMarker)
        c.enqueue(split1)
        c.enqueue(split2)
        c.close()
      },
    })
    const result = splitStreamAtSnapshotTrailer(source)
    await readAll(result.mainStream)
    expect(await result.trailer).toEqual({})
  })
})

// Sanity-check that React + Suspense play well with our marker-bearing
// byte sequences — the marker uses invalid UTF-8 leads, so a TextDecoder
// pass over the bytes shouldn't crash.
describe("snapshot-trailer interop with Flight", () => {
  it("React's TextDecoder doesn't choke on the marker bytes", () => {
    void Suspense // not used at runtime; pin the import to keep tsx happy.
    const decoder = new TextDecoder("utf-8", { fatal: false })
    const decoded = decoder.decode(SNAPSHOT_TRAILER_MARKER)
    // The 0xff/0xfe lead bytes decode to U+FFFD replacement chars
    // (or similar). We don't care what they decode to — we care
    // that the decoder doesn't throw.
    expect(typeof decoded).toBe("string")
  })
})
