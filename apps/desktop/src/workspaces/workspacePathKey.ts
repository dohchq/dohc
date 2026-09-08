export function workspacePathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}
