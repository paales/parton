/**
 * `<RemoteFrame>` — page embeds (the iframe model), in-process.
 *
 * The "remote" here is the app itself: the stubbed `fetch` renders the
 * requested page through the same harness the host render uses, inside
 * its own request scope (`runWithRequestAsync`) and with the SAME
 * response contract the entry produces (commit-only wrap + the
 * snapshots trailer entry) — genuine same-origin self-embedding, ALS
 * isolation seam included.
 *
 * Covers the increment-1 + increment-2 contracts:
 *  - slice marker + rewriter: embedded body content splices in;
 *    head/title/meta/link, body className, and the marker never reach
 *    the host payload;
 *  - explicit headers: RSC-render, embed depth, placement namespace;
 *  - depth termination on the inert marker (never a throw);
 *  - placement-scoped identity: duplicate embeds of one page and a
 *    page embedding ITSELF mint distinct, stable partial ids;
 *  - snapshot-trailer registration into the host registry with
 *    `source: {kind: "page", url, ns}` + label namespacing;
 *  - refetch routing: `partialFromSnapshot` on a page-sourced
 *    snapshot re-embeds the embedded URL with `?partials=<id>`,
 *    replaying the stored placement namespace;
 *  - malformed trailer: render survives, registration is skipped.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Fragment, Suspense, type ReactNode } from "react"
import {
  PartialRoot,
  computeRouteKey,
  parton,
  partialFromSnapshot,
  stripPlacementFold,
} from "../partial.tsx"
import type { RenderArgs } from "../partial.tsx"
import { RemoteFrame } from "../remote-frame.tsx"
import {
  EMBED_BODY_TAG,
  EMBED_DEPTH_HEADER,
  EMBED_LIMIT_ATTR,
  EMBED_NS_HEADER,
  MAX_EMBED_DEPTH,
  applyEmbedNamespace,
  embedNamespaceOf,
  stripEmbedNamespace,
} from "../page-embed.ts"
import {
  _readSnapshotsForRoute,
  type PageSnapshotSource,
  type PartialSnapshot,
} from "../partial-registry.ts"
import { wrapStreamWithCommitOnly } from "../fp-trailer.ts"
import { rewriteFlightStream, type RowRewriter } from "../flight-rewrite.ts"
import { wrapStreamWithSnapshotTrailer } from "../snapshot-trailer.ts"
import { buildMarker } from "../fp-trailer-marker.ts"
import { tag } from "../current-parton.ts"
import { HEADER_RSC_RENDER } from "../../runtime/request.tsx"
import { _captureCommitHandle, getRequest, runWithRequestAsync } from "../../runtime/context.ts"
import { renderServerToFlight, type FlightBytes } from "../../test/rsc-server.ts"

const ENC = new TextEncoder()

async function streamToText(stream: FlightBytes): Promise<string> {
  return new Response(stream).text()
}

/** Harness-only: the bare vitest worker has no client-module loader,
 *  so a decoded client-reference lazy can never resolve. Replace each
 *  import row (`I["/src/…#Export",…]`) with a model row holding the
 *  literal element type `"client-ref"` — every `$L<id>` type ref then
 *  resolves to a plain intrinsic and the decode→re-encode hop works,
 *  with the boundary's `partialId` prop preserved verbatim on the
 *  host wire. Production embeds resolve refs through the real plugin
 *  runtime; this shim exists only below the app-runtime line. */
const neutralizeClientRefs: RowRewriter = (row) =>
  row.type === "I" ? { ...row, type: "", data: '"client-ref"' } : row

/**
 * Render a page the way the entry's embed branch does: `{ root }`
 * payload, commit-only wrap (drains commit-defers — nested embeds'
 * registrations — before commit), then the snapshots trailer entry
 * read from the render's registry at flush.
 */
async function renderPageStream(
  root: ReactNode,
  url: string,
  headers: Record<string, string>,
): Promise<FlightBytes> {
  const request = new Request(url, { headers })
  const { result } = await runWithRequestAsync(request, async () => {
    // Snapshots getter mirrors the entry: scope + routeKey captured at
    // wrap time, committed route snapshots read at flush (never
    // ALS-at-flush), filtered to THIS render's namespace — the route
    // set is a union across placements.
    const routeKey = computeRouteKey(url)
    const ns = embedNamespaceOf(new Headers(headers))
    const getSnapshots = () => {
      const all = _readSnapshotsForRoute("default", routeKey)
      if (ns === null) return all
      const own = new Map<string, PartialSnapshot>()
      for (const [id, snap] of all) if (id.startsWith(`${ns}:`)) own.set(id, snap)
      return own
    }
    const stream = wrapStreamWithSnapshotTrailer(
      wrapStreamWithCommitOnly(
        rewriteFlightStream(
          renderServerToFlight({ root } as unknown as ReactNode),
          neutralizeClientRefs,
        ),
        _captureCommitHandle(),
      ),
      getSnapshots,
    )
    const [forCaller, forDrain] = stream.tee()
    await new Response(forDrain).arrayBuffer()
    return forCaller
  })
  return result
}

