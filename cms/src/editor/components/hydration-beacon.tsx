"use client"

/**
 * Invisible hydration beacon for server-rendered interactive regions.
 *
 * The editor's field form is rendered by a server component (refs
 * can't be used there), but its `<form action>` interception only
 * goes live once React hydrates this part of the tree. The beacon is
 * a client component placed INSIDE the region: its callback ref fires
 * at the commit that attaches it — the same commit that wires the
 * surrounding form — and stamps `data-hydrated` on itself. E2E specs
 * wait for `[data-testid=<testId>][data-hydrated]` before driving the
 * region, because interactions fired earlier hit inert SSR DOM.
 */
export function HydrationBeacon({ testId }: { testId: string }) {
  return <span hidden data-testid={testId} ref={(el) => el?.setAttribute("data-hydrated", "")} />
}
