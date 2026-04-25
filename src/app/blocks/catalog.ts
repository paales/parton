/**
 * App-level block catalog.
 *
 * Imported once (side-effect) by `src/app/root.tsx`. Every
 * `registerBlock` call binds a `type` tag to a `{tags, component}`
 * spec; slot primitives (`<Children>` / `<Child>`) look the tag up
 * at render time to resolve entries in the store.
 *
 * Authors add blocks by writing a component that reads its fields
 * via content accessors and dropping a `registerBlock(…)` line
 * here. HMR-friendly — re-imports replace the prior spec.
 */
import { registerBlock } from "../../framework/cms-runtime.ts";
import { HeroBlock } from "./hero.tsx";
import { RichTextBlock } from "./rich-text.tsx";
import { PageHeroBlock } from "./page-hero.tsx";
import { PageGreetingBlock } from "./page-greeting.tsx";
import { PageSlugNavBlock } from "./page-slug-nav.tsx";
import { PageComposedBlock } from "./page-composed.tsx";
import { PageMultiSlotBlock } from "./page-multi-slot.tsx";

// Slot-level blocks (used inside `<Children>` slots within page-level
// blocks like the composed section).
registerBlock("hero", {
  tags: [".demo-block", ".composed-hero"],
  component: HeroBlock,
});

registerBlock("rich-text", {
  tags: [".demo-block", ".composed-rich-text"],
  component: RichTextBlock,
});

// Page-level blocks (slot children of the page root, `cms-demo-root`).
// The `.page-block` shared tag is what the page root's
// `<Children allow=".page-block" />` declaration matches against —
// the editor uses it to filter the `+ add` palette per slot.
registerBlock("page-hero", {
  tags: [".page-block"],
  component: PageHeroBlock,
});

registerBlock("page-slug-nav", {
  tags: [".page-block"],
  component: PageSlugNavBlock,
});

registerBlock("page-greeting", {
  tags: [".page-block"],
  component: PageGreetingBlock,
});

registerBlock("page-composed", {
  tags: [".page-block"],
  component: PageComposedBlock,
});

registerBlock("page-multi-slot", {
  tags: [".page-block"],
  component: PageMultiSlotBlock,
});
