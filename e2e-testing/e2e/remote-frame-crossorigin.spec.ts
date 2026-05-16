import { expect, request, test } from "./fixtures"

/**
 * /remote-frame-crossorigin-demo — true cross-origin `<RemoteFrame>`.
 *
 * The remote app (`e2e-magento`) must be running on port 5181 in
 * parallel with the host (`e2e-testing` on 5173). The Playwright
 * web-server config starts the host but not the remote — if the
 * remote isn't up, these tests skip cleanly with a clear error.
 */

const REMOTE_ORIGIN = "http://localhost:5181"

test.beforeAll(async () => {
  // Skip the suite if e2e-magento isn't running. The user can
  // start it with `yarn dev:magento` in a separate terminal.
  const ctx = await request.newContext()
  try {
    const probe = await ctx.get(`${REMOTE_ORIGIN}/__remote/magento-greeting`, {
      timeout: 2000,
    })
    if (!probe.ok()) test.skip(true, "e2e-magento returned non-2xx")
  } catch {
    test.skip(true, `e2e-magento not running at ${REMOTE_ORIGIN}; run yarn dev:magento`)
  } finally {
    await ctx.dispose()
  }
})

test.beforeEach(async ({ baseURL }) => {
  const ctx = await request.newContext()
  await ctx.get(`${baseURL ?? "http://localhost:5173"}/__test/clear-caches?all=1`)
  await ctx.dispose()
})

test("host renders cross-origin magento-greeting", async ({ page }) => {
  await page.goto("/remote-frame-crossorigin-demo")
  await expect(page.getByTestId("rfxd-header")).toBeVisible({ timeout: 2000 })

  // Both cross-origin frames arrive after their respective delays.
  await expect(page.getByTestId("magento-greeting")).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId("magento-stocks")).toBeVisible({ timeout: 5000 })

  // The greeting card carries text identifying its origin.
  await expect(page.getByTestId("magento-greeting")).toContainText("e2e-magento")
})

test("cross-origin remote endpoint returns Flight + snapshot trailer", async ({
  request,
}) => {
  const response = await request.get(`${REMOTE_ORIGIN}/__remote/magento-greeting`)
  expect(response.status()).toBe(200)
  expect(response.headers()["content-type"]).toMatch(/^text\/x-component/)
  // CORS header for browser fetches.
  expect(response.headers()["access-control-allow-origin"]).toBe("*")

  // Buffer the response and look for the snapshot trailer marker.
  const bytes = new Uint8Array(await response.body().then((b) => b.buffer))
  const marker = new Uint8Array([
    0xff, 0xfe,
    ...new TextEncoder().encode("snapshot"),
    0xfd, 0xfc,
  ])
  let foundAt = -1
  for (let i = 0; i <= bytes.length - marker.length; i++) {
    let match = true
    for (let j = 0; j < marker.length; j++) {
      if (bytes[i + j] !== marker[j]) {
        match = false
        break
      }
    }
    if (match) {
      foundAt = i
      break
    }
  }
  expect(foundAt, "snapshot trailer marker must be present").toBeGreaterThanOrEqual(0)
})
