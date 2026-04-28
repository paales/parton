import "./styles.css"
// Side-effect import — block specs self-register at module load.
import "./blocks/catalog.ts"
import { PartialRoot, ROOT } from "../lib"
import { NotFoundError, RedirectError } from "../framework/errors.ts"
import { getRequest, setCookie, setFrameworkControl } from "../framework/context.ts"
import { EDITOR_COOKIE, isEditorRequest } from "../framework/cms-runtime.ts"
import { Redirect } from "../framework/redirect-client.tsx"
import { PartialsDebug } from "../lib/partial-debug.tsx"
import { AppNav } from "./components/app-nav.tsx"
import { ChatOverlay } from "./chat/chat-overlay.tsx"
import { NotFoundPage } from "./pages/not-found.tsx"
import { EditorShell } from "../editor/shell.tsx"

import { PokemonPagePlacements } from "./pages/pokemon.tsx"
import { CacheDemoPagePlacements } from "./pages/cache-demo.tsx"
import { CmsDemoPagePlacements } from "./pages/cms-demo.tsx"
import { DeferDemoPagePlacements } from "./pages/defer-demo.tsx"
import { SelectorDemoPagePlacements } from "./pages/selector-demo.tsx"
import { SentinelsDemoPagePlacements } from "./pages/sentinels-demo.tsx"
import { FramesDemoPagePlacements } from "./pages/frames-demo.tsx"
import { BarePagePlacements } from "./pages/bare-stream.tsx"
import { ChatNotesPagePlacements } from "./pages/chat-notes.tsx"
import { MagentoPagePlacements } from "./pages/magento/product-list.tsx"

function syncEditorCookie(): void {
  const url = new URL(getRequest().url)
  const flag = url.searchParams.get("editor")
  if (flag === "1") setCookie(EDITOR_COOKIE, "1")
  else if (flag === "0") setCookie(EDITOR_COOKIE, "", 0)
}

/** All page placements — only the matching specs render. */
function AllPages() {
  return (
    <>
      <PokemonPagePlacements parent={ROOT} />
      <CacheDemoPagePlacements parent={ROOT} />
      <CmsDemoPagePlacements parent={ROOT} />
      <DeferDemoPagePlacements parent={ROOT} />
      <SelectorDemoPagePlacements parent={ROOT} />
      <SentinelsDemoPagePlacements parent={ROOT} />
      <FramesDemoPagePlacements parent={ROOT} />
      <BarePagePlacements parent={ROOT} />
      <ChatNotesPagePlacements parent={ROOT} />
      <MagentoPagePlacements parent={ROOT} />
    </>
  )
}

export function Root() {
  try {
    syncEditorCookie()
    const editorOn = isEditorRequest(getRequest())
    return (
      <PartialRoot>
        <html lang="en" className="light">
          <head>
            <meta charSet="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>React Partials</title>
          </head>
          <body
            className={
              editorOn
                ? "min-h-screen bg-background text-foreground antialiased"
                : "mx-auto min-h-screen max-w-225 bg-background p-8 text-foreground antialiased"
            }
          >
            {editorOn ? (
              <EditorShell>
                <AppNav />
                <AllPages />
              </EditorShell>
            ) : (
              <>
                <AppNav />
                <AllPages />
              </>
            )}
            <ChatOverlay parent={ROOT} />
            {import.meta.env.DEV && <PartialsDebug />}
          </body>
        </html>
      </PartialRoot>
    )
  } catch (e) {
    if (e instanceof NotFoundError) {
      setFrameworkControl({ notFound: true })
      return (
        <html lang="en" className="light">
          <body>
            <NotFoundPage />
          </body>
        </html>
      )
    }
    if (e instanceof RedirectError) {
      setFrameworkControl({ redirect: { url: e.url, status: e.status } })
      return (
        <html lang="en" className="light">
          <body>
            <Redirect url={e.url} />
          </body>
        </html>
      )
    }
    throw e
  }
}