async function pageResponse(
  root: ReactNode,
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  return new Response(await renderPageStream(root, url, headers), {
    status: 200,
    headers: { "content-type": "text/x-component;charset=utf-8" },
  })
}

type FetchCall = { url: string; headers: Headers; credentials?: string }

function stubSelfServingFetch(pageFor: (url: string) => ReactNode): { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers)
      calls.push({ url, headers, credentials: init?.credentials })
      const headerRecord: Record<string, string> = {}
      headers.forEach((v, k) => {
        headerRecord[k] = v
      })
      return pageResponse(pageFor(url), url, headerRecord)
    },
  )
  return { calls }
}

beforeEach(() => {
  vi.unstubAllGlobals()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// ─── Fixtures ──────────────────────────────────────────────────────────

/** Probe that serializes the request URL its render saw — proves the
 *  embedded render ran in its own request scope, not the host's. */
async function RequestUrlProbe() {
  return <span data-testid="embedded-request-url">seen-url:{getRequest().url}</span>
}

/** Addressable parton inside the embedded page — its wire identity
 *  (PartialErrorBoundary's `partialId`) is what the placement
 *  namespace must move. */
const EmbeddedWidget = parton(
  Object.assign(
    async function EmbeddedWidgetRender(_: RenderArgs) {
      // The tag read is this parton's refetch label — what a
      // class-level fan-out (and the host's namespaced prefixing of it)
      // addresses across placements.
      tag("pe-embedded-widget")
      return <div data-testid="embedded-widget">embedded-widget-content</div>
    },
    { displayName: "pe-embedded-widget" },
  ),
)

function EmbeddedRoot() {
  return (
    <PartialRoot>
      <html lang="en">
        <head>
          <meta name="description" content="embedded-meta-sentinel" />
          <title>Embedded Title Sentinel</title>
          <link rel="canonical" href="http://t/embedded-link-sentinel" />
        </head>
        <body className="embedded-body-class">
          <div data-testid="embedded-content">embedded-hello</div>
          <EmbeddedWidget />
          <RequestUrlProbe />
        </body>
      </html>
    </PartialRoot>
  )
}

const HostPage = parton(
  Object.assign(
    function PeHostRender(_: RenderArgs) {
      return (
        <section data-testid="embed-host">
          <Suspense fallback={<div>loading embed…</div>}>
            <RemoteFrame url="/embedded" />
          </Suspense>
        </section>
      )
    },
    { displayName: "pe-host-spec" },
  ),
  { match: "/pe-host" },
)

function HostRoot() {
  return (
    <PartialRoot>
      <html lang="en">
        <head>
          <title>Host Title Sentinel</title>
        </head>
        <body>
          <HostPage />
        </body>
      </html>
    </PartialRoot>
  )
}

const DuplicateHostPage = parton(
  Object.assign(
    function PeDuplicateHostRender(_: RenderArgs) {
      return (
        <section data-testid="dup-host">
          <Suspense fallback={null}>
            <RemoteFrame url="/embedded" />
          </Suspense>
          <Suspense fallback={null}>
            <RemoteFrame url="/embedded" />
          </Suspense>
        </section>
      )
    },
    { displayName: "pe-dup-host-spec" },
  ),
  { match: "/pe-dup-host" },
)

function extractPartialIds(wire: string): string[] {
  const out: string[] = []
  for (const m of wire.matchAll(/"partialId":"((?:[^"\\]|\\.)*)"/g)) {
    out.push(m[1])
  }
  return out
}

/**
 * The spec id behind an effective id: strip the placement namespace an
 * embed render prefixes, then the placement fold (`~<16 hex>`) a
 * non-root placement mints. An embedded page rendered from inside a
 * host parton inherits that host's placement, so its partons carry
 * BOTH markers — the namespace is what separates the placements, the
 * fold rides along and is identity, not attribution.
 */
const baseIdOf = (id: string): string => stripPlacementFold(stripEmbedNamespace(id))

// ─── Tests ─────────────────────────────────────────────────────────────

