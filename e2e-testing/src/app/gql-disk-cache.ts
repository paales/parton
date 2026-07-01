/**
 * Disk-backed record/replay for GraphQL QUERIES against live
 * third-party backends (PokeAPI, GraphCommerce).
 *
 * Why: the e2e suite runs dozens of workers that all fan out to the
 * same public endpoints. Public APIs rate-limit by IP (PokeAPI
 * answers 429 under repeated full-suite runs), and a 429 mid-spec is
 * indistinguishable from an app bug. The suite's query set is
 * deterministic, so the second-and-later runs never need the network:
 * every successful query response is recorded on disk keyed by
 * (endpoint, query, variables) and replayed on the next hit.
 *
 * Scope — queries only, decided by the document's own grammar (the
 * operation keyword), not by guessing: mutations pass through
 * untouched. Errors (including 429s) throw before the write, so only
 * successful responses are ever recorded.
 *
 * Only wrap clients whose backend serves IMMUTABLE reference data
 * (PokeAPI's versioned dataset). A stateful backend must stay live:
 * replaying a cart query recorded before a mutation would mask the
 * mutation's effect. That property comes from what the endpoint IS,
 * not from anything inspectable per-request — so it's the wrapping
 * call site's decision, made once per client.
 *
 * Off by default. The Playwright config exports `GQL_DISK_CACHE=1`
 * to the dev servers it spawns; a plain `yarn dev` stays live. The
 * store lives in `.gql-cache/` (gitignored) under the workspace cwd
 * — delete the folder to re-record.
 */

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

interface RequestClient {
  request<TResult, TVars extends Record<string, unknown>>(
    document: unknown,
    variables?: TVars,
  ): Promise<TResult>
}

const CACHE_DIR = process.env.GQL_CACHE_DIR ?? path.resolve(process.cwd(), ".gql-cache")

/** Stable text form of the document for keying/inspection. gql.tada
 *  documents are parsed DocumentNode ASTs at runtime; raw strings
 *  also satisfy graphql-request's overloads. */
function documentText(document: unknown): string {
  return typeof document === "string" ? document : JSON.stringify(document)
}

/** A document is replayable iff its operation is a `query` — read
 *  from the document itself (the AST's OperationDefinition, or the
 *  leading keyword of a raw string; shorthand `{ field }` documents
 *  are queries by definition). Anything unrecognisable passes
 *  through uncached. */
function isQueryDocument(document: unknown): boolean {
  if (typeof document === "string") {
    const lead = document.trimStart()
    return lead.startsWith("query") || lead.startsWith("{")
  }
  const definitions = (document as { definitions?: unknown })?.definitions
  if (!Array.isArray(definitions)) return false
  const operation = definitions.find(
    (d): d is { kind: string; operation: string } =>
      (d as { kind?: string })?.kind === "OperationDefinition",
  )
  return operation?.operation === "query"
}

/** In-flight dedup: concurrent identical cold queries share one
 *  network round-trip instead of racing the rate limiter. */
const inFlight = new Map<string, Promise<unknown>>()

/** HTTP status off a graphql-request ClientError, if present. */
function errorStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status
}

/**
 * Run the request, retrying on 429. A 429 is the server's own
 * explicit "come back later" — retrying after its `Retry-After` (or
 * a bounded backoff when the header is absent, as nginx's 429 page
 * omits it) is the response's defined semantics, not a guess. Any
 * other error propagates immediately.
 */
async function requestWithRateLimitRetry(
  client: RequestClient,
  document: unknown,
  variables?: Record<string, unknown>,
): Promise<unknown> {
  const backoffMs = [1000, 2000, 4000]
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.request(document, variables)
    } catch (err) {
      if (errorStatus(err) !== 429 || attempt >= backoffMs.length) throw err
      const retryAfter = (err as { response?: { headers?: Record<string, string> } }).response
        ?.headers?.["retry-after"]
      const waitMs = retryAfter ? Number(retryAfter) * 1000 : backoffMs[attempt]
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
}

export function withGqlDiskCache<C extends RequestClient>(client: C, endpoint: string): C {
  if (process.env.GQL_DISK_CACHE !== "1") return client

  const cachedRequest = async (
    document: unknown,
    variables?: Record<string, unknown>,
  ): Promise<unknown> => {
    if (!isQueryDocument(document)) return client.request(document, variables)
    const text = documentText(document)

    const key = createHash("sha256")
      .update(JSON.stringify([endpoint, text, variables ?? null]))
      .digest("hex")
    const file = path.join(CACHE_DIR, `${key}.json`)

    try {
      return JSON.parse(readFileSync(file, "utf8")).data
    } catch {
      // Miss (or torn concurrent write) — fall through to the network.
    }

    const pending = inFlight.get(key)
    if (pending) return pending

    const fetchAndRecord = (async () => {
      const data = await requestWithRateLimitRetry(client, document, variables)
      // Atomic write (temp + rename) so a concurrent reader never
      // parses a half-written file. mkdir per write, so deleting the
      // store while a server is running just means re-recording.
      mkdirSync(CACHE_DIR, { recursive: true })
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      writeFileSync(
        tmp,
        JSON.stringify({ endpoint, query: text, variables: variables ?? null, data }),
      )
      renameSync(tmp, file)
      return data
    })()
    inFlight.set(key, fetchAndRecord)
    try {
      return await fetchAndRecord
    } finally {
      inFlight.delete(key)
    }
  }

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "request") return cachedRequest
      return Reflect.get(target, prop, receiver)
    },
  }) as C
}
