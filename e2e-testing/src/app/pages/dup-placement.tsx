// Duplicate-placement fixture — two placements of ONE parton on one
// page. <DupTick/> renders twice on /dup-placement: nested inside
// <DupWrapperPage/>'s body AND directly in root.tsx. The placement
// fold (partial.tsx) mints each placement its own effective id, so
// both hydrate cleanly, display their own body, and fp-skip
// independently — pinned by e2e/duplicate-placement.spec.ts.

import { parton, searchParam, time, type RenderArgs } from "@parton/framework"
import { DupReload } from "./dup-placement-client.tsx"

function Stamp({ label }: { label: string }) {
  const now = time().now
  return (
    <i data-testid={`dup-stamp-${label}`} data-now={now}>
      {label} rendered at {now}
    </i>
  )
}

export const DupTick = parton(async function DupTickRender(_: RenderArgs) {
  return (
    <div
      data-testid="dup-tick"
      style={{ border: "1px solid #ccc", padding: "0.5em", margin: "0.5em 0" }}
    >
      <Stamp label="tick" />
    </div>
  )
}, "/dup-placement")

export const DupWrapperPage = parton(async function DupWrapperRender(_: RenderArgs) {
  const name = searchParam("dupname")
  return (
    <section
      data-testid="dup-wrapper"
      style={{ border: "2px solid #999", padding: "1em", margin: "1em 0" }}
    >
      <h2>dup placement — wrapper (dupname={name ?? "null"})</h2>
      <Stamp label="wrapper" />
      <p>
        <a href="/dup-placement?dupname=a" data-testid="dup-nav-a">
          nav a
        </a>{" "}
        <a href="/dup-placement?dupname=b" data-testid="dup-nav-b">
          nav b
        </a>{" "}
        <a href="/dup-placement" data-testid="dup-nav-none">
          nav none
        </a>{" "}
        <DupReload />
      </p>
      <p>nested placement:</p>
      <DupTick />
    </section>
  )
}, "/dup-placement")
