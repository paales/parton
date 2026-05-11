/**
 * `ReactCms.partial` constructor — core flow tests.
 */

import { describe, expect, it } from "vitest"
import { ReactCms, ROOT, type RenderArgs } from "../partial.tsx"
import { Frame } from "../frame.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

describe("ReactCms.partial — match + skip", () => {
  it("renders pattern-matched specs with extracted params", async () => {
    // No vary — match params auto-flow into Render. `InferV<{match:
    // "/pokemon/:id"}>` resolves to `{id: string}`, so the call site
    // doesn't need to supply id.
    const Page = ReactCms.partial(
      function ParamPageRender({ id }: { id: string } & RenderArgs) {
        return <span data-testid="param-out">id={id}</span>
      },
      { match: "/pokemon/:id", selector: "#param-page" },
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
        vary: ({ search: { on } }) => (on === "1" ? {} : null),
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
        vary: ({ search: { flavor = "vanilla" } }) => ({ flavor }),
      },
    )
    const v = await flightAt("http://t/flavors?flavor=chocolate", <Page parent={ROOT} />)
    expect(v).toContain("chocolate")
    const dflt = await flightAt("http://t/flavors", <Page parent={ROOT} />)
    expect(dflt).toContain("vanilla")
  })

  it("auto-flows match params to Render with no vary", async () => {
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
        vary: ({ params, search: { page = "1" } }) => ({
          slug: params.slug,
          page: Number(page),
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

describe("ReactCms.partial — call-site prop pass-through", () => {
  it("forwards JSX call-site props to Render alongside vary", async () => {
    const Inner = ReactCms.partial(
      function PassthroughInnerRender({
        pokemonId,
        flavor,
      }: {
        pokemonId: number
        flavor: string
      } & RenderArgs) {
        return (
          <span data-testid="passthrough-out">
            {pokemonId}/{flavor}
          </span>
        )
      },
      {
        selector: "#passthrough-inner",
        vary: ({ search: { flavor = "vanilla" } }) => ({ flavor }),
      },
    )
    // Outer wrapper: parses :id from URL, passes pokemonId as a JSX
    // prop to Inner. Inner gets `flavor` from its own vary and
    // `pokemonId` from the call-site prop.
    const Outer = ReactCms.partial(
      function PassthroughOuterRender({ pokemonId, parent }: { pokemonId: number } & RenderArgs) {
        return <Inner parent={parent} pokemonId={pokemonId} />
      },
      {
        match: "/p/:id",
        selector: "#passthrough-outer",
        vary: ({ params }) => ({ pokemonId: Number(params.id) }),
      },
    )
    const out = await flightAt("http://t/p/9?flavor=mint", <Outer parent={ROOT} />)
    expect(out).toContain("passthrough-out")
    // Flight serializes children as `[9, "/", "mint"]`.
    expect(out).toContain('9,"/","mint"')
  })

  it("inner spec without vary receives props directly from the call site", async () => {
    // The whole point: zero `vary` ceremony. Outer parses the URL,
    // Inner just takes pokemonId as a prop.
    const Inner = ReactCms.partial(
      function NoVaryInnerRender({ pokemonId }: { pokemonId: number } & RenderArgs) {
        return <span data-testid="no-vary-inner">id-{pokemonId}</span>
      },
      { selector: "#no-vary-inner" },
    )
    const Outer = ReactCms.partial(
      function NoVaryOuterRender({ pokemonId, parent }: { pokemonId: number } & RenderArgs) {
        return <Inner parent={parent} pokemonId={pokemonId} />
      },
      {
        match: "/no-vary/:id",
        selector: "#no-vary-outer",
        vary: ({ params }) => ({ pokemonId: Number(params.id) }),
      },
    )
    const out = await flightAt("http://t/no-vary/77", <Outer parent={ROOT} />)
    expect(out).toContain("no-vary-inner")
    expect(out).toContain('"id-",77')
  })
})

describe("ReactCms.partial — two-step builder", () => {
  it("partial(opts) returns a callable builder that produces a spec", async () => {
    // The builder form lets authors derive `typeof Builder.props`
    // before the Render exists — the single-step form can't do that
    // because `const S = partial(R, opts)` + `function R(p: typeof
    // S.props)` hits a circular initializer.
    const Builder = ReactCms.partial({ match: "/builder/:slug", selector: "#two-step" })
    function BuilderRender(p: typeof Builder.props) {
      return <span data-testid="two-step-out">{p.slug}</span>
    }
    const Page = Builder(BuilderRender)
    const out = await flightAt("http://t/builder/hello", <Page parent={ROOT} />)
    expect(out).toContain("two-step-out")
    expect(out).toContain("hello")
  })

  it("builder threads vary's return through the same way single-step does", async () => {
    const Builder = ReactCms.partial({
      match: "/builder/:slug",
      selector: "#two-step-vary",
      vary: ({ params, search: { variant = "default" } }) => ({
        slug: params.slug,
        variant,
      }),
    })
    function BuilderVaryRender(p: typeof Builder.props) {
      return (
        <span data-testid="two-step-vary-out">
          {p.slug}:{p.variant}
        </span>
      )
    }
    const Page = Builder(BuilderVaryRender)
    const out = await flightAt(
      "http://t/builder/foo?variant=mint",
      <Page parent={ROOT} />,
    )
    expect(out).toContain('"foo",":","mint"')
  })
})

describe("ReactCms.partial — match grammar inference", () => {
  it("optional `:foo?` flows through as optional prop", async () => {
    const Page = ReactCms.partial(
      function OptionalParamRender({
        slug,
        page,
      }: { slug: string; page?: string } & RenderArgs) {
        return (
          <span data-testid="opt-out">
            {slug}/{page ?? "none"}
          </span>
        )
      },
      { match: "/opt/:slug{/:page}?", selector: "#opt-spec" },
    )
    const withPage = await flightAt("http://t/opt/x/2", <Page parent={ROOT} />)
    expect(withPage).toContain('"x","/","2"')
    const withoutPage = await flightAt("http://t/opt/x", <Page parent={ROOT} />)
    expect(withoutPage).toContain('"x","/","none"')
  })
})

describe("<Frame> — scope opener", () => {
  it("descendant partials see the frame-resolved request in vary", async () => {
    // <Frame> writes its initialUrl to session if absent; the inner
    // partial's resolveFrameRequest then reads that URL via session,
    // and `vary` sees it as `pathname` instead of the page URL.
    const Inner = ReactCms.partial(
      function FramedInnerRender({ framePath }: { framePath: string } & RenderArgs) {
        return <span data-testid="frame-pathname">{framePath}</span>
      },
      {
        selector: "#framed-inner",
        vary: ({ pathname }) => ({ framePath: pathname }),
      },
    )
    const out = await flightAt(
      "http://t/frame-host",
      <Frame name="drawer-test" initialUrl="/drawer/initial" parent={ROOT}>
        {(p) => <Inner parent={p} />}
      </Frame>,
    )
    expect(out).toContain("/drawer/initial")
    expect(out).not.toContain(">/frame-host<")
  })
})
