import { createRscHandler } from "@parton/framework/entry/rsc.tsx"
import { _clearLogs } from "./app/chat/log.ts"
import { serveDocAsset } from "./app/pages/docs-fs.ts"
import { NotFoundPage } from "./app/pages/not-found.tsx"
import { Root } from "./app/root.tsx"

export default createRscHandler({
  Root,
  notFound: NotFoundPage,
  // This app's pages are exhaustively match-gated: a URL no spec's
  // `match` covers is a 404. The declaration lets the entry
  // short-circuit unmatched document GETs ahead of the whole-tree
  // render and mounts the framework's fallback for soft navigations.
  unmatched: "not-found",
  // Image subresources under /docs/ (direct links + screenshots
  // embedded in markdown) are served as raw bytes; HTML doc pages fall
  // through to the normal RSC/SSR pipeline.
  fetch: serveDocAsset,
  remote: { name: "e2e-testing" },
  clearCaches: _clearLogs,
})

if (import.meta.hot) {
  import.meta.hot.accept()
}
