export function documentVersionKey(
  workspaceId: string,
  path: string,
  reopenKey: number | undefined,
): string {
  return JSON.stringify([workspaceId, path, reopenKey ?? null]);
}
