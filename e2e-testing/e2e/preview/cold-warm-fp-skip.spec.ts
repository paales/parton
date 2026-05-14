import { expect, test } from "@playwright/test"

/**
 * Cold→warm fp-trailer round-trip under `yarn build && yarn preview`.
 *
 * Mirrors `e2e/cold-warm-fp-skip.spec.ts` (dev tier) — verifies the
 * fp-trailer infrastructure works against the production bundle too.
 *
 * The trailer ships as an HTML comment after `</html>` on the SSR
 * response, so this test starts cold via `page.goto("/magento")` to
 * exercise that path. RSC navigations (`<a>`-link clicks intercepted
 * by the Navigation API) don't currently carry their own cold→warm
 * trailer — only the initial SSR load does. A user lands on a route
 * via SSR, the trailer registers the warm fps, and subsequent
 * RSC-nav re-visits to that route fp-skip from then on. Per-RSC-nav
 * trailers are a possible follow-up; see `docs/notes/IDEAS.md`.
 */

test("re-visit to a route fp-skips on the very next nav after cold (prod build)", async ({ page }) => {
  const rscResponses: Array<{ url: string; size: number }> = []
  page.on("response", async (res) => {
    const ct = res.headers()["content-type"] ?? ""
    if (!ct.includes("text/x-component")) return
    try {
      const body = await res.body()
      rscResponses.push({ url: res.url(), size: body.byteLength })
    } catch {
      // ignore
    }
  })

  // Visit /magento (cold, SSR HTML — the trailer comment after </html>
  // is parsed on hydration, registering warm fps for the route's specs).
  await page.goto("/magento")
  await page.waitForSelector("[data-testid=product-grid]", { timeout: 15000 })
  await page.waitForFunction(
    () => typeof (window as any).__rsc_partial_refetch === "function",
    null,
    { timeout: 10000 },
  )

  // Clear the RSC-response log — we're interested only in what happens
  // AFTER the cold render commits and the trailer is applied.
  rscResponses.length = 0

  // Client-side nav away, then back. The away nav is just to remove
  // /magento's partials from the visible tree (they're parked by
  // keepalive).
  await page.getByRole("link", { name: /Pokemon$/ }).click()
  await page.waitForSelector("[data-testid=page-shell]", { timeout: 10000 })
  await page.waitForLoadState("networkidle")

  // Nav back to /magento. The trailer-registered warm fps for the
  // route's specs are in `_currentPageFingerprints`, so `?cached=` on
  // this RSC nav carries them. The server's fp computation lands on
  // those warm fps, shouldSkip=true, the body returns mostly
  // placeholders.
  await page.getByRole("link", { name: /Magento Store/ }).click()
  await page.waitForSelector("[data-testid=product-grid]", { timeout: 15000 })

  const magentoResponses = rscResponses.filter((r) => r.url.includes("/magento_.rsc"))
  expect(
    magentoResponses.length,
    `expected at least one /magento_.rsc response in ${JSON.stringify(rscResponses.map((r) => r.url))}`,
  ).toBeGreaterThan(0)

  // The return nav's response should be much smaller than a cold
  // render. Production bundle's cold magento is ~30 KB (minified +
  // tree-shaken); a successful fp-skip response is mostly
  // placeholders, well under half.
  const returnNav = magentoResponses[0]
  console.log(`return-to-magento (prod): ${returnNav.size} bytes`)
  expect(
    returnNav.size,
    `return-to-magento (${returnNav.size} bytes) is not much smaller than a cold render — ` +
      `fp-trailer round-trip may not be wired in prod`,
  ).toBeLessThan(20_000)
})
