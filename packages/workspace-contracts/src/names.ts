const encoder = new TextEncoder();
export const nameByteLength = (value: string): number => encoder.encode(value).byteLength;

// Created on first use, since some renderers load this module without Intl.Segmenter.
let graphemeSegmenter: Intl.Segmenter | undefined;

function graphemes(value: string): Iterable<{ segment: string; index: number }> {
  if (typeof Intl.Segmenter !== "function") return codePoints(value);
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return graphemeSegmenter.segment(value);
}

function* codePoints(value: string): Generator<{ segment: string; index: number }> {
  let index = 0;
  for (const segment of value) {
    yield { segment, index };
    index += segment.length;
  }
}

export function truncateName(value: string, maxBytes: number): string {
  let bytes = 0;
  for (const { segment, index } of graphemes(value)) {
    bytes += nameByteLength(segment);
    if (bytes > maxBytes) return value.slice(0, index);
  }
  return value;
}

/** `text` cut to `max` characters, ending with "…" when it was longer. No space comes before the "…". */
export function cutText(text: string, max: number): string {
  const characters = [...text];
  return characters.length <= max
    ? text
    : `${characters
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`;
}

// The characters the engine drops from a name (names.rs, shown_name), keeping ZWNJ, ZWJ, and variation selectors.
const HIDDEN_IN_NAMES =
  /(?![\u200C\u200D\p{Variation_Selector}])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

/** A name as the engine shows it: hidden characters dropped, trimmed, and cut to 40 characters. */
export function shownName(name: string): string {
  return cutText(name.replace(HIDDEN_IN_NAMES, "").trim(), 40);
}

/** The author name a server gives an account's phone writes, from the account's name. */
export function accountAuthorName(name: string | null): string {
  return shownName(name ?? "") || "Unnamed";
}

export function isReservedWindowsName(value: string): boolean {
  return /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(
    value,
  );
}

// Shared with the engine: NFC, lowercase, whitespace/underscore to dash.
export function nameSlug(value: string, maxBytes = 200): string {
  const lowered = value.normalize("NFC").toLowerCase().normalize("NFC");
  let slug = "";
  for (const ch of lowered) {
    if (/\p{DI}/u.test(ch)) continue;
    if (/[\p{White_Space}_-]/u.test(ch)) {
      if (slug && !slug.endsWith("-")) slug += "-";
    } else if (/[\p{L}\p{N}]/u.test(ch) || (/\p{M}/u.test(ch) && slug && !slug.endsWith("-"))) {
      slug += ch;
    }
  }
  slug = truncateName(slug.normalize("NFC"), maxBytes).replace(/-+$/u, "");
  if (isReservedWindowsName(slug)) slug = truncateName("name-" + slug, maxBytes);
  return slug;
}

// For app source paths, after the caller's workspace/permission checks.
export function isPortableNamePath(value: string, maxBytes = 1024): boolean {
  return (
    nameByteLength(value) <= maxBytes &&
    /^[\p{L}\p{N}\p{M}_@./-]+$/u.test(value) &&
    value
      .split("/")
      .every(
        (part) =>
          part.length > 0 &&
          !/^[. ]|[. ]$/u.test(part) &&
          nameByteLength(part) <= 255 &&
          !isReservedWindowsName(part),
      )
  );
}
