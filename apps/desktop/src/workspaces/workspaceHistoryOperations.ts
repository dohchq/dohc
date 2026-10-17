import { lstat, readdir } from "node:fs/promises";
import type { Stats } from "node:fs";
import { posix, join } from "node:path";
import type { HistoryCursor, VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { HistoryOperationId, type HistoryOperationReadResult } from "@dohc/workspace-contracts/history-operation";
import type { z } from "zod";
import { validateUserMaterializePath, validateUserWritePath } from "@dohc/workspace-core";
import { realRelativeInRoot } from "@dohc/workspace-core/realPath";
import { withExclusiveWorkspaceOperation, withSharedWorkspaceOperation } from "./workspaceAssets";
import { historyExcludesSubtree, historyPathAdmission, readWorkspaceEnginePolicy } from "./workspaceEnginePolicyFile";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";
import { waitForDeleteRecovery, missingDeleteRecoveryReason, readDeleteRecovery, undoDeleteRecovery, type RecoveryRecord, type DeleteUndoResult } from "./workspaceDeleteRecovery";

type Operation = { workspace: { workspaceId: string; rootPath: string; readOnly?: boolean; shareView?: unknown }; assertCurrent(): void };
export type OperationHistory = Pick<VersionedLiveAdapter, "readHistoryPage" | "undoHistoryOperation">;
export function createOperationHistory(withAdapter: <T>(work: (adapter: OperationHistory) => Promise<T>) => Promise<T | null>): OperationHistory {
  const requireResult = <T>(result: T | null): T => {
    if (result === null) throw new Error("The workspace engine is not running.");
    return result;
  };
  return {
    readHistoryPage: async input => requireResult(await withAdapter(adapter => adapter.readHistoryPage(input))),
    undoHistoryOperation: async input => requireResult(await withAdapter(adapter => adapter.undoHistoryOperation(input))),
  };
}
type Floor = (path: string, entry?: Stats, root?: boolean) => Promise<void>;
const unsupported = "Cannot undo this change yet. Only a delete can be undone.";
function writable(operation: Operation): void {
  operation.assertCurrent();
  if (operation.workspace.readOnly || operation.workspace.shareView !== undefined) throw new Error("History operations require the owning workspace. Open it to continue.");
}
const absent = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const failure = (error: unknown, action: "read" | "undo") => ({ ok: false as const, reason: error instanceof Error && !["SyntaxError", "TypeError", "ZodError", "ParseError", "RangeError"].includes(error.name) && !("syscall" in error) ? error.message : `dohc could not ${action} this operation. Check the workspace, then try again.` });
async function agentFloor(rootPath: string, walkLiveDirectories = true): Promise<Floor> {
  const policy = await readWorkspaceEnginePolicy(rootPath);
  if (policy.errors.length) throw new Error("dohc could not read the workspace file policy. Fix the reported policy errors.");
  const allowed = historyPathAdmission(policy);
  const admitted = (path: string) => {
    const checked = validateUserMaterializePath(path, { platform: process.platform });
    return checked.ok && checked.normalized === path && allowed(path);
  };
  const checked = new Set<string>(), missing = new Set<string>();
  const floor: Floor = async (path, entry) => {
    let parent = path;
    while (parent !== "." && !admitted(parent)) {
      const next = posix.dirname(parent);
      if (next === parent) { parent = "."; break; }
      parent = next;
    }
    const location = (sentenceStart = false) => parent === "." ? sentenceStart ? "The workspace" : "the workspace" : parent;
    const reject = () => new Error("Cannot read or undo this operation. " + location(true) + " contains a link or a reserved, secret, or excluded path.");
    if (!admitted(path)) throw reject();
    if (entry && !entry.isFile() && !entry.isDirectory()) { parent = posix.dirname(path); throw reject(); }
    if (checked.has(path)) return;
    for (let ancestor = posix.dirname(path); ancestor !== "."; ancestor = posix.dirname(ancestor)) {
      if (missing.has(ancestor)) { checked.add(path); return; }
    }
    const target = await realRelativeInRoot(rootPath, join(rootPath, path), true);
    if (!target.ok) {
      if (target.reason === "unreadable-root" || target.reason === "unreadable-path") {
        throw new Error("dohc could not check " + location() + ". Check its permissions, then try again.");
      }
      throw reject();
    }
    if (!admitted(target.relative)) throw reject();
    const current = await lstat(target.resolvedAbsolute).catch(error => {
      if (absent(error)) return null;
      throw new Error("dohc could not check " + location() + ". Check its permissions, then try again.");
    });
    if (current && !current.isFile() && !current.isDirectory()) { parent = posix.dirname(path); throw reject(); }
    checked.add(path);
    if (!current) missing.add(path);
    if (current?.isDirectory() && !walkLiveDirectories && historyExcludesSubtree(policy, path)) throw reject();
    if (walkLiveDirectories && current?.isDirectory()) {
      const names = await readdir(target.resolvedAbsolute).catch(() => {
        throw new Error("dohc could not read " + location() + ". Check its permissions, then try again.");
      });
      for (const name of names) await floor(path + "/" + name);
    }
  };
  return floor;
}
function personFloor(rootPath: string): Floor {
  return async (path, _entry, root = false) => {
    const checked = root ? validateUserWritePath(path) : validateUserMaterializePath(path, { platform: process.platform, allowIgnoredSegments: true });
    if (!checked.ok || checked.normalized !== path) throw new Error("Cannot undo the delete. Its recovery paths are invalid.");
    if (root) await assertResolvedWorkspacePath({ rootPath, absolutePath: join(rootPath, path), spelled: path, label: "Undo path", access: "entry" });
    else {
      const target = await realRelativeInRoot(rootPath, join(rootPath, path), true);
      if (!target.ok || target.relative !== path || !validateUserMaterializePath(target.relative, { platform: process.platform, allowIgnoredSegments: true }).ok) {
        throw new Error("Cannot undo the delete. " + path + " now leads somewhere else.");
      }
    }
  };
}
async function recoveryFloor(record: Readonly<RecoveryRecord>, staged: string | undefined, floor: Floor): Promise<void> {
  await floor(record.base, undefined, true);
  for (const path of new Set([...record.paths, ...record.emptyFolders, ...(record.copies?.map(copy => copy.path) ?? []), ...(record.progress?.restored ?? []), ...(record.progress?.remaining.map(item => item.path) ?? []), ...(record.result?.restored ?? []), ...(record.result?.remaining.map(item => item.path) ?? [])])) await floor(path);
  if (!staged) return;
  const walk = async (source: string, path: string): Promise<void> => {
    const entry = await lstat(source).catch(error => { if (absent(error)) return null; throw error; });
    if (!entry) return;
    await floor(path, entry);
    if (entry.isDirectory() && !entry.isSymbolicLink()) for (const name of await readdir(source)) await walk(join(source, name), `${path}/${name}`);
  };
  await walk(staged, record.base);
}
function decodeCursor(cursor: string, workspaceId: string, operationId: string): HistoryCursor {
  let parsed: HistoryCursor;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.versionId !== "string") throw new Error();
  } catch { throw new Error("Cannot read this operation page. Use the cursor from the previous page."); }
  if (parsed.workspaceId !== workspaceId || parsed.operationId !== operationId || parsed.objectId !== null) throw new Error("This operation page belongs to another operation or workspace.");
  return parsed;
}
function operationId(id: string): void {
  if (!HistoryOperationId.safeParse(id).success) throw new Error("Use an operation id from history list: dohc-operation: followed by a UUID.");
}
export async function readWorkspaceHistoryOperation(operation: Operation, input: { operationId: string; cursor?: string }, history: OperationHistory): Promise<z.infer<typeof HistoryOperationReadResult>> {
  try {
    writable(operation); operationId(input.operationId);
    const { rootPath, workspaceId } = operation.workspace;
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor, workspaceId, input.operationId);
    return await withSharedWorkspaceOperation(rootPath, async () => {
      writable(operation);
      const record = cursor ? undefined : await readDeleteRecovery(rootPath, input.operationId, "read");
      const floor = await agentFloor(rootPath, !record?.result);
      if (record) await recoveryFloor(record, record.staged ? join(rootPath, ".dohc", "trash", record.staged) : undefined, floor);
      const result = await history.readHistoryPage({ workspaceId, operationId: input.operationId, limit: 50, ...(cursor ? { cursor } : {}) });
      for (const member of result.moments) { await floor(member.path); if (member.beforePath) await floor(member.beforePath); }
      if (!record && !result.moments.length && !input.cursor) throw new Error("This operation is not in History.");
      operation.assertCurrent();
      return { ok: true as const, operationId: input.operationId,
        members: result.moments.map(member => ({ momentId: member.momentId, operation: member.operation, path: member.path, ...(member.beforePath ? { beforePath: member.beforePath } : {}) })),
        ...(record ? { withoutHistory: record.paths } : {}), nextCursor: result.nextCursor ? Buffer.from(JSON.stringify(result.nextCursor)).toString("base64url") : null };
    });
  } catch (error) { return failure(error, "read"); }
}
export async function undoWorkspaceHistoryOperation(operation: Operation, input: { operationId: string }, author: MomentWriteAuthor,
  options: { history: OperationHistory; agent: boolean }): Promise<DeleteUndoResult> {
  try {
    writable(operation); operationId(input.operationId);
    const { rootPath, workspaceId } = operation.workspace;
    await waitForDeleteRecovery(input.operationId);
    return await withExclusiveWorkspaceOperation(rootPath, async markChanged => {
      writable(operation);
      const record = await readDeleteRecovery(rootPath, input.operationId);
      const floor = options.agent ? await agentFloor(rootPath, !record?.result) : record ? personFloor(rootPath) : undefined;
      if (record && floor) await recoveryFloor(record, record.staged ? join(rootPath, ".dohc", "trash", record.staged) : undefined, floor);
      let cursor: HistoryCursor | undefined, deleted = false;
      if (!record || record.tracked) do {
        const result = await options.history.readHistoryPage({ workspaceId, operationId: input.operationId, limit: 50, ...(cursor ? { cursor } : {}) });
        for (const member of result.moments) {
          if (floor) { await floor(member.path); if (member.beforePath) await floor(member.beforePath); }
          deleted ||= member.operation === "delete";
          if (!floor && deleted) break;
        }
        cursor = result.nextCursor ?? undefined;
      } while (cursor && (floor || !deleted));
      if (!record) throw new Error(deleted ? missingDeleteRecoveryReason : unsupported);
      return undoDeleteRecovery(rootPath, record, author, options.history, workspaceId, () => writable(operation), markChanged);
    });
  } catch (error) { return failure(error, "undo"); }
}
