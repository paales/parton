import { Partial, PartialRoot } from "../../lib/partial.tsx";
import { AppNav } from "../components/app-nav.tsx";
import { ChatOverlay } from "../chat/chat-overlay.tsx";
import { getPathname, getSearchParam } from "../../framework/context.ts";
import {
  FrameNavigateButton,
  UpdateEntryStateButton,
} from "../components/frames-demo-controls.tsx";
import { FrameNavigationBar } from "../components/frame-nav-bar.tsx";

/**
 * `/frames-demo` — two server-iframes on a normal page.
 *
 *   • The main listing is plain page content. Product clicks drive
 *     `useNavigation().navigate("/frames-demo?product=alpha")`,
 *     which falls through to `window.navigation.navigate()` (no
 *     ambient frame in scope). Browser URL updates, browser back
 *     works, shareable link works. No inline nav bar needed — the
 *     browser is the nav bar.
 *   • `cart`  — drawer-shaped: `/cart/closed` / `/cart/open` /
 *     `/cart/checkout`.
 *   • `menu`  — `/menu/closed` / `/menu/about` / `/menu/settings`.
 *
 * Buttons inside a frame use `useNavigation()` without a name,
 * defaulting to the ambient frame. Buttons outside (e.g. product
 * buttons) do the same, getting the window-scoped handle. See
 * `notes/FRAMES.md`.
 */

// ── Main listing (plain page content — no frame) ──────────────────

