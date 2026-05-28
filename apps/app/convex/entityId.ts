// Canonical entity-id rule, in a NEUTRAL module (no Convex/db
// imports) so entities.ts AND trash.ts can both depend on it without
// an entities↔trash import cycle (Phase-4 holistic review, Codex LOW).
//
// `type` and `slug` are path segments: non-empty, no '/'. This makes
// the `${type}/${slug}` capture ref UNAMBIGUOUS (split on the single
// '/'), so the reviewed-by-default withhold ref is provably exact end
// to end. Without it, an entity like {type:"a/b", slug:"c"} makes
// recordCapture's first-'/' split miss the lookup → NO withhold row
// → a granted window leaks the unconfirmed value.

export function isCanonicalEntityId(type: unknown, slug: unknown): boolean {
  for (const val of [type, slug]) {
    if (typeof val !== 'string' || val.length === 0 || val.includes('/')) {
      return false
    }
  }
  return true
}

// Throwing form for write paths that should fail loud (agent writes via
// _upsertMany / _patch). Recovery paths that must return a result
// instead of throwing use the predicate directly.
export function assertCanonicalEntityId(type: string, slug: string) {
  if (!isCanonicalEntityId(type, slug)) {
    throw new Error(
      `invalid entity id (type=${JSON.stringify(type)}, slug=${JSON.stringify(slug)}): each must be a non-empty string with no "/"`,
    )
  }
}
