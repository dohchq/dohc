// The share selector's VERSION dimension, as one rule in one place.
//
// The relay applies it when it creates a selector (`validateShareSelector` in
// services/sync-relay/src/shareFilter.ts). Every recipient surface that reads
// a selector back — the relay's share metadata response, and the desktop's own
// registry record — must apply the SAME rule, because a version-bearing
// selector with no paths grants the whole tracked workspace. A version id the
// relay would never have issued (empty, padded, or unbounded) must therefore
// never be read as one, or damage becomes the widest grant there is.
//
// Restating the rule per surface is what let `""` through the registry read
// while the relay refused it at creation. It lives here so there is nothing
// to restate.

/** Budget for a share's version id. Bounded because it crosses the wire. */
export const MAX_SHARE_VERSION_ID_CHARS = 128;

/**
 * Whether `value` is a version id the relay could have issued: a non-empty,
 * untrimmed-free string within the character budget. `null` and `undefined`
 * are NOT version ids — a selector that follows main carries no version, and
 * callers must handle that state explicitly rather than through this check.
 */
export function isValidShareVersionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    value.length <= MAX_SHARE_VERSION_ID_CHARS
  );
}
