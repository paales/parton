/**
 * Remote metadata endpoints — static concerns of the page-embed model.
 *
 * Embedding needs NO dedicated render route: a `<RemoteFrame>` fetches
 * an ORDINARY page URL as Flight (the embed headers — see
 * `lib/page-embed.ts`), so an app exposing one parton publishes a page
 * whose route renders just that parton. What remains here is the
 * static metadata the `parton add` CLI consumes:
 *
 *   OPTIONS  *                         → CORS preflight (204)
 *   GET      /__remote/manifest.json   → embeddable-page inventory
 *   GET      /__remote/types.d.ts      → author-provided types file
 *
 * Any other path returns `null` so the caller can fall through to
 * its normal page handler.
 *
 * The manifest lists every addressable spec; specs whose `match`
 * carries a STATIC pathname (a literal URLPattern — no params, no
 * wildcards) additionally advertise it as `path`: the page a typed
 * binding embeds. The classification reads the compiled pattern's
 * grammar, not a guess about intent — a pathname pattern without
 * URLPattern syntax IS a single fixed page.
 */

import { promises as fs } from "node:fs"
import { listSpecs } from "../lib/spec-catalog.ts"
import type { CompiledMatch } from "../lib/match.ts"

export interface RemoteHandlerOptions {
  /** Short app name. Appears in the manifest so generated bindings
   *  carry a stable identifier. */
  name: string
  /** Absolute filesystem path to the author's `remote-types.ts` (or
   *  any TypeScript file). The handler serves its raw contents at
   *  `/__remote/types.d.ts` so the CLI can copy them into the
   *  consumer's repo. Omit if the app doesn't expose typed
   *  capability bindings. */
  typesPath?: string
}

/** Permissive CORS for v1 — capability scoping is the trust boundary
 *  the host can rely on; embed fetches are `credentials: "omit"`. */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "*",
}

const MANIFEST_PATH = "/__remote/manifest.json"
const TYPES_PATH = "/__remote/types.d.ts"

export interface RemoteManifestSpec {
  /** Canonical spec id (the first refetch label). */
  selector: string
  /** PascalCase export name the CLI will use in generated bindings. */
  exportName: string
  /** Refetch labels (first is `selector`). */
  labels: string[]
  /** The embeddable page path for this spec — its `match`'s static
   *  pathname — or null when the spec has no single fixed page (no
   *  match, params, wildcards). The CLI generates bindings only for
   *  specs with a path. */
  path: string | null
  /** Type name in the served `types.d.ts`, or null if the spec
   *  doesn't declare a capability. */
  capabilityType: string | null
}

export interface RemoteManifest {
  name: string
  origin: string
  specs: RemoteManifestSpec[]
}

/** URLPattern pathname syntax — `:name` params, `*` wildcards, groups,
 *  and modifiers. A pathname pattern containing none of these is a
 *  literal path (one fixed page). */
function staticPathOf(match: CompiledMatch | undefined): string | null {
  const pathname = match?.urlPattern?.pathname
  if (!pathname) return null
  return /[:*?+(){}]/.test(pathname) ? null : pathname
}

export function buildRemoteManifest(name: string, origin: string): RemoteManifest {
  const specs = listSpecs()
    .filter((s) => s.addressable !== false)
    .map<RemoteManifestSpec>((s) => ({
      selector: s.id,
      exportName: pascalCase(s.id),
      labels: s.labels,
      path: staticPathOf(s.match),
      capabilityType: s.capabilityType ?? null,
    }))
    .sort((a, b) => a.selector.localeCompare(b.selector))
  return { name, origin, specs }
}

function pascalCase(input: string): string {
  return input
    .split(/[-_/.\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")
}

export function createRemoteHandler(
  opts: RemoteHandlerOptions,
): (request: Request) => Promise<Response | null> {
  return async function remoteHandler(request: Request): Promise<Response | null> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...CORS_HEADERS, "access-control-max-age": "600" },
      })
    }

    const url = new URL(request.url)

    if (url.pathname === MANIFEST_PATH) {
      const manifest = buildRemoteManifest(opts.name, url.origin)
      return new Response(JSON.stringify(manifest, null, 2), {
        status: 200,
        headers: {
          "content-type": "application/json;charset=utf-8",
          ...CORS_HEADERS,
        },
      })
    }

    if (url.pathname === TYPES_PATH) {
      if (!opts.typesPath) {
        return new Response("// no types declared by this remote\n", {
          status: 200,
          headers: {
            "content-type": "text/plain;charset=utf-8",
            ...CORS_HEADERS,
          },
        })
      }
      try {
        const body = await fs.readFile(opts.typesPath, "utf8")
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "text/plain;charset=utf-8",
            ...CORS_HEADERS,
          },
        })
      } catch (err) {
        return new Response(`// failed to read ${opts.typesPath}: ${(err as Error).message}\n`, {
          status: 500,
          headers: {
            "content-type": "text/plain;charset=utf-8",
            ...CORS_HEADERS,
          },
        })
      }
    }

    return null
  }
}
