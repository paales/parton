/**
 * Every parton ships a fingerprint. There is no addressability gate:
 * a bare `parton(Render)` — no `match`, no ancestor parton, nothing
 * but a Render name — emits its `partialFingerprint` on the wire, the
 * boundary the client registers under `id + matchKey`, so it joins the
 * `?cached=` manifest and fp-skips across navigations exactly like a
 * match-gated surface. Identity is the Render name (kebab-cased);
 * placement under a parent folds a `~<hash>` suffix onto the id.
 *
 * The descendant fold still folds a child's tracked-read contribution
 * into its parent's fp — so a parent that fp-skips never serves a
 * stale child body when only the child's dependency moved.
 */

import { describe, expect, it } from "vitest"
import { parton, PartialRoot, type RenderArgs } from "../partial.tsx"
import { cookie, searchParam } from "../server-hooks.ts"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { clearRegistry } from "../partial-registry.ts"

/** Pull `(partialId, partialFingerprint?)` pairs out of a Flight
 *  payload, keyed by partialId. Every parton emits `partialFingerprint`
 *  now, so the fp is expected present for each id. */
function fingerprintsByPartialId(flight: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>()
  const idRe = /"partialId":"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = idRe.exec(flight)) !== null) {
    const id = m[1]
    const tail = flight.slice(m.index, m.index + 200)
    const fpMatch = /"partialFingerprint":"([^"]+)"/.exec(tail)
    out.set(id, fpMatch ? fpMatch[1] : undefined)
  }
  return out
}

async function flightAt(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node)
  return await new Response(stream).text()
}

describe("every parton ships a fingerprint on the wire", () => {
  it("a bare parton — no match, plain body — emits a partialFingerprint", async () => {
    clearRegistry("all")

    // No match, no tracked read: identity is the Render name alone.
    // Catalog id auto-derives to "gate-child".
    const Child = parton(function GateChildRender(_: RenderArgs) {
      return <span data-testid="gate-child-body">child</span>
    })

    // A tracked body read folds into the fp — and the parent's
    // descendant fold — but does not change WHETHER the fp ships.
    const ReadingChild = parton(function ReadOnlyChildRender(_: RenderArgs) {
      const v = searchParam("v", "x")
      return <span data-testid="read-only-body">{`child-${v}`}</span>
    })

    const Parent = parton(
      function GateParentRender() {
        return (
          <div data-testid="gate-parent-body">
            <Child />
            <ReadingChild />
          </div>
        )
      },
      { match: "/gate" },
    )

    const out = await flightAt(
      "http://t/gate",
      <PartialRoot>
        <Parent />
      </PartialRoot>,
    )
    const fps = fingerprintsByPartialId(out)

    // Sanity: all three partials rendered.
    expect(out).toContain("gate-parent-body")
    expect(out).toContain("gate-child-body")
    expect(out).toContain("read-only-body")

    // The parent ships its fp under its bare name.
    expect(fps.get("gate-parent")).toMatch(/^[0-9a-f]{16}$/)

    // Both children ship fps too — placement under a parent folds a
    // `~<hash>` suffix onto the auto id, but the fp is present.
    const childId = [...fps.keys()].find((id) => id.startsWith("gate-child~"))
    expect(childId).toBeDefined()
    expect(fps.get(childId!)).toMatch(/^[0-9a-f]{16}$/)

    const readingId = [...fps.keys()].find((id) => id.startsWith("read-only-child~"))
    expect(readingId).toBeDefined()
    expect(fps.get(readingId!)).toMatch(/^[0-9a-f]{16}$/)
  })

  it("a bare root parton (no match, no ancestor) ships its fp under its Render name", async () => {
    clearRegistry("all")

    // The headline case: placed directly under PartialRoot, no match,
    // no parent parton. It is addressable like any other.
    const Solo = parton(function SoloRootRender(_: RenderArgs) {
      return <span data-testid="solo-body">solo</span>
    })

    const out = await flightAt(
      "http://t/solo",
      <PartialRoot>
        <Solo />
      </PartialRoot>,
    )
    const fps = fingerprintsByPartialId(out)
    expect(fps.get("solo-root")).toMatch(/^[0-9a-f]{16}$/)
  })

  it("the parent's fingerprint moves when a child's tracked read would move (fold safety)", async () => {
    clearRegistry("all")

    // Child reads a cookie in its body — the important assertion is
    // that the PARENT's fp picks up the child's dep contribution
    // through the descendant fold. Without the fold, fp-skipping the
    // parent would serve a stale child body when only the cookie
    // changed.
    const FoldChild = parton(function FoldChildRender(_: RenderArgs) {
      const flag = cookie("flag") ?? "off"
      return <span data-testid="fold-body">flag={flag}</span>
    })

    const Parent = parton(
      function FoldParentRender() {
        return (
          <div>
            <FoldChild />
          </div>
        )
      },
      { match: "/fold" },
    )

    const tree = (
      <PartialRoot>
        <Parent />
      </PartialRoot>
    )

    // Cold→cold→warm so the fold has snapshots to read from.
    await flightAt("http://t/fold", tree)
    const off = await flightAt("http://t/fold", tree)
    const { stream: onStream } = await renderWithRequest("http://t/fold", tree, {
      headers: { cookie: "flag=on" },
    })
    const on = await new Response(onStream).text()

    const fpOff = fingerprintsByPartialId(off).get("fold-parent")
    const fpOn = fingerprintsByPartialId(on).get("fold-parent")
    expect(fpOff).toBeDefined()
    expect(fpOn).toBeDefined()
    expect(fpOn).not.toBe(fpOff)
  })
})
