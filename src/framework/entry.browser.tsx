import {
  createFromReadableStream,
  createFromFetch,
  setServerCallback,
  createTemporaryReferenceSet,
  encodeReply,
} from "@vitejs/plugin-rsc/browser";
import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { rscStream } from "rsc-html-stream/client";
import type { RscPayload } from "./entry.rsc";
import { GlobalErrorBoundary } from "./error-boundary";
import { createRscRenderRequest } from "./request";
import { getCachedPartialIds } from "../lib/partial-client";

async function main() {
  let setPayload: (v: RscPayload) => void;
  let setPayloadRaw: (v: RscPayload) => void;

  const initialPayload = await createFromReadableStream<RscPayload>(rscStream);

  function BrowserRoot() {
    const [payload, setPayload_] = React.useState(initialPayload);

    React.useEffect(() => {
      setPayload = (v) => React.startTransition(() => setPayload_(v));
      setPayloadRaw = setPayload_;
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
    // Revalidate path: commit inside a transition so React holds the
    // current Suspense content visible while fresh content resolves,
    // instead of showing the fallback (which flushSync would do).
    const isRevalidate = url.searchParams.has("revalidate");
    const renderRequest = createRscRenderRequest(url.toString());

    // Streaming RSC consumption: createFromReadableStream resolves when the
    // root chunk arrives, with lazy refs for pending suspended subtrees.
    //
    // The server version-stamps each Suspense `key` per request (see
    // partial.tsx → streamVersion). When we commit the new payload, React
    // sees the version-stamped Suspense keys as NEW elements (different key
    // from the previous render), unmounts the old ones, and mounts fresh
    // boundaries — those display their fallbacks immediately and reveal
    // content as each lazy ref resolves. The surrounding tree (html/head/
    // body/nav) keeps stable keys and reconciles in place, so the page
    // shell stays mounted (no flash).
    //
    // flushSync with setPayloadRaw (not startTransition) is required:
    // transitions would hold back showing fallbacks for the still-pending
    // lazy refs.
    const response = await fetch(renderRequest);
    const payload = await createFromReadableStream<RscPayload>(response.body!);
    if (isRevalidate) {
      setPayload(payload);
    } else {
      flushSync(() => setPayloadRaw(payload));
    }
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
