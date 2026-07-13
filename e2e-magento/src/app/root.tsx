import "./styles.css"
import { PartialRoot, parton } from "@parton/framework"
import {
  MagentoCheckoutStep,
  MagentoGreeting,
  MagentoPaymentSummary,
  MagentoStockTicker,
} from "./remote-specs.tsx"

/** The showcase landing content — gated to `/` so the embeddable
 *  `/remote/*` pages carry only their own parton in the body. */
const ShowcaseHome = parton(
  function ShowcaseHomeRender() {
    return (
      <section>
        <h1>e2e-magento</h1>
        <p>
          Companion app. The pages under <code>/remote/*</code> each host one parton — ordinary,
          individually-browsable pages the host app embeds with <code>&lt;RemoteFrame&gt;</code>.
        </p>
      </section>
    )
  },
  { match: "/" },
)

export function Root() {
  return (
    <PartialRoot>
      <html lang="en">
        <head>
          <meta charSet="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>e2e-magento — showcase</title>
        </head>
        <body>
          <main>
            <ShowcaseHome />
            {/* Embeddable pages — each spec's `match` is its page. */}
            <MagentoGreeting />
            <MagentoCheckoutStep />
            <MagentoPaymentSummary />
            <MagentoStockTicker />
          </main>
        </body>
      </html>
    </PartialRoot>
  )
}
