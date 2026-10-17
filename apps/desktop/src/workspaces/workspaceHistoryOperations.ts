import { lstat, readdir } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, join } from "node:path";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { HistoryOperationId, type HistoryOperationReadResult } from "@dohc/workspace-contracts/history-operation";
import type { z } from "zod";
import { validateUserMaterializePath, validateUserWritePath } from "@dohc/workspace-core";
import { realRelativeInRoot } from "@dohc/workspace-core/realPath";
import { withExclusiveWorkspaceOperation } from "./workspaceAssets";
import { historyPathAdmission, readWorkspaceEnginePolicy } from "./workspaceEnginePolicyFile";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";
import { readDeleteRecovery, undoDeleteRecovery, type DeleteRecoveryFloor, type DeleteUndoResult } from "./workspaceDeleteRecovery";

type Operation = { workspace: { workspaceId: string; rootPath: string; readOnly?: boolean; shareView?: unknown }; assertCurrent(): void };
export type OperationHistory = Pick<VersionedLiveAdapter, "readHistoryPage" | "undoHistoryOperation">;
type Floor = (path: string, entry?: Stats, root?: boolean) => Promise<void>;
const unsupported = "Cannot undo this change yet. Only a delete can be undone.";
const missing = "Cannot undo the delete. Its recovery record is missing or expired. Restore files from History or the trash.";
function writable(operation: Operation): void {
  operation.assertCurrent();
  if (operation.workspace.readOnly || operation.workspace.shareView !== undefined) throw new Error("This workspace is read-only. Change files in the owning workspace.");
}
const absent = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const failure = (error: unknown) => ({ ok: false as const, reason: error instanceof Error && !("syscall" in error) ? error.message : "dohc could not read or undo this operation. Check the workspace, then try again." });
async function pathFloor(rootPath: string, agent: boolean): Promise<Floor> {
  const policy = agent ? await readWorkspaceEnginePolicy(rootPath) : undefined;
  if (policy?.errors.length) throw new Error("dohc could not read the workspace file policy. Fix the reported policy errors.");
  const allowed = policy ? historyPathAdmission(policy) : undefined;
  const admitted = (path: string) => {
    const checked = validateUserMaterializePath(path, { platform: process.platform });
    return checked.ok && checked.normalized === path && allowed!(path);
  };
  const floor: Floor = async (path, entry, root = false) => {
    if (agent) {
      let parent = path;
      while (parent !== "." && !admitted(parent)) parent = dirname(parent).replaceAll("\\\\", "/");
      const reject = () => new Error(`Cannot read or undo this operation. ${parent === "." ? "The workspace" : parent} contains a link or a reserved, secret, or excluded path.`);
      if (!admitted(path)) throw reject();
      const target = await assertResolvedWorkspacePath({ rootPath, absolutePath: join(rootPath, path), spelled: parent, label: "Operation path", access: "entry" }).catch(() => { throw reject(); });
      if (!admitted(target.relative)) throw reject();
      const current = await lstat(target.resolvedAbsolute).catch(error => { if (absent(error)) return null; throw error; });
      if ([entry, current].some(info => info && !info.isFile() && !info.isDirectory())) { parent = dirname(path).replaceAll("\\", "/"); throw reject(); }
      if (current?.isDirectory()) for (const name of await readdir(target.resolvedAbsolute)) await floor(`${path}/${name}`);
    } else {
      const checked = root ? validateUserWritePath(path) : validateUserMaterializePath(path, { platform: process.platform, allowIgnoredSegments: true });
      if (!checked.ok || checked.normalized !== path) throw new Error("Cannot undo the delete. Its recovery paths are invalid.");
      if (root) await assertResolvedWorkspacePath({ rootPath, absolutePath: join(rootPath, path), spelled: path, label: "Undo path", access: "entry" });
      else {
        const target = await realRelativeInRoot(rootPath, join(rootPath, path), true);
        if (!target.ok || target.relative !== path || !validateUserMaterializePath(target.relative, { platform: process.platform, allowIgnoredSegments: true }).ok) {
          throw new Error(`Cannot undo the delete. ${path} now leads somewhere else.`);
        }
      }
    }
  };
  return floor;
}
async function recoveryFloor(record: Parameters<DeleteRecoveryFloor>[0], staged: string | undefined, floor: Floor): Promise<void> {
  await floor(record.base, undefined, true);
  for (const path of [...record.paths, ...record.emptyFolders, ...(record.result?.restored ?? []), ...(record.result?.remaining.map(item => item.path) ?? [])]) await floor(path);
  if (!staged) return;
  const walk = async (source: string, path: string): Promise<void> => {
    const entry = await lstat(source).catch(error => { if (absent(error)) return null; throw error; });
    if (!entry) return;
    await floor(path, entry);
    if (entry.isDirectory() && !entry.isSymbolicLink()) for (const name of await readdir(source)) await walk(join(source, name), `${path}/${name}`);
  };
  await walk(staged, record.base);
}
async function page(history: OperationHistory, workspaceId: string, operationId: string, cursor?: string) {
  const parsed = cursor ? JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Parameters<OperationHistory["readHistoryPage"]>[0]["cursor"] : undefined;
  if (parsed && (parsed.workspaceId !== workspaceId || parsed.operationId !== operationId || parsed.objectId !== null)) throw new Error("This operation page belongs to another operation or workspace.");
  return history.readHistoryPage({ workspaceId, operationId, limit: 50, ...(parsed ? { cursor: parsed, versionId: parsed.versionId } : {}) });
}
export async function readWorkspaceHistoryOperation(operation: Operation, input: { operationId: string; cursor?: string }, history: OperationHistory): Promise<z.infer<typeof HistoryOperationReadResult>> {
  try {
    writable(operation); HistoryOperationId.parse(input.operationId);
    const { rootPath, workspaceId } = operation.workspace;
    return await withExclusiveWorkspaceOperation(rootPath, async () => {
      writable(operation);
      const floor = await pathFloor(rootPath, true);
      const record = await readDeleteRecovery(rootPath, input.operationId).catch(error => { if (error instanceof Error && error.message === missing) return undefined; throw error; });
      if (record) await recoveryFloor(record, record.staged ? join(rootPath, ".dohc", "trash", record.staged) : undefined, floor);
      const result = await page(history, workspaceId, input.operationId, input.cursor);
      for (const member of result.protectedMoments) await floor(member.path);
      for (const member of result.moments) { await floor(member.path); if (member.beforePath) await floor(member.beforePath); }
      if (!record && !result.moments.length && !input.cursor) throw new Error("This operation is not in History.");
      operation.assertCurrent();
      return { ok: true as const, operationId: input.operationId,
        members: result.moments.map(member => ({ momentId: member.momentId, operation: member.operation, path: member.path, ...(member.beforePath ? { beforePath: member.beforePath } : {}) })),
        ...(record ? { withoutHistory: record.paths } : {}), nextCursor: result.nextCursor ? Buffer.from(JSON.stringify(result.nextCursor)).toString("base64url") : null };
    });
  } catch (error) { return failure(error); }
}
export async function undoWorkspaceHistoryOperation(operation: Operation, input: { operationId: string }, author: MomentWriteAuthor,
  options: { history: OperationHistory; agent: boolean }): Promise<DeleteUndoResult> {
  try {
    writable(operation); HistoryOperationId.parse(input.operationId);
    const { rootPath, workspaceId } = operation.workspace;
    return await withExclusiveWorkspaceOperation(rootPath, async markChanged => {
      writable(operation);
      // A recovery record is required before even reading the engine.
      await readDeleteRecovery(rootPath, input.operationId).catch(error => { if (error instanceof Error && error.message === missing) throw new Error(unsupported); throw error; });
      const floor = await pathFloor(rootPath, options.agent);
      return undoDeleteRecovery(rootPath, input, author, options.history, workspaceId, () => writable(operation), markChanged, async (record, staged) => {
        await recoveryFloor(record, staged, floor);
        if (record.tracked) {
          let cursor: string | undefined;
          do {
            const result = await page(options.history, workspaceId, input.operationId, cursor);
            for (const member of result.protectedMoments) await floor(member.path);
            for (const member of result.moments) { await floor(member.path); if (member.beforePath) await floor(member.beforePath); }
            cursor = result.nextCursor ? Buffer.from(JSON.stringify(result.nextCursor)).toString("base64url") : undefined;
          } while (cursor);
        }
        writable(operation);
      });
    });
  } catch (error) { return failure(error); }
}
