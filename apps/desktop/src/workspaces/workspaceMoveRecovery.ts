import type { HistoryOperationsStore, MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { HistoryOperationId, HistoryOperationUndoResult } from "@dohc/workspace-contracts/history-operation";
import type { OperationRecovery } from "./workspaceDeleteRecovery";
import { readRecoveryRecordText, saveRecoveryRecord, scheduleRecoveryPrune, type DeleteRecoveryPlan } from "./workspaceDeleteRecovery";
import type { LocalStateWorkspace } from "./workspaceLocalState";
import { WORKSPACE_TRASH, workspaceTrashForWrite } from "./workspaceTrash";

const Roots = z.object({ operationId: HistoryOperationId, from: z.string(), to: z.string() });
const FileRecord = Roots.extend({
  entries: z.array(z.string()),
  tracked: z.boolean(), pending: z.array(z.string()).optional(), replaced: z.boolean().optional(),
  engine: z.union([z.object({ requested: z.literal(true) }).strict(), z.object({ materialized: z.boolean(), momentCount: z.number(), notRestored: z.array(z.string()).optional() }).strict()]).optional(),
  progress: HistoryOperationUndoResult.options[1].optional(), result: HistoryOperationUndoResult.options[1].optional(),
}).strict();
const FolderRecord = Roots.extend({ kind: z.literal("folder"), noUndo: z.string() }).strict();
const Record = z.union([FolderRecord, FileRecord]);
export type FileMoveRecoveryRecord = z.infer<typeof FileRecord>;
export type MoveRecoveryRecord = z.infer<typeof Record>;
export const moveWord = (from: string, to: string) => dirname(from) === dirname(to) ? "rename" : "move";
export const moveBack = (word: "move" | "rename") => word === "rename" ? "Rename it back yourself." : "Move it back yourself.";
export const folderMoveReason = (from: string, to: string) => `Undo for a folder ${moveWord(from, to)} isn't available yet. ${moveBack(moveWord(from, to))}`;
export const caseOnlyMoveReason = "Cannot undo the rename. It changed only the letter case. Rename it back yourself.";
export const missingMoveRecoveryReason = (word: "move" | "rename") => `Cannot undo the ${word}. Its recovery record is missing or expired. ${moveBack(word)}`;
const invalid = (word: "move" | "rename") => `Cannot undo the ${word}. Its recovery record is invalid. ${moveBack(word)}`;
const absent = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

// An untrusted record reads as an invalid one: Undo refuses and changes nothing.
export async function readMoveRecovery(root: string, id: string): Promise<MoveRecoveryRecord | undefined> {
  const read = await readRecoveryRecordText(root, id, "move");
  if (read.status === "missing") return undefined;
  if (read.status === "refused") throw new Error(`Cannot undo the move. ${read.reason}`);
  if (read.status === "untrusted") throw new Error(invalid("move"));
  let record: MoveRecoveryRecord;
  try { record = Record.parse(JSON.parse(read.text)); }
  catch { throw new Error(invalid("move")); }
  if (record.operationId !== id) throw new Error(invalid(moveWord(record.from, record.to)));
  if ("noUndo" in record && record.noUndo !== folderMoveReason(record.from, record.to)) throw new Error(invalid(moveWord(record.from, record.to)));
  return record;
}

export async function finishFolderMoveRecovery(workspace: LocalStateWorkspace, operationId: string, from: string, to: string): Promise<OperationRecovery> {
  const noUndo = folderMoveReason(from, to);
  try {
    const record = { operationId, from, to, kind: "folder" as const, noUndo };
    await saveRecoveryRecord(workspace, record, "move");
    scheduleRecoveryPrune(workspace);
  } catch { /* The move still returns its folder-specific unavailable Undo. */ }
  return { operationId, undo: { available: false, reason: noUndo, paths: [] } };
}

export async function finishMoveRecovery(workspace: LocalStateWorkspace, plan: DeleteRecoveryPlan, from: string, to: string, replaced: boolean): Promise<OperationRecovery> {
  const word = moveWord(from, to);
  try {
    if (!plan.record || plan.noUndo) throw new Error("Recovery collection failed");
    const record: FileMoveRecoveryRecord = { operationId: plan.operationId, from, to,
      entries: [...plan.record.paths, ...plan.record.emptyFolders], tracked: plan.record.tracked, ...(replaced ? { replaced } : {}) };
    await saveRecoveryRecord(workspace, record, "move");
    scheduleRecoveryPrune(workspace);
    return { operationId: plan.operationId, undo: replaced
      ? { available: false, paths: [], reason: replacedMoveReason(record) }
      : { available: true } };
  } catch {
    return { operationId: plan.operationId, undo: { available: false, paths: [],
      reason: `${word === "rename" ? "Rename" : "Move"} finished. dohc could not save Undo information. ${moveBack(word)}` } };
  }
}
export function replacedMoveReason(record: FileMoveRecoveryRecord): string {
  const word = moveWord(record.from, record.to);
  return `Cannot undo the ${word}. It replaced the old ${record.to}. ${moveBack(word)} Restore the old ${record.to} from History, the system trash, or ${WORKSPACE_TRASH}.`;
}

const info = (path: string) => lstat(path).catch(error => { if (absent(error)) return null; throw error; });
export const moveEntryTarget = (record: FileMoveRecoveryRecord, path: string) => record.to + path.slice(record.from.length);
export async function undoMoveRecovery(workspace: LocalStateWorkspace, record: FileMoveRecoveryRecord,
  author: MomentWriteAuthor, history: Pick<HistoryOperationsStore, "undoHistoryOperation">, workspaceId: string,
  assertCurrent: () => void, markChanged: () => void,
  placeBack: (root: string, source: string, target: string) => Promise<string[]>,
): Promise<z.infer<typeof HistoryOperationUndoResult>> {
  const root = workspace.rootPath;
  const word = moveWord(record.from, record.to);
  const refuse = (detail: string): never => { throw new Error(`Cannot undo the ${word}. ${detail}`); };
  const engineUndo = async () => {
    assertCurrent(); return history.undoHistoryOperation({ workspaceId, operationId: record.operationId,
      requestId: `move-undo:${record.operationId}`, author });
  };
  assertCurrent();
  if (record.replaced) throw new Error(replacedMoveReason(record));
  // Undo saves its progress in the trash, so it asks History only where it can.
  if (record.result) {
    if (record.result.tracked.state === "restoring") {
      await workspaceTrashForWrite(workspace, `undo the ${word}`);
      try {
        if ((await engineUndo()).materialized) {
          record.result.tracked.state = "restored";
          await saveRecoveryRecord(workspace, record, "move");
        }
      } catch { /* A finished Undo keeps its result when refresh is unavailable. */ }
    }
    return record.result;
  }
  await workspaceTrashForWrite(workspace, `undo the ${word}`);
  if (!record.engine) {
    const destination = await info(join(root, record.to));
    if (!destination) return refuse(`Nothing is at ${record.to} now. Check History for where it went.`);
    if (await info(join(root, record.from))) return refuse(`${record.from} now occupies the old path. Move it first.`);
    if (destination.isDirectory()) return refuse(`${record.to} is now a folder. Move it first.`);
    assertCurrent();
    record.engine = { requested: true };
    if (record.tracked) await saveRecoveryRecord(workspace, record, "move");
  }
  if ("requested" in record.engine) {
    const receipt = record.tracked ? await engineUndo() : { materialized: true, momentCount: 0, notRestored: [] };
    if (record.tracked) markChanged();
    record.engine = { materialized: receipt.materialized, momentCount: receipt.momentCount, notRestored: [...receipt.notRestored] };
    record.pending = [...record.entries];
    if (record.entries.length) await saveRecoveryRecord(workspace, record, "move");
  }
  const result: z.infer<typeof HistoryOperationUndoResult.options[1]> = { ok: true,
    tracked: { state: record.engine.materialized ? "restored" : "restoring", momentCount: record.engine.momentCount },
    restored: record.progress?.restored ?? [], remaining: (record.engine.notRestored ?? []).map(path => ({ path,
      retry: false, reason: "dohc could not restore this file. Restore it from History." })) };
  for (const path of [...(record.pending ?? record.entries)]) {
    assertCurrent();
    if (record.engine.notRestored?.some(skipped => skipped === path || skipped === record.to)) {
      record.pending = record.pending?.filter(item => item !== path);
      continue;
    }
    const source = moveEntryTarget(record, path), entry = await info(join(root, source));
    const before = await info(join(root, path));
    const left = entry ? await placeBack(root, join(root, source), join(root, path)) : [];
    if (entry && (!left.length || !before && await info(join(root, path)))) markChanged();
    const remaining = left.map(sub => sub ? `${path}/${sub}` : path);
    record.pending = [...(record.pending ?? record.entries).filter(item => item !== path), ...remaining];
    if (entry && !left.length) result.restored.push(path);
    for (const path of remaining) {
      const source = moveEntryTarget(record, path);
      const old = await lstat(join(root, path), { bigint: true }).catch(() => null);
      const moved = await lstat(join(root, source), { bigint: true }).catch(() => null);
      const linked = old?.isFile() && moved?.isFile() && old.ino !== 0n && old.dev === moved.dev && old.ino === moved.ino && old.size === moved.size;
      result.remaining.push({ path, retry: true, reason: linked
        ? `${path} is back, but dohc could not remove its moved name at ${source}. Close apps using the file, then Undo again to finish.`
        : old ? `${path} now occupies the old path. Move it first. The moved file stays at ${source}.`
        : `dohc could not put ${path} back. It stays at ${source}.` });
    }
    record.progress = result;
    await saveRecoveryRecord(workspace, record, "move");
  }
  if (!record.pending?.length) { record.result = result; delete record.progress; }
  await saveRecoveryRecord(workspace, record, "move");
  return result;
}
