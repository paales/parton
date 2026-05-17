"use client"

import React from "react"
import {
  _clearLatestNavigationError,
  _getLatestNavigationError,
  _subscribeNavigationError,
} from "./navigation-error.ts"

export function GlobalErrorBoundary(props: { children?: React.ReactNode }) {
  return <ErrorBoundary errorComponent={DefaultGlobalErrorPage}>{props.children}</ErrorBoundary>
}

/**
 * Subscribes to the global navigation-error stream and re-throws
 * during render so the nearest enclosing error boundary catches.
 *
 * This is how typed `NavigationError`s from `useNavigation().reload()`
 * / `.navigate()` surface in the UI: the per-call hook publishes via
 * `_publishNavigationError`, this component's `useSyncExternalStore`
 * fires, and the next render throws — caught by whatever boundary
 * the host has wrapped it in. Place it inside `<GlobalErrorBoundary>`
 * for app-wide capture, or at a tighter scope for localized recovery.
 *
 * The latest error is cleared synchronously before the throw, so a
 * boundary `reset()` that re-mounts this subtree starts fresh — no
 * stale-error loop.
 */
export function NavigationErrorBubbler(props: { children?: React.ReactNode }) {
  const error = React.useSyncExternalStore(
    _subscribeNavigationError,
    _getLatestNavigationError,
    () => null,
  )
  if (error) {
    _clearLatestNavigationError()
    throw error
  }
  return <>{props.children}</>
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
