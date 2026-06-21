import { SITE_SOURCE_CODE_EXT_RE } from "@dohc/workspace-contracts/domain";

export function defaultWorkspaceRoot(homeDir: string): string {
  return `${homeDir.replace(/\/+$/, "")}/dohc`;
}

export type FolderValidation = { ok: true } | { ok: false; reason: string };

// POSIX absolute, Windows drive-qualified (C:\ or C:/), or UNC (\\server).
function isAbsolutePathLike(path: string): boolean {
  return (
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\")
  );
}

export function validateAttachedFolder(path: string): FolderValidation {
  if (!isAbsolutePathLike(path)) {
    return { ok: false, reason: "attached folders must be absolute paths" };
  }
  return { ok: true };
}

// Windows silently strips trailing dots/spaces from path segments, so
// ".dohc." and ".dohc " alias the reserved directory there. Strip them before
// any segment comparison.
function stripWindowsAliasSuffix(segment: string): string {
  return segment.replace(/[. ]+$/, "");
}

// Case-insensitive: on default macOS/Windows filesystems .DOHC aliases .dohc,
// so a case-sensitive guard would let writes overwrite dohc metadata. Reserved
// at ANY depth — a nested `notes/.dohc/x` is just as internal as a top-level
// one (the watcher/tree suppress `.dohc` everywhere via hasIgnoredSegment), so
// a user/agent write into one must be refused, not just the first segment.
export function isReservedPath(relativePath: string): boolean {
  return relativePath
    .replaceAll("\\", "/")
    .toLowerCase()
    .split("/")
    .some((segment) => stripWindowsAliasSuffix(segment) === ".dohc");
}

// Path segments that are dohc/system internals at ANY depth — hidden from the
// file tree and never recorded into history. One predicate shared by the
// tree walker and the watcher so the two views of "what exists" cannot drift.
const IGNORED_SEGMENTS = new Set([".dohc", ".git", "node_modules"]);
export function hasIgnoredSegment(relativePath: string): boolean {
  return relativePath
    .replaceAll("\\", "/")
    .toLowerCase()
    .split("/")
    .some((segment) => IGNORED_SEGMENTS.has(stripWindowsAliasSuffix(segment)));
}

export function isSiteSourcePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  const siteSegmentIndex = segments.findIndex((segment) => segment.toLowerCase() === "sites");
  return (
    siteSegmentIndex >= 0 &&
    siteSegmentIndex < segments.length - 2 &&
    SITE_SOURCE_CODE_EXT_RE.test(normalized)
  );
}

export type WritePathValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: "traversal" | "absolute" | "reserved" | "invalid" };

export function validateUserWritePath(relativePath: string): WritePathValidation {
  if (relativePath.includes("\0")) return { ok: false, reason: "invalid" };
  if (isAbsolutePathLike(relativePath)) return { ok: false, reason: "absolute" };
  // Percent-encoded dots/separators are traversal in disguise; decode until
  // stable so double-encoding (%252e -> %2e -> .) cannot slip through.
  let decoded = relativePath;
  for (;;) {
    const next = decoded
      .replace(/%25/gi, "%")
      .replace(/%2e/gi, ".")
      .replace(/%2f/gi, "/")
      .replace(/%5c/gi, "\\");
    if (next === decoded) break;
    decoded = next;
  }
  // Decoding may reveal an absolute path (%2fetc, C%3A is out of scope but
  // drive letters survive decoding as-is).
  if (isAbsolutePathLike(decoded)) return { ok: false, reason: "absolute" };
  const segments = decoded.replaceAll("\\", "/").split("/");
  // Windows strips trailing dots/spaces from segments, so ".. ", "..." and
  // friends can alias ".." or "." there — any segment made ONLY of dots and
  // spaces (beyond the exact "" / "." pass-throughs) is rejected outright,
  // as traversal when it smells like one.
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return { ok: false, reason: "traversal" };
    if (/^[. ]+$/.test(segment)) {
      return segment.includes("..")
        ? { ok: false, reason: "traversal" }
        : { ok: false, reason: "invalid" };
    }
  }
  const normalized = segments
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
  if (normalized.length === 0) return { ok: false, reason: "invalid" };
  if (isReservedPath(normalized)) return { ok: false, reason: "reserved" };
  return { ok: true, normalized };
}

// Lexical normalization: resolves "." and ".." segments and separator noise
// WITHOUT touching the filesystem, so dot-segment disguises ("/home/ice/.")
// cannot slip past string comparisons. Preserves drive and UNC prefixes.
export function normalizeAbsolutePath(path: string): string {
  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? "";
  const rest = drive ? path.slice(drive.length) : path;
  // A real UNC path needs a server segment after \\ or //; a bare POSIX
  // leading // (or ///) is just the filesystem root and must collapse to /,
  // otherwise "//home/ice" would dodge the home-directory guard.
  const uncMatch = /^([\\/])\1+([^\\/])/.exec(rest);
  const unc = drive === "" && uncMatch !== undefined && uncMatch !== null;
  const segments = rest.replaceAll("\\", "/").split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const prefix = unc ? "//" : "/";
  const joined = `${drive}${prefix}${out.join("/")}`;
  const trimmed = joined.replace(/\/+$/, "");
  return trimmed || (drive ? drive : "/");
}

export type RootChoiceValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: string };

// Registry policy: a workspace root must be a real folder choice — never the
// filesystem root or the home directory itself, which would hand workspace
// file operations the user's entire disk or home. Callers must use the
// returned normalized path so registry equality checks are canonical.
export function validateWorkspaceRootChoice(
  rootPath: string,
  homeDir: string,
): RootChoiceValidation {
  const attached = validateAttachedFolder(rootPath);
  if (!attached.ok) return attached;
  const normalized = normalizeAbsolutePath(rootPath);
  const home = normalizeAbsolutePath(homeDir);
  // Filesystem root, a drive root (C:), or a UNC server/share root (//server,
  // //server/share) — never a workspace.
  if (
    normalized === "/" ||
    /^[A-Za-z]:$/.test(normalized) ||
    /^\/\/[^/]*(\/[^/]*)?$/.test(normalized)
  ) {
    return { ok: false, reason: "workspace root cannot be the filesystem root" };
  }
  // Case-insensitive compare: on macOS/Windows "/Home/Ice" aliases the home
  // directory, so a case variant must not slip past this guard.
  if (normalized.toLowerCase() === home.toLowerCase()) {
    return { ok: false, reason: "workspace root cannot be the home directory itself" };
  }
  return { ok: true, normalized };
}

export type PathClassification =
  | { kind: "database" }
  | { kind: "file" };

const DATABASE_EXTENSIONS = [".sqlite", ".sqlite3", ".db"];

export function classifyPath(relativePath: string): PathClassification {
  const lower = relativePath.toLowerCase();
  if (DATABASE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return { kind: "database" };
  }
  return { kind: "file" };
}

// The ONE extension -> media-type table (check-architecture-debt single-owner
// rule). Returns null for unknown extensions — each caller owns its fallback.
const MEDIA_TYPES: Record<string, string> = {
  csv: "text/csv",
  db: "application/vnd.sqlite3",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  jsonl: "application/x-ndjson",
  m4a: "audio/mp4",
  markdown: "text/markdown",
  md: "text/markdown",
  ndjson: "application/x-ndjson",
  pdf: "application/pdf",
  png: "image/png",
  sqlite: "application/vnd.sqlite3",
  sqlite3: "application/vnd.sqlite3",
  txt: "text/plain",
};

export function mediaTypeForPath(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  return MEDIA_TYPES[path.slice(dot + 1).toLowerCase()] ?? null;
}
