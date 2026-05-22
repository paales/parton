/**
 * `parseCookies` overlay semantics.
 *
 * Vary's `cookies` scope is computed from `parseCookies(request)`. The
 * incoming request header is the base, but any `setCookie()` writes
 * made earlier in the same request (typically inside a server action
 * that also calls `getServerNavigation().reload(...)`) overlay on top —
 * so a partial re-rendered immediately after the action sees the new
 * cookie value, consistent with `readCookie` (which already walks
 * `store.cookies` first).
 *
 * Without the overlay, the cart pattern `setCookie("cart_id", X) +
 * getServerNavigation().reload({selector: "cart"})` leaves the
 * immediate re-render reading `cookies.cart_id === undefined` — the
 * cart spec skips its data fetch and the badge stays at 0 until the
 * next nav.
 */
import { describe, expect, it } from "vitest"
import { parseCookies, runWithRequestAsync, setCookie } from "../context.ts"

describe("parseCookies", () => {
  it("reads cookies from request headers", async () => {
    const req = new Request("http://t/", { headers: { cookie: "a=1; b=2" } })
    const { result } = await runWithRequestAsync(req, async () => parseCookies(req))
    expect(result).toEqual({ a: "1", b: "2" })
  })

  it("overlays setCookie writes made in the active request", async () => {
    const req = new Request("http://t/", { headers: { cookie: "a=1" } })
    const { result } = await runWithRequestAsync(req, async () => {
      setCookie("b", "from-action")
      return parseCookies(req)
    })
    expect(result).toEqual({ a: "1", b: "from-action" })
  })

  it("setCookie writes override matching request-header values", async () => {
    // The cart pattern: action receives request with stale cart_id (or none),
    // creates a new cart, setCookie("cart_id", newId), then
    // getServerNavigation().reload({selector: "cart"}). The re-rendered
    // cart spec's vary must see the NEW cart_id.
    const req = new Request("http://t/", { headers: { cookie: "theme=light" } })
    const { result } = await runWithRequestAsync(req, async () => {
      setCookie("theme", "dark")
      return parseCookies(req)
    })
    expect(result).toEqual({ theme: "dark" })
  })

  it("treats setCookie(name, '', 0) as deletion", async () => {
    // Explicit Max-Age=0 follows browser semantics: cookie is gone.
    const req = new Request("http://t/", { headers: { cookie: "theme=light" } })
    const { result } = await runWithRequestAsync(req, async () => {
      setCookie("theme", "", 0)
      return parseCookies(req)
    })
    expect(result).toEqual({})
  })

  it("setCookie with empty value but non-zero Max-Age keeps the key with empty value", async () => {
    // `setCookie("x", "")` (default Max-Age) is "set to empty," not "delete."
    // A vary reading `cookies.x` gets "", not undefined.
    const req = new Request("http://t/", { headers: { cookie: "x=keep" } })
    const { result } = await runWithRequestAsync(req, async () => {
      setCookie("x", "")
      return parseCookies(req)
    })
    expect(result).toEqual({ x: "" })
  })

  it("falls back to plain header parse when no ALS scope is active", () => {
    // parseCookies is also used in fingerprint-fold paths that walk
    // descendant specs; some of those may run outside a full request
    // context. Safe fallback: just parse the header.
    const req = new Request("http://t/", { headers: { cookie: "a=1; b=2" } })
    expect(parseCookies(req)).toEqual({ a: "1", b: "2" })
  })

  it("multiple setCookie writes to the same name — last write wins", async () => {
    const req = new Request("http://t/", { headers: {} })
    const { result } = await runWithRequestAsync(req, async () => {
      setCookie("flag", "first")
      setCookie("flag", "second")
      return parseCookies(req)
    })
    expect(result.flag).toBe("second")
  })
})