function ListView() {
  const skus = ["alpha", "beta", "gamma"];
  return (
    <div data-testid="main-list">
      <h3 style={{ marginTop: 0 }}>Product list</h3>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {skus.map((sku) => (
          <li key={sku} style={{ padding: "0.25rem 0" }}>
            <FrameNavigateButton
              url={`/frames-demo?product=${sku}`}
              label={`Open ${sku}`}
              testId={`main-open-${sku}`}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function DetailView({ sku }: { sku: string }) {
  const renderedAt = Date.now();
  return (
    <div data-testid="main-detail" data-sku={sku} data-rendered-at={renderedAt}>
      <h3 style={{ marginTop: 0 }}>Product: {sku}</h3>
      <p style={{ color: "#888" }}>
        Window URL: <code>?product={sku}</code> · rendered{" "}
        {new Date(renderedAt).toLocaleTimeString()}
      </p>
      <FrameNavigateButton
        url="/frames-demo"
        label="← back to list"
        testId="main-back-to-list"
      />
    </div>
  );
}

function MainContent() {
  const sku = getSearchParam("product");
  return sku ? <DetailView sku={sku} /> : <ListView />;
}

// ── Cart frame content ─────────────────────────────────────────────

function CartClosedView() {
  return (
    <div data-testid="cart-closed" style={{ color: "#888" }}>
      <span>Cart is closed. </span>
      <FrameNavigateButton
        url="/cart/open"
        label="Open cart"
        testId="cart-open-btn"
      />
    </div>
  );
}

function CartOpenView() {
  return (
    <div
      data-testid="cart-open"
      style={{
        border: "1px solid #4a5568",
        borderRadius: 8,
        padding: "1rem",
        background: "#1a1a2e",
      }}
    >
      <h3 style={{ marginTop: 0 }}>Cart</h3>
      <p style={{ color: "#888" }}>0 items · rendered at {new Date().toLocaleTimeString()}</p>
      <FrameNavigateButton
        url="/cart/checkout"
        label="Go to checkout"
        testId="cart-checkout-btn"
      />{" "}
      <FrameNavigateButton
        url="/cart/closed"
        label="Close"
        testId="cart-close-btn"
      />{" "}
      <UpdateEntryStateButton
        patch={{ itemsReady: true }}
        label="Mark ready"
        testId="cart-mark-ready"
      />
    </div>
  );
}

function CartCheckoutView() {
  return (
    <div
      data-testid="cart-checkout"
      style={{
        border: "1px solid #48bb78",
        borderRadius: 8,
        padding: "1rem",
        background: "#22543d",
      }}
    >
      <h3 style={{ marginTop: 0 }}>Checkout</h3>
      <p>Payment form would go here.</p>
      <FrameNavigateButton
        url="/cart/open"
        label="← back to cart"
        testId="cart-back-to-open"
      />
    </div>
  );
}

function CartFrameContent() {
  if (getPathname("/cart/closed")) return <CartClosedView />;
  if (getPathname("/cart/open")) return <CartOpenView />;
  if (getPathname("/cart/checkout")) return <CartCheckoutView />;
  return <div data-testid="cart-unknown">Unknown cart URL.</div>;
}

// ── Menu frame content ─────────────────────────────────────────────

function MenuClosedView() {
  return (
    <div data-testid="menu-closed" style={{ color: "#888" }}>
      <span>Menu is closed. </span>
      <FrameNavigateButton
        url="/menu/about"
        label="About"
        testId="menu-about-btn"
      />{" "}
      <FrameNavigateButton
        url="/menu/settings"
        label="Settings"
        testId="menu-settings-btn"
      />{" "}
      <FrameNavigateButton
        url="/menu/slow"
        label="Slow (streaming)"
        testId="menu-slow-btn"
      />
    </div>
  );
}

function MenuAboutView() {
  return (
    <div
      data-testid="menu-about"
      style={{
        border: "1px solid #4a5568",
        borderRadius: 8,
        padding: "1rem",
        background: "#1a1a2e",
      }}
    >
      <h3 style={{ marginTop: 0 }}>About</h3>
      <p>Demo of the Frame primitive — two server-iframes on a normal page.</p>
      <FrameNavigateButton
        url="/menu/closed"
        label="Close"
        testId="menu-close-btn"
      />
    </div>
  );
}

function MenuSettingsView() {
  return (
    <div
      data-testid="menu-settings"
      style={{
        border: "1px solid #4a5568",
        borderRadius: 8,
        padding: "1rem",
        background: "#1a1a2e",
      }}
    >
      <h3 style={{ marginTop: 0 }}>Settings</h3>
      <p>(no settings yet)</p>
      <FrameNavigateButton
        url="/menu/closed"
        label="Close"
        testId="menu-close-from-settings"
      />
    </div>
  );
}

function MenuFrameContent() {
  if (getPathname("/menu/closed")) return <MenuClosedView />;
  if (getPathname("/menu/about")) return <MenuAboutView />;
  if (getPathname("/menu/settings")) return <MenuSettingsView />;
  if (getPathname("/menu/slow")) return <MenuSlowView />;
  return <div data-testid="menu-unknown">Unknown menu URL.</div>;
}

/**
 * Menu view that includes a slow async component behind a Suspense
 * boundary. Used to verify that streaming INSIDE a framed Partial
 * works — the fallback is painted first, then the delayed content
 * replaces it as the frame's Flight chunk arrives.
 */
async function SlowInsideFrame() {
  await new Promise((r) => setTimeout(r, 400));
  return (
    <div
      data-testid="menu-slow-content"
      style={{ padding: "0.5rem", color: "#48bb78" }}
    >
      Slow content loaded at {new Date().toLocaleTimeString()}
    </div>
  );
}

function MenuSlowView() {
  return (
    <div
      data-testid="menu-slow"
      style={{
        border: "1px solid #4a5568",
        borderRadius: 8,
        padding: "1rem",
        background: "#1a1a2e",
      }}
    >
      <h3 style={{ marginTop: 0 }}>Slow menu view (streaming)</h3>
      <Partial
        selector="#menu-slow-inner"
        fallback={
          <div data-testid="menu-slow-fallback" style={{ color: "#888" }}>
            Loading slow content…
          </div>
        }
      >
        <SlowInsideFrame />
      </Partial>
      <FrameNavigateButton
        url="/menu/closed"
        label="Close"
        testId="menu-close-from-slow"
      />
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────

export function FramesDemoPage() {
  return (
    <PartialRoot>
      <html lang="en">
        <Partial selector="#head">
          <head>
            <meta charSet="UTF-8" />
            <meta
              name="viewport"
              content="width=device-width, initial-scale=1.0"
            />
            <title>Frames Demo</title>
            <style>{`
              * { box-sizing: border-box; margin: 0; padding: 0; }
              body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #ededed; padding: 2rem; max-width: 900px; margin: 0 auto; }
              a { color: #58a6ff; text-decoration: none; }
              a:hover { text-decoration: underline; }
              h1 { font-size: 1.75rem; margin-bottom: 1rem; }
              h2 { font-size: 1.1rem; margin-bottom: 0.5rem; }
              code { background: #2d3748; padding: 0.1rem 0.3rem; border-radius: 4px; font-size: 0.85rem; }
              .card { background: #1a1a2e; border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; }
              button { background: #2d3748; color: #ededed; border: 1px solid #4a5568; padding: 0.4rem 0.8rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
              button:hover:not(:disabled) { background: #4a5568; }
            `}</style>
          </head>
        </Partial>
        <body>
          <AppNav />
          <main style={{ padding: "1rem 0" }}>
            <h1>Frames demo</h1>
            <p style={{ color: "#888", marginBottom: "1.5rem" }}>
              The main listing is plain page content — product clicks
              update the window URL via <code>useNavigation()</code>,
              and the browser back/forward buttons handle navigation
              natively. Two frames (cart and menu) live alongside with
              their own URL scopes and inline nav bars.
            </p>

            <section className="card">
              <h2>Main listing (page-scoped)</h2>
              <MainContent />
            </section>

            <section className="card">
              <h2>Cart frame</h2>
              <Partial selector="#cart" frame="cart" frameUrl="/cart/closed">
                <FrameNavigationBar />
                <CartFrameContent />
              </Partial>
            </section>

            <section className="card">
              <h2>Menu frame</h2>
              <Partial selector="#menu" frame="menu" frameUrl="/menu/closed">
                <FrameNavigationBar />
                <MenuFrameContent />
              </Partial>
            </section>
          </main>
          <ChatOverlay />
        </body>
      </html>
    </PartialRoot>
  );
}
