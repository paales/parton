/**
 * Partons exposed by this app via `/__remote/<id>` so other
 * processes can embed them with `<RemoteFrame>`.
 *
 * Importing this module is what registers the partons in the spec
 * catalog. Without the import, the catalog lookup misses and the
 * remote endpoint returns 404. `root.tsx` triggers the import.
 */

import { parton, getCapability, type RenderArgs } from "@parton/framework"

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

/** A capability-aware parton — reads host-declared values via
 *  `getCapability()`. The host passes them as the `capability`
 *  prop on `<RemoteFrame>`; the framework forwards them as a
 *  signed header and the remote's render scope sees only those
 *  declared values (no host cookies, no host session, no
 *  ambient host context). */
export const MagentoPaymentSummary = parton(
  async function MagentoPaymentSummaryRender(_: RenderArgs) {
    await delay(150)
    const cap = getCapability()
    const cartId = String(cap.cart_id ?? "<missing>")
    const currency = String(cap.currency ?? "USD")
    const total =
      typeof cap.total === "number" ? cap.total : Number(cap.total ?? 0)
    return (
      <div
        data-testid="magento-payment-summary"
        style={{
          padding: "1rem",
          border: "1px solid rgba(56, 189, 248, 0.4)",
          background: "rgba(56, 189, 248, 0.08)",
          borderRadius: "0.5rem",
          color: "#bae6fd",
        }}
      >
        <strong>Payment summary (capability-scoped)</strong>
        <div style={{ marginTop: "0.5rem", fontSize: "0.85em" }}>
          Cart <code>{cartId}</code> · Total{" "}
          <code data-testid="magento-payment-total">
            {currency} {total.toFixed(2)}
          </code>
        </div>
        <div style={{ marginTop: "0.5rem", fontSize: "0.75em", opacity: 0.7 }}>
          These values came from the host via the{" "}
          <code>x-parton-capability</code> header. The remote has no other
          access to the host's request context — its own cookies/session/
          headers belong to the fetch, not the host page.
        </div>
      </div>
    )
  },
  { selector: "magento-payment-summary" },
)

/** A second parton — exercise multiple cross-origin frames in
 *  parallel. Longer delay than the first to make ordering visible.
 *  Varies on `tick` so each render produces a fresh fingerprint
 *  (so the host's selector-targeted refetch produces visibly
 *  different content). The render embeds the tick as
 *  `data-tick=` so e2e tests can assert it strictly changes. */
export const MagentoStockTicker = parton(
  async function MagentoStockTickerRender(
    { tick }: { tick: number } & RenderArgs,
  ) {
    await delay(700)
    const tickers = [
      { sym: "PTON", price: 42.17 + Math.random() * 4 },
      { sym: "RCMS", price: 187.5 + Math.random() * 10 },
      { sym: "FLGT", price: 91.04 + Math.random() * 5 },
    ]
    void tick
    return (
      <div
        data-testid="magento-stocks"
        data-tick={String(tick)}
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
  {
    selector: "magento-stocks",
    vary: () => ({ tick: Date.now() }),
  },
)
