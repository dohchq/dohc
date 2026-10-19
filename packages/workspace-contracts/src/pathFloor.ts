import data from "./pathFoldData.json" with { type: "json" };

const mappings: Record<string, string> = data.mappings;

/** Full case folding, canonical equivalence, and default-ignorable removal. */
export function foldPathSegment(segment: string): string {
  if (/^[\x00-\x7f]*$/.test(segment)) return segment.toLowerCase();
  let folded = "";
  for (const character of segment.normalize("NFD")) {
    const code = character.codePointAt(0)!;
    if (data.ignorables.some(([start, end]) => code >= start && code <= end)) continue;
    folded += mappings[character] ?? character;
  }
  return folded.normalize("NFC");
}

const reservedSegments = [".dohc", ".git", "node_modules"];

// Names the OS writes beside user files, with AppleDouble `._*` files checked
// below. The shared fold fixtures hold this equal to the engine floor's
// macOS and Windows metadata lists in crates/dohc-engine-files/src/floor.rs.
const osMetadataSegments = [
  ".ds_store",
  ".localized",
  "icon\r",
  ".spotlight-v100",
  ".fseventsd",
  ".trashes",
  ".temporaryitems",
  ".documentrevisions-v100",
  "thumbs.db",
  "desktop.ini",
];

/** Inputs have already been folded by the caller. */
export function isReserved83Alias(segment: string, reserved: string): boolean {
  const match = /^([a-z0-9_-]+)~([0-9]+)$/.exec(segment);
  const stem = reserved.replace(/^\.+/, "");
  return segment.length <= 8 && match !== null
    && match[1].length === Math.min(stem.length, 7 - match[2].length)
    && stem.startsWith(match[1]);
}

export function isIgnoredPathSegment(segment: string, stripAliases = true): boolean {
  const folded = foldPathSegment(segment);
  const name = stripAliases ? folded.replace(/[. ]+$/, "") : folded;
  return reservedSegments.includes(name)
    || reservedSegments.some((reserved) => isReserved83Alias(name, reserved))
    || name.startsWith(".dohc-write-")
    || isReserved83Alias(name, ".dohc-write-")
    || osMetadataSegments.includes(name)
    || name.startsWith("._");
}
