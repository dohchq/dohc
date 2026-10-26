import { createHash, randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import { createReadStream } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, readlink, realpath, rename, rm, rmdir, stat, symlink, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { OperationRecovery as OperationRecoverySchema, HistoryOperationUndoResult } from "@dohc/workspace-contracts/history-operation";
import type { HistoryOperationsStore, MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { validateUserMaterializePath } from "@dohc/workspace-core";
import { readOwnedFile } from "@dohc/workspace-core/owned-file";
import { realRelativeInRoot } from "@dohc/workspace-core/realPath";
import { isInside } from "../security/pathContainment";
import { localStateDir, LocalStateFolderError, readOwnedLocalStateFolder, type LocalStateWorkspace } from "./workspaceLocalState";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";
import { WORKSPACE_TRASH, workspaceTrashForWrite } from "./workspaceTrash";

export type OperationRecovery = z.infer<typeof OperationRecoverySchema>;
const UndoResult = HistoryOperationUndoResult.options[1].extend({
  remaining: z.array(HistoryOperationUndoResult.options[1].shape.remaining.element.omit({ retry: true })),
});
export type DeleteUndoResult = z.infer<typeof HistoryOperationUndoResult>;
const Record = z.object({
  operationId: z.string(), staged: z.string().optional(), noUndo: z.string().optional(), base: z.string(), paths: z.array(z.string()),
  emptyFolders: z.array(z.string()), tracked: z.boolean(),
  copies: z.array(z.object({
    path: z.string(), dev: z.number(), ino: z.number(), birthtimeMs: z.number(), size: z.number(),
  })).optional(),
  engine: z.object({ materialized: z.boolean(), momentCount: z.number(), notRestored: z.array(z.string()).optional() }).optional(), progress: UndoResult.optional(), result: UndoResult.optional(),
});
export type RecoveryRecord = z.infer<typeof Record>;
export type DeleteRecoveryPlan = { operationId: string; record?: RecoveryRecord; noUndo?: string };
const code = (error: unknown) => error && typeof error === "object" && "code" in error ? error.code : undefined;
const info = async (path: string) => lstat(path).catch(error => { if (code(error) === "ENOENT") return null; throw error; });
const recordName = (id: string, kind = "delete") => `${kind}-${createHash("sha256").update(id).digest("hex")}.json`;
// Waiters never hold the workspace queue. A move read waits for its record too.
const pendingRecoveries = new Map<string, { done: Promise<void>; waitForReads: boolean }>();
export function beginPendingRecovery(operationId: string, options: { signal?: AbortSignal; waitForReads?: boolean } = {}): () => void {
  let resolve!: () => void, retirement: ReturnType<typeof addAbortListener> | undefined;
  const pending = { done: new Promise<void>(done => { resolve = done; }), waitForReads: options.waitForReads ?? false };
  const finish = () => { if (pendingRecoveries.get(operationId) === pending) pendingRecoveries.delete(operationId); retirement?.[Symbol.dispose](); resolve(); };
  pendingRecoveries.set(operationId, pending);
  if (options.signal?.aborted) finish();
  else if (options.signal) retirement = addAbortListener(options.signal, finish);
  return finish;
}
export async function waitForRecovery(operationId: string, signal?: AbortSignal, action: "read" | "undo" = "undo"): Promise<void> {
  const entry = pendingRecoveries.get(operationId);
  if (!entry || signal?.aborted || (action === "read" && !entry.waitForReads)) return;
  const pending = entry.done;
  if (!signal) { await pending; return; }
  let retirement!: ReturnType<typeof addAbortListener>;
  const retired = new Promise<void>(done => { retirement = addAbortListener(signal, () => done()); });
  try { await Promise.race([pending, retired]); }
  finally { retirement[Symbol.dispose](); }
}
const systemTrash = process.platform === "win32" ? "Recycle Bin" : "Trash";
const MAX_RECORD_AGE = 30 * 24 * 60 * 60 * 1_000;
// A record lists each untracked path a delete took, so a large folder makes a large record.
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
// Where deleted files can be when dohc does not know which.
const restoreByHand = `Restore files from History, the system trash, or ${WORKSPACE_TRASH}.`;
const invalidRecovery = `Cannot undo the delete. Its recovery record is invalid. ${restoreByHand}`;
export const missingDeleteRecoveryReason = `Cannot undo the delete. Its recovery record is missing or expired. ${restoreByHand}`;

// Only recovery metadata expires. Fallback trash contents keep their lifetime.
const prunes = new Map<string, Promise<void>>();
export function scheduleRecoveryPrune(workspace: LocalStateWorkspace): void {
  if (prunes.has(workspace.rootPath)) return;
  prunes.set(workspace.rootPath, new Promise<void>(resolve => setImmediate(resolve)).then(() => prune(workspace)).catch(() => undefined));
}
// Whoever removes a workspace folder, such as a test's cleanup, waits for its prune,
// which reads the folder on its own schedule.
export async function waitForRecoveryPrune(root: string): Promise<void> {
  await prunes.get(root);
}
// A removal is a write, so it waits for this open's `.dohc/local` too, but it
// creates nothing.
async function prune(workspace: LocalStateWorkspace): Promise<void> {
  await localStateDir(workspace);
  await readOwnedLocalStateFolder(workspace.rootPath, "trash", async (dir) => {
    if (dir === null || dir === "unusable") return;
    for (const name of await readdir(dir)) {
      if (!/^(?:delete|move)-[a-f0-9]{64}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/u.test(name)) continue;
      try {
        const path = join(dir, name), entry = await lstat(path);
        if (entry.isFile() && Date.now() - entry.mtimeMs > MAX_RECORD_AGE) {
          await rm(path, { force: true });
        }
      } catch { /* Cleanup cannot affect another delete or its Undo. */ }
    }
  });
}
export async function saveRecoveryRecord(workspace: LocalStateWorkspace, record: { operationId: string }, kind = "delete"): Promise<void> {
  const dir = await workspaceTrashForWrite(workspace, "save Undo information");
  const path = join(dir, recordName(record.operationId, kind));
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    // 0600 whatever the umask: the reader refuses a record others can write.
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
    finally { await file.close(); }
    // Atomic replacement, not a power-loss durability guarantee on Windows.
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => undefined); }
}
/**
 * A recovery record's text, read from the workspace trash. A record decides
 * where Undo writes and what it puts back, so dohc trusts only a file this
 * user owns and alone can change, read through one handle, in a trash folder
 * only this user can change. Any other record is "untrusted", which Undo
 * treats as invalid: it refuses and changes nothing. `.dohc` and
 * `.dohc/local` are checked first, and a problem with either is "refused"
 * with words that fix it. Reads create nothing, and wait for the engine only
 * on Windows, for an open under way.
 */
