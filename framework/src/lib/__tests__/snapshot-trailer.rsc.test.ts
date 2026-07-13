import { describe, expect, it } from "vitest"
import {
  TAG_SNAPSHOTS,
  buildSnapshotTrailer,
  deserializeSnapshot,
  serializeSnapshot,
  wrapStreamWithSnapshotTrailer,
  type SerializedSnapshot,
} from "../snapshot-trailer.ts"
import { splitSegments } from "../fp-trailer-split.ts"
import type { PartialSnapshot } from "../partial-registry.ts"

const ENC = new TextEncoder()

function makeStream(s: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(ENC.encode(s))
      c.close()
    },
  })
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Consume a snapshot-trailer-wrapped stream the way `<RemoteFrame>`
 *  does: `splitSegments`' first segment strips every `\xFF` entry out
 *  of the body and resolves the trailer map. */
async function consumeAsEmbed(stream: ReadableStream<Uint8Array>): Promise<{
  body: string
  snapshots: Record<string, SerializedSnapshot> | null
}> {
  const iter = splitSegments(stream)[Symbol.asyncIterator]()
  const first = await iter.next()
  if (first.done || first.value.kind !== "payload") throw new Error("no payload segment")
  const body = await new Response(first.value.body).text()
  const trailers = await first.value.trailers
  const bytes = trailers.get(TAG_SNAPSHOTS)
  if (!bytes) return { body, snapshots: null }
  try {
    return {
      body,
      snapshots: JSON.parse(new TextDecoder().decode(bytes)) as Record<string, SerializedSnapshot>,
    }
  } catch {
    return { body, snapshots: null }
  }
}

function makeSnapshot(overrides: Partial<PartialSnapshot> = {}): PartialSnapshot {
  return {
    type: "test-spec",
    fallback: null,
    labels: ["test-spec"],
    framePath: Object.freeze([]),
    parentFrameChain: Object.freeze([]),
    parentPath: Object.freeze([]),
    ...overrides,
  }
}

describe("serializeSnapshot / deserializeSnapshot", () => {
  it("round-trips a minimal snapshot", () => {
    const orig = makeSnapshot()
    const ser = serializeSnapshot(orig)
    const json = JSON.parse(JSON.stringify(ser))
    const back = deserializeSnapshot(json)
    expect(back.type).toBe(orig.type)
    expect(back.labels).toEqual(orig.labels)
    expect(back.framePath).toEqual([])
    expect(back.parentFrameChain).toEqual([])
    expect(back.parentPath).toEqual([])
  })

  it("preserves optional fields when present", () => {
    const orig = makeSnapshot({
      labels: ["a", "b"],
      framePath: Object.freeze(["frame1"]),
      parentPath: Object.freeze(["root", "wrap"]),
      props: { foo: "bar", n: 42 },
      varyKey: "vk123",
      matchKey: "mk456",
      emittedFp: "fp789",
    })
    const back = deserializeSnapshot(JSON.parse(JSON.stringify(serializeSnapshot(orig))))
    expect(back.framePath).toEqual(["frame1"])
    expect(back.parentPath).toEqual(["root", "wrap"])
    expect(back.props).toEqual({ foo: "bar", n: 42 })
    expect(back.varyKey).toBe("vk123")
    expect(back.matchKey).toBe("mk456")
    expect(back.emittedFp).toBe("fp789")
  })

  it("drops non-serializable and hop-local fields", () => {
    const orig = makeSnapshot({
      fallback: "would be JSX in real life",
      cache: { maxAge: 60 },
      source: { kind: "page", url: "http://t/x", ns: "e~abc" },
    })
    const ser = serializeSnapshot(orig)
    expect("fallback" in ser).toBe(false)
    expect("cache" in ser).toBe(false)
    // Each hop re-stamps `source` with ITS fetch URL — the wire form
    // never carries the producer's own stamp.
    expect("source" in ser).toBe(false)
  })

  it("omits absent optional fields from the serialized form", () => {
    const orig = makeSnapshot()
    const ser = serializeSnapshot(orig)
    expect("props" in ser).toBe(false)
    expect("varyKey" in ser).toBe(false)
    expect("matchKey" in ser).toBe(false)
    expect("emittedFp" in ser).toBe(false)
  })

  it("deserialized snapshot has fallback: null", () => {
    const back = deserializeSnapshot(serializeSnapshot(makeSnapshot()))
    expect(back.fallback).toBeNull()
  })
})

