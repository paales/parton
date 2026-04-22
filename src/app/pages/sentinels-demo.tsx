import { PartialRoot, Partial } from "../../lib/partial.tsx";
import { AppNav } from "../components/app-nav.tsx";
import { ChatOverlay } from "../chat/chat-overlay.tsx";

/**
 * `/sentinels-demo` — click-through page for the `notFound()` +
 * `redirect()` framework sentinels. Each link triggers a different
 * path through the mechanism; check devtools Network for status codes.
 */
export function SentinelsDemoPage() {
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
            <title>Sentinels Demo</title>
            <style>{`
              * { box-sizing: border-box; margin: 0; padding: 0; }
              body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #ededed; padding: 2rem; max-width: 900px; margin: 0 auto; }
              a { color: #58a6ff; text-decoration: none; }
              a:hover { text-decoration: underline; }
              h1 { font-size: 1.75rem; margin-bottom: 1rem; }
              h2 { font-size: 1.1rem; margin-bottom: 0.5rem; }
              code { background: #2d3748; padding: 0.1rem 0.3rem; border-radius: 4px; font-size: 0.85rem; }
              .card { background: #1a1a2e; border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; }
              .muted { color: #888; margin-bottom: 0.75rem; font-size: 0.9rem; }
              .demo-link { display: inline-block; background: #2d3748; color: #ededed; border: 1px solid #4a5568; padding: 0.5rem 0.9rem; border-radius: 6px; font-size: 0.9rem; margin-right: 0.5rem; margin-top: 0.5rem; }
              .demo-link:hover { background: #4a5568; text-decoration: none; }
              .status { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; margin-left: 0.5rem; }
              .status-404 { background: #742a2a; color: #feb2b2; }
              .status-302 { background: #553c6b; color: #d6bcfa; }
              .status-200 { background: #22543d; color: #9ae6b4; }
            `}</style>
          </head>
        </Partial>
        <body>
          <AppNav />
          <main style={{ padding: "1rem 0" }}>
            <h1>notFound() + redirect() — the sentinels</h1>
            <p className="muted">
              Two framework helpers (<code>src/framework/errors.ts</code>)
              mutate a request-scoped control channel and throw. The
              entry handler picks them up and adjusts the HTTP response.
              Click any link, then check the Network panel for the
              status code.
            </p>

            <section className="card">
              <h2>
                1. <code>notFound()</code> — sync throw from a page
                function
                <span className="status status-404">HTTP 404</span>
              </h2>
              <p className="muted">
                <code>/not-found-demo</code>'s route handler calls{" "}
                <code>notFound()</code> synchronously from{" "}
                <code>Root</code>. The try/catch at the top of{" "}
                <code>Root</code> routes it to the control channel;
                handler returns 404 + the default{" "}
                <code>&lt;NotFoundPage/&gt;</code> body.
              </p>
              <a href="/not-found-demo" className="demo-link" data-testid="link-not-found-sync">
                /not-found-demo →
              </a>
            </section>

            <section className="card">
              <h2>
                2. <code>notFound()</code> — deep async throw
                <span className="status status-404">HTTP 404</span>
              </h2>
              <p className="muted">
                <code>/pokemon/9999999</code> hits the live PokeAPI. The{" "}
                <code>HeroPartial</code> awaits the GraphQL query; the
                result is empty, so it calls <code>notFound()</code>. The
                throw happens during async rendering — <em>after</em>{" "}
                Root's sync catch has already returned. Because{" "}
                <code>notFound()</code> flags the control channel before
                throwing, the entry handler still sees the decision after{" "}
                <code>renderHTML</code> awaits, and re-renders with{" "}
                <code>&lt;NotFoundPage/&gt;</code> cleanly.
              </p>
              <a href="/pokemon/9999999" className="demo-link" data-testid="link-not-found-async">
                /pokemon/9999999 →
              </a>
            </section>

            <section className="card">
              <h2>
                3. <code>redirect()</code> — HTML navigation
                <span className="status status-302">HTTP 302</span>
              </h2>
              <p className="muted">
                <code>/redirect-demo</code> calls{" "}
                <code>redirect("/cache-demo")</code>. For an HTML
                request, the handler returns a native 302 +{" "}
                <code>Location</code> header and the browser follows.
              </p>
              <a href="/redirect-demo" className="demo-link" data-testid="link-redirect-html">
                /redirect-demo →
              </a>
            </section>

            <section className="card">
              <h2>
                4. <code>redirect()</code> — client navigation via{" "}
                <code>&lt;Redirect&gt;</code>
                <span className="status status-200">HTTP 200</span>
              </h2>
              <p className="muted">
                If you navigate to <code>/redirect-demo</code> via an RSC
                refetch (a link click after the app is hydrated, not a
                direct URL visit), the server can't emit a native 302 —{" "}
                <code>fetch()</code> would transparently follow and
                commit the destination's payload for the current route.
                Instead the server renders a{" "}
                <code>&lt;Redirect url=…/&gt;</code> client component in
                the payload; its <code>useEffect</code> calls{" "}
                <code>navigation.navigate</code> on mount.
              </p>
              <a href="/redirect-demo" className="demo-link" data-testid="link-redirect-rsc">
                /redirect-demo (click from here) →
              </a>
            </section>
          </main>
          <ChatOverlay />
        </body>
      </html>
    </PartialRoot>
  );
}
