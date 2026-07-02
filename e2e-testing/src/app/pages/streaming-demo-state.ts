/**
 * Per-scope server state for the /streaming-demo page.
 *
 * `bumps` — client-mutable counter. The Bump button calls
 * `bumps.set(bumps.value + 1)` through the framework's
 * Flight-serialized server-action ref; the parton's `schema`
 * reads it back on the next render.
 *
 * `cardName` / `cardNumber` / `cardCvc` — the controlled-form
 * demo's three client-driven cells. The client routes writes
 * through `useCell(cell).set(v)`, which microtask-coalesces multiple
 * `.set` calls in the same tick into one `__cellWriteBatch` POST.
 * CVC is computed client-side (pure `computeCvc(name, number)`
 * shared with the server-side formatter) — the demo writes it as
 * its own cell, with a coin-flipped stagger so 50% of keystrokes
 * batch all three sets into ONE POST and the other 50% split into
 * TWO POSTs (name + number sync, CVC ~50 ms later). Open the
 * network panel to see the difference.
 *
 * None declares a `partition`, so each is one global slot — a
 * second tab on /streaming-demo broadcasts via its open heartbeat.
 *
 * A per-batch latency simulator is installed via
 * `_setCellWriteDelaySimulator` so the demo's auto-batched writes
 * land with variable RTTs (trimodal: ~fast / typing-speed / slower
 * than typing). Production never installs this.
 *
 * There's no `tick` cell — the live tick demo reads time directly
 * from the render clock and declares `expires(time().nextSecond)` so
 * the segment driver wakes on each second boundary. See
 * `streaming-demo.tsx`'s `LiveTick`.
 */

import { _setCellWriteDelaySimulator, localCell } from "@parton/framework"
import {
  extractNumberDigits,
  formatNumberDigits,
  transformName,
} from "./streaming-demo-card-shared.ts"

export const bumps = localCell({
  id: "demo.bumps",
  shape: "number",
  initial: 0,
})

// `write` is the server's final-say transform. With the local-transform
// toggle ON, the client sends already-cleaned values and write is
// idempotent. With the toggle OFF, the client sends raw and the server
// canonicalises here.
export const cardName = localCell({
  id: "demo.card.name",
  shape: "string",
  initial: "",
  write: transformName,
})

export const cardNumber = localCell({
  id: "demo.card.number",
  shape: "string",
  initial: "",
  write: (raw) => formatNumberDigits(extractNumberDigits(raw)),
})

export const cardCvc = localCell({
  id: "demo.card.cvc",
  shape: "string",
  initial: "",
})

// Master toggle for the per-batch latency simulator below. The
// simulator reads this cell every batch via `peek()` — toggling it
// off skips the delay branch entirely on the next batch (the toggle's
// own write still pays the prior delay, so the change takes effect
// one batch later). Lets the demo flip between "stressful slow" and
// "instant" without redeploy.
export const serverDelay = localCell({
  id: "demo.server-delay",
  shape: "boolean",
  initial: true,
})

// Toggle for the card form's client-side transform predictor. Lives
// as a global cell so the choice broadcasts across tabs and survives
// reloads — same shape as `serverDelay`. The CardForm client reads
// it via `useCell(...).value` and gates whether it passes a transform
// fn to `input()`.
export const applyLocalTransform = localCell({
  id: "demo.apply-local-transform",
  shape: "boolean",
  initial: true,
})

// Trimodal latency when enabled: 1/3 ~fast, 1/3 typing-speed, 1/3
// slower-than-typing. Per-batch (not per-write) — so a coalesced
// batch of N writes pays one delay, and order preservation comes
// from the client's microtask queue, not from the server.
_setCellWriteDelaySimulator(() => {
  if (!serverDelay.peek()) return
  const r = Math.random()
  if (r < 1 / 3) return Math.random() * 30
  if (r < 2 / 3) return 100 + Math.random() * 100
  return 400 + Math.random() * 100
})
