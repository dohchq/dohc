/** Matches the engine's Unicode collision folding without changing the stored path. */
export function foldPathSegment(segment: string): string {
  return segment.normalize("NFKC").toLowerCase().toUpperCase().toLowerCase().normalize("NFKC");
}

const reservedSegments = new Set([".dohc", ".git", "node_modules"]);

export function isIgnoredPathSegment(segment: string, stripAliases = true): boolean {
  const folded = foldPathSegment(segment);
  const name = stripAliases ? folded.replace(/[. ]+$/, "") : folded;
  return reservedSegments.has(name) || name.startsWith(".dohc-write-");
}
