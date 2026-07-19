import { chromium } from "playwright"
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.addInitScript(() => {
  // Genuinely variable heights: every 3rd card 100px taller, every
  // 7th 60px taller — materialization above the viewport now RESIZES
  // content, the exact case the re-anchoring must absorb.
  const style = document.createElement("style")
  style.textContent = `
    [data-testid^="browse-card-"]:nth-of-type(3n) { min-height: 340px !important; }
    [data-testid^="browse-card-"]:nth-of-type(7n) { min-height: 300px !important; }
  `
  document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style))
  window.__jumps = []
  let lastY = 0
  window.addEventListener(
    "scroll",
    () => {
      const d = window.scrollY - lastY
      if (Math.abs(d) > 700) window.__jumps.push(Math.round(d))
      lastY = window.scrollY
    },
    { passive: true, capture: true },
  )
})
await page.goto("http://localhost:5348/magento/browse?page=40", { waitUntil: "networkidle" })
await page.waitForTimeout(1800)
await page.mouse.move(640, 400)
// Stepped up-scroll with settle pauses — spans move, leaves
// materialize ABOVE the viewport with heights ≠ estimate.
const ys = []
for (let round = 0; round < 8; round++) {
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, -600)
    await page.waitForTimeout(80)
  }
  await page.waitForTimeout(900)
  ys.push(await page.evaluate(() => Math.round(scrollY)))
}
const jumps = await page.evaluate(() =>
  window.__jumps.filter((d) => Math.abs(d) !== 600 && Math.abs(d) > 700),
)
console.log("trajectory:", ys.join(","), "| non-wheel jumps >700px:", JSON.stringify(jumps))
const state = await page.evaluate(() => ({
  url: location.search,
  cardsVisible: [...document.querySelectorAll('[data-testid^="browse-card-"]')].filter((c) => {
    const r = c.getBoundingClientRect()
    return r.bottom > 0 && r.top < innerHeight && c.offsetParent !== null
  }).length,
}))
console.log("final:", JSON.stringify(state))
await browser.close()
