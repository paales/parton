/**
 * The declared 404 boundary — `createRscHandler({ unmatched:
 * "not-found" })`.
 *
 * Two halves under test, both keyed on the SAME `urlCoveredByMatch`
 * check so they can never diverge:
 *
 *  1. `unmatchedDocument404` — the entry's whole pre-render verdict,
 *     driven through real `parseRenderRequest` shapes. True exactly
 *     for a DECLARED app's plain document GET at an uncovered URL —
 *     the one case `createRscHandler` answers with the bare not-found
 *     document before any `<Root/>` render starts. Undeclared apps
 *     (the website's bare-parton world) always read false: the
 *     registry alone must never 404 a URL.
 *  2. The `PartialRoot`-mounted fallback: the soft-path half. Declared
 *     + uncovered URL resolves `notFound()` mid-render; covered URLs
 *     and undeclared apps render untouched.
 *
 * (The entry's wiring of a true verdict — return the bare document,
 * skip the tree — cannot run in this tier: `entry/rsc.tsx` needs the
 * full plugin's virtual module graph. The e2e static-assets and
 * not-found specs cover that end to end.)
 */
import { afterEach, describe, expect, it } from "vitest"
import { HEADER_RSC_RENDER, parseRenderRequest } from "../../runtime/request.tsx"
import { flightToString, renderWithRequest } from "../../test/rsc-server.ts"
import {
  _declareNotFoundBoundary,
  _resetNotFoundBoundary,
  hasNotFoundBoundary,
} from "../not-found-boundary.ts"
import { PartialRoot, parton, unmatchedDocument404, urlCoveredByMatch } from "../partial.tsx"

// Fixture specs, constructed once at module eval like any app's. The
// match gate registers "/covered" in the process-global pattern set;
// the bare parton renders at every URL (the website-world shape).
const CoveredPage = parton(function CoveredPageRender() {
  return <div>covered-page-content</div>
}, "/covered")

const BareWorld = parton(function BareWorldRender() {
  return <div>bare-world-content</div>
})

function Root() {
  return (
    <PartialRoot>
      <CoveredPage />
      <BareWorld />
    </PartialRoot>
  )
}

afterEach(() => {
  _resetNotFoundBoundary()
})

describe("urlCoveredByMatch — the boundary's one verdict", () => {
  it("covers a URL a registered pattern matches, and only those", () => {
    expect(urlCoveredByMatch("http://localhost/covered")).toBe(true)
    expect(urlCoveredByMatch("http://localhost/no-spec-covers-this")).toBe(false)
    // Search params are request dimensions within a page, not part of
    // pattern coverage.
    expect(urlCoveredByMatch("http://localhost/covered?q=hi")).toBe(true)
  })

  it("the declaration flag flips only via the entry declaration", () => {
    expect(hasNotFoundBoundary()).toBe(false)
    _declareNotFoundBoundary()
    expect(hasNotFoundBoundary()).toBe(true)
  })
})

describe("unmatchedDocument404 — the entry's pre-render verdict", () => {
  const docGet = (url: string) => parseRenderRequest(new Request(url))

  it("undeclared: false for every URL — the registry alone never 404s", () => {
    expect(unmatchedDocument404(docGet("http://localhost/no-spec-covers-this"))).toBe(false)
    expect(unmatchedDocument404(docGet("http://localhost/covered"))).toBe(false)
  })

  it("declared: true exactly for a plain document GET at an uncovered URL", () => {
    _declareNotFoundBoundary()
    expect(unmatchedDocument404(docGet("http://localhost/no-spec-covers-this"))).toBe(true)
    expect(unmatchedDocument404(docGet("http://localhost/favicon.ico"))).toBe(true)
    expect(unmatchedDocument404(docGet("http://localhost/covered"))).toBe(false)
  })

  it("declared: never an action POST — the response must carry the return value", () => {
    _declareNotFoundBoundary()
    const actionPost = parseRenderRequest(
      new Request("http://localhost/no-spec-covers-this_.rsc", {
        method: "POST",
        headers: { "x-rsc-action": "some-action-id" },
        body: "[]",
      }),
    )
    expect(unmatchedDocument404(actionPost)).toBe(false)
    // A no-JS progressive-enhancement form POST is an action too.
    const formPost = parseRenderRequest(
      new Request("http://localhost/no-spec-covers-this", { method: "POST", body: "" }),
    )
    expect(unmatchedDocument404(formPost)).toBe(false)
  })

  it("declared: never an embed Flight GET — the host owns that document's semantics", () => {
    _declareNotFoundBoundary()
    const embedGet = parseRenderRequest(
      new Request("http://localhost/no-spec-covers-this", {
        headers: { [HEADER_RSC_RENDER]: "1" },
      }),
    )
    expect(unmatchedDocument404(embedGet)).toBe(false)
  })
})

describe("the PartialRoot-mounted fallback (soft path)", () => {
  it("undeclared: an unmatched URL renders the tree as-is — no notFound", async () => {
    const { stream } = await renderWithRequest("http://localhost/no-spec-covers-this", <Root />)
    const text = await flightToString(stream)
    expect(text).toContain("bare-world-content")
    expect(text).not.toContain(":E{")
  })

  it("declared: an uncovered URL resolves notFound() mid-render", async () => {
    _declareNotFoundBoundary()
    // The mounted fallback's notFound() is a framework-branded throw:
    // it bubbles past containment and reaches the wire as a Flight
    // error row (`:E{`) for the entry / host boundary to route — the
    // same shape an app page's own notFound() takes. The rest of the
    // tree still renders (per-parton containment scope).
    const { stream } = await renderWithRequest("http://localhost/no-spec-covers-this", <Root />, {
      onError: () => {},
    })
    const text = await flightToString(stream)
    expect(text).toContain(":E{")
  })

  it("declared: a covered URL renders untouched", async () => {
    _declareNotFoundBoundary()
    const { stream } = await renderWithRequest("http://localhost/covered", <Root />)
    const text = await flightToString(stream)
    expect(text).toContain("covered-page-content")
    expect(text).not.toContain(":E{")
  })
})
