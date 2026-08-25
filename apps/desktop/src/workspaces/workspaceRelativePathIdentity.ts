/** Identity for a filesystem-resolved workspace-relative path. */
export function workspaceRelativePathIdentity(path: string): string {
  // Callers resolve existing entries before they reach this boundary. On a
  // case-insensitive filesystem that collapses aliases to the same physical
  // spelling; keeping the result exact preserves distinct entries in a
  // case-sensitive Windows directory.
  return path;
}

export function workspaceRelativePathsEqual(
  left: string,
  right: string,
): boolean {
  return workspaceRelativePathIdentity(left) === workspaceRelativePathIdentity(right);
}

export function workspaceRelativePathIsAtOrUnder(
  path: string,
  pathOrPrefix: string,
): boolean {
  const candidate = workspaceRelativePathIdentity(path);
  const prefix = workspaceRelativePathIdentity(pathOrPrefix);
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}