export async function readRecoveryRecordText(root: string, id: string, kind: "delete" | "move"): Promise<RecoveryRecordRead> {
  return readOwnedLocalStateFolder(root, "trash", (dir) => recordIn(dir, id, kind)).catch((error: unknown): RecoveryRecordRead => {
    if (error instanceof LocalStateFolderError) return { status: "refused", reason: error.message };
    throw error;
  });
}
type RecoveryRecordRead = { status: "missing" } | { status: "untrusted" } | { status: "refused"; reason: string } | { status: "read"; text: string };
async function recordIn(dir: string | null | "unusable", id: string, kind: "delete" | "move"): Promise<RecoveryRecordRead> {
  if (dir === null) return { status: "missing" };
  if (dir === "unusable") return { status: "untrusted" };
  const path = join(dir, recordName(id, kind));
  const entry = await info(path);
  if (!entry || Date.now() - entry.mtimeMs > MAX_RECORD_AGE) return { status: "missing" };
  const read = await readOwnedFile(path, MAX_RECORD_BYTES).catch(() => null);
  if (read?.status === "missing") return { status: "missing" };
  return read?.status === "read" ? { status: "read", text: read.content } : { status: "untrusted" };
}
export async function readDeleteRecovery(root: string, id: string, action: "read" | "undo" = "undo"): Promise<RecoveryRecord | undefined> {
  const refusal = (detail: string) => new Error(`Cannot ${action === "read" ? "read this operation" : "undo the delete"}. ${detail}`);
  const invalidRecord = `Its recovery record is invalid.${action === "undo" ? ` ${restoreByHand}` : ""}`;
  const read = await readRecoveryRecordText(root, id, "delete");
  if (read.status === "missing") return undefined;
  if (read.status === "refused") throw refusal(read.reason);
  if (read.status === "untrusted") throw refusal(invalidRecord);
  let record: RecoveryRecord;
  try { record = Record.parse(JSON.parse(read.text)); }
  catch { throw refusal(invalidRecord); }
  if (record.operationId !== id) throw refusal(invalidRecord);
  const paths = [record.base, ...record.paths, ...record.emptyFolders, ...(record.copies?.map(copy => copy.path) ?? []),
    ...[record.progress, record.result].flatMap(result => [...(result?.restored ?? []), ...(result?.remaining.map(item => item.path) ?? [])])];
  if (paths.some(path => !validPath(path, record.base))) {
    throw refusal("Its recovery paths are invalid.");
  }
  if (record.staged !== undefined && (!validPath(record.staged, record.staged) || record.staged.includes("/"))) {
    throw refusal(invalidRecord);
  }
  return record;
}

