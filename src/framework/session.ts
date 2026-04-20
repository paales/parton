/**
 * Framework-level session store.
 *
 * A cookie (`__frame_sid`) carries a session ID; the server holds the
 * per-session state in an in-memory map (swap for Redis/KV later
 * behind the same interface). State today: frame URLs keyed by frame
 * name. The session is the **source of truth** for "what scene is
 * the user looking at" — the window URL is a shareable projection
 * over it (see `notes/FRAME_SCOPING.md` and task 6).
 *
 *   cookie `__frame_sid=abc123` → store[abc123] = {
 *     frames: { cart: { url: "/cart/checkout" }, menu: { url: "/menu" } }
 *   }
 *
 * A page refresh re-reads the session, so the user sees the same
 * scene. Closing the browser, reopening, and hitting the same URL
 * gets the same scene — as long as the cookie is still there and
 * the server hasn't evicted the session.
 */

import { getCookie, setCookie } from "./context.ts";

export interface FrameSessionState {
  url: string;
}

export interface SessionState {
  frames: Record<string, FrameSessionState>;
}

const SESSION_COOKIE = "__frame_sid";

// CATEGORY C (notes/SERVER_ISOLATION.md) — intentional shared map.
// Keyed by opaque session ID; different users don't collide.
const store = new Map<string, SessionState>();

function generateSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Return the session ID from the cookie, or `null` if none. Does NOT
 * create a new session.
 */
export function getSessionId(): string | null {
  return getCookie(SESSION_COOKIE) ?? null;
}

/**
 * Ensure a session exists. If the cookie is missing, generate a new
 * session ID and `Set-Cookie` it for the response. Returns the ID.
 *
 * Side-effect: writes to the response's Set-Cookie accumulator on
 * first use. Subsequent calls in the same request are idempotent.
 */
export function ensureSessionId(): string {
  const existing = getSessionId();
  if (existing) return existing;
  const fresh = generateSessionId();
  setCookie(SESSION_COOKIE, fresh);
  return fresh;
}

/**
 * Read the full session state, or an empty state if there's no
 * session yet (or the session ID points to nothing — e.g. cleared
 * between processes).
 */
export function getSessionState(): SessionState {
  const id = getSessionId();
  if (!id) return { frames: {} };
  return store.get(id) ?? { frames: {} };
}

/**
 * Look up one frame's URL in the session. Returns `null` if no
 * session or no entry for this frame.
 */
export function getSessionFrameUrl(frameName: string): string | null {
  return getSessionState().frames[frameName]?.url ?? null;
}

/**
 * Set (or overwrite) a frame's URL in the session. Creates the
 * session (and Set-Cookies the ID) if it doesn't exist yet.
 */
export function setSessionFrameUrl(frameName: string, url: string): void {
  const id = ensureSessionId();
  const existing = store.get(id) ?? { frames: {} };
  existing.frames = { ...existing.frames, [frameName]: { url } };
  store.set(id, existing);
}

/**
 * Remove a frame entry from the session (e.g. a closing drawer). No-op
 * if there's no session or no entry.
 */
export function clearSessionFrame(frameName: string): void {
  const id = getSessionId();
  if (!id) return;
  const existing = store.get(id);
  if (!existing) return;
  const { [frameName]: _removed, ...rest } = existing.frames;
  existing.frames = rest;
  store.set(id, existing);
}

/** Test-only: wipe all sessions. */
export function _clearAllSessions(): void {
  store.clear();
}

/** Test/debug: stats on the session store. */
export function _sessionStats(): { sessions: number; frameCounts: Record<string, number> } {
  const frameCounts: Record<string, number> = {};
  for (const state of store.values()) {
    for (const frameName of Object.keys(state.frames)) {
      frameCounts[frameName] = (frameCounts[frameName] ?? 0) + 1;
    }
  }
  return { sessions: store.size, frameCounts };
}

if (import.meta.hot) {
  // HMR: sessions reference URLs + nothing module-sensitive, so they
  // survive edits cleanly. But if the session store ever holds React
  // element references, this would need to clear.
}
