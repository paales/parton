// Public API surface for the React-CMS partials library.

export {
  ReactCms,
  PartialRoot,
  PartialBoundary,
  ROOT,
  type PartialCtx,
  type PartialOptions,
  type BlockOptions,
  type PartialComponentProps,
  type PartialBuilder,
  type SpecComponent,
  type SpecExtraProps,
  type SelectorToken,
  type SelectorTokens,
  type VaryScope,
  type SchemaScope,
  type RenderArgs,
  type ActivatorProps,
  type DeferSpec,
  type InferV,
  type InferRenderProps,
  type ParseRoute,
  getSpecComponentById,
  lookupSpecComponentByType,
  getRegisteredMatchPatterns,
} from "./partial.tsx"

export {
  PartialsClient,
  getCachedPartialIds,
  useActivate,
  useEnclosingPartialId,
  useNavigation,
  useScrollRestore,
  type ActivatorFire,
} from "./partial-client.tsx"

export type {
  FrameworkNavigation,
  FrameworkNavigateOptions,
  FrameworkReloadOptions,
  FrameworkNavigationResult,
  NavigateTarget,
} from "../runtime/navigation-api.ts"

export { PartialErrorBoundary } from "./partial-error-boundary.tsx"
export { invalidateByTags, clearCache, getCacheStats } from "./partial-cache.ts"