describe("wrapStreamWithSnapshotTrailer → splitSegments trailer map", () => {
  it("round-trips an empty trailer; body bytes are untouched", async () => {
    const wrapped = wrapStreamWithSnapshotTrailer(makeStream('5:"hello"\n'), () => new Map())
    const { body, snapshots } = await consumeAsEmbed(wrapped)
    expect(body).toBe('5:"hello"\n')
    expect(snapshots).toEqual({})
  })

  it("round-trips a trailer with snapshots", async () => {
    const sourceText = '0:{"v":"$L1"}\n1:"data"\n'
    const snap = makeSnapshot({
      type: "demo",
      labels: ["demo", "extra"],
      matchKey: "mk-abc",
      emittedFp: "fp-xyz",
    })
    const wrapped = wrapStreamWithSnapshotTrailer(
      makeStream(sourceText),
      () => new Map([["demo", snap]]),
    )
    const { body, snapshots } = await consumeAsEmbed(wrapped)
    expect(body).toBe(sourceText)
    expect(Object.keys(snapshots ?? {})).toEqual(["demo"])
    expect(snapshots!.demo.type).toBe("demo")
    expect(snapshots!.demo.labels).toEqual(["demo", "extra"])
    expect(snapshots!.demo.matchKey).toBe("mk-abc")
    expect(snapshots!.demo.emittedFp).toBe("fp-xyz")
  })

  it("handles multiple snapshots in one trailer", async () => {
    const wrapped = wrapStreamWithSnapshotTrailer(
      makeStream("0:x\n"),
      () =>
        new Map([
          ["a", makeSnapshot({ type: "a", labels: ["a"] })],
          ["b", makeSnapshot({ type: "b", labels: ["b", "shared"] })],
          ["c", makeSnapshot({ type: "c", labels: ["c"] })],
        ]),
    )
    const { snapshots } = await consumeAsEmbed(wrapped)
    expect(Object.keys(snapshots ?? {}).sort()).toEqual(["a", "b", "c"])
    expect(snapshots!.b.labels).toEqual(["b", "shared"])
  })

  it("trailer bytes never leak into the split body", async () => {
    const wrapped = wrapStreamWithSnapshotTrailer(
      makeStream("xyz\n"),
      () => new Map([["a", makeSnapshot({ type: "a" })]]),
    )
    const bytes = await readAll(wrapped)
    // Wire carries the marker…
    expect(new TextDecoder("utf-8", { fatal: false }).decode(bytes)).toContain("[parton:snapshots:")
    // …but the split body is exactly the Flight bytes.
    const { body } = await consumeAsEmbed(
      new ReadableStream({
        start(c) {
          c.enqueue(bytes)
          c.close()
        },
      }),
    )
    expect(body).toBe("xyz\n")
  })

  it("buildSnapshotTrailer bytes decode as one trailer entry even when chunk-split", async () => {
    const trailer = buildSnapshotTrailer(new Map([["a", makeSnapshot({ type: "a" })]]))
    const flight = ENC.encode("flight\n")
    // Split the marker across two chunks (worst case for the
    // splitter's accumulate-until-parseable loop).
    const cut = flight.length + 8
    const all = new Uint8Array(flight.length + trailer.length)
    all.set(flight, 0)
    all.set(trailer, flight.length)
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(all.subarray(0, cut))
        c.enqueue(all.subarray(cut))
        c.close()
      },
    })
    const { body, snapshots } = await consumeAsEmbed(source)
    expect(body).toBe("flight\n")
    expect(Object.keys(snapshots ?? {})).toEqual(["a"])
  })
})
