/**
 * /cache-demo — server-side render-output caching spike.
 *
 * Each section is its own spec gating on `match: "/cache-demo"`.
 * `CacheDemoSlowPartial` declares `cache={{maxAge: 60}}` and varies
 * by `flavor`; the fast clock partial stays uncached.
 */

import { ReactCms, type PartialCtx, type RenderArgs } from "../../lib"
import { _cacheStats } from "../../lib/cache.tsx"
import { CacheControls } from "../components/cache-controls.tsx"
import { ClickCounter } from "../components/click-counter.tsx"
import { getScope } from "../../framework/context.ts"

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

// ─── Intro ─────────────────────────────────────────────────────────────

export const CacheDemoIntroPartial = ReactCms.partial(CacheDemoIntroRender, {
  match: "/cache-demo",
  selector: "#cache-demo-intro",
  vary: ({ request }) => ({
    flavor: new URL(request.url).searchParams.get("flavor") ?? "vanilla",
  }),
})

async function CacheDemoIntroRender({ flavor }: { flavor: string } & RenderArgs) {
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
}

// ─── Slow content (cached) ─────────────────────────────────────────────

export const CacheDemoSlowPartial = ReactCms.partial(CacheDemoSlowRender, {
  match: "/cache-demo",
  selector: "#slow",
  cache: { maxAge: 60 },
  vary: ({ request }) => ({
    flavor: new URL(request.url).searchParams.get("flavor") ?? "vanilla",
  }),
  fallback: <div data-testid="slow-fallback">Loading slow…</div>,
})

async function CacheDemoSlowRender({ flavor }: { flavor: string } & RenderArgs) {
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
}

// ─── Clock (uncached) ───────────────────────────────────────────────────

export const CacheDemoClockPartial = ReactCms.partial(CacheDemoClockRender, {
  match: "/cache-demo",
  selector: "#clock",
  fallback: <div>Loading clock…</div>,
})

function CacheDemoClockRender({}: RenderArgs) {
  return (
    <div data-testid="clock-content" className="mb-2 rounded-lg bg-muted p-4">
      <div className="font-semibold">Clock (always fresh)</div>
      <div className="mt-1 text-xs text-muted-foreground">
        Server time: {new Date().toISOString()}
      </div>
    </div>
  )
}

// ─── Footer ────────────────────────────────────────────────────────────

export const CacheDemoFooterPartial = ReactCms.partial(CacheDemoFooterRender, {
  match: "/cache-demo",
  selector: "#cache-demo-footer",
  vary: () => ({ tick: Date.now() }),
})

function CacheDemoFooterRender({}: { tick: number } & RenderArgs) {
  return (
    <div className="mt-8 text-xs text-muted-foreground">
      Server <Code>slowRenderCount</Code>:{" "}
      <span data-testid="server-render-count">{slowRenderCounts.get(getScope()) ?? 0}</span>
      <br />
      Try: change <Code>?flavor=</Code>, refetch the slow partial, reload.
    </div>
  )
}

export function CacheDemoPagePlacements({ parent }: { parent: PartialCtx }) {
  return (
    <>
      <CacheDemoIntroPartial parent={parent} />
      <CacheDemoSlowPartial parent={parent} />
      <CacheDemoClockPartial parent={parent} />
      <CacheDemoFooterPartial parent={parent} />
    </>
  )
}
