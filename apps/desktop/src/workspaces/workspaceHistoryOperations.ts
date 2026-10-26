import { caseOnlyMoveReason, missingMoveRecoveryReason, moveWord, moveEntryTarget, readMoveRecovery, undoMoveRecovery, type MoveRecoveryRecord } from "./workspaceMoveRecovery";
import { placeBack } from "./workspaceFileMoves";
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
import { waitForRecovery, missingDeleteRecoveryReason, readDeleteRecovery, undoDeleteRecovery, type RecoveryRecord, type DeleteUndoResult } from "./workspaceDeleteRecovery";
import { stagedTrashEntry } from "./workspaceTrash";

type Operation = { workspace: { workspaceId: string; rootPath: string; attachmentId?: symbol; readOnly?: boolean; shareView?: unknown }; signal?: AbortSignal; assertCurrent(): void };
export type OperationHistory = Pick<VersionedLiveAdapter, "readHistoryPage" | "readHistoryOperation" | "undoHistoryOperation">;
export function createOperationHistory(withAdapter: <T>(work: (adapter: OperationHistory) => Promise<T>) => Promise<T | null>): OperationHistory {
  const requireResult = <T>(result: T | null): T => {
    if (result === null) throw new Error("The workspace engine is not running.");
    return result;
  };
  return {
    readHistoryOperation: async input => requireResult(await withAdapter(adapter => adapter.readHistoryOperation(input))),
    readHistoryPage: async input => requireResult(await withAdapter(adapter => adapter.readHistoryPage(input))),
    undoHistoryOperation: async input => requireResult(await withAdapter(adapter => adapter.undoHistoryOperation(input))),
  };
}

