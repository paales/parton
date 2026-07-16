/**
 * Bare-root-parton fixture — every parton is addressable.
 *
 * `BareRootParton` declares NO match and sits directly in root.tsx's
 * tree: no request gate, no ancestor parton, nothing but its Render
 * name for identity. It ships its fingerprint like any other parton, so
 * it registers, rides the client's cached manifest, and fp-skips across
 * navigations — its `time()` stamp holds. Its ONE dependency is the
 * cell it resolves, so the checkbox's write is the only thing that
 * moves the stamp.
 *
 * `BareRootNavPage` is just a cheap landing surface with two links, so
 * the spec has a deterministic nav away-and-back to drive.
 * Pinned by e2e/bare-root-parton.spec.ts.
 */

import { parton, time, type RenderArgs } from "@parton/framework"
import { BareRootToggle } from "../components/bare-root-toggle.tsx"
import { bareRootToggle } from "./bare-root-state.ts"

export const BareRootParton = parton(async function BareRootRender(_: RenderArgs) {
  // The read IS the dependency: this resolve is why the cell's write
  // re-runs this body. Nothing else here reads the request, so no
  // navigation can move the stamp.
  const toggle = await bareRootToggle.resolve()
  const now = time().now
  return (
    <section
      data-testid="bare-root"
      style={{ border: "1px solid #ccc", padding: "0.5em", margin: "0.5em 0" }}
    >
      <i data-testid="bare-root-stamp" data-now={now}>
        bare root rendered at {now}
      </i>{" "}
      <label>
        toggle <BareRootToggle checked={toggle.value} />
      </label>
    </section>
  )
})

export const BareRootNavPage = parton(function BareRootNavRender(_: RenderArgs) {
  return (
    <section
      data-testid="bare-root-nav"
      style={{ border: "2px solid #999", padding: "1em", margin: "1em 0" }}
    >
      <h2>bare root parton</h2>
      <p>
        <a href="/bare-root/a" data-testid="bare-root-nav-a">
          nav a
        </a>{" "}
        <a href="/bare-root/b" data-testid="bare-root-nav-b">
          nav b
        </a>
      </p>
    </section>
  )
}, "/bare-root{/*}?")
