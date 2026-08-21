import { createHash } from "node:crypto";
import { validateUserWritePath } from "@dohc/workspace-core";
import { SharedFileReadOnlyError } from "@dohc/workspace-contracts/relay";
import {
  withOrderedWorkspaceTextPath,
  writeWorkspaceText,
  type WorkspaceTextReadResult,
  type WorkspaceTextWriteResult,
} from "./workspaceAssets";
import {
  clearPendingMaterializationPaths,
  materializeSharedViewPaths,
  writePendingMaterializationPaths,
} from "./sharedView";
import {
  shareViewTakesLocalWrites,
  type ShareViewWriteScope,
} from "./shareWriteGate";
import type { CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";

// WHICH SURFACE OWNS A WORKSPACE'S FILES — one rule, one place (#646 PR3).
//
// An ORDINARY workspace's folder is the source of truth. The editor writes the
// file, the watcher settles the batch, and the capture turns it into a moment.
// A write that also wrote a moment here would journal the same change twice.
//
// A SHARE VIEW is the other way round. Its engine store is the source of truth
// and its folder is a projection of that store, so nothing watches the folder.
// A write that only touched disk would leave no moment, and a moment is what
// the recipient sends to the granter. So the write goes through the engine, and
// the projection follows it — the same shape the share view's chat writes use.
//
// The two branches must not drift, which is why the level rule is asked once,
// through `shareViewTakesLocalWrites`, and never re-spelled here.

export async function routeWorkspaceTextWrite(input: {
  workspaceId: string;
  rootPath: string;
  relativePath: string;
  text: string;
  expectedContentHash: string;
  // The share view this workspace IS, or null for an ordinary workspace. The
  // caller states the share identity; this module states what it means for the
  // write.
  shareView: ShareViewWriteScope | null;
  // The share view's engine store. Resolved lazily: an ordinary workspace must
  // never open one on the editor's save path.
  shareViewStore: () => CaptureVersionedTextStore;
}): Promise<WorkspaceTextWriteResult> {
  if (input.shareView) {
    // A share view's folder is never written directly, so a level that takes
    // no local writes has nowhere for this save to go. main's
    // `assertWritableWorkspace` refuses it before the handler reaches here;
    // this is the same rule at the seam that would otherwise write.
    if (!shareViewTakesLocalWrites(input.shareView)) {
      throw new SharedFileReadOnlyError();
    }
    return writeShareViewText(input);
  }
  return writeWorkspaceText(
    input.rootPath,
    input.relativePath,
    input.text,
    input.expectedContentHash,
  );
}

/**
 * The recipient's own edit of a shared file: an engine moment first, then the
 * projection on disk.
 *
 * The moment is a consequence of the write rather than something a watcher has
 * to notice later, so the change is proposable the moment the save returns.
 */
async function writeShareViewText(input: {
  workspaceId: string;
  rootPath: string;
  relativePath: string;
  text: string;
  expectedContentHash: string;
  shareViewStore: () => CaptureVersionedTextStore;
}): Promise<WorkspaceTextWriteResult> {
  const path = validateUserWritePath(input.relativePath);
  if (!path.ok) {
    throw new Error(`Invalid write path (${path.reason}): ${input.relativePath}`);
  }
  // Under the SAME per-file ordering the disk writer takes. Two saves racing
  // on one path would otherwise both read the pre-save bytes, both pass the
  // compare below, and both journal a moment.
  return withOrderedWorkspaceTextPath(input.rootPath, input.relativePath, async (readCurrent) => {
    // The optimistic guard every editor save carries, answered from the bytes
    // the editor read. Checked BEFORE the moment: a stale save must be
    // refused, not journaled and then refused.
    const current = await currentContentHash(readCurrent);
    if (current !== input.expectedContentHash) {
      return { status: "conflict", currentContentHash: current };
    }
    const store = input.shareViewStore();
    const main = await store.ensureMainVersion({ workspaceId: input.workspaceId });
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
    await writePendingMaterializationPaths(input.rootPath, [path.normalized]);
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
  });
}

// The hash the disk writer would have compared against, read from the target
// this save already holds — never through `readWorkspaceText`, which queues on
// that same target and would wait on a lock this caller is holding.
//
// A MISSING file reads as null, the same answer the disk writer gives for a
// target that is not there, and null never equals a hash the editor holds.
// Every other failure — a path that escapes the workspace, an unreadable
// file — is raised, never softened into a conflict.
async function currentContentHash(
  readCurrent: () => Promise<WorkspaceTextReadResult>,
): Promise<string | null> {
  try {
    return (await readCurrent()).contentHash;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}
