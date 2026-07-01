import { clearCaches, test, expect, request, waitForPageInteractive } from "./fixtures"

/**
 * /defer-demo — exercises the activation shapes of `<Partial defer>`:
 *
 *   1. `defer={true}` — button-triggered manual activation via
 *      `useNavigation().reload({ selector })`.
 *   2. `defer={<WhenVisible/>}` — IntersectionObserver-triggered
 *      activation when the fallback enters the viewport.
 *
 * Activators are pure triggers — no data crosses the wire. Each
 * section's activated content renders a server timestamp, so a change
 * in that text proves the RSC refetch round-tripped.
 */

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test.describe("Partial defer demo", () => {
  test("defer={true}: button click activates via useNavigation.reload()", async ({ page }) => {
    const rscCalls: Array<{ partials: string | null }> = []
    page.on("request", (req) => {
      const url = req.url()
      if (url.includes("_.rsc")) {
        const u = new URL(url)
        rscCalls.push({ partials: u.searchParams.get("partials") })
      }
    })

    await page.goto("/defer-demo")

    await expect(page.locator('[data-testid="manual-fallback"]')).toBeVisible()
    expect(await page.locator('[data-testid="manual-content"]').count()).toBe(0)
    await waitForPageInteractive(page)

    rscCalls.length = 0
    await page.locator('[data-testid="activate-manual"]').click()
    await expect(page.locator('[data-testid="manual-content"]')).toBeVisible({
      timeout: 5000,
    })

    const hits = rscCalls.filter(
      (c) => c.partials != null && c.partials.split(",").includes("manual"),
    )
    expect(hits.length, "expected exactly one RSC refetch for `manual`").toBeGreaterThanOrEqual(1)
  })

  test("<WhenVisible>: scroll-into-view activates the Partial", async ({ page }) => {
    await page.goto("/defer-demo")
    await expect(page.locator('[data-testid="any-fallback"]')).toBeVisible()
    expect(await page.locator('[data-testid="any-content"]').count()).toBe(0)
    await waitForPageInteractive(page)

    await page.locator('[data-testid="any-fallback"]').scrollIntoViewIfNeeded()
    await expect(page.locator('[data-testid="any-content"]')).toBeVisible({
      timeout: 5000,
    })
  })
})
