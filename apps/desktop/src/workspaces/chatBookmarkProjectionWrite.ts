import type { ChatBookmark } from "@dohc/workspace-engine";
import type {
  WorkspaceEngineCapture,
  WorkspaceGeneratedTextWriteResult,
} from "./workspaceEngineCapture";

type GeneratedBookmarkWriter = Pick<WorkspaceEngineCapture, "writeGeneratedTextFile">;

/**
 * Writes a bookmark projection using only authority the bookmark already owns.
 * A first projection deliberately omits expectedObjectId, so the capture layer
 * refuses a non-identical pre-existing destination instead of adopting it.
 */
export function writeChatBookmarkProjection(input: {
  bookmark: Pick<ChatBookmark, "destinationPath" | "projectionObjectId">;
  text: string;
  capture: GeneratedBookmarkWriter;
}): Promise<WorkspaceGeneratedTextWriteResult> {
  return input.capture.writeGeneratedTextFile({
    path: input.bookmark.destinationPath,
    text: input.text,
    ...(input.bookmark.projectionObjectId
      ? { expectedObjectId: input.bookmark.projectionObjectId }
      : { createOnly: true as const }),
  });
}
