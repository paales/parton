/**
 * /cache-demo — server-side render-output caching spike.
 *
 * Outer wrapper gates the route once. `Slow` is cached (`cache:
 * {maxAge: 60}`) and varies by `flavor`; `Clock` stays uncached.
 */

import { parton, getScope, searchParam, type RenderArgs } from "@parton/framework"
// `_cacheStats` is a framework-internal diagnostic surface — kept on
// the deep path because the demo intentionally peeks at internals.
import { _cacheStats } from "@parton/framework/lib/cache.tsx"
import { CacheControls } from "../components/cache-controls.tsx"
import { ClickCounter } from "../components/click-counter.tsx"

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

const slowRenderCounts = new Map<string, number>()
function bumpSlowRender(): number {
  const scope = getScope()
  const next = (slowRenderCounts.get(scope) ?? 0) + 1
  slowRenderCounts.set(scope, next)
  return next
}

function Code({ children, ...rest }: React.ComponentProps<"code">) {
  return (
    <code {...rest} className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
      {children}
    </code>
  )
}

// ─── Inner specs ───────────────────────────────────────────────────────

const Intro = parton(async function CacheDemoIntroRender({
  flavor,
}: { flavor: string } & RenderArgs) {
  const stats = await _cacheStats()
  return (
    <>
      <title>Cache Demo</title>
      <h1 className="mb-4 text-2xl font-semibold">Server-side cache spike</h1>
      <p className="mb-4 text-muted-foreground">
        flavor=<Code>{flavor}</Code> · cache size:{" "}
        <Code data-testid="cache-size">{stats.size}</Code>
      </p>
      <CacheControls />
    </>
  )
})

// `Slow` self-sources `flavor` from the URL via a tracked
// `searchParam` read, so any refetch re-derives it against the current
// request — no parent-passed prop, no refetch-time override. The cache
// keys on the spec's fingerprint, which folds in the recorded read, so
// each flavor is a distinct cache entry. (Contrast `Intro`, which
// takes `flavor` as a plain wrapper prop — fine for a child that only
// ever re-renders with its parent, never on its own refetch.)
const Slow = parton(
  async function CacheDemoSlowRender(_: RenderArgs) {
    const flavor = searchParam("flavor") ?? "vanilla"
    const slowRenderCount = bumpSlowRender()
    await delay(500)
    return (
      <div
        data-testid="slow-content"
        data-render-count={slowRenderCount}
        className="mb-2 rounded-lg bg-card p-4"
      >
        <div className="font-semibold">Slow content (flavor: {flavor})</div>
        <div className="mt-1 text-xs text-muted-foreground">
          rendered {slowRenderCount} time{slowRenderCount === 1 ? "" : "s"} · computed at{" "}
          {new Date().toISOString()}
        </div>
        <div className="mt-3">
          <ClickCounter />
        </div>
      </div>
    )
  },
  {
    cache: { maxAge: 60 },
    fallback: <div data-testid="slow-fallback">Loading slow…</div>,
  },
)

const Clock = parton(
  function CacheDemoClockRender() {
    return (
      <div data-testid="clock-content" className="mb-2 rounded-lg bg-muted p-4">
        <div className="font-semibold">Clock (always fresh)</div>
        <div className="mt-1 text-xs text-muted-foreground">
          Server time: {new Date().toISOString()}
        </div>
      </div>
    )
  },
  {
    // Always fresh: never served from the client's fp cache — every
    // request re-renders the timestamp.
    fpSkip: false,
    fallback: <div>Loading clock…</div>,
  },
)

// Re-renders inline with its parent whenever the wrapper's `?flavor`
// read moves — enough to show the live render count. `fpSkip: false`
// keeps the count honest on refetches whose fingerprint is otherwise
// unchanged.
const Footer = parton(
  function CacheDemoFooterRender() {
    return (
      <div className="mt-8 text-xs text-muted-foreground">
        Server <Code>slowRenderCount</Code>:{" "}
        <span data-testid="server-render-count">{slowRenderCounts.get(getScope()) ?? 0}</span>
        <br />
        Try: change <Code>?flavor=</Code>, refetch the slow partial, reload.
      </div>
    )
  },
  { fpSkip: false },
)

// ─── Outer wrapper — matches /cache-demo, threads flavor down ─────────

export const CacheDemoPage = parton(
  function CacheDemoRender(_: RenderArgs) {
    const flavor = searchParam("flavor") ?? "vanilla"
    return (
      <>
        <Intro flavor={flavor} />
        <Slow />
        <Clock />
        <Footer />
      </>
    )
  },
  { match: "/cache-demo" },
)
