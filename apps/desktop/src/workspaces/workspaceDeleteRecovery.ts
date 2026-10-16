import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, symlink, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import type { HistoryOperationsStore, HistoryUndoResult, MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { validateUserMaterializePath } from "@dohc/workspace-core";
import { realRelativeInRoot } from "@dohc/workspace-core/realPath";
import { isInside } from "../security/pathContainment";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";

export type DeleteRecovery = { operationId: string; undo: { available: true } | { available: false; reason: string; paths: string[] } };
export type DeleteUndoResult = { ok: false; reason: string } | {
  ok: true; operationId: string; tracked: { state: "restoring" | "restored"; count: number };
  restored: string[]; remaining: { path: string; trashPath: string; reason: string }[];
};
const UndoResult = z.object({
  ok: z.literal(true), operationId: z.string(), tracked: z.object({ state: z.enum(["restoring", "restored"]), count: z.number() }),
  restored: z.array(z.string()), remaining: z.array(z.object({ path: z.string(), trashPath: z.string(), reason: z.string() })),
});
const Record = z.object({
  operationId: z.string(), staged: z.string(), base: z.string(), paths: z.array(z.string()), tracked: z.number(),
  // No bytes are retained here. Existing fallback trash keeps its existing lifetime.
  available: z.boolean().nullable(), noUndo: z.string().optional(), requestId: z.string().optional(),
  engine: z.object({ materialized: z.boolean(), momentCount: z.number() }).optional(), result: UndoResult.optional(),
});
type RecoveryRecord = z.infer<typeof Record>;
const code = (error: unknown) => error && typeof error === "object" && "code" in error ? error.code : undefined;
const info = async (path: string) => lstat(path).catch(error => { if (code(error) === "ENOENT") return null; throw error; });
const recordName = (id: string) => `delete-${createHash("sha256").update(id).digest("hex")}.json`;

async function trashDir(root: string): Promise<string> {
  const dir = join(await resolveWorkspaceMetadataDir(root), "trash");
  await mkdir(dir, { recursive: true });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isInside(await realpath(root), await realpath(dir))) {
    throw new Error("Cannot undo the delete. The workspace trash must be a real folder inside this workspace.");
  }
  return dir;
}
async function save(root: string, record: RecoveryRecord): Promise<void> {
  const path = join(await trashDir(root), recordName(record.operationId));
  // Rename replaces only our private metadata, never a visible workspace file.
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx");
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => undefined); }
}
async function load(root: string, id: string): Promise<RecoveryRecord> {
  const path = join(await trashDir(root), recordName(id));
  if ((await info(path))?.isSymbolicLink()) throw new Error("Cannot undo the delete. Its recovery record is a link.");
  const record = Record.parse(JSON.parse(await readFile(path, "utf8")));
  if (record.operationId !== id || basename(record.staged) !== record.staged) throw new Error("Invalid delete recovery record.");
  return record;
}

// Capture's returned set identifies the bytes History holds.
export async function stageDeleteRecovery(root: string, operationId: string, staged: string, base: string,
  tracked: readonly string[]): Promise<void> {
  const paths: string[] = [];
  const recorded = new Set(tracked);
  const parents = new Set<string>();
  for (const file of tracked) {
    for (let parent = dirname(file); parent !== "."; parent = dirname(parent)) parents.add(parent.split(sep).join("/"));
  }
  const walk = async (sub: string): Promise<void> => {
    const path = sub ? `${base}/${sub}` : base;
    const stat = await lstat(join(staged, sub));
    if (stat.isDirectory()) {
      if (!parents.has(path)) { paths.push(path); return; }
      const entries = await readdir(join(staged, sub));
      if (!entries.length) paths.push(path);
      for (const name of entries) await walk(sub ? `${sub}/${name}` : name);
    } else if (!recorded.has(path)) paths.push(path);
  };
  await walk("");
  await save(root, { operationId, staged: basename(staged), base, paths, tracked: tracked.length, available: null });
}

export async function finishDeleteRecovery(root: string, operationId: string, trashed: boolean, staged?: string): Promise<DeleteRecovery> {
  const record = await load(root, operationId);
  if (staged !== undefined) record.staged = basename(staged);
  record.available = !trashed || record.paths.length === 0;
  if (!record.available) {
    const where = process.platform === "win32" ? "in the Recycle Bin" : "in the Trash";
    record.noUndo = `Cannot undo this delete. ${record.paths.join(", ")} ${record.paths.length === 1 ? "is" : "are"} ${where}. Restore ${record.paths.length === 1 ? "it" : "them"} there.`;
  }
  await save(root, record);
  return { operationId, undo: record.available ? { available: true } : { available: false, reason: record.noUndo!, paths: record.paths } };
}

