/**
 * PartialMatch / Match — page-level routing wrapper tests.
 *
 * Note on assertions: Flight in dev mode serializes component source
 * along with the rendered output, so a string like "cms-demo" can
 * appear in the wire stream as part of a serialized `pattern` prop
 * even when the matching branch didn't render. Assertions therefore
 * key on rendered output specifics — `"data-testid":"…"` for which
 * leaf actually rendered, and `"children":"…"` / value-typed Flight
 * encodings for the actual content.
 */

import { describe, expect, it } from "vitest"
import { ReactCms, ROOT, type RenderArgs } from "../partial.tsx"
import { Match, PartialMatch } from "../partial-match.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"
import * as ReactClient from "@vitejs/plugin-rsc/vendor/react-server-dom/client.edge"

/**
 * Render through the test harness, then decode the Flight stream
 * back to a React payload and JSON-stringify it. Dev-mode Flight
 * embeds debug serialization of every `props.children` on every
 * server-component invocation — including unrendered branches —
 * which makes raw-text assertions noisy. The decoded payload is
 * just the actually-rendered tree, so `toContain` / `not.toContain`
 * means what you'd expect.
 */
async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  const decoded = await ReactClient.createFromReadableStream(stream, {
    serverConsumerManifest: {
      serverModuleMap: {},
      moduleMap: new Proxy({} as Record<string, unknown>, {
        get: (_t, id) =>
          new Proxy({} as Record<string, unknown>, {
            get: (_t2, name) =>
              typeof name === "string" && typeof id === "string"
                ? { id, chunks: [], name }
                : undefined,
          }),
      }),
    },
  })
  return JSON.stringify(decoded)
}

describe("PartialMatch — first-match-wins routing", () => {
  it("renders only the first matching Match branch", async () => {
    const out = await flightAt(
      "http://t/pokemon/7",
      <PartialMatch>
        <Match pattern="/cms-demo">
          <span data-testid="cms-leaf">cms-content</span>
        </Match>
        <Match pattern="/pokemon/:id">
          <span data-testid="detail-leaf">detail-content</span>
        </Match>
        <Match pattern="/">
          <span data-testid="home-leaf">home-content</span>
        </Match>
      </PartialMatch>,
    )
    expect(out).toContain('"data-testid":"detail-leaf"')
    expect(out).toContain("detail-content")
    expect(out).not.toContain('"data-testid":"cms-leaf"')
    expect(out).not.toContain('"data-testid":"home-leaf"')
  })

  it("renders fallback when no Match hits", async () => {
    const out = await flightAt(
      "http://t/no/such/route",
      <PartialMatch fallback={<span data-testid="not-found-leaf">404</span>}>
        <Match pattern="/pokemon/:id">
          <span data-testid="detail-leaf">x</span>
        </Match>
        <Match pattern="/">
          <span data-testid="home-leaf">x</span>
        </Match>
      </PartialMatch>,
    )
    expect(out).toContain('"data-testid":"not-found-leaf"')
    expect(out).not.toContain('"data-testid":"detail-leaf"')
    expect(out).not.toContain('"data-testid":"home-leaf"')
  })

  it("renders nothing (not an error) when no match and no fallback", async () => {
    const out = await flightAt(
      "http://t/missing",
      <PartialMatch>
        <Match pattern="/known">
          <span data-testid="known-leaf">k</span>
        </Match>
      </PartialMatch>,
    )
    expect(out).not.toContain('"data-testid":"known-leaf"')
  })

  it("ignores non-Match children — chrome belongs outside the wrapper", async () => {
    const out = await flightAt(
      "http://t/pokemon/3",
      <PartialMatch>
        <span data-testid="chrome-leaf">chrome-content</span>
        <Match pattern="/pokemon/:id">
          <span data-testid="detail-leaf">detail-content</span>
        </Match>
      </PartialMatch>,
    )
    expect(out).toContain('"data-testid":"detail-leaf"')
    expect(out).not.toContain('"data-testid":"chrome-leaf"')
  })

  it("'*' catch-all matches as a fallback ordering trick", async () => {
    const Catchall = (
      <PartialMatch>
        <Match pattern="/known">
          <span data-testid="known-leaf">k</span>
        </Match>
        <Match pattern="/*">
          <span data-testid="catchall-leaf">c</span>
        </Match>
      </PartialMatch>
    )
    const known = await flightAt("http://t/known", Catchall)
    expect(known).toContain('"data-testid":"known-leaf"')
    expect(known).not.toContain('"data-testid":"catchall-leaf"')

    const fallthrough = await flightAt("http://t/anything/else", Catchall)
    expect(fallthrough).toContain('"data-testid":"catchall-leaf"')
    expect(fallthrough).not.toContain('"data-testid":"known-leaf"')
  })
})

