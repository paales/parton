// Public API surface for the React-CMS partials library.

export {
  ReactCms,
  PartialRoot,
  PartialBoundary,
  ROOT,
  type PartialCtx,
  type PartialOptions,
  type PartialComponentProps,
  type SelectorToken,
  type SelectorTokens,
  type VaryScope,
  type RenderArgs,
  type ActivatorProps,
  type DeferSpec,
  getSpecComponentById,
  lookupSpecComponentForCmsId,
} from "./partial.tsx"

export {
  Children,
  Child,
  type ChildrenProps,
  type ChildProps,
} from "./slot.tsx"

export { Match, PartialMatch, getActiveMatchParams } from "./partial-match.tsx"

export {
  PartialsClient,
  getCachedPartialIds,
  useActivate,
  useNavigation,
} from "./partial-client.tsx"

export type {
  FrameworkNavigation,
  FrameworkNavigateOptions,
  FrameworkReloadOptions,
  FrameworkNavigationResult,
  NavigateTarget,
} from "../framework/navigation-api.ts"

export { PartialErrorBoundary } from "./partial-error-boundary.tsx"
export { invalidateByTags, clearCache, getCacheStats } from "./partial-cache.ts"
