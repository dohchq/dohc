import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, rmdir, stat, symlink, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { HistoryOperationsStore, MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { validateUserMaterializePath } from "@dohc/workspace-core";
import { realRelativeInRoot } from "@dohc/workspace-core/realPath";
import { isInside } from "../security/pathContainment";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";

export type DeleteRecovery = { operationId: string; undo: { available: true } | { available: false; reason: string; paths: string[] } };
const UndoResult = z.object({
  ok: z.literal(true), tracked: z.object({ state: z.enum(["restoring", "restored"]), momentCount: z.number() }),
  restored: z.array(z.string()), remaining: z.array(z.object({ path: z.string(), reason: z.string() })),
});
export type DeleteUndoResult = { ok: false; reason: string } | z.infer<typeof UndoResult>;
const Record = z.object({
  operationId: z.string(), staged: z.string().optional(), base: z.string(), paths: z.array(z.string()),
  emptyFolders: z.array(z.string()), tracked: z.boolean(),
  copies: z.array(z.object({
    path: z.string(), dev: z.number(), ino: z.number(), birthtimeMs: z.number(), size: z.number(),
  })).optional(),
  engine: z.object({ materialized: z.boolean(), momentCount: z.number() }).optional(), progress: UndoResult.optional(), result: UndoResult.optional(),
});
type RecoveryRecord = z.infer<typeof Record>;
export type DeleteRecoveryPlan = { operationId: string; record?: RecoveryRecord; noUndo?: string };
const code = (error: unknown) => error && typeof error === "object" && "code" in error ? error.code : undefined;
const info = async (path: string) => lstat(path).catch(error => { if (code(error) === "ENOENT") return null; throw error; });
const recordName = (id: string) => `delete-${createHash("sha256").update(id).digest("hex")}.json`;
const MAX_RECORD_AGE = 30 * 24 * 60 * 60 * 1_000;
const unavailable = "Cannot undo the delete. Its recovery record is missing or expired. Restore files from History or the trash.";

async function trashDir(root: string): Promise<string> {
  const dir = join(await resolveWorkspaceMetadataDir(root), "trash");
  await mkdir(dir, { recursive: true });
  const entry = await lstat(dir);
  if (!entry.isDirectory() || entry.isSymbolicLink() || !isInside(await realpath(root), await realpath(dir))) {
    throw new Error("Cannot undo the delete. The workspace trash must be a real folder inside this workspace.");
  }
  return dir;
}
// Only recovery metadata expires. Fallback trash contents keep their lifetime.
const pruned = new Set<string>();
function schedulePrune(root: string): void {
  if (pruned.has(root)) return;
  pruned.add(root);
  setImmediate(() => { void prune(root).catch(() => undefined); });
}
async function prune(root: string): Promise<void> {
  const dir = await trashDir(root);
  for (const name of await readdir(dir)) {
    if (!/^delete-[a-f0-9]{64}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/u.test(name)) continue;
    try {
      const path = join(dir, name), entry = await lstat(path);
      if (entry.isFile() && Date.now() - entry.mtimeMs > MAX_RECORD_AGE) {
        await rm(path, { force: true });
      }
    } catch { /* Cleanup cannot affect another delete or its Undo. */ }
  }
}
async function save(root: string, record: RecoveryRecord): Promise<void> {
  const dir = await trashDir(root);
  const path = join(dir, recordName(record.operationId));
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx");
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
    finally { await file.close(); }
    // Atomic replacement, not a power-loss durability guarantee on Windows.
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => undefined); }
}
async function load(root: string, id: string): Promise<RecoveryRecord> {
  const dir = await trashDir(root);
  const path = join(dir, recordName(id));
  const entry = await info(path);
  if (!entry) throw new Error(unavailable);
  if (Date.now() - entry.mtimeMs > MAX_RECORD_AGE) { await unlink(path); throw new Error(unavailable); }
  if (entry.isSymbolicLink()) throw new Error("Cannot undo the delete. Its recovery record is a link.");
  const record = Record.parse(JSON.parse(await readFile(path, "utf8")));
  if (record.operationId !== id || record.staged !== undefined && basename(record.staged) !== record.staged) throw new Error("Invalid delete recovery record.");
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
export async function finishDeleteRecovery(root: string, plan: DeleteRecoveryPlan, trashed: boolean, staged?: string): Promise<DeleteRecovery> {
  const { operationId, record } = plan;
  try {
    if (!record) throw new Error("Recovery collection failed");
    record.staged = trashed || staged === undefined ? undefined : basename(staged);
    if (!plan.noUndo && trashed && record.paths.length) {
      const where = process.platform === "win32" ? "in the Recycle Bin" : "in the Trash";
      plan.noUndo = `Cannot undo the delete. ${record.paths.join(", ")} ${record.paths.length === 1 ? "is" : "are"} ${where}. Restore ${record.paths.length === 1 ? "it" : "them"} there.`;
    }
    if (plan.noUndo) return { operationId, undo: { available: false, reason: plan.noUndo, paths: record.paths } };
    await save(root, record);
    schedulePrune(root);
    return { operationId, undo: { available: true } };
  } catch {
    return { operationId, undo: { available: false, paths: record?.paths ?? [],
      reason: "Delete finished. dohc could not save Undo information. Restore files from History or the trash." } };
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
async function sourcePath(root: string, record: RecoveryRecord, path: string): Promise<string> {
  if (!record.staged || path !== record.base && !path.startsWith(`${record.base}/`)) throw new Error("Invalid delete recovery record.");
  const dir = await trashDir(root);
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
async function copyExclusive(root: string, record: RecoveryRecord, path: string, source: string, target: string, mode: number): Promise<void> {
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
      await save(root, record);
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
export async function undoDeleteRecovery(root: string, input: { operationId: string; requestId: string }, author: MomentWriteAuthor,
  history: Pick<HistoryOperationsStore, "undoHistoryOperation">, workspaceId: string,
  assertCurrent: () => void, markChanged: () => void): Promise<DeleteUndoResult> {
  const record = await load(root, input.operationId);
  const engineUndo = () => history.undoHistoryOperation({ workspaceId, operationId: input.operationId,
    requestId: `delete-undo:${input.operationId}`, author });
  if (record.result) {
    if (record.result.tracked.state === "restoring") {
      try {
        const current = await engineUndo();
        if (current.materialized) { record.result.tracked.state = "restored"; await save(root, record); }
      } catch { /* A finished Undo keeps its saved result when refresh is unavailable. */ }
    }
    return record.result;
  }
  const resuming = record.engine !== undefined;
  if (!record.engine) {
    for (const path of [...record.paths, ...record.emptyFolders]) {
      const target = await checkedTarget(root, path, record.base);
      const occupant = await info(target);
      if (occupant && !(record.emptyFolders.includes(path) && occupant.isDirectory())) return { ok: false, reason: `Cannot undo the delete. ${path} now occupies the old path. Move it first.` };
      if (record.paths.includes(path)) {
        const source = await sourcePath(root, record, path).catch(error => { if (code(error) === "ENOENT") return undefined; throw error; });
        if (!source || !await info(source)) return { ok: false, reason: `Cannot undo the delete. ${path} is no longer in the workspace trash, and History has no copy of it.` };
      }
    }
    assertCurrent();
    const receipt = record.tracked ? await engineUndo() : { materialized: true, momentCount: 0 };
    record.engine = { materialized: receipt.materialized, momentCount: receipt.momentCount };
    await save(root, record);
    markChanged();
  }
  const pendingPaths = record.progress ? new Set(record.copies?.map(copy => copy.path)) : undefined;
  const result: z.infer<typeof UndoResult> = { ok: true,
    tracked: { state: record.engine.materialized ? "restored" : "restoring", momentCount: record.engine.momentCount },
    restored: record.progress?.restored ?? [], remaining: record.progress?.remaining.filter(item => !pendingPaths?.has(item.path)) ?? [] };
  if (record.progress) record.progress = result;
  const keepSource = new Set<string>();
  const linkedModes = new Map<string, number>();
  const place = async (path: string, empty = false): Promise<void> => {
    assertCurrent();
    const trashPath = `.dohc/trash/${record.staged}${path.slice(record.base.length)}`;
    let retryable = false;
    try {
      const target = await checkedTarget(root, path, record.base);
      const source = empty ? undefined : await sourcePath(root, record, path);
      const entry = source === undefined ? undefined : await lstat(source);
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
        await copyExclusive(root, record, path, source!, target, entry!.mode);
      } else if (!resuming || !await alreadyPlaced(source!, target)) {
        await mkdir(dirname(target), { recursive: true });
        await checkedTarget(root, path, record.base);
        if (entry?.isSymbolicLink()) {
          const destination = await readlink(source!);
          const original = resolve(root, dirname(path), destination);
          const base = join(root, record.base);
          const referent = isInside(base, original) ? join(await trashDir(root), record.staged!, relative(base, original)) : original;
          const directory = await stat(referent).then(value => value.isDirectory(), () => false);
          await symlink(destination, target, directory ? process.platform === "win32" && isAbsolute(destination) ? "junction" : "dir" : "file");
        } else {
          try {
            await link(source!, target);
            if (process.platform === "win32" && (entry!.mode & 0o222) === 0) linkedModes.set(target, entry!.mode & 0o7777);
          } catch (error) {
            if (code(error) === "EEXIST") throw error;
            await copyExclusive(root, record, path, source!, target, entry!.mode);
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
      const sourceMissing = !empty && await sourcePath(root, record, path)
        .then(async source => !await info(source)).catch(sourceError => code(sourceError) === "ENOENT");
      result.remaining.push({ path, reason: empty
        ? `dohc could not recreate ${path}. Check the old path, then create the folder there.`
        : code(error) === "EEXIST"
        ? `${path} now occupies the old path. The deleted file stays at ${trashPath}.`
        : sourceMissing
        ? record.copies?.some(copy => copy.path === path)
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
  await save(root, record);
  const staged = record.staged
    ? await trashDir(root).then(dir => join(dir, record.staged!)).catch(() => undefined) : undefined;
  if (staged) for (const path of result.restored.filter(path => !keepSource.has(path))) {
    await sourcePath(root, record, path).then(async source => {
      if (record.emptyFolders.includes(path)) await rmdir(source);
      else await rm(source, { recursive: true, force: true });
      for (let parent = dirname(source); isInside(staged, parent); parent = dirname(parent)) await rmdir(parent);
    }).catch(() => undefined);
  }
  for (const [target, mode] of linkedModes) await chmod(target, mode).catch(() => undefined);
  return result;
}
