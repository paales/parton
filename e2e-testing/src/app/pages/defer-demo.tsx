/**
 * /defer-demo — exercises the three shapes of `defer` plus
 * batched-activation, streaming/defer race, and concurrent-refetch
 * scenarios.
 *
 * Outer wrapper gates the route once; sub-specs render unconditionally
 * inside it.
 */

import { parton, type RenderArgs } from "@parton/framework"
import { WhenVisible } from "../components/when-visible.tsx"
import { WhenMounted } from "../components/when-mounted.tsx"
import { ActivateButton } from "../components/defer-demo-controls.tsx"
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
    selector: "#manual",
    defer: true,
    fallback: (
      <DormantFallback testId="manual-fallback">
        dormant — waiting for manual activation
      </DormantFallback>
    ),
  },
)

// Batched activation: two partials that each activate on mount fire in
// the same tick, so `enqueueRefetch`'s microtask coalescer folds them
// into ONE refetch (`?partials=batch-a,batch-b`).
function makeBatch(label: string) {
  return parton(
    async function BatchRender({}: RenderArgs) {
      return (
        <div data-testid={`${label}-content`}>
          <Timestamp prefix="activated at" />
        </div>
      )
    },
    {
      selector: `#${label}`,
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
    await new Promise((r) => setTimeout(r, 1500))
    return (
      <div data-testid="slow-content">
        <Timestamp prefix="slow stream resolved at" />
      </div>
    )
  },
  {
    selector: "#slow-stream",
    fallback: (
      <DormantFallback testId="slow-fallback">slow content streaming… (1.5s)</DormantFallback>
    ),
  },
)

export const RaceDeferPartial = parton(
  function RaceDeferRender({}: RenderArgs) {
    return (
      <div data-testid="race-defer-content">
        <Timestamp prefix="race defer activated at" />
      </div>
    )
  },
  {
    selector: "#race-defer",
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
    async function ConcurrentRender({}: RenderArgs) {
      await new Promise((r) => setTimeout(r, delayMs))
      return (
        <div data-testid={`concurrent-${label}`}>
          <strong>{label}</strong> ({delayMs}ms): {new Date().toISOString()}
        </div>
      )
    },
    {
      selector: `#concurrent-${label} .concurrent`,
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
    selector: "#any",
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
            <div>
              <ActivateButton partialId="manual" label="Activate manually" />
            </div>
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
              <ActivateButton
                partialId="concurrent-a"
                label="refetch a"
                testId="refresh-concurrent-a"
                streaming
              />
              <ActivateButton
                partialId="concurrent-b"
                label="refetch b"
                testId="refresh-concurrent-b"
                streaming
              />
              <ActivateButton
                partialId="concurrent-c"
                label="refetch c"
                testId="refresh-concurrent-c"
                streaming
              />
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
