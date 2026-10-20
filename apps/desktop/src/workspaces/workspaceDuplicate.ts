import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { withExclusiveWorkspaceOperation } from "./workspaceAssets";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { historyPathAdmission } from "./workspaceEnginePolicyFile";
import { admitPath } from "./workspaceFileMoves";
import { refuseMoveAcrossShareMount } from "./shareMounts";
import { storedShareMounts, shareMountRegistryIsPresent } from "./shareViewFilesTarget";

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
    return capture.changePathsAs([endpoint.physical], {operation: "duplicate", author, operationId}, async engine => {
      assertWritable();
      const source = await admitPath(workspace.rootPath, path);
      if (source.physical !== endpoint.physical || !(await lstat(join(workspace.rootPath, source.physical))).isFile()) throw new Error("The source changed. Check the file, then try again.");
      const allowed = historyPathAdmission(engine.policy);
      if (engine.policy.errors.length || !allowed(source.path) || !allowed(source.physical)) throw new Error("History cannot record this file. Choose a path with no reserved, secret, or excluded files.");
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
      const copied = await engine.duplicateFile(source.physical, target);
      markChanged();
      return {path: copied.path, materialized: copied.materialized, operationId, undo: {available: true as const}};
    }, () => []);
  }, {markOnSuccess: false});
}
