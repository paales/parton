"use client";

import type { ReactNode } from "react";
import { useNavigation } from "../../lib/partial-client.tsx";

/**
 * Selector-targeted nav link for the field panel's configuration tabs.
 *
 * The tab `<a href="/cms-edit?select=…&config=N">` switches which
 * config the right pane edits. Plain-anchor navigation runs the
 * editor route through a full streaming render — but
 * `cms-edit-fields` reads `?config=` via `getRequest()` (not
 * `getSearchParam`, to dodge the preview frame's scope-cell leak),
 * and `getRequest()` doesn't contribute to the structural
 * fingerprint. The server fp-matches the unchanged fingerprint and
 * emits a placeholder; the client keeps the old form on screen, so
 * the URL flips but the form doesn't.
 *
 * Routing the click through `nav.navigate(href, { selector:
 * "#cms-edit-fields" })` puts `cms-edit-fields` in the explicit-id
 * set on the server, which forces it to render fresh regardless of
 * the fingerprint — same trick `CmsEditTreeLink` uses for the tree
 * sidebar.
 */
export function CmsEditConfigTab({
  href,
  className,
  children,
  testId,
  active,
}: {
  href: string;
  className?: string;
  children: ReactNode;
  testId?: string;
  active: boolean;
}) {
  const nav = useNavigation();
  function onClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    ) {
      return;
    }
    e.preventDefault();
    void nav.navigate(href, {
      history: "push",
      selector: "#cms-edit-fields",
    });
  }
  return (
    <a
      href={href}
      onClick={onClick}
      className={className}
      data-testid={testId}
      data-active={active}
    >
      {children}
    </a>
  );
}
