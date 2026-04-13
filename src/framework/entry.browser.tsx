import {
  createFromReadableStream,
  createFromFetch,
  setServerCallback,
  createTemporaryReferenceSet,
  encodeReply,
} from "@vitejs/plugin-rsc/browser";
import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { rscStream } from "rsc-html-stream/client";
import type { RscPayload } from "./entry.rsc";
import { GlobalErrorBoundary } from "./error-boundary";
import { createRscRenderRequest } from "./request";
import { getCachedPartialIds } from "../lib/partial-client";

async function main() {
  let setPayload: (v: RscPayload) => void;

  const initialPayload = await createFromReadableStream<RscPayload>(rscStream);

  function BrowserRoot() {
    const [payload, setPayload_] = React.useState(initialPayload);

    React.useEffect(() => {
      setPayload = (v) => React.startTransition(() => setPayload_(v));
    }, [setPayload_]);

    React.useEffect(() => {
      return listenNavigation(() => fetchRscPayload());
    }, []);

    return payload.root;
  }

  async function fetchRscPayload(overrideUrl?: string) {
    // Tell the server which partials are already cached so it can skip them.
    // If the caller already set ?cached= (e.g., usePartial excluding the
    // target partial), respect that instead of overwriting with the full list.
    const url = new URL(overrideUrl ?? window.location.href);
    if (!url.searchParams.has("cached")) {
      const cachedIds = getCachedPartialIds();
      if (cachedIds.length > 0) {
        url.searchParams.set("cached", cachedIds.join(","));
      }
    }
    const renderRequest = createRscRenderRequest(url.toString());
    const payload = await createFromFetch<RscPayload>(fetch(renderRequest));
    setPayload(payload);
  }

  // Allow usePartial() to trigger partial-specific refetches.
  // Uses window directly to avoid module instance duplication between
  // the browser entry bundle and "use client" component bundles.
  (window as any).__rsc_partial_refetch = (url: string) =>
    fetchRscPayload(url);

  setServerCallback(async (id, args) => {
    const temporaryReferences = createTemporaryReferenceSet();
    // Include cached partial fingerprints so the server can skip
    // unchanged partials after a server action (same as navigation).
    const actionUrl = new URL(window.location.href);
    const cachedIds = getCachedPartialIds();
    if (cachedIds.length > 0) {
      actionUrl.searchParams.set("cached", cachedIds.join(","));
    }
    const renderRequest = createRscRenderRequest(actionUrl.toString(), {
      id,
      body: await encodeReply(args, { temporaryReferences }),
    });
    const payload = await createFromFetch<RscPayload>(fetch(renderRequest), {
      temporaryReferences,
    });

    setPayload(payload);
    const { ok, data } = payload.returnValue!;
    if (!ok) throw data;
    return data;
  });

  const browserRoot = (
    <React.StrictMode>
      <GlobalErrorBoundary>
        <BrowserRoot />
      </GlobalErrorBoundary>
    </React.StrictMode>
  );

  if ("__NO_HYDRATE" in globalThis) {
    createRoot(document).render(browserRoot);
  } else {
    hydrateRoot(document, browserRoot, {
      formState: initialPayload.formState,
    });
  }

  if (import.meta.hot) {
    import.meta.hot.on("rsc:update", () => {
      fetchRscPayload();
    });
  }
}

function listenNavigation(onNavigation: () => void) {
  window.addEventListener("popstate", onNavigation);

  const oldPushState = window.history.pushState;
  window.history.pushState = function (...args) {
    const res = oldPushState.apply(this, args);
    onNavigation();
    return res;
  };

  const oldReplaceState = window.history.replaceState;
  window.history.replaceState = function (...args) {
    const res = oldReplaceState.apply(this, args);
    onNavigation();
    return res;
  };

  function onClick(e: MouseEvent) {
    const link = (e.target as Element).closest("a");
    if (
      link &&
      link instanceof HTMLAnchorElement &&
      link.href &&
      (!link.target || link.target === "_self") &&
      link.origin === location.origin &&
      !link.hasAttribute("download") &&
      e.button === 0 &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey &&
      !e.defaultPrevented
    ) {
      e.preventDefault();
      history.pushState(null, "", link.href);
    }
  }
  document.addEventListener("click", onClick);

  return () => {
    document.removeEventListener("click", onClick);
    window.removeEventListener("popstate", onNavigation);
    window.history.pushState = oldPushState;
    window.history.replaceState = oldReplaceState;
  };
}

main();