// Collection stays in memory until the delete finishes. Bookkeeping cannot veto a delete.
export async function stageDeleteRecovery(operationId: string, staged: string, base: string,
  tracked: readonly string[]): Promise<DeleteRecoveryPlan> {
  try {
    const paths: string[] = [], emptyFolders: string[] = [];
    const recorded = new Set(tracked), parents = new Set<string>();
    for (const file of tracked) {
      for (let parent = dirname(file); parent !== "."; parent = dirname(parent)) parents.add(parent.split(sep).join("/"));
    }
    let invalid: string | undefined;
    const walk = async (sub: string): Promise<void> => {
      const path = sub ? `${base}/${sub}` : base;
      if (!validPath(path, base)) invalid ??= path;
      const entry = await lstat(join(staged, sub));
      if (entry.isDirectory()) {
        const entries = await readdir(join(staged, sub));
        if (!entries.length) emptyFolders.push(path);
        else if (!parents.has(path)) paths.push(path);
        else for (const name of entries) await walk(sub ? `${sub}/${name}` : name);
      } else if (!recorded.has(path)) paths.push(path);
    };
    await walk("");
    return { operationId, record: { operationId, base, paths, emptyFolders, tracked: tracked.length > 0 },
      ...(invalid ? { noUndo: `Cannot undo the delete. Invalid recovery path: ${invalid}. Restore it from the trash.` } : {}) };
  } catch { return { operationId }; }
}
export async function finishDeleteRecovery(workspace: LocalStateWorkspace, plan: DeleteRecoveryPlan,
  { trashed, staged }: { trashed: boolean; staged?: string }): Promise<OperationRecovery> {
  const { operationId, record } = plan;
  try {
    if (!record) throw new Error("Recovery collection failed");
    record.staged = trashed || staged === undefined ? undefined : basename(staged);
    if (!plan.noUndo && trashed && record.paths.length) {
      const where = `in the ${systemTrash}`;
      plan.noUndo = `Cannot undo the delete. ${record.paths.join(", ")} ${record.paths.length === 1 ? "is" : "are"} ${where}. Restore ${record.paths.length === 1 ? "it" : "them"} there.`;
      record.noUndo = plan.noUndo;
      await saveRecoveryRecord(workspace, record).catch(() => undefined);
      scheduleRecoveryPrune(workspace);
    }
    if (plan.noUndo) {
      return { operationId, undo: { available: false, reason: plan.noUndo, paths: record.paths } };
    }
    await saveRecoveryRecord(workspace, record);
    scheduleRecoveryPrune(workspace);
    return { operationId, undo: { available: true } };
  } catch {
    return { operationId, undo: { available: false, paths: record?.paths ?? [],
      reason: `Delete finished. dohc could not save Undo information. Restore files from History or ${trashed ? "the system trash" : WORKSPACE_TRASH}.` } };
  }
}
const validPath = (path: string, base: string) => {
  const checked = validateUserMaterializePath(path, { platform: process.platform, allowIgnoredSegments: path !== base });
  return checked.ok && checked.normalized === path;
};
async function checkedTarget(root: string, path: string, base: string): Promise<string> {
  if (!validPath(path, base)) throw new Error(`Cannot undo the delete. Invalid recovery path: ${path}.`);
  await assertResolvedWorkspacePath({ rootPath: root, absolutePath: join(root, base), spelled: base, label: "Undo path", access: "entry" });
  const target = await realRelativeInRoot(root, join(root, path), true);
  if (!target.ok || target.relative !== path) throw new Error(`Cannot undo the delete. ${path} now leads somewhere else.`);
  return target.resolvedAbsolute;
}
// The deleted entry's copy in the workspace trash. Nothing pins its bytes:
// the record names only where it is. Only this user can reach it, because
// `.dohc/local` is private and the trash is a folder no other user can change.
async function sourcePath(dir: string, record: RecoveryRecord, path: string): Promise<string> {
  if (!record.staged || path !== record.base && !path.startsWith(`${record.base}/`)) throw new Error(invalidRecovery);
  const source = join(dir, record.staged, path.slice(record.base.length));
  const parent = await realpath(dirname(source));
  if (!isInside(dir, parent)) throw new Error("Cannot undo the delete. Its staged path leads outside the workspace trash.");
  return source;
}
const fingerprint = async (path: string | FileHandle, size?: number) => {
  const hash = createHash("sha256");
  const range = { start: 0, ...(size === undefined ? {} : { end: size - 1 }) };
  if (size !== 0) {
    const stream = typeof path === "string" ? createReadStream(path, range) : path.createReadStream({ ...range, autoClose: false });
    for await (const chunk of stream) hash.update(chunk);
  }
  return hash.digest("hex");
};
async function alreadyPlaced(source: string, target: string): Promise<boolean> {
  const [a, b] = await Promise.all([lstat(source), info(target)]);
  if (!b) return false;
  if (a.isSymbolicLink()) return b.isSymbolicLink() && await readlink(source) === await readlink(target);
  return b.isFile() && a.size === b.size && (a.ino !== 0 && a.ino === b.ino && a.dev === b.dev || await fingerprint(source) === await fingerprint(target));
}

