/**
 * `<RemoteFrame>` — server-rendered frame from a remote origin.
 *
 * Fetches Flight bytes from another endpoint (same-origin in v1;
 * cross-origin once CSP / capability scoping land), pipes them
 * through the row-level rewriter, decodes the result, and returns
 * the tree as JSX. The outer Flight encoder serializes the
 * decoded subtree into the host's response, so Suspense pacing
 * inside the remote payload streams through to the client.
 *
 * Both the cache and `<RemoteFrame>` are consumers of the same
 * `flight-rewrite` primitive — wire-level stitching is the
 * framework's foundational composition mechanism. The cache passes
 * `passthroughRewriter`; `<RemoteFrame>` passes a `moduleRefRewriter`
 * for cross-origin paths.
 *
 * Place inside a Suspense boundary if the remote may be slow:
 *
 *   <Suspense fallback={<Spinner />}>
 *     <RemoteFrame src="/__remote/payment-form" parent={parent} />
 *   </Suspense>
 *
 * Wire format of the remote endpoint: a bare React element encoded
 * with `renderToReadableStream`. No Root, no wrapper object — the
 * decoded value IS the JSX to render here.
 */

import type { ReactNode } from "react"
import { createFromReadableStream } from "./flight-runtime.ts"
import {
  composeRewriters,
  moduleRefRewriter,
  passthroughRewriter,
  rewriteFlightStream,
  type RowRewriter,
} from "./flight-rewrite.ts"
import type { PartialCtx } from "./partial-context.ts"
import { registerPartial } from "./partial-registry.ts"
import { parseSnapshotTrailer } from "./snapshot-trailer.ts"
import { getRequest } from "../runtime/context.ts"
import {
  CAPABILITY_HEADER,
  encodeCapability,
  type Capability,
} from "../runtime/capability.ts"

export interface RemoteFrameProps {
  /** Absolute URL or same-origin path of the remote Flight endpoint. */
  src: string
  /** Host `PartialCtx`. Threaded through normal placement; the
   *  remote's render happens in its own process scope so this isn't
   *  forwarded over the wire, but the prop keeps the JSX call site
   *  consistent with other partons. */
  parent: PartialCtx
  /** Extra rewriter applied to every Flight row from the remote.
   *  Compose with the module-ref rewrite (auto-derived from `src`
   *  origin when `rewriteModuleRefs` is omitted or `true`). */
  rewriter?: RowRewriter
  /** Controls module-ref rewriting:
   *  - `true` / omitted: relative paths (`./X.tsx`) and absolute
   *    server paths (`/src/X.tsx`) are rewritten to absolute URLs
   *    at the remote origin so the host's browser can dynamically
   *    import them.
   *  - `false`: pass through unchanged. Use when the remote already
   *    emits absolute URLs in its module refs.
   *  - `(path) => path`: custom rewrite. */
  rewriteModuleRefs?: boolean | ((path: string) => string)
  /** Optional headers to send on the remote fetch. Composed
   *  with the capability header (the capability wins on collision). */
  headers?: Record<string, string>
  /** Host-declared scope the remote can read. Flat record of
   *  JSON-serializable values; serialized as the
   *  `x-parton-capability` header. The remote endpoint reads it
   *  into an ALS context and exposes via `getCapability()` to
   *  rendering specs. The remote sees ONLY what's declared
   *  here — the host's cookies don't leak (the fetch is
   *  `credentials: "omit"`). */
  capability?: Capability
}

function defaultModuleRewrite(srcOrigin: string): (path: string) => string {
  return (path) => {
    // Already-absolute URLs and bare package specifiers: leave alone.
    if (path.startsWith("http://") || path.startsWith("https://")) return path

    // Dev-mode filesystem-absolute paths (`/@fs/Users/...`). Both
    // host and remote run on the same machine in development, so
    // either process can serve the same path. Adding the remote
    // origin would actually break the host's vite-rsc plugin —
    // it rejects cross-origin URLs as invalid client references.
    // For shared framework modules (PartialErrorBoundary etc.)
    // the host can resolve `/@fs/...framework/...` against its own
    // bundle. Leaving these alone makes dev "just work".
    //
    // Production cross-origin is a different shape entirely (the
    // remote emits hashed asset URLs at its CDN; CORS on the
    // bundle assets lets the host browser load them). Authors
    // who need that can override via the `rewriteModuleRefs`
    // prop.
    if (path.startsWith("/@fs/") || path.startsWith("/@id/")) return path

    if (path.startsWith("./") || path.startsWith("../") || path.startsWith("/")) {
      try {
        return new URL(path, srcOrigin).href
      } catch {
        return path
      }
    }
    return path
  }
}

