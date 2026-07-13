import "./styles.css"
import { PartialRoot } from "@parton/framework"
import { EmbassyBulletin } from "./world/embassy-page.tsx"
import { WorldPage } from "./world/world-page.tsx"

export function Root() {
  return (
    <html lang="en" className="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>parton — an RSC-native framework</title>
      </head>
      <body>
        <PartialRoot>
          <WorldPage />
          {/* The embassy district's embeddable pages — ordinary pages,
              each gated to its own `/embassy/*` route (the world's
              match carves those out). The building overlay embeds them
              back into the world under a paint grant. */}
          <EmbassyBulletin />
        </PartialRoot>
      </body>
    </html>
  )
}
