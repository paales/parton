/**
 * Pure transform + caret-math helpers for the card-form demo card.
 *
 * Imported by BOTH the server action (`commitCardForm`) and the
 * client component (`CardForm`). No server-side deps; safe for client
 * bundles.
 *
 * The transforms are the "shared rules" that both client and server
 * apply identically when the local-transform toggle is on — so the
 * input's display value stays stable across round-trips and the
 * server's authoritative write reaches the same result. Server-only
 * rules (CVC derivation, the inserted spaces in number formatting)
 * live in `streaming-demo-actions.ts` and only surface to the client
 * via the next render's `cell.value`.
 */

export const NAME_MAX_CHARS = 26
export const NUMBER_MAX_DIGITS = 16

// ─── Name ─────────────────────────────────────────────────────────────
//
// Uppercase ASCII letters and spaces only. Caps at NAME_MAX_CHARS
// surviving chars. Per-character mapping: every input char either
// produces one output char or none — no insertions — so the caret math
// is just "count surviving chars before the caret's input position."

export function transformName(raw: string): string {
  let out = ""
  for (let i = 0; i < raw.length; i++) {
    if (out.length >= NAME_MAX_CHARS) break
    const ch = raw[i].toUpperCase()
    if (!/[A-Z ]/.test(ch)) continue
    out += ch
  }
  return out
}

export function transformNameWithCaret(
  raw: string,
  caret: number,
): { value: string; caret: number } {
  let out = ""
  let outCaret: number | null = null
  for (let i = 0; i <= raw.length; i++) {
    if (i === caret) outCaret = out.length
    if (i === raw.length) break
    if (out.length >= NAME_MAX_CHARS) continue
    const ch = raw[i].toUpperCase()
    if (!/[A-Z ]/.test(ch)) continue
    out += ch
  }
  return { value: out, caret: outCaret ?? out.length }
}

// ─── Number ───────────────────────────────────────────────────────────
//
// Two flavors:
//   - `extractNumberDigits` strips to digits-only, caps at
//     NUMBER_MAX_DIGITS. The wire shape sent to the server — the
//     server formats with spaces, the client never has to.
//   - `formatNumberDigits` inserts " " between every group of 4 digits.
//     The server-side display transform; the client applies it ONLY
//     when the local-transform toggle is on. Otherwise the client
//     types raw and adopts the formatted value at the next quiet
//     moment.
//
// Caret math for the formatted flavor handles inserted separators:
// the caret tracks the user's logical position (after the Nth digit)
// and gets bumped past any space that lands at that position so the
// cursor sits *after* the separator, ready to receive the next digit.

export function extractNumberDigits(raw: string): string {
  let out = ""
  for (let i = 0; i < raw.length; i++) {
    if (out.length >= NUMBER_MAX_DIGITS) break
    if (!/\d/.test(raw[i])) continue
    out += raw[i]
  }
  return out
}

export function formatNumberDigits(digits: string): string {
  let out = ""
  for (let i = 0; i < digits.length && i < NUMBER_MAX_DIGITS; i++) {
    if (i > 0 && i % 4 === 0) out += " "
    out += digits[i]
  }
  return out
}

export function transformNumberWithCaret(
  raw: string,
  caret: number,
): { value: string; caret: number } {
  // Count digits in raw BEFORE the caret position. That's the user's
  // logical position in the formatted output ("after the Nth digit").
  let digitsBeforeCaret = 0
  const upto = Math.min(caret, raw.length)
  for (let i = 0; i < upto; i++) {
    if (/\d/.test(raw[i])) digitsBeforeCaret++
  }
  if (digitsBeforeCaret > NUMBER_MAX_DIGITS) digitsBeforeCaret = NUMBER_MAX_DIGITS

  // Build the formatted output and record the caret position at the
  // moment we emit digit #digitsBeforeCaret.
  let out = ""
  let outCaret = digitsBeforeCaret === 0 ? 0 : -1
  let digitCount = 0
  for (let i = 0; i < raw.length; i++) {
    if (!/\d/.test(raw[i])) continue
    if (digitCount >= NUMBER_MAX_DIGITS) break
    if (digitCount > 0 && digitCount % 4 === 0) out += " "
    out += raw[i]
    digitCount++
    if (digitCount === digitsBeforeCaret) outCaret = out.length
  }
  if (outCaret < 0) outCaret = out.length

  // If the caret landed immediately before an inserted space, bump it
  // past — so "1234|" formats to "1234 |", with the cursor ready for
  // the next digit rather than parked inside the separator.
  while (outCaret < out.length && out[outCaret] === " ") outCaret++

  return { value: out, caret: outCaret }
}

// ─── CVC ──────────────────────────────────────────────────────────────
//
// Deterministic 3-digit code from (name, number). Server-only —
// the client never derives this locally; it lands on the next render
// after the action commits. Demonstrates a cell whose value depends
// on other cells in the same write transaction.

export function computeCvc(name: string, number: string): string {
  // FNV-1a-style fold over name + ":" + number. Modulo 1000, zero-pad.
  let h = 2166136261
  const s = `${name}:${number}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return String(Math.abs(h) % 1000).padStart(3, "0")
}