/** True iff `src` is an absolute URL (different origin possible). */
function isAbsoluteUrl(src: string): boolean {
  return src.startsWith("http://") || src.startsWith("https://")
}

export async function RemoteFrame({
  src,
  parent: _parent,
  rewriter,
  rewriteModuleRefs,
  headers,
  capability,
}: RemoteFrameProps): Promise<ReactNode> {
  // Resolve `src` to an absolute URL. `fetch` in the server runtime
  // doesn't accept bare-path inputs — and we need the origin
  // anyway to decide whether module-ref rewriting applies.
  const wasRelative = !isAbsoluteUrl(src)
  const absoluteSrc = wasRelative
    ? new URL(src, getRequest().url).href
    : src

  const requestHeaders: Record<string, string> = { ...(headers ?? {}) }
  if (capability !== undefined) {
    requestHeaders[CAPABILITY_HEADER] = encodeCapability(capability)
  }

  // `credentials: "omit"` is the trust-boundary teeth: even on
  // same-origin fetches the host's cookies do NOT leak to the
  // remote. The only host context the remote sees is what was
  // explicitly forwarded via `capability`.
  const response = await fetch(absoluteSrc, {
    headers: requestHeaders,
    credentials: "omit",
  })
  if (!response.ok || !response.body) {
    throw new Error(
      `RemoteFrame: fetch failed for ${absoluteSrc} (status ${response.status})`,
    )
  }

  // Buffer-then-split: read the full response, separate Flight
  // bytes from the snapshot trailer. Losing within-remote
  // streaming is the cost; gaining unified addressing across the
  // host/remote boundary is the prize. See `snapshot-trailer.ts`
  // for the trade-off discussion.
  const fullBuffer = new Uint8Array(await response.arrayBuffer())
  const { flightBytes, snapshots } = parseSnapshotTrailer(fullBuffer)

  // Register the remote's snapshots in the host's request
  // registry — selector-based refetch can now find these ids.
  // Stamp `source` so `partialFromSnapshot` routes the refetch
  // back to the remote origin via a fresh `<RemoteFrame>` rather
  // than trying to look up the spec in the local catalog (which
  // may not have it in true cross-origin deployments).
  if (snapshots) {
    const sourceOrigin = new URL(absoluteSrc).origin
    for (const [id, snap] of Object.entries(snapshots)) {
      registerPartial(id, {
        ...snap,
        source: {
          kind: "remote",
          origin: sourceOrigin,
          capability: capability as Record<string, unknown> | undefined,
        },
      })
    }
  }

  // Auto-derive module rewrite policy from `src`:
  // - Relative `src` (same-origin): no rewrite needed; host's bundle
  //   already knows the modules.
  // - Absolute `src` (cross-origin): default to rewriting relative
  //   module paths to the remote origin so the host browser can
  //   import them.
  const transform: ((path: string) => string) | null =
    rewriteModuleRefs === false
      ? null
      : typeof rewriteModuleRefs === "function"
        ? rewriteModuleRefs
        : wasRelative
          ? null
          : defaultModuleRewrite(new URL(absoluteSrc).origin)

  const moduleRw: RowRewriter =
    transform != null ? moduleRefRewriter(transform) : passthroughRewriter

  const pipeline: RowRewriter =
    rewriter != null ? composeRewriters(moduleRw, rewriter) : moduleRw

  const flightStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(flightBytes)
      controller.close()
    },
  })
  const rewrittenStream = rewriteFlightStream(flightStream, pipeline)
  return await createFromReadableStream<ReactNode>(rewrittenStream)
}
