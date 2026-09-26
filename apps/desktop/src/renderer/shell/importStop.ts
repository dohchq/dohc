import type { ImportWorkspaceFilesResult } from "../../ipc/bridgeContract";
import type { ErrorDetailField } from "./copyDetails";
import { SHELL_ERROR_MAX_CHARS } from "./useShellError";

type ImportStop = NonNullable<ImportWorkspaceFilesResult["stop"]>;

// Why an import stopped, in the words a person uses. The filesystem's own
// error text goes only into Copy details.
export function importStopSentence(stop: ImportStop): string {
  const file = shortName(stop.file);
  // The target has to come back before the link can be imported, so the
  // steps come in that order.
  if (stop.refusal === "dangling-link") {
    return `dohc did not import ${file}, a symbolic link to a missing file. Restore that file, then import it instead.`;
  }
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

// A notice made of what happened, why, and what to do next. The toast cuts a
// message at SHELL_ERROR_MAX_CHARS, so when the three run long, the middle
// is shortened: the instruction at the end always survives whole.
export function fitImportMessage(head: string, middle: string, tail: string): string {
  // Measured in UTF-16 units, as the toast measures; cut on whole characters.
  const room = SHELL_ERROR_MAX_CHARS - head.length - tail.length;
  if (middle.length <= room) return `${head}${middle}${tail}`;
  let kept = "";
  for (const char of middle) {
    if (kept.length + char.length > room - 1) break;
    kept += char;
  }
  return `${head}${kept}…${tail}`;
}

// Every landed path for Copy details, whole: a path is useless once its file
// name is cut off, and a workspace path can run to 4096 characters. The list
// stops at 100 lines, then counts the rest, so the report stays bounded.
const IMPORTED_DETAIL_MAX_LINES = 100;
const IMPORTED_PATH_MAX_CHARS = 4096;

export function importedPathDetails(paths: readonly string[]): ErrorDetailField[] {
  const lines: ErrorDetailField[] = paths
    .slice(0, IMPORTED_DETAIL_MAX_LINES)
    .map((path) => ["Imported", path, IMPORTED_PATH_MAX_CHARS] as const);
  const more = paths.length - lines.length;
  if (more > 0) lines.push(["Imported", `${more} more`]);
  return lines;
}

// The files that landed, for a sentence a person reads: "a.md",
// "a.md and b.md", or "a.md and 4 more".
export function namedPaths(paths: readonly string[]): string {
  const first = shortName(paths[0] ?? "");
  if (paths.length === 1) return first;
  if (paths.length === 2) return `${first} and ${shortName(paths[1]!)}`;
  return `${first} and ${paths.length - 1} more`;
}
