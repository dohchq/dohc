const encoder = new TextEncoder();
export const nameByteLength = (value: string): number => encoder.encode(value).byteLength;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function truncateName(value: string, maxBytes: number): string {
  let bytes = 0;
  for (const { segment, index } of graphemeSegmenter.segment(value)) {
    bytes += nameByteLength(segment);
    if (bytes > maxBytes) return value.slice(0, index);
  }
  return value;
}

export function isReservedWindowsName(value: string): boolean {
  return /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(value);
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
  return nameByteLength(value) <= maxBytes &&
    /^[\p{L}\p{N}\p{M}_@./-]+$/u.test(value) && value.split("/").every(part =>
      part.length > 0 && !/^[. ]|[. ]$/u.test(part) && nameByteLength(part) <= 255 && !isReservedWindowsName(part));
}
