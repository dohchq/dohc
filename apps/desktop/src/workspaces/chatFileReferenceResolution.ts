export interface ResolvedTrackedChatFilePath {
  objectId: string;
  path: string;
}

interface ChatFileMentionPathInput {
  /** Object identity currently assigned to the requested path, when tracked. */
  requestedObjectId: string | null;
  attachmentObjectId?: string;
  attachmentPathHint?: string;
  pathByObjectId: ReadonlyMap<string, string>;
}

/**
 * Resolves a stored mention only through the identity used for its lookup.
 *
 * A path-hint fallback is used only when the requested path is not currently
 * tracked. Object-owned rows with that old hint may have moved elsewhere, so
 * exposing their current path here would attach the old conversation to a new
 * or untracked file that reused the hint.
 */
export function resolveChatFileMentionPath({
  requestedObjectId,
  attachmentObjectId,
  attachmentPathHint,
  pathByObjectId,
}: ChatFileMentionPathInput): string | null {
  if (!requestedObjectId) {
    return attachmentObjectId ? null : attachmentPathHint ?? null;
  }
  if (attachmentObjectId !== requestedObjectId) return null;
  return pathByObjectId.get(attachmentObjectId) ?? null;
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
