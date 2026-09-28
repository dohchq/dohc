import { SITE_SOURCE_CODE_EXT_RE } from "@dohc/workspace-contracts/domain-values";

export function defaultWorkspaceRoot(homeDir: string): string {
  return `${homeDir.replace(/\/+$/, "")}/dohc`;
}

type FolderValidation = { ok: true } | { ok: false; reason: string };

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

export { stripWindowsAliasSuffix, isDohcMetadataPath, isSharedWithMePath, isReservedPath, hasEngineIgnoredSegment, hasIgnoredSegment, validateUserWritePath, validateUserMaterializePath, validateUserReadPath, type WritePathValidation } from "@dohc/workspace-contracts/workspace-paths";

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

// Lexical normalization: resolves "." and ".." segments and separator noise
// without touching the filesystem, so dot-segment disguises ("/home/user/.")
// cannot slip past string comparisons. Preserves drive and UNC prefixes.
export function normalizeAbsolutePath(path: string): string {
  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? "";
  const rest = drive ? path.slice(drive.length) : path;
  // A real UNC path needs a server segment after \\ or //; a bare POSIX
  // leading // (or ///) is just the filesystem root and must collapse to /,
  // otherwise "//home/user" would dodge the home-directory guard.
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

type RootChoiceValidation =
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
  // Case-insensitive compare: on macOS/Windows "/Home/Sam" aliases the home
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

// The one extension -> media-type table (check-architecture-debt single-owner
// rule). Returns null for unknown extensions — each caller owns its fallback.
const MEDIA_TYPES: Record<string, string> = {
  cjs: "text/javascript",
  cts: "application/typescript",
  csv: "text/csv",
  css: "text/css",
  db: "application/vnd.sqlite3",
  excalidraw: "application/json",
  htm: "text/html",
  html: "text/html",
  js: "text/javascript",
  jsx: "text/javascript",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  jsonl: "application/x-ndjson",
  m4a: "audio/mp4",
  markdown: "text/markdown",
  md: "text/markdown",
  mjs: "text/javascript",
  mts: "application/typescript",
  ndjson: "application/x-ndjson",
  pdf: "application/pdf",
  png: "image/png",
  scss: "text/css",
  sh: "text/plain",
  sqlite: "application/vnd.sqlite3",
  sqlite3: "application/vnd.sqlite3",
  txt: "text/plain",
  ts: "application/typescript",
  tsx: "application/typescript",
};

export function mediaTypeForPath(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  return MEDIA_TYPES[path.slice(dot + 1).toLowerCase()] ?? null;
}
