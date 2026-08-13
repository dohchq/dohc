import { SITE_SOURCE_CODE_EXT_RE } from "@dohc/workspace-contracts/domain-values";

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

// On Windows an 8.3 short-name alias resolves to its long form, so `DOHC~1`
// addresses `.dohc` and `SHARED~1` addresses `shared-with-me`. A reserved guard
// that only compared literal segments would let those aliases through. This
// detects a short-name-shaped segment whose expansion COULD be `stem` (the 8.3
// base of a reserved name): Windows keeps `base + "~" + digits` within 8 chars,
// shrinking the base as the collision index grows, so the alias prefix is the
// stem truncated to that width. Platform-independent on purpose — a reservation
// bypass must never depend on the guard running on the OS that expands aliases.
function isReserved83Alias(segment: string, stem: string): boolean {
  const match = /^([a-z0-9]{1,8})~(\d+)$/i.exec(segment);
  if (!match) return false;
  const baseLen = Math.min(stem.length, 7 - match[2].length);
  return baseLen >= 1 && match[1].toUpperCase() === stem.slice(0, baseLen);
}

const DOHC_SHORT_NAME_STEM = "DOHC"; // 8.3 base of `.dohc`
const SHARED_WITH_ME_SHORT_NAME_STEM = "SHARED"; // 8.3 base of `shared-with-me`

// Case-insensitive: on default macOS/Windows filesystems .DOHC aliases .dohc,
// so a case-sensitive guard would let writes overwrite dohc metadata. Reserved
// at ANY depth — a nested `notes/.dohc/x` is just as internal as a top-level
// one (the watcher/tree suppress `.dohc` everywhere via hasIgnoredSegment), so
// a user/agent write into one must be refused, not just the first segment.
//
// Exported because this is the READ-side reservation: callers that re-decide
// the reservation on a RESOLVED path (a symlink can spell `.dohc` under any
// name — #638) need the same predicate validateUserReadPath uses, not a copy.
export function isDohcMetadataPath(relativePath: string): boolean {
  return relativePath
    .replaceAll("\\", "/")
    .toLowerCase()
    .split("/")
    .map(stripWindowsAliasSuffix)
    .some((segment) => segment === ".dohc" || isReserved83Alias(segment, DOHC_SHORT_NAME_STEM));
}