describe("page embed — slice + headers", () => {
  it("splices the embedded page's body content into the host payload", async () => {
    const { calls } = stubSelfServingFetch(() => <EmbeddedRoot />)
    const out = await streamToText(await renderPageStream(<HostRoot />, "http://t/pe-host", {}))

    // Host chrome renders.
    expect(out).toContain("Host Title Sentinel")
    expect(out).toContain("embed-host")

    // Embedded body content is present…
    expect(out).toContain("embedded-hello")
    expect(out).toContain("embedded-widget-content")

    // …but the embedded page's document chrome is not: no title/meta/
    // link hijack, no html/body singleton leak, no marker residue.
    expect(out).not.toContain("Embedded Title Sentinel")
    expect(out).not.toContain("embedded-meta-sentinel")
    expect(out).not.toContain("embedded-link-sentinel")
    expect(out).not.toContain("embedded-body-class")
    expect(out).not.toContain(EMBED_BODY_TAG)

    // Exactly one embed fetch, addressed to the ordinary page URL
    // resolved against the host request — no special route — and
    // credentialless even same-origin.
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://t/embedded")
    expect(calls[0].credentials).toBe("omit")
  })

  it("requests Flight via the render header and stamps depth + placement namespace", async () => {
    const { calls } = stubSelfServingFetch(() => <EmbeddedRoot />)
    await streamToText(await renderPageStream(<HostRoot />, "http://t/pe-host", {}))

    expect(calls).toHaveLength(1)
    expect(calls[0].headers.get(HEADER_RSC_RENDER)).toBe("1")
    expect(calls[0].headers.get(EMBED_DEPTH_HEADER)).toBe("1")
    const ns = calls[0].headers.get(EMBED_NS_HEADER)
    expect(ns).toMatch(/^e~[0-9a-f]+$/)
  })

  it("runs the embedded render in its own request scope (ALS isolation)", async () => {
    stubSelfServingFetch(() => <EmbeddedRoot />)
    const out = await streamToText(await renderPageStream(<HostRoot />, "http://t/pe-host", {}))

    // The probe inside the embedded page saw the EMBEDDED request URL,
    // not the host's.
    expect(out).toContain("seen-url:")
    expect(out).toContain("http://t/embedded")
  })
})

describe("page embed — recursion", () => {
  it("terminates a self-referential embed at MAX_EMBED_DEPTH with the inert marker", async () => {
    function SelfEmbedRoot() {
      return (
        <PartialRoot>
          <html lang="en">
            <head>
              <title>Self Title</title>
            </head>
            <body>
              <div data-testid="self-level">self-level</div>
              <Suspense fallback={null}>
                <RemoteFrame url="/pe-self" />
              </Suspense>
            </body>
          </html>
        </PartialRoot>
      )
    }
    const { calls } = stubSelfServingFetch(() => <SelfEmbedRoot />)
    const out = await streamToText(
      await renderPageStream(<SelfEmbedRoot />, "http://t/pe-self", {}),
    )

    // Depth 0 (host) fetches depth 1, … depth MAX-1 fetches depth MAX;
    // the RemoteFrame rendered AT depth MAX renders the inert limit
    // marker instead of fetching.
    expect(calls).toHaveLength(MAX_EMBED_DEPTH)
    expect(calls.map((c) => c.headers.get(EMBED_DEPTH_HEADER))).toEqual(
      Array.from({ length: MAX_EMBED_DEPTH }, (_, i) => String(i + 1)),
    )
    // Every level's body content made it through the chain, and the
    // chain end is the explicit termination marker — silent, not an
    // error.
    const levels = out.match(/self-level/g) ?? []
    expect(levels.length).toBeGreaterThanOrEqual(2)
    expect(out).toContain(EMBED_LIMIT_ATTR)
  })
})

