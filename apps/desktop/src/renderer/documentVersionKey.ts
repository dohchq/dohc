export function documentKey(workspaceId: string, path: string): string {
  return JSON.stringify([workspaceId, path]);
}

export function documentVersionKey(
  workspaceId: string,
  path: string,
  reopenKey: number | undefined,
): string {
  return JSON.stringify([workspaceId, path, reopenKey ?? null]);
}
