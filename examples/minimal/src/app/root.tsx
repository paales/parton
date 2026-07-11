import { parton, searchParam, PartialRoot, type RenderArgs } from "@parton/framework"
import { greeting } from "./greeting-state.ts"
import { setGreeting } from "./greeting-actions.ts"
import { GreetingForm } from "./greeting-form.tsx"

// `parton(Render, match)` — an addressable, independently re-renderable
// subtree. The string form of `match` is a URLPattern pathname gate: a
// miss means this instance doesn't render (nothing to gate here, since
// it's the whole page).
const GreetingPage = parton(async function GreetingRender(_: RenderArgs) {
  // Tracked read: `searchParam` records `search:name` as a dependency —
  // the read IS the dependency, no separate `vary` declaration. Visit
  // `/?name=you` and this line alone decides what re-renders.
  const name = searchParam("name") ?? "world"

  // Cell read: server-owned state, resolved where it's used. Resolving
  // records a `cell:greeting` dependency, so a write (via `setGreeting`
  // below) re-renders this parton on the next request.
  const state = await greeting.resolve()

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 480 }}>
      <h1>Hello, {name}</h1>
      <p>Server-stored greeting: {state.value || "(nothing saved yet)"}</p>
      {/* `setGreeting` is a plain "use server" function — a bound
       *  server reference passed straight through as a prop. The
       *  client calls it directly; no fetch, no API route. */}
      <GreetingForm greeting={state.value} setGreeting={setGreeting} />
    </main>
  )
}, "/")

export function Root() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>parton — minimal example</title>
      </head>
      <body>
        {/* `<PartialRoot>` is the page-scope provider every parton
         *  needs — the client merge layer, the live-channel heartbeat,
         *  the navigation intercept. One per app, wrapping everything. */}
        <PartialRoot>
          <GreetingPage />
        </PartialRoot>
      </body>
    </html>
  )
}
