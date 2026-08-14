import { validateUserWritePath } from "@dohc/workspace-core";
import { classifyEngineFilePath } from "./enginePathFloor";

// The share selector's VERSION and ACCESS dimensions, as one rule in one
// place.
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

/**
 * Budget for a share's version id. Bounded because it crosses the wire.
 *
 * The unit is UTF-16 code units — what `String.length` counts — so one astral
 * character spends two. Every surface that reports this limit must say that
 * unit: "characters" would misreport an astral id by half. The engine twin
 * (`crates/dohc-engine-sync/src/share.rs`) counts the same unit.
 */
export const MAX_SHARE_VERSION_ID_CHARS = 128;

/**
 * Whether `value` is a version id the relay could have issued: a non-empty,
 * untrimmed-free string within the budget above. `null` and `undefined` are
 * NOT version ids — a selector that follows main carries no version, and
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

/**
 * Whether `value` is a path the relay could have issued in a share selector.
 *
 * The relay accepts a path only if it is a non-empty string that validates,
 * normalizes to itself, and classifies as tracked — it stores the NORMALIZED
 * form, so anything else is a path it never wrote (`validateShareSelector` in
 * `services/sync-relay/src/shareFilter.ts`, which expands the same rule into
 * separate branches because it owes distinct error codes at create time).
 *
 * Every surface that reads a selector BACK applies this, for the same reason
 * the version rule lives here: a reader that accepts more than the writer
 * issues will accept damage, and `""` is the path-shaped version of the empty
 * version id that got through once already.
 */
export function isShareablePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const validated = validateUserWritePath(value);
  if (!validated.ok || validated.normalized !== value) return false;
  return classifyEngineFilePath(validated.normalized).kind === "tracked";
}

/**
 * The file-share access levels (issue #646, S7), in the order the UI offers
 * them. `view` is the narrowest.
 *
 * The chat-channel selector's own binary `access` is a different field on a
 * different selector kind. It is not this rule.
 */
export const SHARE_ACCESS_VALUES = ["view", "comment", "edit"] as const;

export type ShareAccess = (typeof SHARE_ACCESS_VALUES)[number];

/**
 * Whether `value` is a level the relay could have issued: exactly one of the
 * three lowercase strings above. No case folding and no trimming — a level a
 * surface cannot read is not a narrower grant, it is an unreadable one.
 *
 * The engine twin (`ShareAccess::parse` in
 * `crates/dohc-engine-sync/src/share.rs`) accepts the same set, held to this
 * function vector by vector in
 * `crates/dohc-engine-sync/tests/security_contract.rs`.
 */
export function isShareAccessValue(value: unknown): value is ShareAccess {
  return (
    typeof value === "string" &&
    (SHARE_ACCESS_VALUES as readonly string[]).includes(value)
  );
}
