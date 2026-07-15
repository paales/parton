// Duplicate-placement fixture (control) — single placement of
// SoloTick, nested only. The behavioral baseline for
// pages/dup-placement.tsx.

import { parton, searchParam, time, type RenderArgs } from "@parton/framework"

function SoloStamp({ label }: { label: string }) {
  const now = time().now
  return (
    <i data-testid={`solo-stamp-${label}`} data-now={now}>
      {label} rendered at {now}
    </i>
  )
}

export const SoloTick = parton(async function SoloTickRender(_: RenderArgs) {
  return (
    <div
      data-testid="solo-tick"
      style={{ border: "1px solid #ccc", padding: "0.5em", margin: "0.5em 0" }}
    >
      <SoloStamp label="tick" />
    </div>
  )
}, "/dup-control")

export const SoloWrapperPage = parton(async function SoloWrapperRender(_: RenderArgs) {
  const name = searchParam("dupname")
  return (
    <section
      data-testid="solo-wrapper"
      style={{ border: "2px solid #999", padding: "1em", margin: "1em 0" }}
    >
      <h2>dup control — wrapper (dupname={name ?? "null"})</h2>
      <SoloStamp label="wrapper" />
      <p>
        <a href="/dup-control?dupname=a" data-testid="solo-nav-a">
          nav a
        </a>{" "}
        <a href="/dup-control?dupname=b" data-testid="solo-nav-b">
          nav b
        </a>{" "}
        <a href="/dup-control" data-testid="solo-nav-none">
          nav none
        </a>
      </p>
      <p>nested placement:</p>
      <SoloTick />
    </section>
  )
}, "/dup-control")
