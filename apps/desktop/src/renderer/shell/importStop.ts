import type { ImportWorkspaceFilesResult } from "../../ipc/bridgeContract";

type ImportStop = NonNullable<ImportWorkspaceFilesResult["stop"]>;

// Why an import stopped, in the words a person uses. The filesystem's own
// error text goes only into Copy details. A refusal dohc wrote itself is
// already in those words.
export function importStopSentence(stop: ImportStop): string {
  if (stop.reason) return stop.reason;
  const file = shortName(stop.file);
  switch (stop.code) {
    case "EACCES":
    case "EPERM":
      return `dohc isn't allowed to read ${file} or write to this folder.`;
    case "ENOSPC":
      return "The disk is full.";
    // The source or the destination folder can be the missing side.
    case "ENOENT":
      return `dohc could not find ${file} or this folder anymore.`;
    default:
      return `dohc could not copy ${file}.`;
  }
}

// A notice's message is cut at 500 characters, and a file name can run to
// 255, so a sentence shows at most one name, and shortens it. The whole list
// goes into Copy details.
const SHORT_NAME_MAX_CHARS = 60;

function shortName(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const chars = [...name];
  return chars.length <= SHORT_NAME_MAX_CHARS
    ? name
    : `${chars.slice(0, SHORT_NAME_MAX_CHARS - 1).join("")}…`;
}

// The files that landed, for a sentence a person reads: "a.md",
// "a.md and b.md", or "a.md and 4 more".
export function namedPaths(paths: readonly string[]): string {
  const first = shortName(paths[0] ?? "");
  if (paths.length === 1) return first;
  if (paths.length === 2) return `${first} and ${shortName(paths[1]!)}`;
  return `${first} and ${paths.length - 1} more`;
}
