"use server";

/**
 * Demo server actions for partial invalidation.
 *
 * Each action returns { invalidate: [...partialIds] }.
 * The framework reads this from the return value and renders
 * only those partials in the response. PartialsClient on the
 * client merges the fresh partials with its cache.
 */

export async function refreshHero() {
  return { invalidate: ["hero"] };
}

export async function refreshStats() {
  return { invalidate: ["stats"] };
}

export async function refreshAll() {
  return { invalidate: ["hero", "stats", "species"] };
}
