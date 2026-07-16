/**
 * /defer-demo — exercises the three shapes of `defer` plus
 * batched-activation, streaming/defer race, and concurrent-refetch
 * scenarios.
 *
 * Outer wrapper gates the route once; sub-specs render unconditionally
 * inside it.
 */

import { parton, tag, type RenderArgs } from "@parton/framework"
import { WhenVisible } from "../components/when-visible.tsx"
import { WhenMounted } from "../components/when-mounted.tsx"
import { BumpButton, WhenClicked } from "../components/defer-demo-controls.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "@parton/copies/components/ui/card"

function InlineCode({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">{children}</code>
}

function DormantFallback({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <div data-testid={testId} className="italic text-muted-foreground">
      {children}
    </div>
  )
}

function Timestamp({ prefix }: { prefix: string }) {
  return (
    <span>
      {prefix} {new Date().toISOString()}
    </span>
  )
}

// ─── Sub-specs ──────────────────────────────────────────────────────────

export const ManualPartial = parton(
  function ManualRender({}: RenderArgs) {
    return (
      <div data-testid="manual-content">
        <Timestamp prefix="activated at" />
      </div>
    )
  },
  {
    defer: <WhenClicked label="Activate manually" testId="activate-manual" />,
    fallback: (
      <DormantFallback testId="manual-fallback">
        dormant — waiting for manual activation
      </DormantFallback>
    ),
  },
)

// Batched activation: two partials that each activate on mount fire in
// the same tick, so `enqueueRefetch`'s microtask coalescer folds them
// into ONE statement forcing both ids.
function makeBatch(label: string) {
  return parton(
    Object.assign(
      async function BatchRender({}: RenderArgs) {
        return (
          <div data-testid={`${label}-content`}>
            <Timestamp prefix="activated at" />
          </div>
        )
      },
      { displayName: label },
    ),
    {
      defer: <WhenMounted />,
      fallback: (
        <DormantFallback testId={`${label}-fallback`}>
          dormant — activates on mount, batched with its sibling
        </DormantFallback>
      ),
    },
  )
}

export const BatchAPartial = makeBatch("batch-a")
export const BatchBPartial = makeBatch("batch-b")

export const SlowStreamPartial = parton(
  async function SlowStreamRender({}: RenderArgs) {
    // Render interval stamped into the DOM — the defer-race e2e spec
    // proves race-defer's activation did not serialize behind this
    // stream from interval OVERLAP (race started before slow
    // finished), a server-clock signal.
    const startedAt = Date.now()
    await new Promise((r) => setTimeout(r, 1500))
    return (
      <div data-testid="slow-content" data-started-at={startedAt} data-finished-at={Date.now()}>
        <Timestamp prefix="slow stream resolved at" />
      </div>
    )
  },
  {
    fallback: (
      <DormantFallback testId="slow-fallback">slow content streaming… (1.5s)</DormantFallback>
    ),
  },
)

export const RaceDeferPartial = parton(
  function RaceDeferRender({}: RenderArgs) {
    // See SlowStreamPartial — the pair's stamps prove the activation
    // refetch ran concurrently with the slow stream.
    return (
      <div data-testid="race-defer-content" data-started-at={Date.now()}>
        <Timestamp prefix="race defer activated at" />
      </div>
    )
  },
  {
    defer: <WhenMounted />,
    fallback: (
      <DormantFallback testId="race-defer-fallback">
        dormant — activates immediately on mount
      </DormantFallback>
    ),
  },
)

function makeConcurrent(label: string, delayMs: number) {
  return parton(
    Object.assign(
      async function ConcurrentRender({}: RenderArgs) {
        // The refetch buttons bump this tag — the read subscribes.
        tag(`concurrent-${label}`)
        // Server-side render interval, stamped into the DOM. The
        // concurrency e2e spec proves parallel handling from interval
        // OVERLAP (`started(b) < finished(a)`), which no client-side
        // wall-clock measurement can do reliably under machine load.
        const startedAt = Date.now()
        await new Promise((r) => setTimeout(r, delayMs))
        return (
          <div
            data-testid={`concurrent-${label}`}
            data-started-at={startedAt}
            data-finished-at={Date.now()}
          >
            <strong>{label}</strong> ({delayMs}ms): {new Date().toISOString()}
          </div>
        )
      },
      { displayName: `concurrent-${label}` },
    ),
    {
      fallback: (
        <div data-testid={`concurrent-${label}-fallback`} className="text-muted-foreground">
          {label} ({delayMs}ms): streaming…
        </div>
      ),
    },
  )
}

export const ConcurrentAPartial = makeConcurrent("a", 400)
export const ConcurrentBPartial = makeConcurrent("b", 800)
export const ConcurrentCPartial = makeConcurrent("c", 1200)

export const VisibilityDeferPartial = parton(
  function VisibilityDeferRender({}: RenderArgs) {
    return (
      <div data-testid="any-content">
        <Timestamp prefix="activated at" />
      </div>
    )
  },
  {
    defer: <WhenVisible />,
    fallback: (
      <DormantFallback testId="any-fallback">
        dormant — scroll into view to activate
      </DormantFallback>
    ),
  },
)

// ─── Static chrome ──────────────────────────────────────────────────────

export const DeferDemoPage = parton(
  function DeferDemoRender() {
    return (
      <main className="py-4">
        <title>Defer Demo</title>
        <h1 className="mb-4 text-2xl font-semibold">Partial defer — feature demo</h1>
        <p className="mb-8 text-muted-foreground">
          Three activation shapes for <InlineCode>defer</InlineCode>.
        </p>

        <Card data-testid="section-manual" className="mb-8 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">
              1. <InlineCode>defer={"{true}"}</InlineCode>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-0">
            <ManualPartial />
          </CardContent>
        </Card>

        <Card data-testid="section-batch" className="mb-8 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">2. Batched activation</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-0">
            <BatchAPartial />
            <BatchBPartial />
          </CardContent>
        </Card>

        <Card data-testid="section-race" className="mb-8 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">3. Streaming + defer race</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-0">
            <SlowStreamPartial />
            <RaceDeferPartial />
          </CardContent>
        </Card>

        <Card data-testid="section-concurrent" className="mb-8 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">4. Concurrent refetches</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-0">
            <ConcurrentAPartial />
            <ConcurrentBPartial />
            <ConcurrentCPartial />
            <div className="flex flex-wrap gap-2">
              <BumpButton name="concurrent-a" label="refetch a" testId="refresh-concurrent-a" />
              <BumpButton name="concurrent-b" label="refetch b" testId="refresh-concurrent-b" />
              <BumpButton name="concurrent-c" label="refetch c" testId="refresh-concurrent-c" />
            </div>
          </CardContent>
        </Card>

        <Card data-testid="section-any" className="mb-8 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">
              5. <InlineCode>&lt;WhenVisible&gt;</InlineCode>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-0">
            <div data-testid="any-spacer" className="h-[90vh]" aria-hidden="true" />
            <VisibilityDeferPartial />
          </CardContent>
        </Card>
      </main>
    )
  },
  { match: "/defer-demo" },
)
