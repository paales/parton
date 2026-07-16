/**
 * The public `createServerContext` / `getServerContext` API — provider scopes
 * a value to descendants; readers anywhere inside read it; siblings outside
 * see the default; and — the payoff of one shared channel — a user context
 * threads cleanly THROUGH a parton (which only overlays the reserved parent
 * key, copying the rest of the map) to a nested reader.
 */

import { describe, expect, it } from "vitest"
import { renderServerToFlight, flightToString, renderWithRequest } from "../../test/rsc-server.ts"
import { createServerContext, getServerContext } from "../server-context.ts"
import { parton, type RenderArgs } from "../partial.tsx"

const Theme = createServerContext<string>("light")

const seen: Array<{ tag: string; theme: string }> = []
async function Reader({ tag }: { tag: string }) {
  await new Promise((r) => setTimeout(r, 1)) // read AFTER an await — must still resolve
  seen.push({ tag, theme: getServerContext(Theme) })
  return <span data-tag={tag} />
}

describe("createServerContext / getServerContext", () => {
  it("a reader inside the provider sees its value", async () => {
    seen.length = 0
    await flightToString(
      renderServerToFlight(
        <Theme value="dark">
          <Reader tag="A" />
        </Theme>,
      ),
    )
    expect(seen.find((s) => s.tag === "A")?.theme).toBe("dark")
  })

  it("a reader with no provider sees the default", async () => {
    seen.length = 0
    await flightToString(renderServerToFlight(<Reader tag="B" />))
    expect(seen.find((s) => s.tag === "B")?.theme).toBe("light")
  })

  it("a nested provider overrides the outer one for its subtree", async () => {
    seen.length = 0
    await flightToString(
      renderServerToFlight(
        <Theme value="dark">
          <Theme value="solarized">
            <Reader tag="C" />
          </Theme>
        </Theme>,
      ),
    )
    expect(seen.find((s) => s.tag === "C")?.theme).toBe("solarized")
  })

  it("isolates siblings — only the wrapped subtree sees the value", async () => {
    seen.length = 0
    await flightToString(
      renderServerToFlight(
        <>
          <Theme value="dark">
            <Reader tag="X" />
          </Theme>
          <Reader tag="Y" />
        </>,
      ),
    )
    expect(seen.find((s) => s.tag === "X")?.theme).toBe("dark")
    expect(seen.find((s) => s.tag === "Y")?.theme).toBe("light") // NOT "dark"
  })
})

// ── threading through a parton (the shared-channel payoff) ───────────────
const Locale = createServerContext<string>("en")

const LocaleProbe = parton(async function LocaleProbeRender(_: RenderArgs) {
  return <span data-testid="locale">{getServerContext(Locale)}</span>
})

describe("createServerContext: threads through a parton", () => {
  it("a parton's Render reads a context provided above it", async () => {
    const { stream } = await renderWithRequest(
      "http://t/x",
      <Locale value="nl">
        <div>
          <LocaleProbe />
        </div>
      </Locale>,
    )
    const text = await flightToString(stream)
    expect(text).toContain("nl")
    expect(text).not.toContain(">en<")
  })
})
