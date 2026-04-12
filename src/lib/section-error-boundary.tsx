"use client";

import React from "react";

interface Props {
  sectionId: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Per-section error boundary.
 *
 * Wraps each section so a render failure in one section doesn't
 * crash the entire page. Shows an inline error card with a retry
 * button that triggers a navigation to re-fetch from the server.
 */
export class SectionErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  retry = () => {
    React.startTransition(() => {
      this.setState({ error: null });
      // Trigger a re-render from the server by replaying the current URL
      history.replaceState(null, "", window.location.href);
    });
  };

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            background: "#2a1a1a",
            border: "1px solid #5a2a2a",
            borderRadius: 12,
            padding: "1.25rem",
            marginBottom: "1rem",
          }}
        >
          <div style={{ color: "#f56565", fontWeight: 600, marginBottom: "0.5rem" }}>
            Section "{this.props.sectionId}" failed to render
          </div>
          {import.meta.env.DEV && (
            <pre
              style={{
                fontSize: "0.75rem",
                color: "#e88",
                whiteSpace: "pre-wrap",
                marginBottom: "0.75rem",
              }}
            >
              {this.state.error.message}
            </pre>
          )}
          <button
            type="button"
            onClick={this.retry}
            style={{
              background: "#5a2a2a",
              color: "#ededed",
              border: "1px solid #7a3a3a",
              padding: "0.4rem 0.8rem",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: "0.8rem",
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
