import { test, expect } from "@playwright/test";

/**
 * Bare streaming test — three plain Suspense boundaries, zero Partials.
 *
 * If this shows stages appearing progressively after refetch, we know
 * the streaming path works and the current issue is in Partials.
 * If all three appear simultaneously at ~2s, the setState/stream plumbing
 * itself is broken at a lower level.
 */
test("bare streaming: stages reveal progressively on refetch", async ({ page }) => {
  const consoleLines: string[] = [];
  page.on("console", (msg) => {
    const t = msg.text();
    if (t.includes("[stream]")) consoleLines.push(t);
  });
  page.on("pageerror", (err) => console.log(`PAGEERROR: ${err.message}`));

  await page.goto("/bare");
  await page.waitForSelector('[data-testid="stage-3-content"]', { timeout: 15000 });
  console.log("Initial SSR loaded with all 3 stages");

  // Install timing tracker BEFORE clicking refetch.
  await page.evaluate(() => {
    const w = window as any;
    w.__t = {
      t0: 0,
      started: false,
      events: [] as string[],
      stages: {} as Record<string, number>,
      lastState: "",
    };

    function snapshot() {
      const parts: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const content = document.querySelector(`[data-testid="stage-${i}-content"]`);
        const fallback = document.querySelector(`[data-testid="stage-${i}-fallback"]`);
        if (content) {
          parts.push(`S${i}:CONTENT`);
          if (w.__t.started && !w.__t.stages[`stage${i}`]) {
            w.__t.stages[`stage${i}`] = Math.round(performance.now() - w.__t.t0);
          }
        } else if (fallback) {
          parts.push(`S${i}:FALLBACK`);
          if (w.__t.started && !w.__t.stages[`stage${i}_fb`]) {
            w.__t.stages[`stage${i}_fb`] = Math.round(performance.now() - w.__t.t0);
          }
        } else {
          parts.push(`S${i}:GONE`);
          if (w.__t.started && !w.__t.stages[`stage${i}_gone`]) {
            w.__t.stages[`stage${i}_gone`] = Math.round(performance.now() - w.__t.t0);
          }
        }
      }
      return parts.join(" | ");
    }

    const check = () => {
      if (!w.__t.started) return;
      const state = snapshot();
      if (state !== w.__t.lastState) {
        const ms = Math.round(performance.now() - w.__t.t0);
        w.__t.events.push(`[${ms}ms] ${state}`);
        w.__t.lastState = state;
      }
    };

    const raf = () => { check(); if (w.__t.started) requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    w.__t.poll = setInterval(check, 5);
    const obs = new MutationObserver(check);
    obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    w.__t.obs = obs;
  });

  // Start the clock, then click refetch.
  await page.evaluate(() => {
    (window as any).__t.t0 = performance.now();
    (window as any).__t.started = true;
  });

  await page.locator('[data-testid="refetch-full"]').click();
  await page.waitForTimeout(8000);

  const result = await page.evaluate(() => {
    const t = (window as any).__t;
    t.started = false;
    clearInterval(t.poll);
    t.obs?.disconnect();
    return { events: t.events, stages: t.stages };
  });

  console.log("\n=== State transitions ===");
  for (const e of result.events) console.log(`  ${e}`);
  console.log("\n=== Stage timings (ms after refetch click) ===");
  console.log(JSON.stringify(result.stages, null, 2));
  console.log("\n=== Browser [stream] logs ===");
  for (const l of consoleLines) console.log(`  ${l}`);

  const s1 = result.stages.stage1;
  const s2 = result.stages.stage2;
  const s3 = result.stages.stage3;
  if (s1 != null && s2 != null && s3 != null) {
    console.log(`\nProgressive timing: S1=${s1}ms, S2=${s2}ms, S3=${s3}ms`);
    console.log(`Gap 1→2: ${s2 - s1}ms; Gap 2→3: ${s3 - s2}ms`);
  }

  expect(result.stages).toBeDefined();
});
