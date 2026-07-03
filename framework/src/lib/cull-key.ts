/**
 * The culled-variant key grammar — shared by the server emission
 * (partial.tsx, partial-registry.ts) and the client cull machinery
 * (cull-park.ts, cull-slot.tsx, partial-client-state.ts).
 *
 * A cullable keepalive parton has TWO rendered states per match
 * variant: the in-view content and the out-of-view skeleton. The
 * culled state is a VARIANT — its wire matchKey (and its registry
 * variant key) is the base key plus this suffix, so both states ride
 * the existing `(id, matchKey)` machinery side by side: separate
 * client cache slots, separate advertised fingerprints, separate
 * placeholder identities, separate server snapshots (each state's
 * dep record folds its own fingerprint). Content identity WITHIN a
 * state stays the fingerprint's job.
 *
 * Base matchKeys are 16-char hex hashes (or the constant root key) —
 * `~` cannot occur in one, so the suffix is unambiguous and the
 * `id:matchKey:fp` wire token split (colon-based) is untouched.
 */
export const CULLED_KEY_SUFFIX = "~cull"

/** The culled-state twin of a base matchKey / variant key. */
export function culledKey(base: string): string {
	return `${base}${CULLED_KEY_SUFFIX}`
}

export function isCulledKey(key: string): boolean {
	return key.endsWith(CULLED_KEY_SUFFIX)
}

/** Strip the culled suffix — identity for base keys. */
export function baseKey(key: string): string {
	return isCulledKey(key) ? key.slice(0, -CULLED_KEY_SUFFIX.length) : key
}
