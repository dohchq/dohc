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
 * `RESOLVE_REQUEST_FRAME_BYTES`: the control frame that carries a whole
 * `conflicts.resolve` request, measured in JSON-ENCODED bytes.
 *
 * A combined body is not bounded on its own. The same request carries two
 * 16 KiB metadata fields, a path, four identifiers and an idempotency key, and
 * escaping can double any of them, so what a body gets is whatever the rest of
 * its request leaves. Measure a candidate with `jsonStringEncodedLength`
 * instead of comparing a raw byte count against this.
 */
export const RESOLVE_REQUEST_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * How many bytes a string occupies once JSON-encoded, quotes included — the
 * daemon's `json_string_encoded_len` (lib.rs), and the only count
 * `RESOLVE_REQUEST_FRAME_BYTES` is spent in.
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
    } else if (code >= 0xd800 && code <= 0xdfff) {
      // A LONE surrogate. `for...of` yields a matched pair as its combined
      // code point, so anything left in this range is unpaired, and
      // `JSON.stringify` emits it as a six-character escape rather than the
      // three UTF-8 bytes its value suggests. The Rust twin cannot reach this
      // class — a `&str` holds no unpaired surrogate, and the daemon rejects
      // the escape as malformed — which is why measuring it belongs here.
      length += 6;
    } else if (code < 0x10000) {
      length += 3;
    } else {
      length += 4;
    }
  }
  return length;
}
