import { createHash, randomUUID } from "node:crypto";
import { lstat, open, rename, rm } from "node:fs/promises";
import { z } from "zod";
import { HistoryOperationId } from "@dohc/workspace-contracts/history-operation";
import type { DohcPathGuard } from "@dohc/workspace-core";
import { readOwnedFile } from "@dohc/workspace-core/owned-file";
import { localStateFolder, LocalStateUnavailableError, type LocalStateWorkspace } from "./workspaceLocalState";
import { basename, join, posix } from "node:path";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { withExclusiveWorkspaceOperation } from "./workspaceAssets";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { historyPathAdmission } from "./workspaceEnginePolicyFile";
import { admitPath } from "./workspaceFileMoves";
import { StoredEntryIdentityUnavailable } from "./storedEntryPath";
import { refuseMoveAcrossShareMount } from "./shareMounts";
import { storedShareMounts, shareMountRegistryIsPresent } from "./shareViewFilesTarget";

// A receipt in `.dohc/local/duplicate-pending` lets a retry find the copy an
// earlier Duplicate of the same file made before its reply was lost. It
// describes what this computer did, so it stays out of iCloud Drive.
const PendingDuplicate = z.object({workspaceId: z.string(), source: z.string(), path: z.string(), operationId: HistoryOperationId}).strict();
const PENDING_GUARD: DohcPathGuard = {path: ".dohc/local/duplicate-pending", lead: "dohc could not save Duplicate recovery."};
async function pendingLocation(workspace: LocalStateWorkspace, source: string) {
  let directory: string;
  try {
    directory = await localStateFolder(workspace, "duplicate-pending", PENDING_GUARD);
  } catch (error) {
    if (!(error instanceof LocalStateUnavailableError)) throw error;
    throw new LocalStateUnavailableError(error.refusal, error.refusal === "not-opened"
      ? "dohc did not duplicate this file because the workspace has not finished opening. Try again when it opens."
      : "dohc did not duplicate this file because it can't keep this workspace's .dohc/local out of iCloud Drive. Restart dohc to try again.");
  }
  return join(directory, createHash("sha256").update(source).digest("hex") + ".json");
}
// Only a missing receipt means no earlier Duplicate is pending. One dohc
// can't read, parse or trust may stand for a copy already made, so
// Duplicate refuses rather than make another and replace the receipt.
async function readPending(path: string, source: string) {
  const read = await readOwnedFile(path, 64 * 1024).catch(() => null);
  if (read?.status === "missing") return null;
  try {
    if (read?.status === "read") return PendingDuplicate.parse(JSON.parse(read.content));
  } catch { /* Refused below. */ }
  throw new Error(`dohc did not duplicate ${source} because it can't use the pending Duplicate at ${PENDING_GUARD.path}/${basename(path)}. Check History for an earlier copy. Then remove that file and try again.`);
}
async function savePending(path: string, record: z.infer<typeof PendingDuplicate>) {
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    // 0600 whatever the umask: the reader ignores a receipt others can write.
    const file = await open(temp, "wx", 0o600);
    try {await file.writeFile(JSON.stringify(record)); await file.sync();} finally {await file.close();}
    await rename(temp, path);
  } finally {await rm(temp, {force: true});}
}

export async function duplicateWorkspaceFile(
  operation: { workspace: { workspaceId: string; rootPath: string; attachmentId?: symbol; readOnly?: boolean; shareView?: unknown; shareMounts?: unknown }; assertCurrent(): void },
  path: string, author: MomentWriteAuthor, capture: Pick<WorkspaceEngineCapture, "changePathsAs">,
) {
  const { workspace } = operation;
  const assertWritable = () => {
    operation.assertCurrent();
    if (workspace.readOnly || workspace.shareView !== undefined) throw new Error("Duplicate requires the owning workspace. Open it to continue.");
  };
  assertWritable();
  const operationId = `dohc-operation:${randomUUID()}`;
  return withExclusiveWorkspaceOperation(workspace.rootPath, async markChanged => {
    const endpoint = await admitPath(workspace.rootPath, path);
    if (!(await lstat(join(workspace.rootPath, endpoint.physical))).isFile()) throw new Error("Duplicate supports one regular file. Choose a file instead of a folder or link.");
    const pendingPath = await pendingLocation(workspace, endpoint.physical);
    const result = await capture.changePathsAs([endpoint.physical], {operation: "duplicate", author, operationId}, async engine => {
      assertWritable();
      const source = await admitPath(workspace.rootPath, path);
      if (source.physical !== endpoint.physical || !(await lstat(join(workspace.rootPath, source.physical))).isFile()) throw new Error("The source changed. Check the file, then try again.");
      const allowed = historyPathAdmission(engine.policy);
      if (engine.policy.errors.length || !allowed(source.path) || !allowed(source.physical)) throw new Error("History cannot record this file. Choose a path with no reserved, secret, or excluded files.");
      const pending = await readPending(pendingPath, source.path);
      if (pending) {
        if (pending.workspaceId !== workspace.workspaceId || pending.source !== source.physical) throw new Error("This pending Duplicate belongs to another file or workspace.");
        const previous = await engine.readDuplicate(pending.operationId, pending.path);
        if (previous) {
          const target = await admitPath(workspace.rootPath, previous.path);
          if (previous.path !== pending.path || !allowed(target.path) || !allowed(target.physical)) throw new Error("dohc could not confirm the pending Duplicate. Check its operation in History.");
          const materialized = await lstat(join(workspace.rootPath, previous.path)).then(entry => entry.isFile(), error => {if (error.code === "ENOENT") return false; throw error;});
          assertWritable();
          markChanged();
          return {path: previous.path, materialized, operationId: pending.operationId, undo: {available: true as const}};
        }
        await rm(pendingPath, {force: true});
      }
      const folder = posix.dirname(source.physical), extension = posix.extname(source.physical), stem = posix.basename(source.physical, extension);
      let target = "";
      for (let n = 1; ; n++) {
        const suffix = process.platform === "win32" ? ` - Copy${n === 1 ? "" : ` (${n})`}`
          : process.platform === "darwin" ? ` copy${n === 1 ? "" : ` ${n}`}` : ` (copy${n === 1 ? "" : ` ${n}`})`;
        target = posix.join(folder, stem + suffix + extension);
        const admitted = await admitPath(workspace.rootPath, target);
        if (!allowed(target) || !allowed(admitted.physical)) throw new Error("History cannot record the copy at this path. Choose another source file.");
        const exists = await lstat(join(workspace.rootPath, target)).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
        if (!exists && !await engine.hasPath(target)) break;
      }
      await refuseMoveAcrossShareMount(workspace.rootPath, source.path, target, storedShareMounts(workspace), shareMountRegistryIsPresent(workspace));
      if (!(await engine.recordDisk(source.physical, [source.physical])).includes(source.physical)) throw new Error("History cannot retain this file. Choose a smaller file.");
      assertWritable();
      await savePending(pendingPath, {workspaceId: workspace.workspaceId, source: source.physical, path: target, operationId});
      const copied = await engine.duplicateFile(source.physical, target);

      markChanged();
      return {path: copied.path, materialized: copied.materialized, operationId, undo: {available: true as const}};
    }, () => []);
    if (result.materialized) await rm(pendingPath, {force: true});
    return result;
  }, {markOnSuccess: false}).catch((error: unknown) => {
    if (error instanceof StoredEntryIdentityUnavailable) throw new Error(
      `dohc did not duplicate ${path}. dohc could not tell which file or folder on disk it is. Check it in your file manager before trying again.`,
    );
    throw error;
  });
}