async function checkedTarget(root: string, path: string, base: string): Promise<string> {
  const checked = validateUserMaterializePath(path, { platform: process.platform, allowIgnoredSegments: path !== base });
  if (!checked.ok || checked.normalized !== path) throw new Error(`Cannot undo the delete. Invalid recovery path: ${path}.`);
  // A person's delete admits the root entry, including its excluded descendants.
  await assertResolvedWorkspacePath({ rootPath: root, absolutePath: join(root, base), spelled: base, label: "Undo path", access: "entry" });
  const target = await realRelativeInRoot(root, join(root, path), true);
  if (!target.ok || target.relative !== path) throw new Error(`Cannot undo the delete. ${path} now leads somewhere else.`);
  return target.resolvedAbsolute;
}
async function sourcePath(root: string, record: RecoveryRecord, path: string): Promise<string> {
  if (path !== record.base && !path.startsWith(`${record.base}/`)) throw new Error("Invalid delete recovery record.");
  const source = join(await trashDir(root), record.staged, path.slice(record.base.length));
  const parent = await realpath(dirname(source));
  if (!isInside(await trashDir(root), parent)) throw new Error("Cannot undo the delete. Its staged path leads outside the workspace trash.");
  return source;
}
const fingerprint = async (path: string) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};
async function alreadyPlaced(source: string, target: string): Promise<boolean> {
  const [a, b] = await Promise.all([lstat(source), info(target)]);
  if (!b) return false;
  if (a.isSymbolicLink()) return b.isSymbolicLink() && await readlink(source) === await readlink(target);
  if (a.isDirectory()) return b.isDirectory() && (await readdir(target)).length === 0;
  return b.isFile() && a.size === b.size && (a.ino !== 0 && a.ino === b.ino && a.dev === b.dev || await fingerprint(source) === await fingerprint(target));
}

export async function undoDeleteRecovery(root: string, input: { operationId: string; requestId: string }, author: MomentWriteAuthor,
  history: Pick<HistoryOperationsStore, "undoHistoryOperation">, workspaceId: string,
  placeFile: (root: string, source: string, target: string, keepSource: boolean, checkPath: () => Promise<unknown>) => Promise<void>,
  assertCurrent: () => void, markChanged: () => void): Promise<DeleteUndoResult> {
  const record = await load(root, input.operationId);
  const resuming = record.engine !== undefined;
  if (!record.available) return { ok: false, reason: record.noUndo ?? "Cannot undo this delete. Its recovery record is incomplete." };
  if (record.requestId !== undefined && record.requestId !== input.requestId) return { ok: false, reason: "This delete already has an Undo request. Retry that request." };
  if (record.result) return record.result;
  // Before the first engine commit, every rowless destination must be free.
  if (!record.engine) {
    for (const path of record.paths) {
      const target = await checkedTarget(root, path, record.base);
      if (await info(target)) return { ok: false, reason: `Cannot undo the delete. ${path} now occupies the old path. Move it first.` };
      await lstat(await sourcePath(root, record, path));
    }
    assertCurrent();
    record.requestId = input.requestId;
    await save(root, record);
    const result: Pick<HistoryUndoResult, "materialized" | "momentCount"> = record.tracked
      ? await history.undoHistoryOperation({ workspaceId, ...input, author })
      : { materialized: true, momentCount: 0 };
    record.engine = { materialized: result.materialized, momentCount: result.momentCount };
    await save(root, record);
    markChanged();
  }
  const result: Extract<DeleteUndoResult, { ok: true }> = {
    ok: true, operationId: input.operationId,
    tracked: { state: record.engine.materialized ? "restored" : "restoring", count: record.engine.momentCount }, restored: [], remaining: [],
  };
  const place = async (source: string, target: string): Promise<void> => {
    const path = relative(root, target).split(sep).join("/");
    await checkedTarget(root, path, record.base);
    const stat = await lstat(source);
    if (stat.isDirectory()) {
      await mkdir(dirname(target), { recursive: true });
      if (!resuming || !(await info(target))?.isDirectory()) await mkdir(target);
      for (const name of await readdir(source)) await place(join(source, name), join(target, name));
    } else if (!resuming || !await alreadyPlaced(source, target)) {
      if (stat.isSymbolicLink()) { await mkdir(dirname(target), { recursive: true }); await symlink(await readlink(source), target); }
      else await placeFile(root, source, target, true, () => checkedTarget(root, path, record.base));
    }
  };
  for (const path of record.paths) {
    assertCurrent();
    const trashPath = `.dohc/trash/${record.staged}${path.slice(record.base.length)}`;
    try {
      const target = await checkedTarget(root, path, record.base);
      const source = await sourcePath(root, record, path);
      // Sources survive placement until the final receipt. A crash after an exclusive
      // copy/link but before that receipt can confirm equal bytes without overwriting.
      await place(source, target);
      result.restored.push(path);
      markChanged();
    } catch (error) {
      result.remaining.push({ path, trashPath, reason: code(error) === "EEXIST"
        ? `${path} now occupies the old path. The deleted file stays at ${trashPath}.`
        : `dohc could not put ${path} back. It stays at ${trashPath}.` });
    }
  }
  record.result = result;
  await save(root, record);
  // Existing fallback contents remain recoverable. Only successfully placed private files go.
  for (const path of result.restored) {
    await sourcePath(root, record, path).then(source => rm(source, { recursive: true, force: true })).catch(() => undefined);
  }
  return result;
}
