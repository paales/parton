import { Partial } from "../../lib";

/**
 * Shared cross-page nav. Self-contained — wraps its own content in
 * `<Partial id="nav">` so every page gets a fingerprint-skippable
 * nav just by rendering `<AppNav/>`. Works anywhere in the JSX
 * tree (no "must be a direct child of `<PartialRoot>`" constraint,
 * because the runtime discovers Partials by executing them).
 */
export function AppNav() {
  return (
    <Partial id="nav">
      <nav
        style={{
          marginBottom: "1.5rem",
          paddingBottom: "1rem",
          borderBottom: "1px solid #2d3748",
        }}
      >
        <a href="/">Pokemon</a>
        {" · "}
        <a href="/magento">Magento Store</a>
        {" · "}
        <a href="/bare">Bare Stream</a>
        {" · "}
        <a href="/cache-demo">Cache Demo</a>
        {" · "}
        <a href="/defer-demo">Defer Demo</a>
        {" · "}
        <a href="/selector-demo">Selector Demo</a>
        {" · "}
        <a href="/sentinels-demo">Sentinels Demo</a>
        {" · "}
        <a href="/frames-demo">Frames Demo</a>
      </nav>
    </Partial>
  );
}
