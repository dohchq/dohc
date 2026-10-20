import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { z } from "zod";
import { HistoryOperationId } from "@dohc/workspace-contracts/history-operation";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";
import { join, posix } from "node:path";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { withExclusiveWorkspaceOperation } from "./workspaceAssets";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { historyPathAdmission } from "./workspaceEnginePolicyFile";
import { admitPath } from "./workspaceFileMoves";
import { refuseMoveAcrossShareMount } from "./shareMounts";
import { storedShareMounts, shareMountRegistryIsPresent } from "./shareViewFilesTarget";

const PendingDuplicate = z.object({workspaceId: z.string(), source: z.string(), path: z.string(), operationId: HistoryOperationId}).strict();
async function pendingLocation(root: string, source: string) {
  const directory = join(await resolveWorkspaceMetadataDir(root), "duplicate-pending");
  await mkdir(directory, {recursive: true});
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("dohc could not save Duplicate recovery. The recovery folder must be a real folder in this workspace.");
  return join(directory, createHash("sha256").update(source).digest("hex") + ".json");
}
async function readPending(path: string) {
  const entry = await lstat(path).catch(error => {if (error.code === "ENOENT") return null; throw error;});
  if (!entry) return null;
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("dohc could not read the pending Duplicate. Check the workspace recovery files.");
  return PendingDuplicate.parse(JSON.parse(await readFile(path, "utf8")));
}
async function savePending(path: string, record: z.infer<typeof PendingDuplicate>) {
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    const file = await open(temp, "wx");
    try {await file.writeFile(JSON.stringify(record)); await file.sync();} finally {await file.close();}
    await rename(temp, path);
  } finally {await rm(temp, {force: true});}
}

export async function duplicateWorkspaceFile(
  operation: { workspace: { workspaceId: string; rootPath: string; readOnly?: boolean; shareView?: unknown; shareMounts?: unknown }; assertCurrent(): void },
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
    const pendingPath = await pendingLocation(workspace.rootPath, endpoint.physical);
    const result = await capture.changePathsAs([endpoint.physical], {operation: "duplicate", author, operationId}, async engine => {
      assertWritable();
      const source = await admitPath(workspace.rootPath, path);
      if (source.physical !== endpoint.physical || !(await lstat(join(workspace.rootPath, source.physical))).isFile()) throw new Error("The source changed. Check the file, then try again.");
      const allowed = historyPathAdmission(engine.policy);
      if (engine.policy.errors.length || !allowed(source.path) || !allowed(source.physical)) throw new Error("History cannot record this file. Choose a path with no reserved, secret, or excluded files.");
      const pending = await readPending(pendingPath);
      if (pending) {
        if (pending.workspaceId !== workspace.workspaceId || pending.source !== source.physical) throw new Error("This pending Duplicate belongs to another file or workspace.");
        const previous = await engine.readDuplicate(pending.operationId, pending.path);
        if (previous) {
          const target = await admitPath(workspace.rootPath, previous.path);
          if (previous.path !== pending.path || !allowed(target.path) || !allowed(target.physical)) throw new Error("dohc could not confirm the pending Duplicate. Check its operation in History.");
          const materialized = await lstat(join(workspace.rootPath, previous.path)).then(entry => entry.isFile(), error => {if (error.code === "ENOENT") return false; throw error;});
          if (materialized) {
            assertWritable();
            markChanged();
            return {path: previous.path, materialized, operationId: pending.operationId, undo: {available: true as const}};
          }
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
    await rm(pendingPath, {force: true});
    return result;
  }, {markOnSuccess: false});
}
