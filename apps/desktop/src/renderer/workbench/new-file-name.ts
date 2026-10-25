import { validateUserMaterializePath } from "@dohc/workspace-contracts/workspace-paths";

// Long enough for any title, short enough to keep the path well inside
// Windows' 260-character limit in a nested folder.
const PAGE_NAME_LIMIT = 120;

// A new page's file name comes from its title. Characters a file name cannot
// hold on Windows, macOS or Linux become spaces, runs of spaces close up, and
// leading dots (a hidden file) and trailing dots and spaces (which Windows
// drops) go. A title that still names no file this computer can write, such
// as CON, or names nothing at all, is Untitled.
export function pageFileStem(title: string, platform: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "");
  const stem = Array.from(cleaned).slice(0, PAGE_NAME_LIMIT).join("").replace(/[. ]+$/, "");
  return stem && validateUserMaterializePath(`${stem}.md`, { platform }).ok ? stem : "Untitled";
}

// The first of "Stem.md", "Stem 2.md", "Stem 3.md"… in `folder` that no path
// in `occupied` holds. `occupied` is lowercase, because Windows and macOS
// compare names without case.
export function nextPagePath(folder: string, stem: string, occupied: ReadonlySet<string>): string {
  const prefix = folder ? `${folder}/` : "";
  for (let index = 1; ; index += 1) {
    const path = `${prefix}${index === 1 ? stem : `${stem} ${index}`}.md`;
    if (!occupied.has(path.toLowerCase())) return path;
  }
}

// New files are markdown by default: a typed name whose leaf has no
// extension gets ".md" appended. An explicit extension ("notes.txt") is
// respected exactly, dotfiles (".env") stay literal — a leading dot is not
// an extension — and a trailing dot reads as "extension not typed yet", so
// "notes." becomes "notes.md".
export function withMarkdownDefault(relativePath: string): string {
  return withDefaultExtension(relativePath, "md");
}

// A rename keeps the file's own extension. When the renamed file has one and
// the typed name has none, the typed name takes the file's last extension
// back: "report.csv" typed as "report" stays "report.csv", and
// "archive.tar.gz" typed as "archive" becomes "archive.gz", the same last-dot
// rule file kinds use. A typed extension or dotfile is respected exactly, as
// for new files. A file without an extension ("LICENSE", ".env") takes the
// typed name exactly. A tail with whitespace is not an extension, so
// "Mr. Rogers" typed as "Fred" becomes "Fred".
export function withRenameDefault(fromPath: string, toPath: string): string {
  const extension = extensionOf(leafOf(fromPath));
  return extension && !/\s/.test(extension) ? withDefaultExtension(toPath, extension) : toPath;
}

function withDefaultExtension(relativePath: string, extension: string): string {
  // Backend validation accepts "\" as a separator too and drops empty
  // segments (workspace-core paths.ts), so a trailing separator is noise:
  // "notes/" creates the file "notes". Strip it so the default still lands,
  // and derive the leaf on either separator.
  const base = relativePath.replace(/[/\\]+$/, "");
  const leaf = leafOf(base);
  if (!leaf || leaf === "." || leaf === "..") return relativePath;
  const dot = leaf.lastIndexOf(".");
  if (dot === 0 && leaf.length > 1) return relativePath; // dotfile: .env
  if (extensionOf(leaf)) return relativePath; // extension: a.txt
  if (dot === leaf.length - 1) return `${base}${extension}`; // trailing dot: a.
  return `${base}.${extension}`; // no extension: a
}

function leafOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

// The text after the leaf's last dot: "txt" for "a.txt", "gz" for
// "a.tar.gz". "a", "a." and the dotfile ".env" have none.
function extensionOf(leaf: string): string | null {
  const dot = leaf.lastIndexOf(".");
  return dot > 0 && dot < leaf.length - 1 ? leaf.slice(dot + 1) : null;
}
