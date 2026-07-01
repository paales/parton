import { clearCaches, expect, request, test, waitForPageInteractive } from "./fixtures"

/**
 * /remote-frame-demo — `<RemoteFrame>` integration coverage.
 *
 * Covers:
 *  - Host chrome paints before any remote arrives.
 *  - Multiple remotes stream into the page in parallel (slower
 *    ones don't gate faster ones).
 *  - A `"use client"` component inside a remote spec hydrates and
 *    is interactive in the host's browser.
 *  - A remote spec with `cache: { maxAge }` returns from cache on
 *    the second fetch.
 *  - Selector-based refetch updates the affected remote's content.
 */

test.beforeEach(async ({ baseURL }) => {
  await clearCaches(baseURL)
})

test("host chrome paints before any remote arrives", async ({ page }) => {
  await page.goto("/remote-frame-demo", { waitUntil: "commit" })

  // Header + controls + footer are in the host's first stream chunk;
  // remote bodies arrive later via SSR Suspense reveals.
  await expect(page.getByTestId("rfd-header")).toBeVisible({ timeout: 2000 })
  await expect(page.getByTestId("rfd-controls")).toBeVisible({ timeout: 2000 })
  await expect(page.getByTestId("rfd-footer")).toBeVisible({ timeout: 2000 })

  // The remote-slow card (1000ms) should arrive eventually.
  await expect(page.getByTestId("remote-slow")).toBeVisible({ timeout: 5000 })
})

test("multiple remotes stream in parallel (slow doesn't gate fast)", async ({ page }) => {
  await page.goto("/remote-frame-demo", { waitUntil: "commit" })

  await page.waitForSelector('[data-testid="remote-fast"]', { timeout: 5000 })
  await page.waitForSelector('[data-testid="remote-slow"]', { timeout: 10000 })

  // Parallelism from the remotes' own render intervals: each card
  // stamps `data-started-at` / `data-finished-at` (server clock,
  // around its awaited delay — fast 200ms, slow 1000ms). Rendered in
  // parallel means the intervals OVERLAP: slow must have started
  // before fast finished. A pipeline that serialized the remote
  // fetches would start slow only after fast (and mid) completed.
  // `.first()` — during a Suspense re-commit (heartbeat re-render)
  // React transiently keeps the prior children hidden alongside the
  // incoming copy, so the testid can match twice with identical
  // stamps. Either copy answers the interval question.
  const read = async (testid: string) => {
    const el = page.getByTestId(testid).first()
    return {
      started: Number(await el.getAttribute("data-started-at")),
      finished: Number(await el.getAttribute("data-finished-at")),
    }
  }
  const fast = await read("remote-fast")
  const slow = await read("remote-slow")
  expect(
    slow.started,
    `slow must start before fast finishes (parallel); fast=${JSON.stringify(fast)} slow=${JSON.stringify(slow)}`,
  ).toBeLessThan(fast.finished)
})

test("client component inside a remote spec hydrates and is interactive", async ({ page }) => {
  await page.goto("/remote-frame-demo")
  await waitForPageInteractive(page)

  // Wait for the remote that contains ClickCounter.
  await page.waitForSelector('[data-testid="remote-counter-mount"]', {
    timeout: 5000,
  })

  // Scope the ClickCounter query to the remote-counter mount — the
  // cached-region demo has its own copy and we don't want to grab it.
  const counter = page
    .getByTestId("remote-counter-mount")
    .locator('[data-testid="click-counter"][data-hydrated]')

  await expect(counter).toHaveText(/clicked 0/, { timeout: 5000 })
  await counter.click()
  await expect(counter).toHaveText(/clicked 1/)
  await counter.click()
  await expect(counter).toHaveText(/clicked 2/)
})

test("cached remote spec: second direct fetch replays the stored render", async ({ request }) => {
  // The spec renders an ISO timestamp AFTER its 500ms of awaited
  // work. A cache hit replays the stored Flight bytes, so the second
  // fetch must carry the SAME timestamp — the direct signal the work
  // didn't re-run (wall-clock comparisons only correlate with it).
  const iso = /\d{4}-\d{2}-\d{2}T[\d:.]+Z/
  const coldBody = await (await request.get("/__remote/remote-cached")).text()
  const coldStamp = coldBody.match(iso)?.[0]
  expect(coldStamp, "cold render must carry a timestamp").toBeDefined()

  const warmBody = await (await request.get("/__remote/remote-cached")).text()
  expect(warmBody.match(iso)?.[0], "warm fetch must replay the stored timestamp").toBe(coldStamp)
})

test("refresh button updates a remote frame's timestamp", async ({ page }) => {
  // Validates the unified-addressing loop closed by the snapshot
  // trailer (`snapshot-trailer.ts`): the remote endpoint ships
  // PartialBoundary snapshots as a trailing JSON segment after
  // its Flight bytes. The host's <RemoteFrame> parses the trailer
  // and re-registers each snapshot in the host's request registry.
  // `nav.reload({selector: "remote-fast"})` then finds the id and
  // routes through the normal cache-mode refetch path — in same-
  // origin v1 the refetch hits the host's local copy of the spec
  // (the catalog has it). v2 cross-origin will need a
  // `source: "remote:<origin>"` annotation to route refetches
  // back to the remote endpoint.
  await page.goto("/remote-frame-demo")
  await waitForPageInteractive(page)
  await page.waitForSelector('[data-testid="remote-fast"]', { timeout: 5000 })

  const card = page.getByTestId("remote-fast")
  const initialText = await card.textContent()

  await page.locator('[data-testid="rfd-refresh-remote-fast"][data-hydrated]').click()

  await expect
    .poll(async () => (await card.textContent()) !== initialText, {
      timeout: 5000,
    })
    .toBe(true)
})

test("page navigation re-fetches all remote frames with fresh content", async ({ page }) => {
  await page.goto("/remote-frame-demo")
  await page.waitForSelector('[data-testid="remote-fast"]', { timeout: 5000 })
  const firstText = await page.getByTestId("remote-fast").textContent()

  // Full navigation re-runs the host's render which re-fetches the
  // remote (the remote spec has no cache, so each fetch is fresh).
  // Validates the end-to-end pipeline works across navigation.
  await page.goto("/remote-frame-demo?bust=" + Date.now())
  await page.waitForSelector('[data-testid="remote-fast"]', { timeout: 5000 })
  const secondText = await page.getByTestId("remote-fast").textContent()

  expect(secondText).not.toBe(firstText)
})
