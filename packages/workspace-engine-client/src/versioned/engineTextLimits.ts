/**
 * The daemon's text limits, under the daemon's own names, mirrored from
 * `crates/dohc-workspace-engine/src/lib.rs`.
 *
 * A LEAF module on purpose: it imports nothing. The fixtures that model these
 * limits sit beside `node:crypto`, and a renderer that imported them from
 * there would pull a Node builtin into the browser bundle — which neither
 * typecheck nor vitest would catch, because both resolve TypeScript directly
 * (the #272 failure mode).
 */

/**
 * `MAX_DESKTOP_CAPTURE_TEXT_BYTES`: the largest text body an answer carries in
 * band. Past it the daemon reports the digest and this limit, and the caller
 * hydrates the body with `versionedText.readBlob`.
 */
export const MAX_DESKTOP_CAPTURE_TEXT_BYTES = 128 * 1024;

/**
 * `MAX_MERGED_RESOLUTION_TEXT_BYTES`: what `conflicts.resolve` accepts as a
 * hand-combined body, measured in JSON-ENCODED bytes — one control frame
 * (8 MiB) less the envelope headroom the conflict listing keeps.
 *
 * Encoded, not raw: escaping doubles every newline and quote, and turns most
 * other control bytes into six bytes, so a raw byte count is not this budget.
 * A surface that wants a bound a person can act on should measure its own
 * editing limit; this one bounds what the apply route accepts.
 */
export const MAX_MERGED_RESOLUTION_TEXT_BYTES = 8 * 1024 * 1024 - 64 * 1024;

/**
 * How many bytes a string occupies once JSON-encoded, quotes included — the
 * daemon's `json_string_encoded_len` (lib.rs), and the only count
 * `MAX_MERGED_RESOLUTION_TEXT_BYTES` is spent in.
 *
 * `JSON.stringify` gives the same answer; this counts instead of building, so
 * measuring a multi-megabyte body does not allocate a second copy of it.
 */
export function jsonStringEncodedLength(text: string): number {
  let length = 2;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      length += 2;
    } else if (code < 0x20) {
      length += 6;
    } else if (code < 0x80) {
      length += 1;
    } else if (code < 0x800) {
      length += 2;
    } else if (code < 0x10000) {
      length += 3;
    } else {
      length += 4;
    }
  }
  return length;
}
