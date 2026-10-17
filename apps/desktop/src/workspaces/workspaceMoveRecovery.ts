import type { HistoryOperationsStore, MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { lstat, readFile, readdir, realpath, rmdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { HistoryOperationId, HistoryOperationUndoResult } from "@dohc/workspace-contracts/history-operation";
import type { OperationRecovery } from "./workspaceDeleteRecovery";
import { saveRecoveryRecord, scheduleRecoveryPrune, type DeleteRecoveryPlan } from "./workspaceDeleteRecovery";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";
import { isInside } from "../security/pathContainment";

const Record = z.object({
  operationId: HistoryOperationId, from: z.string(), to: z.string(), entries: z.array(z.string()),
  tracked: z.boolean(), pending: z.array(z.string()).optional(), replaced: z.boolean().optional(),
  engine: z.object({ materialized: z.boolean(), momentCount: z.number() }).optional(),
  progress: HistoryOperationUndoResult.options[1].optional(), result: HistoryOperationUndoResult.options[1].optional(),
});
export type MoveRecoveryRecord = z.infer<typeof Record>;
export const moveWord = (from: string, to: string) => dirname(from) === dirname(to) ? "rename" : "move";
export const moveBack = (word: "move" | "rename") => word === "rename" ? "Rename it back yourself." : "Move it back yourself.";
export const caseOnlyMoveReason = "Cannot undo the rename. It changed only the letter case. Rename it back yourself.";
export const missingMoveRecoveryReason = (word: "move" | "rename") => `Cannot undo the ${word}. Its recovery record is missing or expired. ${moveBack(word)}`;
const invalid = (word: "move" | "rename") => `Cannot undo the ${word}. Its recovery record is invalid. ${moveBack(word)}`;
const absent = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

export async function readMoveRecovery(root: string, id: string): Promise<MoveRecoveryRecord | undefined> {
  const metadata = await resolveWorkspaceMetadataDir(root, { create: false });
  if (!metadata) return undefined;
  const dir = join(metadata, "trash");
  const folder = await lstat(dir).catch(error => { if (absent(error)) return null; throw error; });
  if (!folder) return undefined;
  if (!folder.isDirectory() || folder.isSymbolicLink() || !isInside(await realpath(root), await realpath(dir))) throw new Error(invalid("move"));
  const path = join(dir, `move-${createHash("sha256").update(id).digest("hex")}.json`);
  const entry = await lstat(path).catch(error => { if (absent(error)) return null; throw error; });
  if (!entry || Date.now() - entry.mtimeMs > 30 * 24 * 60 * 60 * 1_000) return undefined;
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(invalid("move"));
  let record: MoveRecoveryRecord;
  try { record = Record.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch { throw new Error(invalid("move")); }
  if (record.operationId !== id) throw new Error(invalid(moveWord(record.from, record.to)));
  return record;
}

export async function finishMoveRecovery(root: string, plan: DeleteRecoveryPlan, from: string, to: string, replaced: boolean): Promise<OperationRecovery> {
  const word = moveWord(from, to);
  try {
    if (!plan.record || plan.noUndo) throw new Error("Recovery collection failed");
    const record: MoveRecoveryRecord = { operationId: plan.operationId, from, to,
      entries: [...plan.record.paths, ...plan.record.emptyFolders], tracked: plan.record.tracked, ...(replaced ? { replaced } : {}) };
    await saveRecoveryRecord(root, record, "move");
    scheduleRecoveryPrune(root);
    return { operationId: plan.operationId, undo: replaced
      ? { available: false, paths: [], reason: replacedMoveReason(record) }
      : { available: true } };
  } catch {
    return { operationId: plan.operationId, undo: { available: false, paths: [],
      reason: `${word === "rename" ? "Rename" : "Move"} finished. dohc could not save Undo information. ${moveBack(word)}` } };
  }
}
export function replacedMoveReason(record: MoveRecoveryRecord): string {
  const word = moveWord(record.from, record.to);
  return `Cannot undo the ${word}. It replaced the old ${record.to}. ${moveBack(word)} Restore the old ${record.to} from History or the trash.`;
}

const info = (path: string) => lstat(path).catch(error => { if (absent(error)) return null; throw error; });
export const moveEntryTarget = (record: MoveRecoveryRecord, path: string) => record.to + path.slice(record.from.length);
export async function undoMoveRecovery(root: string, record: MoveRecoveryRecord, members: readonly { path: string }[],
  author: MomentWriteAuthor, history: Pick<HistoryOperationsStore, "undoHistoryOperation">, workspaceId: string,
  assertCurrent: () => void, markChanged: () => void,
  placeBack: (root: string, source: string, target: string) => Promise<string[]>,
): Promise<z.infer<typeof HistoryOperationUndoResult>> {
  const word = moveWord(record.from, record.to);
  const refuse = (detail: string): never => { throw new Error(`Cannot undo the ${word}. ${detail}`); };
  const engineUndo = () => history.undoHistoryOperation({ workspaceId, operationId: record.operationId,
    requestId: `move-undo:${record.operationId}`, author });
  const cleanup = async (path: string): Promise<void> => {
    if (!(await info(path))?.isDirectory()) return;
    for (const name of await readdir(path)) await cleanup(join(path, name));
    await rmdir(path).catch(() => undefined);
  };
  const refresh = async (result: z.infer<typeof HistoryOperationUndoResult.options[1]>) => {
    if (result.tracked.state === "restoring") {
      const current = await engineUndo();
      if (current.materialized) result.tracked.state = "restored";
    }
    if (result.tracked.state === "restored") await cleanup(join(root, record.to));
    await saveRecoveryRecord(root, record, "move");
    markChanged();
    return result;
  };
  assertCurrent();
  if (record.replaced) throw new Error(replacedMoveReason(record));
  if (record.result) return refresh(record.result);
  if (!record.engine) {
    if (!await info(join(root, record.to))) return refuse(`Nothing is at ${record.to} now. Check History for where it went.`);
    if (await info(join(root, record.from))) return refuse(`${record.from} now occupies the old path. Move it first.`);
    const admitted = new Set(members.map(member => member.path));
    const entries = record.entries.map(path => moveEntryTarget(record, path));
    const walk = async (path: string): Promise<string | undefined> => {
      if (entries.includes(path)) return;
      const entry = await info(join(root, path));
      if (!entry) return;
      if (entry.isDirectory()) {
        for (const name of await readdir(join(root, path))) { const added = await walk(`${path}/${name}`); if (added) return added; }
      } else if (!admitted.has(path)) return path;
    };
    const added = await walk(record.to);
    if (added) return refuse(`The ${word} did not bring ${added}. Move it out of ${record.to} first.`);
    assertCurrent();
    const receipt = record.tracked ? await engineUndo() : { materialized: true, momentCount: 0 };
    record.engine = { materialized: receipt.materialized, momentCount: receipt.momentCount };
    record.pending = [...record.entries];
    await saveRecoveryRecord(root, record, "move");
    markChanged();
  }
  const result: z.infer<typeof HistoryOperationUndoResult.options[1]> = { ok: true,
    tracked: { state: record.engine.materialized ? "restored" : "restoring", momentCount: record.engine.momentCount },
    restored: record.progress?.restored ?? [], remaining: [] };
  for (const path of [...(record.pending ?? record.entries)]) {
    assertCurrent();
    const source = moveEntryTarget(record, path), entry = await info(join(root, source));
    const left = entry ? await placeBack(root, join(root, source), join(root, path)) : [];
    const remaining = left.map(sub => sub ? `${path}/${sub}` : path);
    record.pending = [...(record.pending ?? record.entries).filter(item => item !== path), ...remaining];
    if (entry && !left.length) result.restored.push(path);
    for (const path of remaining) {
      const source = moveEntryTarget(record, path), moved = await info(join(root, source));
      result.remaining.push({ path, retry: true, reason: await info(join(root, path))
        ? `${path} now occupies the old path. Move it first. The moved ${moved?.isDirectory() ? "folder" : "file"} stays at ${source}.`
        : `dohc could not put ${path} back. It stays at ${source}.` });
    }
    record.progress = result;
    await saveRecoveryRecord(root, record, "move");
    markChanged();
  }
  if (!record.pending?.length) { record.result = result; delete record.progress; }
  await saveRecoveryRecord(root, record, "move");
  return refresh(result);
}
