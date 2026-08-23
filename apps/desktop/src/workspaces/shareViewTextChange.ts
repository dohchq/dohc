import { createHash } from "node:crypto";
import { validateUserWritePath } from "@dohc/workspace-core";
import type { WorkspaceTextWriteResult } from "./workspaceAssets";
import {
  clearPendingMaterializationPaths,
  materializeSharedViewPaths,
  writePendingMaterializationPaths,
} from "./sharedView";
import type { CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";

/**
 * Internal text-change primitive for ShareViewFiles. Authority and lifecycle
 * admission belong to that owner; this function only applies one text change.
 *
 * The moment is a consequence of the write rather than something a watcher has
 * to notice later, so the change is proposable the moment the save returns.
 */
export async function applyShareViewTextWrite(input: {
  workspaceId: string;
  rootPath: string;
  relativePath: string;
  text: string;
  expectedContentHash: string;
  shareViewStore: () => CaptureVersionedTextStore;
}): Promise<WorkspaceTextWriteResult> {
  const path = validateUserWritePath(input.relativePath);
  if (!path.ok) {
    throw new Error(
      `Invalid write path (${path.reason}): ${input.relativePath}`,
    );
  }
  const store = input.shareViewStore();
  const main = await store.ensureMainVersion({
    workspaceId: input.workspaceId,
  });
  // A received share's store is canonical. Comparing against the projected
  // file would turn repair debt into a false conflict, or accept a stale edit
  // over a newer canonical value.
  const snapshot = await store.readTextFile({
    workspaceId: input.workspaceId,
    versionId: main.id,
    path: path.normalized,
  });
  const current =
    snapshot === null
      ? null
      : (snapshot.sha256 ??
        createHash("sha256").update(snapshot.text, "utf8").digest("hex"));
  if (current !== input.expectedContentHash) {
    return { status: "conflict", currentContentHash: current };
  }
  await writePendingMaterializationPaths(input.rootPath, [path.normalized]);
  await store.writeTextFile({
    workspaceId: input.workspaceId,
    versionId: main.id,
    path: path.normalized,
    text: input.text,
    metadata: { origin: "local-file" },
  });
  // The projection follows the moment, through the SAME materializer the
  // share's pull uses: a share view's disk writes keep the realpath
  // containment that module owns, and the bytes on disk come from the store
  // rather than from a second copy of the text.
  await materializeSharedViewPaths(
    input.rootPath,
    input.workspaceId,
    [{ path: path.normalized, operation: "write", contentKind: "text" }],
    store,
  );
  await clearPendingMaterializationPaths(input.rootPath, [path.normalized]);
  return {
    status: "written",
    contentHash: createHash("sha256").update(input.text).digest("hex"),
  };
}