// The top-level shared-with-me projection: share mounts materialize there,
// and only mount refresh may write it. It is deliberately a WRITE reservation
// only — the folder exists to be read (user, agent, local sites), so read
// validation (validateUserReadPath) allows it while every write surface
// refuses it.
export function isSharedWithMePath(relativePath: string): boolean {
  const first = relativePath.replaceAll("\\", "/").toLowerCase().split("/").map(stripWindowsAliasSuffix)[0] ?? "";
  return first === "shared-with-me" || isReserved83Alias(first, SHARED_WITH_ME_SHORT_NAME_STEM);
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

// A generated-8.3-SHAPED segment that does NOT alias a reserved name (those
// are caught by Check A). Used only by Check B below.
const SHORT_NAME_ALIAS_RE = /^[^.\s]{1,8}~\d+(?:\.[^.\s]{1,3})?$/;

// CHECK B — MATERIALIZE HAZARD (disk-write safety only). A segment that is
// unsafe to WRITE onto a Windows disk but is otherwise host-legal: an NTFS
// Alternate Data Stream / drive-relative colon, a reserved device basename, or
// a generic 8.3-shape name (`report~1.pdf`). A colon is a legal filename byte
// off Windows and these names are ordinary files there, so this is gated to
// win32 by the caller and runs ONLY at actual disk write/create sinks — never
// on classify/capture/read (that was the over-block). Reserved aliases are
// already refused by Check A before this runs.
function hasMaterializeHazard(segment: string): boolean {
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

// Write-side validation — CHECK A only (reserved-path). Gates classification,
// capture, persisted-row checks, and the engine store write, none of which
// touch the local disk, so it never applies the materialize hazard (Check B):
// a synced/host-legal name like "report~1.pdf" must classify and capture on
// every platform. Actual disk sinks use validateUserMaterializePath instead.
export function validateUserWritePath(
  relativePath: string,
  options: { allowIgnoredSegments?: boolean } = {},
): WritePathValidation {
  return validateWorkspacePath(relativePath, {
    allowIgnoredSegments: options.allowIgnoredSegments,
    reserved: isReservedPath,
    rejectHostUnsafeNames: false,
  });
}

// Disk-write validation — CHECK A + CHECK B. THE validator for every sink that
// does writeFile/mkdir/rename/create of a user-controlled path. Check B is
// gated to Windows (it protects the LOCAL disk), so a name that cannot be
// written here (`nul.md`, `a:b`, `report~1.pdf`) is refused with
// `unsupported-name`; `platform` is injectable for tests. Reserved violations
// still win (Check A runs first).
export function validateUserMaterializePath(
  relativePath: string,
  options: { allowIgnoredSegments?: boolean; platform?: NodeJS.Platform } = {},
): WritePathValidation {
  const platform = options.platform ?? process.platform;
  return validateWorkspacePath(relativePath, {
    allowIgnoredSegments: options.allowIgnoredSegments,
    reserved: isReservedPath,
    rejectHostUnsafeNames: platform === "win32",
  });
}

// Read-side validation — CHECK A only (read variant). The shared-with-me
// projection is readable (a WRITE reservation, not a secret), so only `.dohc`
// metadata stays refused at any depth. Traversal / encoding / ignored-segment
// rules are byte-identical to the write side. The materialize hazard is NOT
// applied to reads (an existing on-disk file must be readable on every
// platform, whatever its name) with ONE win32-only exception: a colon in a
// workspace-RELATIVE read path is always an NTFS Alternate Data Stream
// reference (relative paths carry no drive letters), which dohc never reads —
// so it is refused on Windows. Off Windows a colon is a legal filename byte and
// reads accept it. `platform` is injectable for tests.
export function validateUserReadPath(
  relativePath: string,
  options: { allowIgnoredSegments?: boolean; platform?: NodeJS.Platform } = {},
): WritePathValidation {
  const platform = options.platform ?? process.platform;
  return validateWorkspacePath(relativePath, {
    allowIgnoredSegments: options.allowIgnoredSegments,
    reserved: isDohcMetadataPath,
    rejectHostUnsafeNames: false,
    rejectAdsColon: platform === "win32",
  });
}

function validateWorkspacePath(
  relativePath: string,
  options: {
    allowIgnoredSegments?: boolean;
    reserved: (normalized: string) => boolean;
    rejectHostUnsafeNames: boolean;
    rejectAdsColon?: boolean;
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
  }
  const normalized = segments
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
  if (normalized.length === 0) return { ok: false, reason: "invalid" };
  // Check A (reserved) runs BEFORE Check B so a reserved alias always reports
  // "reserved", never "unsupported-name".
  if (options.reserved(normalized)) return { ok: false, reason: "reserved" };
  if (!options.allowIgnoredSegments && hasIgnoredSegment(normalized)) {
    return { ok: false, reason: "reserved" };
  }
  // Check B (materialize hazard) — disk sinks only, gated to win32 by the
  // caller via rejectHostUnsafeNames (which already covers the ADS colon). On
  // reads only the win32 ADS-colon slice of Check B applies (rejectAdsColon).
  if (options.rejectHostUnsafeNames) {
    for (const segment of normalized.split("/")) {
      if (hasMaterializeHazard(segment)) return { ok: false, reason: "unsupported-name" };
    }
  } else if (options.rejectAdsColon) {
    for (const segment of normalized.split("/")) {
      if (segment.includes(":")) return { ok: false, reason: "unsupported-name" };
    }
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
