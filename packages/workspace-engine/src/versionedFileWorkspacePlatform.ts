import type {
  FileWorkspaceCapabilityReport,
  FileWorkspacePlatformMode,
} from "@dohc/workspace-contracts/engine";

export type {
  FileWorkspaceCapabilityReport,
  FileWorkspacePlatformMode,
} from "@dohc/workspace-contracts/engine";

export function resolveFileWorkspacePlatformMode(
  forced?: FileWorkspacePlatformMode,
): FileWorkspacePlatformMode {
  if (forced) return forced;
  return process.platform === "linux" ? "linux-anchored" : "portable";
}

export function getFileWorkspaceCapabilityReport(
  mode: FileWorkspacePlatformMode,
  platform: NodeJS.Platform = process.platform,
): FileWorkspaceCapabilityReport {
  if (mode === "linux-anchored") {
    return {
      platform,
      mode,
      atomicReplace: true,
      symlinkDefense: "descriptor-relative",
      descriptorPinning: true,
      containmentCheck: "realpath-root-containment",
      fileFsync: true,
      parentDirectoryFsync: "supported",
      notes: [],
    };
  }

  // Portable mode reports the degradation for the current platform. When tests
  // force portable mode on Linux, Linux has the same portable capabilities as
  // Darwin here: O_NOFOLLOW is available and directory fsync is supported, but
  // mutations are not descriptor-pinned.
  if (platform === "win32") {
    return {
      platform,
      mode,
      atomicReplace: true,
      symlinkDefense: "lstat-only",
      descriptorPinning: false,
      containmentCheck: "realpath-root-containment",
      fileFsync: true,
      parentDirectoryFsync: "best-effort-noop",
      notes: [
        "Parent-directory identity is re-checked immediately before each mutating syscall instead of being pinned by an open directory file descriptor.",
        "Open-time O_NOFOLLOW is unavailable; symlink refusal relies on an lstat check immediately before the operation.",
        "Parent directory fsync is unsupported on Windows and is skipped; only the file itself is fsync'd.",
      ],
    };
  }

  return {
    platform,
    mode,
    atomicReplace: true,
    symlinkDefense: "o-nofollow-lstat",
    descriptorPinning: false,
    containmentCheck: "realpath-root-containment",
    fileFsync: true,
    parentDirectoryFsync: "supported",
    notes: [
      "Parent-directory identity is re-checked immediately before each mutating syscall instead of being pinned by an open directory file descriptor; a directory-swap attack has a narrower window than on Linux but is not fully eliminated.",
    ],
  };
}
