import { expect, test } from "./fixtures"

/**
 * Regression: `getServerNavigation().navigate(url)` ships a `url`
 * trailer that the client applies via `history.replaceState`. The
 * intent (per the comment on `applyStandardTrailers` in
 * `segment-trailers-client.ts`) is to update the browser URL bar
 * silently — the rendered content already arrived in the action
 * response, so a fresh GET for the new URL is redundant.
 *
 * Observed 2026-05-20: the `replaceState` call DOES fire a navigate
 * event on the Navigation API, the framework's nav handler picks it
 * up, and a fresh full-route GET fires for the post-trailer URL. One
 * Push URL click → one POST (the action) + one redundant GET. The
 * GET should not happen.
 *
 * This spec drives the streaming-demo "Push URL" button and asserts
 * that only the action POST fires — no follow-up GET for the new
 * `?seq=` URL.
 */

test("server-pushed URL trailer applies silently — no redundant GET fires", async ({
  page,
}) => {
  const rscRequests: Array<{ url: string; method: string }> = []
  page.on("request", (req) => {
    const url = req.url()
    if (!url.includes("_.rsc")) return
    // Ignore the heartbeat's streaming connection — it's intentionally
    // long-lived and unrelated to the action's URL push.
    const u = new URL(url)
    if (u.searchParams.get("streaming") === "1") return
    rscRequests.push({ url, method: req.method() })
  })

  await page.goto("/streaming-demo")
  await page.locator("body[data-streaming-demo-ready]").waitFor({ timeout: 10000 })
  // Settle any in-flight RSC from initial render.
  await page.waitForTimeout(500)
  rscRequests.length = 0

  await page.locator('[data-testid="streaming-demo-push-btn"]').click()
  // Long enough for the action POST to complete AND for any
  // navigation-triggered GET to fire.
  await page.waitForTimeout(1500)

  // The action POST should fire exactly once. No GET for the new URL.
  const posts = rscRequests.filter((r) => r.method === "POST")
  const gets = rscRequests.filter((r) => r.method === "GET")
  expect(posts.length, "expected exactly one POST (the pushSeq action)").toBe(1)
  expect(
    gets,
    `expected zero GETs after the URL trailer applies — saw:\n${gets
      .map((g) => `  GET ${new URL(g.url).pathname}${new URL(g.url).search}`)
      .join("\n")}`,
  ).toEqual([])

  // Sanity: the URL bar did get the trailer's update.
  expect(new URL(page.url()).searchParams.get("seq")).not.toBeNull()
})
