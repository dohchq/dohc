import type { ImportWorkspaceFilesResult } from "../../ipc/bridgeContract";

type ImportStop = NonNullable<ImportWorkspaceFilesResult["stop"]>;

// Why an import stopped, in the words a person uses. The filesystem's own
// error text goes only into Copy details.
export function importStopSentence(stop: ImportStop): string {
  switch (stop.code) {
    case "EACCES":
    case "EPERM":
      return `dohc isn't allowed to read ${stop.file} or write to this folder.`;
    case "ENOSPC":
      return "The disk is full.";
    case "ENOENT":
      return `${stop.file} was moved or deleted before dohc could copy it.`;
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
