/**
 * Server context against the PRODUCTION react-server-dom Flight build.
 *
 * The carrier (a parton's parent, the frame chain, any `createServerContext`
 * value) is threaded by a patch to the vendored Flight server. The dev and
 * prod builds schedule tasks differently, and a carrier that only threads in
 * the dev build's finer task granularity ships green on every existing tier —
 * `test:rsc` and `test:e2e` both run the DEV build. This file runs the same
 * kind of assertions against the PROD build, so a prod-only carrier regression
 * fails here.
 *
 * `@vitejs/plugin-rsc/vendor/react-server-dom/server.edge` picks dev vs prod on
 * `process.env.NODE_ENV` at require-time. `yarn test:rsc:prod` sets
 * `NODE_ENV=production`; under any other run the suite skips (so a stray
 * all-projects `vitest run` doesn't assert against the dev build). See
 * `docs/internals/server-context.md`.
 */

import { describe, expect, it } from "vitest"
import type { ReactNode } from "react"
import { flightToString, renderServerToFlight } from "../../test/rsc-server.ts"
import { createServerContext, getServerContext } from "../server-context.ts"
import { ClientWrap } from "./prod-client-fixture.tsx"

const PROD = process.env.NODE_ENV === "production"

const Ctx = createServerContext<string>("DEFAULT")

/** Async consumer — reads AFTER an await, so a pass proves the value
 *  survived both the async boundary and React's deferred serialization. */
async function Read({ tag }: { tag: string }) {
  await new Promise((r) => setTimeout(r, 1))
  return <span>{`[${tag}:${getServerContext(Ctx)}]`}</span>
}

describe.skipIf(!PROD)("server context — PRODUCTION Flight build", () => {
  it("loaded the production build (guard)", async () => {
    // The dev build emits per-component debug-info rows the prod build omits.
    // If NODE_ENV=production didn't swap in the prod build, this fails loud
    // rather than the suite silently testing dev again.
    const text = await flightToString(renderServerToFlight(<Read tag="g" />))
    expect(text).not.toMatch(/"env":/) // dev-only componentDebugInfo
  })

  it("threads a provider value to an async descendant", async () => {
    const text = await flightToString(
      renderServerToFlight(
        <Ctx value="A">
          <div>
            <Read tag="x" />
          </div>
        </Ctx>,
      ),
    )
    expect(text).toContain("[x:A]")
    expect(text).not.toContain("[x:DEFAULT]")
  })

  it("isolates sibling providers and restores for the outside", async () => {
    const text = await flightToString(
      renderServerToFlight(
        <>
          <Ctx value="A">
            <Read tag="a" />
          </Ctx>
          <Ctx value="B">
            <Read tag="b" />
          </Ctx>
          <Read tag="outside" />
        </>,
      ),
    )
    expect(text).toContain("[a:A]")
    expect(text).toContain("[b:B]")
    expect(text).toContain("[outside:DEFAULT]") // no leak past the providers
    expect(text).not.toContain("[a:B]")
  })

  it("threads through an ARRAY of children (deferred serialization)", async () => {
    // `renderFragment` defers array elements to the parent task's
    // serialization pass — the exact path a render-time scope can't reach,
    // and the reason a provider outlines its subtree into a context-bearing
    // task. This is the case that regressed in prod.
    const text = await flightToString(
      renderServerToFlight(
        <Ctx value="A">
          {["one", "two", "three"].map((k) => (
            <Read key={k} tag={k} />
          ))}
        </Ctx>,
      ),
    )
    expect(text).toContain("[one:A]")
    expect(text).toContain("[two:A]")
    expect(text).toContain("[three:A]")
    expect(text).not.toContain(":DEFAULT")
  })

  it("nests providers — the inner value wins for its subtree", async () => {
    const text = await flightToString(
      renderServerToFlight(
        <Ctx value="A">
          <Ctx value="B">
            <Read tag="inner" />
          </Ctx>
        </Ctx>,
      ),
    )
    expect(text).toContain("[inner:B]")
  })

  it("threads through a CLIENT-component boundary (deferred prop serialization)", async () => {
    // A server consumer rendered as a client component's `children` serialises
    // in React's deferred prop pass — the frames-demo shape (the frame parton
    // sits behind the `FrameNameProvider` client boundary). A render-time scope
    // can't reach it; the provider's outlined task does.
    const text = await flightToString(
      renderServerToFlight(
        <Ctx value="A">
          <ClientWrap>
            <Read tag="client-child" />
          </ClientWrap>
        </Ctx>,
      ),
    )
    expect(text).toContain("[client-child:A]")
    expect(text).not.toContain("[client-child:DEFAULT]")
  })
})
