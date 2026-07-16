/**
 * Embed economics — the measurement surfaces.
 *
 * Every embed hop costs a fetch + a decode→re-encode of the embedded
 * subtree on the host. These two pages hold everything constant
 * except that hop, so the delta IS the embed overhead:
 *
 *  - /embed-econ         — 8 same-origin `<RemoteFrame>` embeds of
 *                          `/econ-item` (each a full page fetch +
 *                          slice + re-encode).
 *  - /embed-econ-inline  — the SAME content component rendered inline
 *                          8 times (zero hops).
 *
 * `/econ-item` is the embedded unit: an ordinary page whose parton
 * renders a deliberately content-heavy body (~6 KB of markup), so the
 * per-hop re-encode cost is visible above fixed overheads.
 *
 * Measured by `e2e-testing/scripts/measure-embed-econ.mjs` against
 * the prod preview build; numbers + verdict live in
 * `docs/reference/remote-frame.md` § Embed economics.
 */

import { parton, RemoteFrame, type RenderArgs } from "@parton/framework"
import { Suspense } from "react"

const ROWS = Array.from({ length: 40 }, (_, i) => ({
  sku: `SKU-${String(i).padStart(4, "0")}`,
  name: `Catalog item ${i} — a moderately long display name for realistic byte weight`,
  price: (19.95 + i * 3.17).toFixed(2),
  stock: (i * 7) % 83,
}))

/** The content both variants render — a realistic product-grid chunk. */
export function EconContent() {
  return (
    <table className="w-full text-xs" data-testid="econ-content">
      <tbody>
        {ROWS.map((r) => (
          <tr key={r.sku}>
            <td className="pr-2 font-mono opacity-70">{r.sku}</td>
            <td className="pr-2">{r.name}</td>
            <td className="pr-2 text-right tabular-nums">${r.price}</td>
            <td className="text-right tabular-nums">{r.stock} in stock</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The embeddable unit — an ordinary page hosting the content. */
export const EconItemPage = parton(
  function EconItemRender(_: RenderArgs) {
    return (
      <section data-testid="econ-item">
        <EconContent />
      </section>
    )
  },
  { match: "/econ-item" },
)

const FRAME_COUNT = 8

export const EmbedEconDemoPage = parton(
  function EmbedEconDemoRender(_: RenderArgs) {
    return (
      <>
        <header className="mb-4" data-testid="embed-econ-header">
          <h2 className="text-xl font-semibold">Embed economics — {FRAME_COUNT} frames</h2>
        </header>
        {Array.from({ length: FRAME_COUNT }, (_, i) => (
          <section key={i} className="mb-2 rounded border border-dashed p-2">
            <Suspense fallback={<div className="italic">Loading frame {i}…</div>}>
              <RemoteFrame url="/econ-item" />
            </Suspense>
          </section>
        ))}
      </>
    )
  },
  { match: "/embed-econ" },
)

export const EmbedEconInlineDemoPage = parton(
  function EmbedEconInlineDemoRender(_: RenderArgs) {
    return (
      <>
        <header className="mb-4" data-testid="embed-econ-inline-header">
          <h2 className="text-xl font-semibold">
            Embed economics — inline control ({FRAME_COUNT}×)
          </h2>
        </header>
        {Array.from({ length: FRAME_COUNT }, (_, i) => (
          <section key={i} className="mb-2 rounded border border-dashed p-2">
            <EconContent />
          </section>
        ))}
      </>
    )
  },
  { match: "/embed-econ-inline" },
)