// Retrying through a verified handle cannot remove or overwrite a replacement at the path.
async function copyExclusive(workspace: LocalStateWorkspace, record: RecoveryRecord, path: string, source: string, target: string, mode: number): Promise<void> {
  const pending = record.copies?.find(copy => copy.path === path), occupant = await info(target);
  if (pending && occupant && !occupant.isFile()) throw Object.assign(new Error("Copy target changed"), { code: "EEXIST" });
  const size = (await lstat(source)).size;
  let writable = true;
  let file = pending && occupant
    ? await open(target, "r+").catch(error => {
      if (code(error) === "EISDIR") throw Object.assign(new Error("Copy target changed"), { code: "EEXIST" });
      if (code(error) !== "EPERM" && code(error) !== "EACCES") throw error;
      writable = false;
      return open(target, "r");
    })
    : await open(target, "wx", mode);
  let complete = false;
  try {
    const entry = await file.stat();
    if (pending && occupant) {
      if (!entry.isFile() || pending.ino === 0
        || entry.dev !== pending.dev || entry.ino !== pending.ino || entry.birthtimeMs !== pending.birthtimeMs
        || size !== pending.size || entry.size > size
        || await fingerprint(file, entry.size) !== await fingerprint(source, entry.size)) {
        throw Object.assign(new Error("Copy target changed"), { code: "EEXIST" });
      }
      // Full bytes may have survived a crash before the receipt. Flush them before acknowledging the copy.
      complete = entry.size === size;
    }
    if (!writable) {
      await file.chmod(mode | 0o200);
      await file.close();
      file = await open(target, "r+");
      const current = await file.stat();
      if (!current.isFile() || current.dev !== entry.dev || current.ino !== entry.ino || current.birthtimeMs !== entry.birthtimeMs
        || current.size !== entry.size || await fingerprint(file, current.size) !== await fingerprint(source, current.size)) {
        throw Object.assign(new Error("Copy target changed"), { code: "EEXIST" });
      }
    }
    if (!complete) {
      record.copies = [...(record.copies ?? []).filter(copy => copy.path !== path),
        { path, dev: entry.dev, ino: entry.ino, birthtimeMs: entry.birthtimeMs, size }];
      // Persist ownership before the first byte. A crash before this save leaves an unclaimed occupant.
      await saveRecoveryRecord(workspace, record);
      await file.writeFile(createReadStream(source));
    }
    await file.chmod(mode & 0o7777);
    await file.sync();
  } finally { await file.close(); }
  const copy = record.copies!.find(copy => copy.path === path)!, placed = await info(target);
  if (!placed?.isFile() || placed.dev !== copy.dev || placed.ino !== copy.ino || placed.birthtimeMs !== copy.birthtimeMs
    || placed.size !== copy.size) {
    throw Object.assign(new Error("Copy target changed"), { code: "EEXIST" });
  }
}
export async function undoDeleteRecovery(workspace: LocalStateWorkspace, record: RecoveryRecord, author: MomentWriteAuthor,
  history: Pick<HistoryOperationsStore, "undoHistoryOperation">, workspaceId: string,
  assertCurrent: () => void, markChanged: () => void): Promise<DeleteUndoResult> {
  const root = workspace.rootPath;
  assertCurrent();
  if (record.noUndo) return { ok: false, reason: record.noUndo };
  const expose = (result: z.infer<typeof UndoResult>): DeleteUndoResult => ({ ...result,
    remaining: result.remaining.map(item => ({ ...item, retry: record.copies?.some(copy => copy.path === item.path) ?? false })) });
  const engineUndo = () => history.undoHistoryOperation({ workspaceId, operationId: record.operationId,
    requestId: `delete-undo:${record.operationId}`, author });
  // Undo saves its progress in the trash, so it asks History only where it can.
  if (record.result) {
    if (record.result.tracked.state === "restoring") {
      await workspaceTrashForWrite(workspace, "undo the delete");
      try {
        const current = await engineUndo();
        if (current.materialized) { record.result.tracked.state = "restored"; await saveRecoveryRecord(workspace, record); }
      } catch { /* A finished Undo keeps its saved result when refresh is unavailable. */ }
    }
    return expose(record.result);
  }
  const trash = await workspaceTrashForWrite(workspace, "undo the delete");
  const resuming = record.engine !== undefined;
  if (!record.engine) {
    for (const path of [...record.paths, ...record.emptyFolders]) {
      const target = await checkedTarget(root, path, record.base);
      const occupant = await info(target);
      if (occupant && !(record.emptyFolders.includes(path) && occupant.isDirectory())) return { ok: false, reason: `Cannot undo the delete. ${path} now occupies the old path. Move it first.`,
        refusal: { code: "old-path-occupied", path } };
      if (record.paths.includes(path)) {
        const source = await sourcePath(trash, record, path).catch(error => { if (code(error) === "ENOENT") return undefined; throw error; });
        if (!source || !await info(source)) return { ok: false, reason: `Cannot undo the delete. ${path} is no longer in ${WORKSPACE_TRASH}, and History has no copy of it. Check the ${systemTrash}.` };
      }
    }
    assertCurrent();
    const receipt = record.tracked ? await engineUndo() : { materialized: true, momentCount: 0, notRestored: [] };
    record.engine = { materialized: receipt.materialized, momentCount: receipt.momentCount, notRestored: [...receipt.notRestored] };
    await saveRecoveryRecord(workspace, record);
    markChanged();
  }
  const pendingPaths = record.progress ? new Set(record.copies?.map(copy => copy.path)) : undefined;
  const result: z.infer<typeof UndoResult> = { ok: true,
    tracked: { state: record.engine.materialized ? "restored" : "restoring", momentCount: record.engine.momentCount },
    restored: record.progress?.restored ?? [], remaining: record.progress?.remaining.filter(item => !pendingPaths?.has(item.path)) ?? [] };
  if (record.progress) record.progress = result;
  for (const path of record.engine.notRestored ?? []) {
    if (!result.remaining.some(item => item.path === path)) result.remaining.push({ path,
      reason: "dohc could not restore this file. Restore it from History." });
  }
  const keepSource = new Set<string>();
  const linkedModes = new Map<string, number>();
  const place = async (path: string, empty = false): Promise<void> => {
    assertCurrent();
    if (record.engine?.notRestored?.includes(path)) {
      return;
    }
    const trashPath = `${WORKSPACE_TRASH}/${record.staged}${path.slice(record.base.length)}`;
    let retryable = false;
    let folder = empty;
    try {
      const target = await checkedTarget(root, path, record.base);
      const source = empty ? undefined : await sourcePath(trash, record, path);
      const entry = source === undefined ? undefined : await lstat(source);
      folder = empty || entry?.isDirectory() === true;
      retryable = true;
      if (empty || entry?.isDirectory()) {
        await mkdir(dirname(target), { recursive: true });
        if (!(empty || resuming) || !(await info(target))?.isDirectory()) await mkdir(target);
        const start = result.restored.length, failures = result.remaining.length;
        for (const name of source === undefined ? [] : await readdir(source)) await place(`${path}/${name}`);
        if (result.remaining.length === failures && ![...keepSource].some(child => child.startsWith(`${path}/`))) result.restored.splice(start, result.restored.length - start, path);
        return;
      }
      if (record.copies?.some(copy => copy.path === path)) {
        await copyExclusive(workspace, record, path, source!, target, entry!.mode);
      } else if (!resuming || !await alreadyPlaced(source!, target)) {
        await mkdir(dirname(target), { recursive: true });
        await checkedTarget(root, path, record.base);
        if (entry?.isSymbolicLink()) {
          const destination = await readlink(source!);
          const original = resolve(root, dirname(path), destination);
          const base = join(root, record.base);
          const referent = isInside(base, original) ? join(trash, record.staged!, relative(base, original)) : original;
          const directory = await stat(referent).then(value => value.isDirectory(), () => false);
          await symlink(destination, target, directory ? process.platform === "win32" && isAbsolute(destination) ? "junction" : "dir" : "file");
        } else {
          try {
            await link(source!, target);
            if (process.platform === "win32" && (entry!.mode & 0o222) === 0) linkedModes.set(target, entry!.mode & 0o7777);
          } catch (error) {
            if (code(error) === "EEXIST") throw error;
            await copyExclusive(workspace, record, path, source!, target, entry!.mode);
          }
        }
      } else {
        // A resumed copy may have missed its flush. Keep the private source.
        keepSource.add(path);
      }
      if (record.copies) record.copies = record.copies.filter(copy => copy.path !== path);
      result.restored.push(path);
      markChanged();
    } catch (error) {
      // An interrupted copy stays journaled and keeps its source until a later Undo succeeds.
      const sourceMissing = !empty && await sourcePath(trash, record, path)
        .then(async source => !await info(source)).catch(sourceError => code(sourceError) === "ENOENT");
      const pendingCopy = record.copies?.some(copy => copy.path === path) ?? false;
      if (sourceMissing && record.copies) record.copies = record.copies.filter(copy => copy.path !== path);
      result.remaining.push({ path, reason: empty
        ? `dohc could not recreate ${path}. Check the old path, then create the folder there.`
        : code(error) === "EEXIST"
        ? `${path} now occupies the old path. ${pendingCopy && !sourceMissing ? "Move it first. " : ""}${sourceMissing ? "Its trash copy is gone." : `The deleted ${folder ? "folder" : "file"} stays at ${trashPath}.`}`
        : sourceMissing
        ? pendingCopy
          && await checkedTarget(root, path, record.base).then(info).then(entry => entry?.isFile()).catch(() => false)
          ? `${path} may be incomplete. Its trash copy is gone.`
          : `dohc could not put ${path} back. Its trash copy is gone.`
        : retryable && record.copies?.some(copy => copy.path === path)
          && await info(join(root, path)).then(entry => entry?.isFile()).catch(() => false)
        ? `${path} may be incomplete. Undo again to retry, or restore it from ${trashPath}.`
        : `dohc could not put ${path} back. It stays at ${trashPath}.` });
    }
  };
  if (pendingPaths) {
    for (const path of pendingPaths) await place(path);
  } else {
    for (const path of record.paths) await place(path);
    for (const path of record.emptyFolders) await place(path, true);
  }
  if (record.copies?.length) record.progress = result;
  else { record.result = result; delete record.progress; }
  await saveRecoveryRecord(workspace, record);
  const staged = record.staged ? join(trash, record.staged) : undefined;
  if (staged) for (const path of result.restored.filter(path => !keepSource.has(path))) {
    await sourcePath(trash, record, path).then(async source => {
      if (record.emptyFolders.includes(path)) await rmdir(source);
      else await rm(source, { recursive: true, force: true });
      for (let parent = dirname(source); isInside(staged, parent); parent = dirname(parent)) await rmdir(parent);
    }).catch(() => undefined);
  }
  for (const [target, mode] of linkedModes) await chmod(target, mode).catch(() => undefined);
  return expose(result);
}