describe("page embed — placement-scoped identity", () => {
  it("two embeds of one page mint distinct placement namespaces and distinct partial ids", async () => {
    function DupRoot() {
      return (
        <PartialRoot>
          <html lang="en">
            <body>
              <DuplicateHostPage />
            </body>
          </html>
        </PartialRoot>
      )
    }
    const { calls } = stubSelfServingFetch(() => <EmbeddedRoot />)
    const out = await streamToText(await renderPageStream(<DupRoot />, "http://t/pe-dup-host", {}))

    expect(calls).toHaveLength(2)
    const ns0 = calls[0].headers.get(EMBED_NS_HEADER)!
    const ns1 = calls[1].headers.get(EMBED_NS_HEADER)!
    expect(ns0).not.toBe(ns1)

    // Both embedded copies of the widget reach the wire under their
    // own placement-prefixed id.
    const widgetIds = new Set(
      extractPartialIds(out).filter((id) => baseIdOf(id) === "pe-embedded-widget"),
    )
    expect(widgetIds.size).toBe(2)
    expect(
      [...widgetIds].every(
        (id) => id.includes("~") && stripPlacementFold(id).endsWith(":pe-embedded-widget"),
      ),
    ).toBe(true)
  })

  it("a page embedding itself mints a distinct id per nesting level (the hydration fix)", async () => {
    const SelfWidget = parton(async function PeSelfWidgetRender(_: RenderArgs) {
      return <div>self-widget</div>
    })
    function SelfRoot() {
      return (
        <PartialRoot>
          <html lang="en">
            <body>
              <SelfWidget />
              <Suspense fallback={null}>
                <RemoteFrame url="/pe-self-ids" />
              </Suspense>
            </body>
          </html>
        </PartialRoot>
      )
    }
    stubSelfServingFetch(() => <SelfRoot />)
    const out = await streamToText(await renderPageStream(<SelfRoot />, "http://t/pe-self-ids", {}))

    const ids = new Set(extractPartialIds(out).filter((id) => baseIdOf(id) === "pe-self-widget"))
    // Host level (bare id) + one distinct prefixed id per embedded
    // level. Identical ids across levels are exactly what broke
    // hydration in the spike.
    expect(ids.has("pe-self-widget")).toBe(true)
    expect(ids.size).toBe(1 + MAX_EMBED_DEPTH)
  })

  it("applyEmbedNamespace is idempotent; stripEmbedNamespace resolves the bare id", () => {
    const ns = "e~0123abcd"
    const once = applyEmbedNamespace(ns, "widget")
    expect(once).toBe("e~0123abcd:widget")
    expect(applyEmbedNamespace(ns, once)).toBe(once)
    expect(stripEmbedNamespace(once)).toBe("widget")
    // Human-namespaced grammar strips too.
    expect(stripEmbedNamespace("magento~ff00:stocks")).toBe("stocks")
    // Ordinary namespaced ids (no `~`) are left alone.
    expect(stripEmbedNamespace("slot:hero")).toBe("slot:hero")
    expect(embedNamespaceOf(new Headers({ [EMBED_NS_HEADER]: ns }))).toBe(ns)
  })
})

