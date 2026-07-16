/**
 * GraphQL introspection generator — the engine behind `parton gql`.
 *
 * Fetches a live endpoint's introspection and writes the gql.tada
 * `-env.d.ts` an app's backend module imports. Optionally scaffolds the
 * backend module itself (`graphqlBackend(...)`). Runs from any workspace
 * without that workspace depending on gql.tada: the loader + output
 * formatter come from `@gql.tada/internal`, which the framework owns.
 *
 *   generateBackend({ url, name, dir, headers, scaffold }) — programmatic
 *   runGqlGenerate(argv)                                   — CLI (parton gql)
 */

import { mkdir, writeFile, access } from "node:fs/promises"
import { join, resolve } from "node:path"
import { loadFromURL, outputIntrospectionFile } from "@gql.tada/internal"

/** Derive a backend name from an endpoint host when `--name` is omitted:
 *  the registrable label (`beta.pokeapi.co` → `pokeapi`,
 *  `graphcommerce.vercel.app` → `graphcommerce`). A convenience default —
 *  pass `--name` to be explicit. */
function deriveName(url) {
  const host = new URL(url).hostname
  const labels = host.split(".").filter(Boolean)
  if (labels.length <= 1) return labels[0] ?? "backend"
  // Drop the public suffix label(s) and take the one before them.
  return labels[labels.length - 2]
}

/** A generated env file matches `.prettierignore`'s `**\/*-env.d.ts`. */
function envFileName(name) {
  return `${name}-env.d.ts`
}

function scaffoldModule(name) {
  const endpointConst = `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_ENDPOINT`
  return `import { graphqlBackend } from "@parton/framework/graphql"
import type { introspection } from "./${envFileName(name)}"

export const ${endpointConst} = "__ENDPOINT__"

export const ${name} = graphqlBackend<{
  introspection: introspection
  // Map custom scalars to their TS types (e.g. DateTime: string). The
  // GraphQL built-in scalars are inferred — only override the custom ones.
  scalars: {}
}>({ endpoint: ${endpointConst} })

// The tag + client for mutations and direct \`client.request(doc)\` reads:
export const { graphql, client } = ${name}
export { readFragment } from "@parton/framework/graphql"
export type { ResultOf, FragmentOf, VariablesOf } from "@parton/framework/graphql"
`
}

/**
 * Fetch introspection from `url` and write `<dir>/<name>-env.d.ts`. When
 * `scaffold` is set and the module doesn't exist, also writes
 * `<dir>/<name>.ts`. Returns the paths written.
 */
export async function generateBackend({ url, name, dir = "src/app", headers, scaffold = false }) {
  const backendName = name ?? deriveName(url)
  const outDir = resolve(process.cwd(), dir)
  await mkdir(outDir, { recursive: true })

  const loader = loadFromURL({ url, name: backendName, headers })
  const { introspection } = await loader.load()
  const contents = outputIntrospectionFile(introspection, {
    fileType: ".d.ts",
    shouldPreprocess: true,
  })

  const envPath = join(outDir, envFileName(backendName))
  await writeFile(envPath, contents, "utf8")
  const written = [envPath]

  if (scaffold) {
    const modulePath = join(outDir, `${backendName}.ts`)
    const exists = await access(modulePath).then(
      () => true,
      () => false,
    )
    if (exists) {
      process.stdout.write(`  (skipped scaffold: ${modulePath} already exists)\n`)
    } else {
      await writeFile(modulePath, scaffoldModule(backendName).replace("__ENDPOINT__", url), "utf8")
      written.push(modulePath)
    }
  }

  return { name: backendName, written }
}

// ── CLI (parton gql) ────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { headers: {} }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--name") opts.name = argv[++i]
    else if (a === "--dir") opts.dir = argv[++i]
    else if (a === "--scaffold") opts.scaffold = true
    else if (a === "--header") {
      const raw = argv[++i] ?? ""
      const idx = raw.indexOf(":")
      if (idx < 0) throw new Error(`--header must be "Key: Value" (got ${JSON.stringify(raw)})`)
      opts.headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim()
    } else positional.push(a)
  }
  opts.url = positional[0]
  return opts
}

export async function runGqlGenerate(argv) {
  const opts = parseArgs(argv)
  if (!opts.url) {
    process.stderr.write(
      "Usage: parton gql <url> [--name <name>] [--dir <dir>] " +
        '[--header "Key: Value"]... [--scaffold]\n',
    )
    process.exit(1)
  }
  const headers = Object.keys(opts.headers).length ? opts.headers : undefined
  process.stdout.write(`Fetching introspection from ${opts.url}\n`)
  const { name, written } = await generateBackend({ ...opts, headers })
  for (const path of written) process.stdout.write(`Wrote ${path}\n`)
  process.stdout.write(`GraphQL backend "${name}" ready.\n`)
}