type Floor = (path: string, entry?: Stats, root?: boolean) => Promise<void>;
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
function personFloor(rootPath: string, word = "delete"): Floor {
  return async (path, _entry, root = false) => {
    const checked = root ? validateUserWritePath(path) : validateUserMaterializePath(path, { platform: process.platform, allowIgnoredSegments: true });
    if (!checked.ok || checked.normalized !== path) throw new Error(`Cannot undo the ${word}. Its recovery paths are invalid.`);
    if (root) await assertResolvedWorkspacePath({ rootPath, absolutePath: join(rootPath, path), spelled: path, label: "Undo path", access: "entry" });
    else {
      const target = await realRelativeInRoot(rootPath, join(rootPath, path), true);
      if (!target.ok || target.relative !== path || !validateUserMaterializePath(target.relative, { platform: process.platform, allowIgnoredSegments: true }).ok) {
        throw new Error(`Cannot undo the ${word}. ` + path + " now leads somewhere else.");
      }
    }
  };
}
async function recoveryFloor(record: Readonly<RecoveryRecord>, staged: string | undefined, floor: Floor): Promise<void> {
  await floor(record.base, undefined, true);
  for (const path of record.engine?.notRestored ?? []) await floor(path);
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
async function moveRecoveryFloor(record: MoveRecoveryRecord, floor: Floor): Promise<void> {
  const invalid = () => new Error(`Cannot undo the ${moveWord(record.from, record.to)}. Its recovery paths are invalid.`);
  if (record.from === record.to || record.from.startsWith(record.to + "/") || record.to.startsWith(record.from + "/")) throw invalid();
  const paths = "noUndo" in record ? [] : [...record.entries, ...(record.pending ?? []), ...[record.progress, record.result].flatMap(result => result?.restored ?? [])];
  for (const path of paths) if (path !== record.from) throw invalid();
  if (!("noUndo" in record)) for (const path of new Set([...(record.engine && "notRestored" in record.engine ? record.engine.notRestored ?? [] : []), ...[record.progress, record.result].flatMap(result => result?.remaining.map(item => item.path) ?? [])])) await floor(path);
  await floor(record.from, undefined, true);
  await floor(record.to, undefined, true);
  if ("entries" in record && record.entries.length) { await floor(record.from); await floor(record.to); }
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
    await waitForRecovery(input.operationId, operation.signal, "read");
    if (operation.signal?.aborted) throw new Error("This workspace was closed. Open it again.");
    return await withSharedWorkspaceOperation(rootPath, async () => {
      writable(operation);
      const record = cursor ? undefined : await readDeleteRecovery(rootPath, input.operationId, "read");
      const move = cursor ? undefined : await readMoveRecovery(rootPath, input.operationId);
      const floor = await agentFloor(rootPath, !record?.result);
      if (move) await moveRecoveryFloor(move, floor);
      if (record) await recoveryFloor(record, record.staged ? stagedTrashEntry(rootPath, record.staged) : undefined, floor);
      const result = await history.readHistoryPage({ workspaceId, operationId: input.operationId, limit: 50, ...(cursor ? { cursor } : {}) });
      for (const member of result.moments) { await floor(member.path); if (member.beforePath) await floor(member.beforePath); }
      if (!record && !move && !result.moments.length && !input.cursor) throw new Error("This operation is not in History.");
      operation.assertCurrent();
      return { ok: true as const, operationId: input.operationId,
        members: result.moments.map(member => ({ momentId: member.momentId, operation: member.operation, path: member.path, ...(member.beforePath ? { beforePath: member.beforePath } : {}) })),
        ...(record ? { withoutHistory: record.paths } : move && !("noUndo" in move) ? { withoutHistory: move.entries.map(path => moveEntryTarget(move, path)) } : {}), nextCursor: result.nextCursor ? Buffer.from(JSON.stringify(result.nextCursor)).toString("base64url") : null };
    });
  } catch (error) { return failure(error, "read"); }
}
export async function undoWorkspaceHistoryOperation(operation: Operation & { signal: AbortSignal }, input: { operationId: string }, author: MomentWriteAuthor,
  options: { history: OperationHistory; agent: boolean }): Promise<DeleteUndoResult> {
  try {
    writable(operation); operationId(input.operationId);
    const { workspace } = operation, { rootPath, workspaceId } = workspace;
    await waitForRecovery(input.operationId, operation.signal);
    if (operation.signal.aborted) throw new Error("This workspace was closed. Open it again.");
    writable(operation);
    return await withExclusiveWorkspaceOperation(rootPath, async markChanged => {
      writable(operation);
      const record = await readDeleteRecovery(rootPath, input.operationId);
      const move = record ? undefined : await readMoveRecovery(rootPath, input.operationId);
      if (move && "noUndo" in move) throw new Error(move.noUndo);
      if (move && move.from !== move.to && move.from.toLowerCase() === move.to.toLowerCase()) throw new Error(caseOnlyMoveReason);
      const floor = options.agent ? await agentFloor(rootPath, move ? true : !record?.result)
        : record ? personFloor(rootPath) : move ? personFloor(rootPath, moveWord(move.from, move.to)) : null;
      if (move && floor) await moveRecoveryFloor(move, floor);
      if (record && floor) await recoveryFloor(record, record.staged ? stagedTrashEntry(rootPath, record.staged) : undefined, floor);
      let cursor: HistoryCursor | undefined, deleted = false;
      const members: { path: string; beforePath?: string | null; operation: string }[] = [];
      if ((!record && !move) || record?.tracked || move?.tracked) do {
        const result = await options.history.readHistoryPage({ workspaceId, operationId: input.operationId, limit: 50, ...(cursor ? { cursor } : {}) });
        for (const member of result.moments) {
          if (floor) { await floor(member.path); if (member.beforePath) await floor(member.beforePath); }
          members.push(member);
          deleted ||= member.operation === "delete";
          if (!floor && deleted) break;
        }
        cursor = result.nextCursor ?? undefined;
      } while (cursor && (floor || !deleted));
      const history: OperationHistory = { ...options.history, undoHistoryOperation: async input => {
        const result = await options.history.undoHistoryOperation(input);
        try { if (floor) for (const path of result.notRestored) await floor(path); }
        catch (error) { markChanged(); throw error; }
        return result;
      } };
      if (move) return undoMoveRecovery(workspace, move, author, history, workspaceId, () => writable(operation), markChanged, (root, from, to) => placeBack(root, from, to, "", true));
      if (!record && (await history.readHistoryOperation({workspaceId, operationId: input.operationId})).kind === "file-duplicate") {
        const duplicateFloor = await agentFloor(rootPath);
        const member = members[0];
        if (!member) throw new Error("This Duplicate is not in the active workspace version. Open its version to undo it.");
        await duplicateFloor(member.path);
        const result = await history.undoHistoryOperation({workspaceId, operationId: input.operationId, requestId: `duplicate-undo:${input.operationId}`, author: {...author}});
        markChanged();
        return {ok: true as const, tracked: {state: result.materialized ? "restored" as const : "restoring" as const, momentCount: result.momentCount}, restored: [],
          remaining: result.notRestored.map(path => ({path, reason: `Cannot undo Duplicate. ${path} changed.`, retry: false}))};
      }
      if (!record) {
        const rename = members.find(member => member.operation === "rename");
        throw new Error(deleted ? missingDeleteRecoveryReason : rename
          ? missingMoveRecoveryReason(moveWord(rename.beforePath ?? rename.path, rename.path)) : "This operation is not in History.");
      }
      return undoDeleteRecovery(workspace, record, author, history, workspaceId, () => writable(operation), markChanged);
    }, { markOnSuccess: false });
  } catch (error) {
    // Refuse through the authority wrapper before its final currentness check.
    if (operation.signal.aborted) throw new Error("This workspace was closed. Open it again.");
    return failure(error, "undo");
  }
}
