import { test, expect } from "./fixtures"

/**
 * Static assets under `public/` — favicon.ico and friends.
 *
 * Vite's own dev-server middleware (`servePublicMiddleware`) and
 * `vite preview`'s asset middleware both serve `public/` BEFORE the
 * RSC handler's catch-all is installed (both `configureServer` and
 * `configurePreviewServer` register the framework's fetch handler as
 * a POST hook — see `docs/reference/intro.md` § Static assets). A
 * request for a file that actually exists under `public/` never
 * reaches the RSC pipeline at all; this suite covers the two cases
 * that DO reach it: a genuine miss (no file, no matching spec) and an
 * ordinary app route.
 */
test.describe("static assets", () => {
  test("favicon.ico: served by Vite's static layer, never the RSC pipeline", async ({
    page,
    baseURL,
  }) => {
    const res = await page.request.get(`${baseURL}/favicon.ico`)
    expect(res.status()).toBe(200)
    expect(res.headers()["content-type"]).toContain("image/x-icon")
    const body = await res.body()
    expect(body.length).toBeGreaterThan(0)
  })

  test("a static-root miss: cheap 404, not the full app shell", async ({ page, baseURL }) => {
    // No `public/` file and no spec's `match` covers this pathname —
    // `getRegisteredMatchPatterns()` (the same registry
    // `<NotFoundFallback>` consults) says so before any render runs,
    // so `entry/rsc.tsx` renders ONLY the bare `<NotFoundPage/>`
    // document, skipping the full `<Root/>` pass (page chrome,
    // GraphQL-backed sections, the CMS editor shell) entirely. The
    // response is still an HTML document with status 404 — the
    // narrow one, not the app's full page shell.
    const res = await page.request.get(`${baseURL}/this-path-has-no-spec-and-no-public-file.png`)
    expect(res.status()).toBe(404)
    const body = await res.text()
    expect(body).toContain('data-testid="not-found"')
    // The full page shell (`Root`'s wrapper div) never rendered.
    expect(body).not.toContain('data-testid="page-shell"')
  })

  test("an app route still renders normally", async ({ page, baseURL }) => {
    const res = await page.request.get(`${baseURL}/`)
    expect(res.status()).toBe(200)
    const body = await res.text()
    expect(body).toContain('data-testid="page-shell"')
  })
})
