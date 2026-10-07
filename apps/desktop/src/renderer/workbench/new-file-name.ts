// New files are markdown by default: a typed name whose leaf has no
// extension gets ".md" appended. An explicit extension ("notes.txt") is
// respected exactly, dotfiles (".env") stay literal — a leading dot is not
// an extension — and a trailing dot reads as "extension not typed yet", so
// "notes." becomes "notes.md".
export function withMarkdownDefault(relativePath: string): string {
  // Backend validation accepts "\" as a separator too and drops empty
  // segments (workspace-core paths.ts), so a trailing separator is noise:
  // "notes/" creates the file "notes". Strip it so the default still lands,
  // and derive the leaf on either separator.
  const base = relativePath.replace(/[/\\]+$/, "");
  const leaf = leafOf(base);
  if (!leaf || leaf === "." || leaf === "..") return relativePath;
  const dot = leaf.lastIndexOf(".");
  if (dot === 0 && leaf.length > 1) return relativePath; // dotfile: .env
  if (hasExtension(leaf)) return relativePath; // extension: a.txt
  if (dot === leaf.length - 1) return `${base}md`; // trailing dot: a.
  return `${base}.md`; // no extension: a
}

// Renames keep a file's own extension rules. A file with an extension never
// loses it: a typed name without one gets the Markdown default, so
// "notes.md" typed as "notes" stays put. A file without an extension
// ("LICENSE", ".env") takes the typed name exactly.
export function withRenameDefault(fromPath: string, toPath: string): string {
  return hasExtension(leafOf(fromPath)) ? withMarkdownDefault(toPath) : toPath;
}

function leafOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

// "a.txt" has an extension. "a", "a." and the dotfile ".env" do not.
function hasExtension(leaf: string): boolean {
  const dot = leaf.lastIndexOf(".");
  return dot > 0 && dot < leaf.length - 1;
}
