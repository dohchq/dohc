// New files are markdown by default: a typed name whose leaf has no
// extension gets ".md" appended. An explicit extension ("notes.txt") is
// respected exactly, dotfiles (".env") stay literal — a leading dot is not
// an extension — and a trailing dot reads as "extension not typed yet", so
// "notes." becomes "notes.md". Renames never go through this helper: they
// stay literal so users can strip or change extensions deliberately.
export function withMarkdownDefault(relativePath: string): string {
  // Backend validation accepts "\" as a separator too and drops empty
  // segments (workspace-core paths.ts), so a trailing separator is noise:
  // "notes/" creates the file "notes". Strip it so the default still lands,
  // and derive the leaf on either separator.
  const base = relativePath.replace(/[/\\]+$/, "");
  const leaf = base.slice(
    Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\")) + 1,
  );
  if (!leaf || leaf === "." || leaf === "..") return relativePath;
  const dot = leaf.lastIndexOf(".");
  if (dot === 0 && leaf.length > 1) return relativePath; // dotfile: .env
  if (dot > 0 && dot < leaf.length - 1) return relativePath; // extension: a.txt
  if (dot === leaf.length - 1) return `${base}md`; // trailing dot: a.
  return `${base}.md`; // no extension: a
}
