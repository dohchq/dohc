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
// any segment comparison. Exported so the engine path floor (secret vs tracked
// classification) applies the SAME alias normalization these reserved/ignored
// guards do — otherwise `secret.env ` classifies as tracked on Windows while
// naming the real `secret.env` secret on disk.
export function stripWindowsAliasSuffix(segment: string): string {
  return segment.replace(/[. ]+$/, "");
}

// Case-insensitive: on default macOS/Windows filesystems .DOHC aliases .dohc,
// so a case-sensitive guard would let writes overwrite dohc metadata. Reserved
// at ANY depth — a nested `notes/.dohc/x` is just as internal as a top-level
// one (the watcher/tree suppress `.dohc` everywhere via hasIgnoredSegment), so
// a user/agent write into one must be refused, not just the first segment.
function isDohcMetadataPath(relativePath: string): boolean {
  return relativePath
    .replaceAll("\\", "/")
    .toLowerCase()
    .split("/")
    .map(stripWindowsAliasSuffix)
    .some((segment) => segment === ".dohc");
}

// The top-level shared-with-me projection: share mounts materialize there,
// and only mount refresh may write it. It is deliberately a WRITE reservation
// only — the folder exists to be read (user, agent, local sites), so read
// validation (validateUserReadPath) allows it while every write surface
// refuses it.
export function isSharedWithMePath(relativePath: string): boolean {
  const segments = relativePath
    .replaceAll("\\", "/")
    .toLowerCase()
    .split("/")
    .map(stripWindowsAliasSuffix);
  return segments[0] === "shared-with-me";
}

export function isReservedPath(relativePath: string): boolean {
  return isDohcMetadataPath(relativePath) || isSharedWithMePath(relativePath);
}

// Path segments that are dohc/system internals at ANY depth — hidden from the
// file tree and never recorded into history. One predicate shared by the
// tree walker and the watcher so the two views of "what exists" cannot drift.
// The `.dohc-write-*` prefix is reserved for visible-directory atomic staging:
// it can briefly exist beside user files, but scanners/watchers must treat it
// as dohc noise, never a workspace artifact.
const IGNORED_SEGMENTS = new Set([".dohc", ".git", "node_modules"]);
const IGNORED_FILE_PREFIXES = [".dohc-write-"];
export function hasIgnoredSegment(relativePath: string): boolean {
  return relativePath
    .replaceAll("\\", "/")
    .toLowerCase()
    .split("/")
    .some((segment) => {
      const normalized = stripWindowsAliasSuffix(segment);
      return (
        IGNORED_SEGMENTS.has(normalized) ||
        IGNORED_FILE_PREFIXES.some((prefix) => normalized.startsWith(prefix))
      );
    });
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

// Win32 resolves these basenames to devices — bare or with any extension
// ("nul", "NUL.md", "com1.tar.gz") — so such a segment never lands in the
// workspace tree. The superscript digits alias the ASCII ones (COM¹ = COM1).
const WINDOWS_DEVICE_NAME_RE =
  /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$|clock\$)$/i;

// Device matching uses the name before the first dot with trailing spaces
// stripped: "NUL .txt" opens the NUL device too.
function isWindowsDeviceSegment(segment: string): boolean {
  const base = segment.split(".", 1)[0] ?? segment;
  return WINDOWS_DEVICE_NAME_RE.test(stripWindowsAliasSuffix(base));
}

// Generated 8.3 short names ("DOHC~1", "SHARED~1", "SECRET~1.ENV") can alias
// ANY long name on Windows volumes with short-name generation, so a
// short-name-shaped segment can address .dohc, shared-with-me, or a secret
// file without ever matching the literal segment guards above. The disk
// meaning of the shape is ambiguous, so reject it outright.
const SHORT_NAME_ALIAS_RE = /^[^.\s]{1,8}~\d+(?:\.[^.\s]{1,3})?$/;

// NTFS Alternate Data Stream / drive-relative colons, reserved device names,
// and generated 8.3 short-name aliases are all WINDOWS filesystem behaviors:
// a colon is a legal filename byte on macOS/Linux, `DOHC~1` does not alias
// `.dohc` where 8.3 generation does not exist, and `nul.md` is an ordinary
// file. So this predicate only fires when the CURRENT host is Windows —
// rejecting these host-legal names elsewhere would refuse real files for a
// threat that cannot exist on that host. A remote Windows peer self-protects
// at its OWN materialize boundary.
function isHostUnsafeSegment(segment: string): boolean {
  return (
    segment.includes(":") ||
    isWindowsDeviceSegment(segment) ||
    SHORT_NAME_ALIAS_RE.test(stripWindowsAliasSuffix(segment))
  );
}

export type WritePathValidation =
  | { ok: true; normalized: string }
  | {
      ok: false;
      reason: "traversal" | "absolute" | "reserved" | "invalid" | "unsupported-name";
    };

// Write-side validation. The host-unsafe-name checks (colon/ADS, device
// names, 8.3 aliases) protect the LOCAL disk we are about to write to, so
// they run only when the current host is Windows — `platform` is injectable
// for tests but defaults to the real process platform.
export function validateUserWritePath(
  relativePath: string,
  options: { allowIgnoredSegments?: boolean; platform?: NodeJS.Platform } = {},
): WritePathValidation {
  const platform = options.platform ?? process.platform;
  return validateWorkspacePath(relativePath, {
    ...options,
    reserved: isReservedPath,
    rejectHostUnsafeNames: platform === "win32",
  });
}

// Read-side validation: identical pipeline to validateUserWritePath except
// the shared-with-me projection is readable — it is a WRITE reservation, not
// a secret. `.dohc` metadata stays refused at any depth, and traversal /
// encoding / ignored-segment rules are byte-identical to the write side so
// the two validators can never drift on what a path MEANS. Host-unsafe-name
// checks are NEVER applied to reads: a file that already exists on disk must
// be readable and capturable on every platform, whatever its name.
export function validateUserReadPath(
  relativePath: string,
  options: { allowIgnoredSegments?: boolean } = {},
): WritePathValidation {
  return validateWorkspacePath(relativePath, {
    ...options,
    reserved: isDohcMetadataPath,
    rejectHostUnsafeNames: false,
  });
}

function validateWorkspacePath(
  relativePath: string,
  options: {
    allowIgnoredSegments?: boolean;
    reserved: (normalized: string) => boolean;
    rejectHostUnsafeNames: boolean;
  },
): WritePathValidation {
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
    // Colon/ADS, device names, and 8.3 aliases are unsafe to WRITE on Windows
    // (see isHostUnsafeSegment); reject them only when writing to a Windows
    // host so reads and non-win32 writes keep host-legal names.
    if (options.rejectHostUnsafeNames && isHostUnsafeSegment(segment)) {
      return { ok: false, reason: "unsupported-name" };
    }
  }
  const normalized = segments
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
  if (normalized.length === 0) return { ok: false, reason: "invalid" };
  if (options.reserved(normalized)) return { ok: false, reason: "reserved" };
  if (!options.allowIgnoredSegments && hasIgnoredSegment(normalized)) {
    return { ok: false, reason: "reserved" };
  }
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
  cjs: "text/javascript",
  cts: "application/typescript",
  csv: "text/csv",
  css: "text/css",
  db: "application/vnd.sqlite3",
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
