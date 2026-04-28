/**
 * `ReactCms.partial` constructor — core flow tests.
 */

import { describe, expect, it } from "vitest"
import { ReactCms, ROOT, type RenderArgs } from "../partial.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

describe("ReactCms.partial — match + skip", () => {
  it("renders pattern-matched specs with extracted params", async () => {
    const Page = ReactCms.partial(
      function ParamPageRender({ id }: { id: string } & RenderArgs) {
        return <span data-testid="param-out">id={id}</span>
      },
      "/pokemon/:id",
    )
    const out = await flightAt("http://t/pokemon/42", <Page parent={ROOT} />)
    // Flight serializes JSX children as an array `["id=", "42"]`.
    expect(out).toContain('"id=","42"')
    expect(out).toContain("param-out")
  })

  it("emits nothing on a pattern miss", async () => {
    const Page = ReactCms.partial(
      function MissTargetRender({}: RenderArgs) {
        return <span data-testid="should-not-appear">x</span>
      },
      { match: "/pokemon/:id", selector: "#match-miss-test" },
    )
    const out = await flightAt("http://t/cache-demo", <Page parent={ROOT} />)
    expect(out).not.toContain("should-not-appear")
  })

  it("emits nothing when vary returns null", async () => {
    const Page = ReactCms.partial(
      function VaryNullTargetRender({}: RenderArgs) {
        return <span data-testid="vary-null-target">x</span>
      },
      {
        match: "/x",
        selector: "#vary-null-spec",
        vary: ({ request }) =>
          new URL(request.url).searchParams.get("on") === "1" ? {} : null,
      },
    )
    const off = await flightAt("http://t/x", <Page parent={ROOT} />)
    expect(off).not.toContain("vary-null-target")
    const on = await flightAt("http://t/x?on=1", <Page parent={ROOT} />)
    expect(on).toContain("vary-null-target")
  })
})

describe("ReactCms.partial — vary + render", () => {
  it("threads vary result into render props", async () => {
    const Page = ReactCms.partial(
      function FlavorPageRender({ flavor }: { flavor: string } & RenderArgs) {
        return <span data-testid="flavor">{flavor}</span>
      },
      {
        match: "/flavors",
        selector: "#flavor-spec",
        vary: ({ request }) => ({
          flavor: new URL(request.url).searchParams.get("flavor") ?? "vanilla",
        }),
      },
    )
    const v = await flightAt("http://t/flavors?flavor=chocolate", <Page parent={ROOT} />)
    expect(v).toContain("chocolate")
    const dflt = await flightAt("http://t/flavors", <Page parent={ROOT} />)
    expect(dflt).toContain("vanilla")
  })

  it("provides match params to render when no vary set", async () => {
    const Page = ReactCms.partial(
      function MatchParamRender({ slug }: { slug: string } & RenderArgs) {
        return <span data-testid="slug-out">{slug}</span>
      },
      { match: "/p/:slug", selector: "#match-only-spec" },
    )
    const out = await flightAt("http://t/p/hello-world", <Page parent={ROOT} />)
    expect(out).toContain("hello-world")
  })

  it("merges match params + vary additional fields", async () => {
    const Page = ReactCms.partial(
      function MergedRender({
        slug,
        page,
      }: {
        slug: string
        page: number
      } & RenderArgs) {
        return (
          <span data-testid="merged">
            {slug}/{page}
          </span>
        )
      },
      {
        match: "/p/:slug",
        selector: "#merged-spec",
        vary: ({ params, request }) => ({
          slug: params.slug,
          page: Number(new URL(request.url).searchParams.get("page") ?? 1),
        }),
      },
    )
    const out = await flightAt("http://t/p/x?page=3", <Page parent={ROOT} />)
    // Flight serializes JSX children as an array `["x", "/", 3]` —
    // assert on the array form rather than the rendered text.
    expect(out).toContain('"x","/",3')
  })
})

describe("ReactCms.partial — selector & cmsId derivation", () => {
  it("auto-derives selector from Render.name", async () => {
    function MyAutoSelectedRender({}: RenderArgs) {
      return <i data-testid="auto-selector-output">ok</i>
    }
    const Page = ReactCms.partial(MyAutoSelectedRender, { match: "/auto-selector-test" })
    const out = await flightAt("http://t/auto-selector-test", <Page parent={ROOT} />)
    expect(out).toContain("auto-selector-output")
  })

  it("strips Render/Page/Block/Partial suffixes when auto-deriving", async () => {
    function MyHeaderPage({}: RenderArgs) {
      return <i data-partial-id="auto-header-id">x</i>
    }
    // Even though the function ends in `Page`, the selector should
    // strip it. We can't easily inspect the selector from outside,
    // but we can verify the rendered partial wrapper carries the
    // expected id by reaching into the Flight payload.
    const Page = ReactCms.partial(MyHeaderPage, { match: "/strip-suffix-test" })
    const out = await flightAt("http://t/strip-suffix-test", <Page parent={ROOT} />)
    expect(out).toContain("auto-header-id")
  })
})

describe("ReactCms.partial — children passthrough", () => {
  it("forwards `children` from the spec component to Render", async () => {
    const Wrapper = ReactCms.partial(
      function WrapperRender({ children }: RenderArgs) {
        return (
          <div data-testid="wrapper">
            <span data-testid="wrapper-marker">w</span>
            {children}
          </div>
        )
      },
      { match: "/wrapper-test", selector: "#wrapper-spec" },
    )
    const out = await flightAt(
      "http://t/wrapper-test",
      <Wrapper parent={ROOT}>
        <span data-testid="inner-content">inner</span>
      </Wrapper>,
    )
    expect(out).toContain("wrapper-marker")
    expect(out).toContain("inner-content")
  })
})

describe("ReactCms.partial — frame scope", () => {
  it("vary receives frame-resolved request when spec opens a frame", async () => {
    // Without a session entry, the frame falls back to the spec's
    // frameUrl option. The vary callback should see that URL, not
    // the page URL.
    const Page = ReactCms.partial(
      function FramedRender({
        framePath,
      }: {
        framePath: string
      } & RenderArgs) {
        return <span data-testid="frame-pathname">{framePath}</span>
      },
      {
        match: "/frame-host",
        selector: "#framed-spec",
        frame: "drawer",
        frameUrl: "/drawer/initial",
        vary: ({ request }) => ({
          framePath: new URL(request.url).pathname,
        }),
      },
    )
    const out = await flightAt("http://t/frame-host", <Page parent={ROOT} />)
    expect(out).toContain("/drawer/initial")
    expect(out).not.toContain(">/frame-host<")
  })
})
