import { join } from "node:path";
import type {
  CollectionRecordEditAdapter,
  CollectionRecordEditContext,
} from "@dohc/automation-executor/collection-record-edits";
import {
  readWorkspaceText,
  withStaleSensitiveWorkspaceOperation,
} from "./workspaceAssets";
import { requirePublishedWrite, type WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { createFile, CreatedFileWriteError } from "./workspaceFiles";

/** What this desktop's record writes in one workspace run over. Main supplies it. */
export interface DesktopRecordEditHost {
  capture: Pick<WorkspaceEngineCapture, "openYDocSession" | "writeAuthoredFile">;
  workspaceRoot: string;
  /** Engine adapter runner; resolves null when the engine is unavailable. */
  withAdapter<T>(
    work: (adapter: CollectionRecordEditAdapter) => Promise<T>,
  ): Promise<T | null>;
  /**
   * Subscribes to the engine's announcement of each settled capture pass in
   * this workspace: the paths the pass captured or reconciled, or null when
   * the announcement did not list them all. Returns the unsubscribe.
   */
  onCaptureSettled(listener: (paths: readonly string[] | null) => void): () => void;
  signal: AbortSignal;
}

/**
 * The record edit context over this desktop's capture. A record opens as the
 * capture's live document session. An automation's file is written through
 * the engine with the automation as the moment's author. Anyone else's is
 * created on disk, as the createWorkspaceFile IPC does, and capture takes it
 * from there. Each settled capture pass is the news that records may have
 * been adopted.
 */
export function desktopRecordEditContext(host: DesktopRecordEditHost): CollectionRecordEditContext {
  const { capture, workspaceRoot, signal } = host;
  return {
    openRecord: (path) =>
      capture.openYDocSession({
        path,
        // A record file is a live Markdown document.
        contentKind: "richdoc",
        // The capture already folds remote updates into the session's
        // canonical doc; the seam holds no second replica to notify.
        onRemoteUpdate: () => undefined,
      }),
    async createFile(path, text, author) {
      if (author.kind === "automation") {
        requirePublishedWrite(path, await capture.writeAuthoredFile(join(workspaceRoot, path), text, author, {
          createOnly: true,
          signal,
        }));
        return path;
      }
      return await withStaleSensitiveWorkspaceOperation(
        workspaceRoot,
        async () => await createFile(workspaceRoot, path, text, { exclusive: true }),
      );
    },
    isIncompleteFileWrite: (error) => error instanceof CreatedFileWriteError,
    readText: (path) => readWorkspaceText(workspaceRoot, path),
    withAdapter: host.withAdapter,
    onRecordsChanged: host.onCaptureSettled,
    signal,
  };
}
