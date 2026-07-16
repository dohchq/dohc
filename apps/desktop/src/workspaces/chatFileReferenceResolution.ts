export interface ResolvedTrackedChatFilePath {
  objectId: string;
  path: string;
}

/**
 * Resolves a chat mention path without making edge spaces ambiguous.
 *
 * Files whose names really begin or end with spaces win when they exist. The
 * trimmed retry is only a compatibility path for hand-typed tokens such as
 * `@[ docs/plan.md]` and `@[docs/plan.md #scope]`.
 */
export async function resolveTrackedChatFilePath(
  path: string,
  fileObjectIdForPath: (path: string) => Promise<string | null>,
): Promise<ResolvedTrackedChatFilePath | null> {
  const exactObjectId = await fileObjectIdForPath(path);
  if (exactObjectId) {
    return { objectId: exactObjectId, path };
  }

  const trimmedPath = path.trim();
  if (trimmedPath === path) return null;

  const trimmedObjectId = await fileObjectIdForPath(trimmedPath);
  return trimmedObjectId
    ? { objectId: trimmedObjectId, path: trimmedPath }
    : null;
}
