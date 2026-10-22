import { normalizeRootPath } from "@dohc/workspace-core";

// The registry uses forward slashes; physical operations use native paths.
export function workspaceRootsMatch(left: string, right: string): boolean {
  return normalizeRootPath(left, process.platform) === normalizeRootPath(right, process.platform);
}

export function workspaceRootForOperation(operationRootPath: string, requestedRootPath: string): string {
  if (!workspaceRootsMatch(operationRootPath, requestedRootPath)) {
    throw new Error("This workspace changed while this ran. Try again.");
  }
  return operationRootPath;
}
