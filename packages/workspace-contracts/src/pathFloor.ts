import data from "./pathFoldData.json";

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

/** Inputs have already been folded by the caller. */
export function isReserved83Alias(segment: string, reserved: string): boolean {
  const match = /^([a-z0-9_-]+)~([0-9]+)$/.exec(segment);
  return segment.length <= 8 && match !== null && reserved.replace(/^\.+/, "").startsWith(match[1]);
}

export function isIgnoredPathSegment(segment: string, stripAliases = true): boolean {
  const folded = foldPathSegment(segment);
  const name = stripAliases ? folded.replace(/[. ]+$/, "") : folded;
  return reservedSegments.includes(name)
    || reservedSegments.some((reserved) => isReserved83Alias(name, reserved))
    || name.startsWith(".dohc-write-")
    || isReserved83Alias(name, ".dohc-write-");
}
