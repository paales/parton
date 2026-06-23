"use client"

import React from "react"

export function GlobalErrorBoundary(props: { children?: React.ReactNode }) {
  return <ErrorBoundary errorComponent={DefaultGlobalErrorPage}>{props.children}</ErrorBoundary>
}

class ErrorBoundary extends React.Component<{
  children?: React.ReactNode
  errorComponent: React.FC<{ error: Error; reset: () => void }>
}> {
  state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  reset = () => {
    this.setState({ error: null })
  }

  render() {
    const error = this.state.error
    if (error) {
      return <this.props.errorComponent error={error} reset={this.reset} />
    }
    return this.props.children
  }
}

/**
 * Errors that are a benign consequence of fast navigation, not app
 * bugs. A superseding navigation tears the in-flight RSC Flight stream
 * mid-render ("Connection closed."), React can't finish a streamed
 * Suspense boundary, or a concurrent commit races the DOM
 * (`removeChild` / `insertBefore`). They should self-heal — the
 * superseding navigation's payload renders next — not strand the user
 * on the global error page until a refresh.
 */
export function isTransientNavError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === "AbortError") return true
  const m = error.message
  return (
    m.includes("Connection closed") ||
    m.includes("could not finish this Suspense boundary") ||
    m.includes("BodyStreamBuffer was aborted") ||
    m.includes("removeChild") ||
    m.includes("insertBefore")
  )
}

// Bound auto-recovery so a genuinely un-renderable payload (a tear with
// no superseding payload behind it) can't spin forever — past the
// budget the error falls through to the enclosing <GlobalErrorBoundary>.
const RECOVERY_WINDOW_MS = 3000
const MAX_RECOVERIES = 25

/**
 * Recovers from transient navigation stream tears WITHOUT unmounting
 * its host, so the live payload state + heartbeat that own it survive.
 * On a transient error it remounts its children (a fresh `generation`
 * key) — by which point the superseding navigation has set the current
 * payload, so the live page renders. Genuine (non-transient) errors,
 * and a tear that never settles within the budget, rethrow to the
 * enclosing <GlobalErrorBoundary>.
 *
 * Place it INSIDE the component that owns the payload state, around the
 * rendered payload root — not around that component itself, or a
 * recovery would remount the state and lose the live payload.
 */
export class NavigationErrorBoundary extends React.Component<
  { children?: React.ReactNode },
  { error: Error | null; generation: number }
> {
  state: { error: Error | null; generation: number } = { error: null, generation: 0 }
  private recoveries = 0
  private windowStart = 0

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    if (!isTransientNavError(error)) return // render() rethrows it
    const now = Date.now()
    if (now - this.windowStart > RECOVERY_WINDOW_MS) {
      this.windowStart = now
      this.recoveries = 0
    }
    if (++this.recoveries > MAX_RECOVERIES) return // give up → render() rethrows
    React.startTransition(() =>
      this.setState((s) => ({ error: null, generation: s.generation + 1 })),
    )
  }

  componentDidUpdate(prevProps: { children?: React.ReactNode }) {
    // A newer navigation set a fresh payload while we were erroring —
    // `children` is the rendered payload root, so a changed reference
    // means new content to try. Clear the error and render it; this
    // catches the case where the superseding payload lands a beat after
    // the tear, rather than waiting on the remount alone.
    if (this.state.error && prevProps.children !== this.props.children) {
      this.recoveries = 0
      this.setState({ error: null })
    }
  }

  render() {
    const { error } = this.state
    if (error) {
      // Transient + still within budget → render nothing this frame;
      // componentDidCatch has scheduled a remount with the superseding
      // payload. Otherwise the error is genuine (or unrecoverable) —
      // hand it up to <GlobalErrorBoundary>.
      if (isTransientNavError(error) && this.recoveries < MAX_RECOVERIES) return null
      throw error
    }
    return <React.Fragment key={this.state.generation}>{this.props.children}</React.Fragment>
  }
}

function DefaultGlobalErrorPage(props: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <head>
        <title>Error</title>
      </head>
      <body style={{ padding: "2rem", fontFamily: "system-ui" }}>
        <h1>Something went wrong</h1>
        <pre>{import.meta.env.DEV ? props.error.message : "(Unknown)"}</pre>
        <button type="button" onClick={() => React.startTransition(() => props.reset())}>
          Reset
        </button>
      </body>
    </html>
  )
}
