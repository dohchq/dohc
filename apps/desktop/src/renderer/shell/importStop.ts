import type { ImportWorkspaceFilesResult } from "../../ipc/bridgeContract";

type ImportStop = NonNullable<ImportWorkspaceFilesResult["stop"]>;

// Why an import stopped, in the words a person uses. The filesystem's own
// error text goes only into Copy details. A refusal dohc wrote itself is
// already in those words.
export function importStopSentence(stop: ImportStop): string {
  if (stop.reason) return stop.reason;
  switch (stop.code) {
    case "EACCES":
    case "EPERM":
      return `dohc isn't allowed to read ${stop.file} or write to this folder.`;
    case "ENOSPC":
      return "The disk is full.";
    // The source or the destination folder can be the missing side.
    case "ENOENT":
      return `dohc could not find ${stop.file} or this folder anymore.`;
    default:
      return `dohc could not copy ${stop.file}.`;
  }
}

// Up to three paths by name, then how many more, for a sentence a person
// reads: "a.md and b.md", "a.md, b.md, and c.md", "a.md, b.md, c.md, and 2 more".
export function namedPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, 3);
  const more = paths.length - shown.length;
  if (more > 0) return `${shown.join(", ")}, and ${more} more`;
  if (shown.length <= 2) return shown.join(" and ");
  return `${shown.slice(0, -1).join(", ")}, and ${shown.at(-1)}`;
}
