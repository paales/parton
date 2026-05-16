/**
 * Partons exposed by this app via `/__remote/<id>` so other
 * processes can embed them with `<RemoteFrame>`.
 *
 * Importing this module is what registers the partons in the spec
 * catalog. Without the import, the catalog lookup misses and the
 * remote endpoint returns 404. `root.tsx` triggers the import.
 */

import { parton, type RenderArgs } from "@parton/framework"

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A simple greeting parton — proves cross-origin RSC bytes flow. */
export const MagentoGreeting = parton(
  async function MagentoGreetingRender(_: RenderArgs) {
    await delay(250)
    const ts = new Date().toISOString()
    return (
      <div
        data-testid="magento-greeting"
        style={{
          padding: "1rem",
          border: "1px solid rgba(168, 85, 247, 0.4)",
          background: "rgba(168, 85, 247, 0.08)",
          borderRadius: "0.5rem",
          color: "#e9d5ff",
        }}
      >
        <strong>Greetings from e2e-magento (port 5181)</strong>
        <div style={{ fontSize: "0.8em", opacity: 0.7, marginTop: "0.25rem" }}>
          Rendered at <code>{ts}</code>
        </div>
        <div style={{ fontSize: "0.8em", opacity: 0.7, marginTop: "0.25rem" }}>
          This is a SEPARATE Node process. The host app at port 5173 fetched these
          Flight bytes from{" "}
          <code>http://localhost:5181/__remote/magento-greeting</code>, rewrote any
          module references to absolute URLs on this origin, decoded the result,
          and stitched it into its outer response.
        </div>
      </div>
    )
  },
  { selector: "magento-greeting" },
)

/** A second parton — exercise multiple cross-origin frames in
 *  parallel. Longer delay than the first to make ordering visible. */
export const MagentoStockTicker = parton(
  async function MagentoStockTickerRender(_: RenderArgs) {
    await delay(700)
    const tickers = [
      { sym: "PTON", price: 42.17 + Math.random() * 4 },
      { sym: "RCMS", price: 187.5 + Math.random() * 10 },
      { sym: "FLGT", price: 91.04 + Math.random() * 5 },
    ]
    return (
      <div
        data-testid="magento-stocks"
        style={{
          padding: "1rem",
          border: "1px solid rgba(244, 114, 182, 0.4)",
          background: "rgba(244, 114, 182, 0.08)",
          borderRadius: "0.5rem",
          color: "#fbcfe8",
        }}
      >
        <strong>Stock ticker (cross-origin, 700ms)</strong>
        <table style={{ marginTop: "0.5rem", fontSize: "0.85em", width: "100%" }}>
          <tbody>
            {tickers.map((t) => (
              <tr key={t.sym}>
                <td style={{ opacity: 0.7 }}>{t.sym}</td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  ${t.price.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  },
  { selector: "magento-stocks" },
)
