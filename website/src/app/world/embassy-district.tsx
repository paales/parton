import { RemoteFrame } from "@parton/framework"
import { VocabularyStyles } from "@parton/framework/lib/vocabulary.tsx"
import { Suspense } from "react"
import { EMBASSY_DISTRICT } from "./constants.ts"

/**
 * The embassy district layer — the federation arc's demo thread
 * (`docs/notes/remote-frame-arc.md`), rendered by the world page as a
 * plain overlay component at plane coordinates (the auction layer's
 * pattern: chunks underneath only TINT; the content rides the page
 * parton, decoupled from the chunks' cull gates and pulse lanes).
 *
 * The building hosts the PAINT-ONLY exhibit: `<RemoteFrame>` at an
 * ordinary page this same app publishes (`/embassy/bulletin` —
 * `./embassy-page.tsx`), under `grant="paint"`. The splice admits only
 * the framework vocabulary, zero remote modules load, and the content
 * arrives pull-only — a paint grant registers no snapshots, so the
 * embassy never lanes and costs the live stream nothing. The WORLD
 * paints it: `<VocabularyStyles/>` resolves the vocabulary tags from
 * this bundle, and the `--parton-*` custom properties set on
 * `.embassy-building` (styles.css) cross the embed box's containment
 * boundary — the bulletin wears the world's ink.
 *
 * ── Seams: the district's remaining exhibits (see the seam note in
 *    ./embassy-page.tsx for the pages) ──
 *   - TRADE DESK wing — arc increment 5 lands `grant="interactive"` +
 *     bound cells: mount `<RemoteFrame url="/embassy/trade-desk"
 *     grant="interactive" cells={{ cart: … }}>` here, beside the
 *     bulletin.
 *   - CUSTOMS WINDOW wing — arc increment 6 lands the URL grant:
 *     mount a frame whose `request` mask projects the host URL, so
 *     the window follows the world's navigation.
 *   - LATE COURIER post — the deadline knob: mount an embed with
 *     `deadline="…"` that misses on purpose, showing the fallback +
 *     on-late policy as a piece of the district.
 */
export function EmbassyDistrict() {
  return (
    <div
      className="embassy-layer"
      style={{
        left: EMBASSY_DISTRICT.x0,
        top: EMBASSY_DISTRICT.y0,
        width: EMBASSY_DISTRICT.x1 - EMBASSY_DISTRICT.x0,
        height: EMBASSY_DISTRICT.y1 - EMBASSY_DISTRICT.y0,
      }}
    >
      <VocabularyStyles />
      <div className="card embassy-building" data-testid="embassy-building">
        <h1 className="card__title">EMBASSY</h1>
        <p>
          A foreign page flies its flag here: the bulletin below is /embassy/bulletin — an ordinary
          page of this same app — fetched as Flight and spliced in under a PAINT grant.
        </p>
        <p>
          Only the framework vocabulary crosses; the world's own stylesheet paints it. Zero remote
          code runs.
        </p>
        <Suspense fallback={<p className="card__hint">the courier is en route…</p>}>
          <RemoteFrame url="/embassy/bulletin" grant="paint" />
        </Suspense>
        <p className="card__hint embassy-plaque" data-testid="embassy-plaque">
          plaque: one crate confiscated at the border — the bulletin smuggles a raw HTML row, and
          non-vocabulary rows never survive a paint splice
        </p>
      </div>
    </div>
  )
}
