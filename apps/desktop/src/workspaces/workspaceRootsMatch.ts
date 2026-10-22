import { normalizeRootPath } from "@dohc/workspace-core";

// The registry uses forward slashes; physical operations use native paths.
export function workspaceRootsMatch(left: string, right: string): boolean {
  return normalizeRootPath(left, process.platform) === normalizeRootPath(right, process.platform);
}
