export interface WorkspaceFileListingScope {
  path?: string;
  recursive?: boolean;
}

// Match literal, case-sensitive workspace paths, including an exact
// file path. The scope narrows a listing; it never grants read authority.
export function matchesFileListingScope(
  path: string,
  scope: WorkspaceFileListingScope = {},
): boolean {
  const root = scope.path ?? ".";
  if (root !== "." && path !== root && !path.startsWith(`${root}/`)) return false;
  const remainder = root === "." ? path : path.slice(root.length + 1);
  return scope.recursive !== false || !remainder.includes("/");
}

export function directoryMayContainListedFiles(
  path: string,
  scope: WorkspaceFileListingScope = {},
): boolean {
  const root = scope.path ?? ".";
  if (root === ".") return scope.recursive !== false;
  return (
    path === root ||
    root.startsWith(`${path}/`) ||
    (scope.recursive !== false && path.startsWith(`${root}/`))
  );
}
