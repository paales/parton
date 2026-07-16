/**
 * Forced lanes over page-embedded snapshots — the increment-2 refetch
 * path against a real drive.
 *
 * A host page embeds the SAME page twice (distinct placement
 * namespaces). A url statement whose `?__force=` overlay names BOTH
 * embedded ids must lane each one as a focused re-embed
 * (`?partials=<id>` at the embedded URL, stored namespace replayed) —
 * fresh bytes for both placements. Forces are effective parton ids:
 * the framework-internal id-forcing protocol, resolved against the
 * route's snapshots.
 */

import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Fragment, Suspense } from "react"
import { _captureCommitHandle, runWithRequestAsync } from "../../runtime/context.ts"
import { _clearInvalidationRegistry } from "../../runtime/invalidation-registry.ts"
import { _clearAllSessions } from "../../runtime/session.ts"
import {
  decodeLane,
  drainPayloadSegment,
  freshLiveScope,
  withLiveDrive,
} from "../../test/live-drive.tsx"
import { CHANNEL_ENDPOINT, type ChannelEnvelope } from "../channel-protocol.ts"
import { tag } from "../current-parton.ts"
import { handleChannelPost } from "../connection-session.ts"
import { renderServerToFlight } from "../../test/rsc-server.ts"
import { rewriteFlightStream, type RowRewriter } from "../flight-rewrite.ts"
import { wrapStreamWithCommitOnly } from "../fp-trailer.ts"
import { embedNamespaceOf, stripEmbedNamespace } from "../page-embed.ts"
import {
  PartialRoot,
  computeRouteKey,
  parton,
  partialFromSnapshot,
  stripPlacementFold,
  type RenderArgs,
} from "../partial.tsx"
import {
  _readSnapshotsForRoute,
  clearRegistry,
  enterRequestRegistry,
  lookupPartial,
} from "../partial-registry.ts"
import { runWithPartialState } from "../partial-request-state.ts"
import { RemoteFrame } from "../remote-frame.tsx"
import { wrapStreamWithSnapshotTrailer } from "../snapshot-trailer.ts"

let producerRenders = 0

const LaneWidget = parton(async function PeLaneWidgetRender(_: RenderArgs) {
  // The tag read subscribes this parton to the `pe-lane-widget` wake —
  // what the harness's shutdown bump uses to release the parked drive.
  tag("pe-lane-widget")
  producerRenders++
  return <div>{`lane-widget:${producerRenders}`}</div>
})

function ProducerRoot() {
  return (
    <PartialRoot>
      <html lang="en">
        <body>
          <LaneWidget />
        </body>
      </html>
    </PartialRoot>
  )
}

const LaneHostPage = parton(
  Object.assign(
    function PeLaneHostRender(_: RenderArgs) {
      return (
        <section>
          <Suspense fallback={null}>
            <RemoteFrame url="/pe-lane-embedded" />
          </Suspense>
          <Suspense fallback={null}>
            <RemoteFrame url="/pe-lane-embedded" />
          </Suspense>
        </section>
      )
    },
    { displayName: "pe-lane-host-spec" },
  ),
  { match: "/pe-lane-host" },
)

const LaneHostRoot = (): ReactNode => (
  <PartialRoot>
    <html lang="en">
      <body>
        <LaneHostPage />
      </body>
    </html>
  </PartialRoot>
)

/** Harness-only client-ref neutralizer — see page-embed.rsc.test.tsx. */
const neutralizeClientRefs: RowRewriter = (row) =>
  row.type === "I" ? { ...row, type: "", data: '"client-ref"' } : row

/** Producer stub — mirrors the entry's `handleEmbedRender` for both
 *  shapes (whole page / focused `?partials=`). */
function stubProducerFetch(): { calls: string[] } {
  const calls: string[] = []
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      const headers = new Headers(init?.headers)
      const headerRecord: Record<string, string> = {}
      headers.forEach((v, k) => {
        headerRecord[k] = v
      })
      const request = new Request(url, { headers: headerRecord })
      const partials = new URL(url).searchParams.get("partials")
      const { result } = await runWithRequestAsync(request, async () => {
        let stream: ReadableStream<Uint8Array> | null = null
        let getSnapshots:
          | (() => Map<string, import("../partial-registry.ts").PartialSnapshot>)
          | null = null
        if (partials) {
          const registry = enterRequestRegistry(computeRouteKey(url), "cache")
          getSnapshots = () => registry.pendingWrites
          const ids = partials.split(",").filter(Boolean)
          const targets = ids.map((id) => [id, lookupPartial(id)] as const)
          if (targets.every(([, snap]) => snap !== undefined)) {
            const root = targets.map(([id, snap]) => (
              <Fragment key={id}>{partialFromSnapshot(id, snap!)}</Fragment>
            ))
            stream = runWithPartialState(
              {
                requestedIds: new Set(ids),
                isPartialRefetch: true,
                cachedFingerprints: new Map(),
                cachedMatchKeys: new Map(),
                ackedFingerprints: null,
                explicitIds: new Set(ids),
                seenIds: new Set(),
              },
              () => renderServerToFlight({ root } as unknown as ReactNode),
            )
          }
        }
        if (stream === null) {
          const routeKey = computeRouteKey(url)
          const ns = embedNamespaceOf(new Headers(headerRecord))
          getSnapshots = () => {
            // Committed route set (scope fixed by the harness header),
            // filtered to THIS render's namespace like the entry.
            const all = _readSnapshotsForRoute(headerRecord["x-test-scope"] ?? "default", routeKey)
            if (ns === null) return all
            const own = new Map<string, import("../partial-registry.ts").PartialSnapshot>()
            for (const [id, snap] of all) if (id.startsWith(`${ns}:`)) own.set(id, snap)
            return own
          }
          stream = renderServerToFlight({ root: <ProducerRoot /> } as unknown as ReactNode)
        }
        const wrapped = wrapStreamWithSnapshotTrailer(
          wrapStreamWithCommitOnly(
            rewriteFlightStream(stream, neutralizeClientRefs),
            _captureCommitHandle(),
          ),
          () => getSnapshots!(),
        )
        const [forCaller, forDrain] = wrapped.tee()
        await new Response(forDrain).arrayBuffer()
        return forCaller
      })
      return new Response(result, {
        status: 200,
        headers: { "content-type": "text/x-component;charset=utf-8" },
      })
    },
  )
  return { calls }
}