describe("Match — ambient params flow into descendant specs", () => {
  it("descendant spec without its own match reads params from outer Match", async () => {
    const Inner = ReactCms.partial(
      function InnerByAmbient({ id }: { id: string } & RenderArgs) {
        return <span data-testid="ambient-leaf">id={id}</span>
      },
      {
        selector: "#ambient-inner",
        // No match — vary's `params` comes from the enclosing Match.
        vary: ({ params }) => ({ id: params.id ?? "(none)" }),
      },
    )
    const out = await flightAt(
      "http://t/pokemon/9",
      <PartialMatch>
        <Match pattern="/pokemon/:id">
          <Inner parent={ROOT} />
        </Match>
      </PartialMatch>,
    )
    expect(out).toContain('"data-testid":"ambient-leaf"')
    expect(out).toContain('"id=","9"')
  })

  it("descendant spec with its own match takes precedence over ambient", async () => {
    const Inner = ReactCms.partial(
      function InnerWithOwnMatch({ slug }: { slug: string } & RenderArgs) {
        return <span data-testid="own-match-leaf">slug={slug}</span>
      },
      {
        match: "/p/:slug",
        selector: "#inner-own-match",
      },
    )
    // Outer Match exposes id=42, but Inner's own match runs against
    // the page URL (`/pokemon/42`) — Inner's match misses, so Inner
    // returns null. The data-testid must NOT appear in rendered output.
    const miss = await flightAt(
      "http://t/pokemon/42",
      <PartialMatch>
        <Match pattern="/pokemon/:id">
          <Inner parent={ROOT} />
        </Match>
      </PartialMatch>,
    )
    expect(miss).not.toContain('"data-testid":"own-match-leaf"')
  })

  it("Match standalone (no PartialMatch parent) still gates and provides params", async () => {
    const Inner = ReactCms.partial(
      function StandaloneMatchInner({ id }: { id: string } & RenderArgs) {
        return <span data-testid="standalone-leaf">id={id}</span>
      },
      {
        selector: "#standalone-match-inner",
        vary: ({ params }) => ({ id: params.id ?? "" }),
      },
    )
    const tree = (
      <Match pattern="/pokemon/:id">
        <Inner parent={ROOT} />
      </Match>
    )
    const hit = await flightAt("http://t/pokemon/55", tree)
    expect(hit).toContain('"data-testid":"standalone-leaf"')
    expect(hit).toContain('"id=","55"')

    const miss = await flightAt("http://t/cache-demo", tree)
    expect(miss).not.toContain('"data-testid":"standalone-leaf"')
  })

  it("nested Match shadows outer match-params with its own", async () => {
    const Leaf = ReactCms.partial(
      function NestedMatchLeaf({ slug }: { slug: string } & RenderArgs) {
        return <span data-testid="leaf-slug">slug={slug}</span>
      },
      {
        selector: "#nested-match-leaf",
        vary: ({ params }) => ({ slug: params.slug ?? "(none)" }),
      },
    )
    // Outer Match captures id=42, inner Match captures slug=hello.
    // The inner Match's injection wins, so Leaf sees slug=hello.
    const out = await flightAt(
      "http://t/pokemon/42/hello",
      <PartialMatch>
        <Match pattern="/pokemon/:id/:slug">
          <Match pattern="/pokemon/:nope/:slug">
            <Leaf parent={ROOT} />
          </Match>
        </Match>
      </PartialMatch>,
    )
    expect(out).toContain('"data-testid":"leaf-slug"')
    expect(out).toContain('"slug=","hello"')
  })
})
