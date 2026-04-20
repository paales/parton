"use client";

import { useNavigation } from "../../lib/partial-client.tsx";

/**
 * Button that navigates a named frame to a URL. Used from INSIDE a
 * frame's content — `frame` prop is optional; when omitted,
 * `useNavigation()` defaults to the ambient frame.
 */
export function FrameNavigateButton({
  frame: frameName,
  url,
  label,
  testId,
}: {
  frame?: string;
  url: string;
  label: string;
  testId?: string;
}) {
  const nav = useNavigation(frameName);
  return (
    <button
      type="button"
      data-testid={testId ?? `frame-nav-${nav.name ?? "window"}`}
      onClick={() => void nav.navigate(url)}
    >
      {label}
    </button>
  );
}

/**
 * Button that calls `updateCurrentEntry` to attach frame-state
 * to the current history entry. Used in the demo to show the state
 * readout picking up what we wrote.
 */
export function UpdateEntryStateButton({
  frame: frameName,
  patch,
  label,
  testId,
}: {
  frame?: string;
  patch: Record<string, unknown>;
  label: string;
  testId?: string;
}) {
  const nav = useNavigation(frameName);
  return (
    <button
      type="button"
      data-testid={testId ?? `update-entry-${nav.name ?? "window"}`}
      onClick={() => nav.updateCurrentEntry(patch)}
    >
      {label}
    </button>
  );
}
