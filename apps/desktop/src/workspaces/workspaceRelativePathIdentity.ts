/** Filesystem identity for an already-normalized workspace-relative path. */
export function workspaceRelativePathIdentity(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? path.toLowerCase() : path;
}

export function workspaceRelativePathsEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    workspaceRelativePathIdentity(left, platform) ===
    workspaceRelativePathIdentity(right, platform)
  );
}

export function workspaceRelativePathIsAtOrUnder(
  path: string,
  pathOrPrefix: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const candidate = workspaceRelativePathIdentity(path, platform);
  const prefix = workspaceRelativePathIdentity(pathOrPrefix, platform);
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}
