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
  let setPayloadRaw: (v: RscPayload) => void;

  const initialPayload = await createFromReadableStream<RscPayload>(rscStream);

  function BrowserRoot() {
    const [payload, setPayload_] = React.useState(initialPayload);

    React.useEffect(() => {
      setPayload = (v) => React.startTransition(() => setPayload_(v));
      setPayloadRaw = setPayload_;
    }, [setPayload_]);

    React.useEffect(() => {
      return listenNavigation((url) => fetchRscPayload(url));
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
    // Suspense keys are bare partial ids — React reconciles each
    // boundary in place across refetches. The two commit paths differ
    // only in how React treats pending children on the client:
    //
    //   setPayload (default, wraps in startTransition): React holds
    //     the current UI visible until the new content is fully
    //     ready. No Suspense fallback flash, no per-chunk streaming.
    //     Good for "just swap values" UX like a cart badge or live
    //     price (pair with `isPending` on the trigger).
    //
    //   setPayloadRaw (opt-in via ?disableTransition=1): plain post-
    //     await setState, outside any transition. React 19 shows
    //     Suspense fallbacks for pending children and commits Flight
    //     chunks as they arrive, giving per-row progressive streaming.
    //     Good for search / filter results where per-row reveal
    //     improves perceived latency.
    const disableTransition = url.searchParams.has("disableTransition");
    const renderRequest = createRscRenderRequest(url.toString());
    const response = await fetch(renderRequest);
    const payload = await createFromReadableStream<RscPayload>(response.body!);
    if (disableTransition) {
      setPayloadRaw(payload);
    } else {
      setPayload(payload);
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

import { consumeSilentFlag } from "./silent-replace.ts";

function listenNavigation(onNavigation: (url: string) => Promise<void>) {
  const handler = (event: NavigateEvent) => {
    if (!event.canIntercept) return;
    if (event.hashChange || event.downloadRequest !== null) return;
    if (event.formMethod === "POST") return;
    // `window.location.reload()` fires a navigate event with
    // `navigationType: "reload"` that the browser *can* intercept as
    // same-document. Intercepting defeats the whole point of a reload
    // (it re-runs against the existing module state). Pass it through
    // so the browser does a real cross-document reload.
    if (event.navigationType === "reload") return;
    // Silent URL updates (LoadMore's ?pages=, SearchInput's ?q= in URL
    // mode) flip a short-lived flag via `silentReplace()`. When set, we
    // skip the intercept so the URL updates for bookmarkability but no
    // server round-trip fires.
    if (consumeSilentFlag()) return;

    event.intercept({
      handler: () => onNavigation(event.destination.url),
    });
  };

  navigation.addEventListener("navigate", handler);
  return () => navigation.removeEventListener("navigate", handler);
}

main();
