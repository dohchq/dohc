const encoder = new TextEncoder();
export const nameByteLength = (value: string): number => encoder.encode(value).byteLength;

// Unicode 17 Canonical_Combining_Class=Virama, matching unicode-normalization in Rust.
const VIRAMA_RE = /[\u{94d}\u{9cd}\u{a4d}\u{acd}\u{b4d}\u{bcd}\u{c4d}\u{ccd}\u{d3b}\u{d3c}\u{d4d}\u{dca}\u{e3a}\u{eba}\u{f84}\u{1039}\u{103a}\u{1714}\u{1715}\u{1734}\u{17d2}\u{1a60}\u{1b44}\u{1baa}\u{1bab}\u{1bf2}\u{1bf3}\u{2d7f}\u{a806}\u{a82c}\u{a8c4}\u{a953}\u{a9c0}\u{aaf6}\u{abed}\u{10a3f}\u{11046}\u{11070}\u{1107f}\u{110b9}\u{11133}\u{11134}\u{111c0}\u{11235}\u{112ea}\u{1134d}\u{113ce}\u{113cf}\u{113d0}\u{11442}\u{114c2}\u{115bf}\u{1163f}\u{116b6}\u{1172b}\u{11839}\u{1193d}\u{1193e}\u{119e0}\u{11a34}\u{11a47}\u{11a99}\u{11c3f}\u{11d44}\u{11d45}\u{11d97}\u{11f41}\u{11f42}\u{1612f}]/u;

export function truncateName(value: string, maxBytes: number): string {
  let end = 0, boundary = 0, bytes = 0, joinsNext = false;
  for (const ch of value) {
    const mark = /[\p{M}\u200d]/u.test(ch);
    // Keep marks with their base and preserve virama/ZWJ joins across intervening marks.
    // Keep this mark-backoff rule identical to the engine's truncate_name.
    if (!mark && !joinsNext) boundary = end;
    bytes += nameByteLength(ch);
    if (bytes > maxBytes) return value.slice(0, boundary);
    end += ch.length;
    joinsNext = VIRAMA_RE.test(ch) || ch === "\u200d" || (mark && joinsNext);
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
