import { foldPathSegment, isIgnoredPathSegment, isReserved83Alias } from "./pathFloor";

// POSIX absolute, Windows drive-qualified (C:\ or C:/), or UNC (\\server).
function isAbsolutePathLike(path: string): boolean {
  return (
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\")
  );
}


// Windows silently strips trailing dots/spaces from path segments, so
// ".dohc." and ".dohc " alias the reserved directory there. Strip them before
// any segment comparison. Exported so the engine path floor (secret vs tracked
// classification) applies the same alias normalization these reserved/ignored
// guards do — otherwise `secret.env ` classifies as tracked on Windows while
// naming the real `secret.env` secret on disk.
export function stripWindowsAliasSuffix(segment: string): string {
  return segment.replace(/[. ]+$/, "");
}


// Case-insensitive: on default macOS/Windows filesystems .DOHC aliases .dohc,
// so a case-sensitive guard would let writes overwrite dohc metadata. Reserved
// at any depth — a nested `notes/.dohc/x` is just as internal as a top-level
// one (the watcher/tree suppress `.dohc` everywhere via hasIgnoredSegment), so
// a user/agent write into one must be refused, not just the first segment.
//
// Exported because this is the READ-side reservation: callers that re-decide
// the reservation on a resolved path (a symlink can spell `.dohc` under any
// name — #638) need the same predicate validateUserReadPath uses, not a copy.
export function isDohcMetadataPath(relativePath: string): boolean {
  return relativePath
    .replaceAll("\\", "/")
    .split("/")
    .map(foldPathSegment)
    .map(stripWindowsAliasSuffix)
    .some((segment) => segment === ".dohc" || isReserved83Alias(segment, ".dohc"));
}

// The top-level shared-with-me projection: share mounts materialize there,
// and only mount refresh may write it. It is deliberately a write reservation
// only — the folder exists to be read (user, agent, local sites), so read
// validation (validateUserReadPath) allows it while every write surface
// refuses it.
export function isSharedWithMePath(relativePath: string): boolean {
  const first = relativePath.replaceAll("\\", "/").split("/").map(foldPathSegment).map(stripWindowsAliasSuffix)[0] ?? "";
  return first === "shared-with-me" || isReserved83Alias(first, "shared-with-me");
}

export function isReservedPath(relativePath: string): boolean {
  return isDohcMetadataPath(relativePath) || isSharedWithMePath(relativePath);
}

// Path segments that are dohc/system internals at any depth — hidden from the
// file tree and never recorded into history. One predicate shared by the
// tree walker and the watcher so the two views of "what exists" cannot drift.
// The `.dohc-write-*` prefix is reserved for visible-directory atomic staging:
// it can briefly exist beside user files, but scanners/watchers must treat it
// as dohc noise, never a workspace artifact.
// Capture folds reserved names on every host. Only Windows strips trailing
// dot/space aliases from on-disk names.
export function hasEngineIgnoredSegment(
  relativePath: string,
  platform: string,
): boolean {
  return relativePath.split("/").some((segment) => isIgnoredPathSegment(segment, platform === "win32"));
}

export function hasIgnoredSegment(path: string): boolean {
  return hasEngineIgnoredSegment(path.replaceAll("\\", "/"), "win32");
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

// A generated-8.3-SHAPED segment that does not alias a reserved name (those
// are caught by Check A). Used only by Check B below.
const SHORT_NAME_ALIAS_RE = /^[^.\s]{1,8}~\d+(?:\.[^.\s]{1,3})?$/;

// CHECK B — MATERIALIZE HAZARD (disk-write safety only). A segment that is
// unsafe to write onto a Windows disk but is otherwise host-legal: an NTFS
// Alternate Data Stream / drive-relative colon, a reserved device basename, or
// a generic 8.3-shape name (`report~1.pdf`). A colon is a legal filename byte
// off Windows and these names are ordinary files there, so this is gated to
// win32 by the caller and runs only at actual disk write/create sinks — never
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

// Disk-write validation — CHECK A + CHECK B. The validator for every sink that
// does writeFile/mkdir/rename/create of a user-controlled path. Check B is
// gated to Windows (it protects the LOCAL disk), so a name that cannot be
// written here (`nul.md`, `a:b`, `report~1.pdf`) is refused with
// `unsupported-name`. The caller names the platform whose disk it writes; the
// renderer has no `process` to read one from. Reserved violations still win
// (Check A runs first).
export function validateUserMaterializePath(
  relativePath: string,
  options: { allowIgnoredSegments?: boolean; platform: string },
): WritePathValidation {
  return validateWorkspacePath(relativePath, {
    allowIgnoredSegments: options.allowIgnoredSegments,
    reserved: isReservedPath,
    rejectHostUnsafeNames: options.platform === "win32",
  });
}

// Read-side validation — CHECK A only (read variant). The shared-with-me
// projection is readable (a write reservation, not a secret), so only `.dohc`
// metadata stays refused at any depth. Traversal / encoding / ignored-segment
// rules are byte-identical to the write side. The materialize hazard is not
// applied to reads (an existing on-disk file must be readable on every
// platform, whatever its name) with one win32-only exception: a colon in a
// workspace-RELATIVE read path is always an NTFS Alternate Data Stream
// reference (relative paths carry no drive letters), which dohc never reads —
// so it is refused on Windows. Off Windows a colon is a legal filename byte and
// reads accept it. The caller names the platform whose disk it reads.
export function validateUserReadPath(
  relativePath: string,
  options: { allowIgnoredSegments?: boolean; platform: string },
): WritePathValidation {
  return validateWorkspacePath(relativePath, {
    allowIgnoredSegments: options.allowIgnoredSegments,
    reserved: isDohcMetadataPath,
    rejectHostUnsafeNames: false,
    rejectAdsColon: options.platform === "win32",
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
  // friends can alias ".." or "." there — any segment made only of dots and
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
  // Check A (reserved) runs before Check B so a reserved alias always reports
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