beforeEach(() => {
  vi.unstubAllGlobals()
  _clearInvalidationRegistry()
  producerRenders = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearRegistry("all")
  _clearAllSessions()
  _clearInvalidationRegistry()
})

async function post(scope: string, envelope: ChannelEnvelope): Promise<number> {
  const request = new Request(`http://localhost${CHANNEL_ENDPOINT}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-scope": scope,
    },
    body: JSON.stringify(envelope),
  })
  const { result } = await runWithRequestAsync(request, () => handleChannelPost(request))
  return result.status
}

describe("page-embed forced lanes", () => {
  it("a __force overlay lanes BOTH embedded placements as focused re-embeds", async () => {
    const scope = freshLiveScope("pe-lane")
    const { calls } = stubProducerFetch()

    await withLiveDrive(
      "http://localhost/pe-lane-host",
      LaneHostRoot,
      scope,
      async (h) => {
        const first = await h.segments.next()
        if (first.done || first.value.kind !== "payload")
          throw new Error("expected payload segment 0")
        const seg0 = await drainPayloadSegment(first.value)
        expect(seg0).toContain("lane-widget:")

        // Both embedded placements registered host-side under distinct
        // placement-prefixed ids.
        const routeKey = computeRouteKey("http://localhost/pe-lane-host")
        // Each placement's key is its namespace over the folded spec
        // id — the embedded page renders from inside the host parton,
        // so its partons carry the host placement's fold too.
        const embedded = [..._readSnapshotsForRoute(scope, routeKey).keys()].filter(
          (id) =>
            stripPlacementFold(stripEmbedNamespace(id)) === "pe-lane-widget" &&
            id !== "pe-lane-widget",
        )
        expect(embedded.length).toBe(2)

        const embedFetches = calls.length
        // Fire the refetch: a url statement carrying both effective
        // ids as its one-shot force overlay, on the channel endpoint
        // (the same envelope the client transport POSTs).
        const conn = h.connectionId()
        if (!conn) throw new Error("expected a connection id after segment 0")
        const force = new URLSearchParams({ __force: embedded.join(",") })
        const status = await post(scope, {
          connection: conn,
          seq: 1,
          frames: [{ kind: "url", url: `/pe-lane-host?${force}`, intent: "silent" }],
        })
        expect(status).toBe(204)

        // Consume segments until the forced lanes arrive — the driver
        // may emit a covering payload segment first (a nav-shaped
        // statement) or lane directly (a same-URL refetch).
        const seen = new Map<string, string>()
        while (seen.size < 2) {
          const seg = await h.segments.next()
          if (seg.done) throw new Error(`stream ended with ${seen.size} lanes`)
          if (seg.value.kind === "payload") {
            await drainPayloadSegment(seg.value)
            continue
          }
          for await (const lane of seg.value.lanes) {
            const { bodyText } = await decodeLane(lane)
            seen.set(lane.partonId, bodyText)
            if (seen.size === 2) break
          }
        }
        expect([...seen.keys()].sort()).toEqual([...embedded].sort())
        for (const [id, body] of seen) {
          expect(body, `lane ${id} must carry fresh widget bytes`).toContain("lane-widget:")
        }
        // Each lane re-embedded the page focused: ?partials=<id> at
        // the embedded URL with the STORED namespace replayed.
        const refetchUrls = calls.slice(embedFetches)
        expect(refetchUrls.length).toBeGreaterThanOrEqual(2)
        for (const id of embedded) {
          expect(
            refetchUrls.some((u) => decodeURIComponent(u).includes(`partials=${id}`)),
            `expected a focused refetch for ${id}; got ${refetchUrls.join(", ")}`,
          ).toBe(true)
        }

        await h.shutdown("pe-lane-widget")
      },
      undefined,
    )
  })
})
