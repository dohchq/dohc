import type { ChatBookmark } from "@dohc/workspace-engine";
import type {
  WorkspaceEngineCapture,
  WorkspaceGeneratedTextArchiveResult,
  WorkspaceGeneratedTextWriteResult,
} from "./workspaceEngineCapture";
import { isChatBookmarkProjectionFor } from "./chatBookmarkProjection";

type GeneratedBookmarkWriter = Pick<WorkspaceEngineCapture, "writeGeneratedTextFile">;
type GeneratedBookmarkArchiver = Pick<WorkspaceEngineCapture, "archiveGeneratedTextFile">;

type BookmarkProjectionIdentity = Pick<
  ChatBookmark,
  "bookmarkId" | "destinationPath" | "projectionObjectId"
>;

function bookmarkProjectionIdentity(bookmarkId: string) {
  return (text: string) => isChatBookmarkProjectionFor(text, bookmarkId);
}

/**
 * Writes a bookmark projection using only authority the bookmark already owns.
 * When a legacy/crash-interrupted projection lacks its persisted object id,
 * recovery happens atomically through the durable bookmark frontmatter marker.
 * A path collision without that exact marker always fails closed.
 */
export function writeChatBookmarkProjection(input: {
  bookmark: BookmarkProjectionIdentity;
  text: string;
  capture: GeneratedBookmarkWriter;
}): Promise<WorkspaceGeneratedTextWriteResult> {
  return input.capture.writeGeneratedTextFile({
    path: input.bookmark.destinationPath,
    text: input.text,
    ...(input.bookmark.projectionObjectId
      ? { expectedObjectId: input.bookmark.projectionObjectId }
      : {
          recoverExistingText: bookmarkProjectionIdentity(input.bookmark.bookmarkId),
        }),
  });
}

export function archiveChatBookmarkProjection(input: {
  bookmark: BookmarkProjectionIdentity;
  archivedPath: string;
  capture: GeneratedBookmarkArchiver;
}): Promise<WorkspaceGeneratedTextArchiveResult> {
  return input.capture.archiveGeneratedTextFile({
    fromPath: input.bookmark.destinationPath,
    toPath: input.archivedPath,
    ...(input.bookmark.projectionObjectId
      ? { expectedObjectId: input.bookmark.projectionObjectId }
      : {
          recoverExistingText: bookmarkProjectionIdentity(input.bookmark.bookmarkId),
        }),
  });
}