describe("page embed — registration + refetch routing (increment 2)", () => {
  it("registers trailer snapshots into the host registry with a page source stamp", async () => {
    const { calls } = stubSelfServingFetch(() => <EmbeddedRoot />)
    await streamToText(await renderPageStream(<HostRoot />, "http://t/pe-host", {}))

    const ns = calls[0].headers.get(EMBED_NS_HEADER)!
    const routeKey = computeRouteKey("http://t/pe-host")
    const snapshots = _readSnapshotsForRoute("default", routeKey)
    // The registered key is the id the embedded render actually minted:
    // this placement's namespace over the folded spec id.
    const id = [...snapshots.keys()].find(
      (k) => k.startsWith(`${ns}:`) && baseIdOf(k) === "pe-embedded-widget",
    )
    expect(id).toBeDefined()
    const snap = snapshots.get(id!)
    expect(snap).toBeDefined()
    expect(snap!.source).toEqual({ kind: "page", url: "http://t/embedded", ns })
    // The label is the embedded parton's own tag subscription, carried
    // through as shipped — a class-level fan-out target.
    expect(snap!.labels).toContain("pe-embedded-widget")
  })

  it("the human namespace prefixes the placement namespace; labels register as shipped", async () => {
    const NsHostPage = parton(
      Object.assign(
        function PeNsHostRender(_: RenderArgs) {
          return (
            <Suspense fallback={null}>
              <RemoteFrame url="/embedded" namespace="acme" />
            </Suspense>
          )
        },
        { displayName: "pe-ns-host-spec" },
      ),
      { match: "/pe-ns-host" },
    )
    function NsRoot() {
      return (
        <PartialRoot>
          <html lang="en">
            <body>
              <NsHostPage />
            </body>
          </html>
        </PartialRoot>
      )
    }
    const { calls } = stubSelfServingFetch(() => <EmbeddedRoot />)
    await streamToText(await renderPageStream(<NsRoot />, "http://t/pe-ns-host", {}))

    // The human name is cosmetic: it prefixes the MINTED PLACEMENT
    // NAMESPACE so registry/wire ids read `acme~<hash>:…` instead of
    // `e~<hash>:…`. Identity never depends on it — the placement
    // namespace disambiguates on its own.
    const ns = calls[0].headers.get(EMBED_NS_HEADER)!
    expect(ns).toMatch(/^acme~/)
    const snapshots = _readSnapshotsForRoute("default", computeRouteKey("http://t/pe-ns-host"))
    const id = [...snapshots.keys()].find(
      (k) => k.startsWith(`${ns}:`) && baseIdOf(k) === "pe-embedded-widget",
    )
    expect(id).toBeDefined()
    const snap = snapshots.get(id!)
    expect(snap).toBeDefined()
    // Labels register AS SHIPPED — bare. They name the embedded
    // parton's OWN cell/tag subscriptions, so a bump matching a tag
    // the remote render read must keep matching them; a host-side
    // prefix would break the producer's own fan-out.
    expect(snap!.labels).toContain("pe-embedded-widget")
    expect(snap!.source).toMatchObject({ kind: "page", url: "http://t/embedded", ns })
  })

  it("partialFromSnapshot on a page source re-embeds ?partials=<id> at the embedded URL", async () => {
    const { calls } = stubSelfServingFetch(() => <EmbeddedRoot />)

    const ns = "e~feedbeef"
    const id = applyEmbedNamespace(ns, "pe-embedded-widget")
    const source: PageSnapshotSource = { kind: "page", url: "http://t/embedded", ns }
    const snap = {
      type: "pe-embedded-widget",
      fallback: null,
      labels: ["pe-embedded-widget"],
      framePath: Object.freeze([]) as readonly string[],
      parentFrameChain: Object.freeze([]) as readonly string[],
      parentPath: Object.freeze([]) as readonly string[],
      source,
    }

    const out = await streamToText(
      await renderPageStream(
        <Fragment>{partialFromSnapshot(id, snap)}</Fragment>,
        "http://t/pe-refetch-host",
        {},
      ),
    )

    // The refetch is the ordinary protocol at the embedded URL…
    expect(calls).toHaveLength(1)
    const fetched = new URL(calls[0].url)
    expect(fetched.origin + fetched.pathname).toBe("http://t/embedded")
    expect(fetched.searchParams.get("partials")).toBe(id)
    // …replaying the STORED placement namespace (never re-derived).
    expect(calls[0].headers.get(EMBED_NS_HEADER)).toBe(ns)
    expect(calls[0].headers.get(EMBED_DEPTH_HEADER)).toBe("1")
    // The spliced payload carries the widget's content.
    expect(out).toContain("embedded-widget-content")
  })
})

describe("page embed — hardening", () => {
  it("a malformed snapshots trailer skips registration but keeps the render", async () => {
    vi.stubGlobal("fetch", async (): Promise<Response> => {
      const flight = await new Response(
        await renderPageStream(<EmbeddedRoot />, "http://t/pe-broken", {
          [HEADER_RSC_RENDER]: "1",
          [EMBED_DEPTH_HEADER]: "1",
          [EMBED_NS_HEADER]: "e~broken",
        }),
      ).arrayBuffer()
      // Rebuild the wire with a garbage snapshots entry REPLACING the
      // real one: strip everything after the first \xFF, then append
      // junk under a valid marker header.
      const bytes = new Uint8Array(flight)
      const ff = bytes.indexOf(0xff)
      const body = ff >= 0 ? bytes.subarray(0, ff) : bytes
      const junk = ENC.encode("not json {{{")
      const marker = buildMarker("snapshots", junk.length)
      const out = new Uint8Array(body.length + marker.length + junk.length)
      out.set(body, 0)
      out.set(marker, body.length)
      out.set(junk, body.length + marker.length)
      return new Response(out as unknown as BodyInit, { status: 200 })
    })

    const BrokenHost = parton(
      Object.assign(
        function PeBrokenHostRender(_: RenderArgs) {
          return (
            <Suspense fallback={null}>
              <RemoteFrame url="/pe-broken" />
            </Suspense>
          )
        },
        { displayName: "pe-broken-host-spec" },
      ),
      { match: "/pe-broken-host" },
    )
    const out = await streamToText(
      await renderPageStream(
        <PartialRoot>
          <html lang="en">
            <body>
              <BrokenHost />
            </body>
          </html>
        </PartialRoot>,
        "http://t/pe-broken-host",
        {},
      ),
    )
    // Content splices fine…
    expect(out).toContain("embedded-hello")
    // …and nothing registered from the junk trailer.
    const snapshots = _readSnapshotsForRoute("default", computeRouteKey("http://t/pe-broken-host"))
    const registered = [...snapshots.keys()].filter(
      (id) => baseIdOf(id) === "pe-embedded-widget" && id !== "pe-embedded-widget",
    )
    expect(registered).toEqual([])
  })
})
