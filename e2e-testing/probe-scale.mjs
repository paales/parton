import { chromium } from "playwright"

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
page.on("console", (m) => {
  if (/error/i.test(m.type())) console.log("[console.error]", m.text().slice(0, 200))
})
await page.goto("http://localhost:5348/scale", { waitUntil: "networkidle" })
await page.waitForTimeout(800)

const snap = () =>
  page.evaluate(() => ({
    url: location.search,
    scrollY: Math.round(window.scrollY),
    docH: document.documentElement.scrollHeight,
    nodes: document.querySelectorAll("*").length,
    skels: document.querySelectorAll(".parton-skel").length,
    res: [...document.querySelectorAll(".parton-scroller-res")].map((r) => ({
      base: r.dataset.so,
      count: r.dataset.sn,
      h: Math.round(r.getBoundingClientRect().height),
    })),
    cells: document.querySelectorAll('[data-testid="scale-cell"]').length,
    visibleCell: (() => {
      const el = document.elementFromPoint(600, 400)
      const c = el?.closest('[data-testid="scale-cell"]')
      return c ? c.getAttribute("data-i") : null
    })(),
  }))

console.log("cold:", JSON.stringify(await snap()))

// Scrollbar jump to ~50%.
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight * 0.5))
await page.waitForTimeout(80)
console.log("t+80ms (band should be local skeletons):", JSON.stringify(await snap()))

// Wait for the settle statement + window move + content.
for (let i = 1; i <= 8; i++) {
  await page.waitForTimeout(500)
  const s = await snap()
  console.log(`t+${i * 0.5}s:`, JSON.stringify(s))
  if (s.visibleCell !== null) break
}

// Scroll UP 15 notches — zero backward jumps allowed.
await page.mouse.move(600, 400)
const ys = []
for (let i = 0; i < 15; i++) {
  await page.mouse.wheel(0, -600)
  await page.waitForTimeout(120)
  ys.push(await page.evaluate(() => Math.round(window.scrollY)))
}
let maxFwd = 0
for (let i = 1; i < ys.length; i++) maxFwd = Math.max(maxFwd, ys[i] - ys[i - 1])
console.log("scroll-up trajectory:", ys.join(","), "max forward jump:", maxFwd)
console.log("final:", JSON.stringify(await snap()))
await browser.close()
