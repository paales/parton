"use client";

export function BareRefetchButton() {
  return (
    <div style={{ display: "flex", gap: "0.5rem" }}>
      <button
        type="button"
        data-testid="refetch-full"
        onClick={() => {
          const handler = (window as any).__rsc_partial_refetch as
            | ((url: string) => Promise<void>)
            | undefined;
          if (!handler) return;
          const url = new URL(window.location.href);
          url.searchParams.set("n", String(Date.now()));
          handler(url.toString());
        }}
      >
        Refetch (streaming)
      </button>
      <button
        type="button"
        data-testid="refetch-cache"
        onClick={() => {
          const handler = (window as any).__rsc_partial_refetch as
            | ((url: string) => Promise<void>)
            | undefined;
          if (!handler) return;
          const url = new URL(window.location.href);
          url.searchParams.set("n", String(Date.now()));
          // Trigger cache-mode refetch for all partials in "bare" namespace.
          // Matches the real flush() behavior: when client cache is empty,
          // request every partial so we can populate the cache.
          url.searchParams.set(
            "partials",
            "bare/head,bare/stage-1,bare/stage-2,bare/stage-3",
          );
          handler(url.toString());
        }}
      >
        Refetch (cache)
      </button>
    </div>
  );
}
