import { randomUUID } from "node:crypto";
import { OPERATION_ID_PREFIX } from "@dohc/workspace-contracts/engine";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, readdir, open, realpath, rename, rmdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { CliResultByVerb } from "@dohc/cli/protocol";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import { validateUserMaterializePath } from "@dohc/workspace-core";
import { workspaceDestinationError, workspaceNameError } from "@dohc/workspace-contracts/workspace-paths";
import type { WorkspaceAuthorityOperation } from "./workspaceAuthorityOwner";
import { withExclusiveWorkspaceOperation } from "./workspaceAssets";
import type { AuthoredPathChanges, WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { historyExcludesSubtree, historyPathAdmission, type WorkspaceEnginePolicySnapshot } from "./workspaceEnginePolicyFile";
import { assertMoveParentCase, checkCaseRename, deleteIdentityUnavailable, deletePath, moveIdentityUnavailable, moveIntoWorkspaceTrash, movePath, prepareWorkspaceMove, prepareWorkspaceDelete, removeEmptyWorkspaceFolder } from "./workspaceFiles";
import { storedEntryPath, StoredEntryIdentityUnavailable } from "./storedEntryPath";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";
import { beginPendingRecovery, finishDeleteRecovery, stageDeleteRecovery, type OperationRecovery, type DeleteRecoveryPlan } from "./workspaceDeleteRecovery";

import { finishMoveRecovery, finishFolderMoveRecovery, folderMoveReason, moveBack, moveWord } from "./workspaceMoveRecovery";
import { scheduleLinkRewrite, type LinkRewriteContext } from "./workspaceLinkRewrites";
import { ICloudCheckRefusal } from "./workspaceICloudOnly";
import { WORKSPACE_TRASH } from "./workspaceTrash";

// The workspace's id and attachment name the engine open whose `.dohc/local`
// holds the workspace trash.
type PathChangeWorkspace = { workspaceId: string; rootPath: string; attachmentId?: symbol; readOnly?: boolean; shareView?: unknown };

export interface PathChangeOptions {
  capture: Pick<WorkspaceEngineCapture, "changePathsAs">;
  requestId: string;
  linkRewrites?: LinkRewriteContext;
  trashItem(absolutePath: string): Promise<void>;
  // Tells open editors that the documents at or under a path are gone.
  markDeleted(path: string): void;
}

// A path as spelled and where it resolves, and for a tree the files in it,
// relative to it. A lone file is the one file "".
interface AdmittedPath { path: string; relative: string; physical: string }
interface AdmittedTree extends AdmittedPath { files: string[] }

type MoveFailure = Extract<CliResultByVerb["fileMove"], { ok: false }>;
type DeleteFailure = Extract<CliResultByVerb["fileDelete"], { ok: false }>;

// What a change leaves once capture is released: its answer, and the entry
// in the workspace trash that then leaves for the system trash. The system
// trash runs through the returned completion, after capture and workspace authority are released.
type Changed<Done, Failed> = { done: Done; trash?: string } | { failed: Failed };

const under = (base: string, sub: string) => (sub ? `${base}/${sub}` : base);
const errnoOf = (error: unknown) => (error instanceof Error && "syscall" in error && "code" in error ? String(error.code) : undefined);
const exists = (absolute: string) => lstat(absolute).then(() => true, () => false);
const workspaceTrashPath = (staged: string) => `${WORKSPACE_TRASH}/${basename(staged)}`;
// The engine addresses no path past 1,024 UTF-8 bytes or holding a control
// character (MAX_CANONICAL_WORKSPACE_PATH_BYTES in dohc-engine-files). History
// holds nothing there and no live document can open one.
const engineAddresses = (path: string) =>
  Buffer.byteLength(path, "utf8") <= 1_024 && !/[\u0000-\u001f\u007f]/u.test(path);

// Node's own messages name absolute host paths, so a system error becomes
// what happened, in the agent's words. dohc's own refusals pass through.
function reason(error: unknown, failed: string): string {
  const code = errnoOf(error);
  if (code === undefined) {
    if (error instanceof Error && error.message === "capture-hold-ended") {
      return `${failed} dohc stopped holding History for this workspace while it worked. Try again.`;
    }
    return error instanceof Error ? error.message : failed;
  }
  const next = code === "ENOENT" || code === "ENOTDIR" ? "Something changed the path while dohc worked. Check it, then try again."
    : code === "ENOSPC" ? "The disk is full. Free space, then try again."
      : "Close any program using it, then try again.";
  return `${failed} (${code}). ${next}`;
}

type PathChangeOperation = { readonly workspace: PathChangeWorkspace; assertCurrent(): void };

function assertWritable(operation: PathChangeOperation) {
  operation.assertCurrent();
  if (operation.workspace.readOnly || operation.workspace.shareView !== undefined) {
    throw new Error("This workspace is read-only. Change files in the owning workspace.");
  }
}

function checkedPath(path: string): string {
  const checked = validateUserMaterializePath(path, { platform: process.platform });
  if (checked.ok || checked.reason === "unsupported-name") {
    for (const name of (checked.ok ? checked.normalized : path.replaceAll("\\", "/")).split("/")) {
      const error = workspaceNameError(name, process.platform);
      if (error) throw new Error(error);
    }
  }
  if (!checked.ok) throw new Error(`Cannot change ${path}: ${checked.reason}. Choose a visible workspace path.`);
  return checked.normalized;
}

// The path as spelled and where it resolves. A move or delete renames the
// entry itself, so its last segment is not followed. An entry already on
// disk also answers to its own name there (`physical`), as
// prepareWorkspaceDelete does: on a disk that ignores case, Notes.txt then
// reaches the notes.txt History holds. A link keeps its spelled name, and
// admitTree refuses it.
export async function admitPath(rootPath: string, path: string): Promise<AdmittedPath> {
  const normalized = checkedPath(path);
  const target = await assertResolvedWorkspacePath({ rootPath, absolutePath: join(rootPath, normalized),
    spelled: path, label: "Path", access: "entry" });
  const info = await lstat(target.resolvedAbsolute).catch(() => null);
  const physical = info && !info.isSymbolicLink()
    ? await storedEntryPath(await realpath(rootPath), target.resolvedAbsolute)
    : target.relative;
  return { path: normalized, relative: target.relative, physical };
}

// Every entry at or under an existing path must be a regular file or folder
// History records at each of `bases`, as spelled and where it resolves. A
// reserved or ignored folder, such as .git or node_modules, refuses before
// dohc reads inside it.
async function admitTree(rootPath: string, admitted: AdmittedPath, allowed: (path: string) => boolean,
  otherBases: readonly string[] = []): Promise<AdmittedTree> {
  const spelled = admitted.path;
  // The tree is named by its entry on disk from here on.
  const target = { ...admitted, relative: admitted.physical };
  const bases = [target.path, target.relative, ...otherBases];
  const files: string[] = [];
  const walk = async (sub: string): Promise<void> => {
    const absolute = join(rootPath, target.relative, sub);
    const info = await lstat(absolute).catch((error: unknown) => {
      if (!sub && errnoOf(error) === "ENOENT") throw new Error(`Nothing is at ${spelled}. List the folder to see what is there.`);
      throw error;
    });
    if (!info.isFile() && !info.isDirectory()) {
      throw new Error(`dohc does not move or delete ${under(spelled, sub)}: History keeps regular files and folders, not links. Change it yourself.`);
    }
    for (const base of bases) {
      const path = under(base, sub);
      const checked = validateUserMaterializePath(path, { platform: process.platform });
      if (!checked.ok || checked.normalized !== path || (info.isFile() && !allowed(path))) {
        throw new Error(`History cannot record ${under(spelled, sub)}. Choose a path with no reserved, secret, or excluded files.`);
      }
    }
    if (info.isFile()) {
      files.push(sub);
      return;
    }
    for (const name of (await readdir(absolute)).sort()) await walk(sub ? `${sub}/${name}` : name);
  };
  await walk("");
  return { ...target, files };
}

// The regular files at or under `entry` that History records. A link moves
// as itself and is never followed; a folder the policy wholly excludes, or
// one History cannot address, is not read.
async function historyFilesUnder(rootPath: string, entry: string, allowed: (path: string) => boolean,
  excludedFolder: (path: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  const walk = async (path: string): Promise<void> => {
    const info = await lstat(join(rootPath, path));
    const addressed = validateUserMaterializePath(path, { platform: process.platform }).ok && engineAddresses(path);
    if (!addressed) return;
    if (info.isFile()) {
      if (allowed(path)) files.push(path);
      return;
    }
    if (!info.isDirectory() || excludedFolder(path)) return;
    for (const name of (await readdir(join(rootPath, path))).sort()) await walk(`${path}/${name}`);
  };
  await walk(entry);
  return files;
}

// The policy the capture seam read for this change, once it left the queue.
function historyAdmission(policy: WorkspaceEnginePolicySnapshot): (path: string) => boolean {
  if (policy.errors.length) throw new Error(`dohc could not read the workspace file policy: ${policy.errors.join("; ")}. Fix the reported policy errors.`);
  return historyPathAdmission(policy);
}

// Private staged sources can be copied. Visible sources require a hard link,
// so edits through either name survive removal of the moved name.
async function checkPlacement(rootPath: string, to: string): Promise<void> {
  const path = relative(rootPath, to).split(sep).join("/");
  await assertResolvedWorkspacePath({ rootPath, absolutePath: to, spelled: path, label: "Path", access: "entry" });
}
async function placeFile(rootPath: string, from: string, to: string, visibleSource: boolean): Promise<void> {
  await checkPlacement(rootPath, to);
  await mkdir(dirname(to), { recursive: true });
  const source = await lstat(from, { bigint: true }), target = await lstat(to, { bigint: true }).catch(() => null);
  const alreadyPlaced = target?.isFile() && source.ino !== 0n && source.dev === target.dev && source.ino === target.ino && source.size === target.size;
  if (!alreadyPlaced) await link(from, to).catch(async (error: unknown) => {
    // Node has no conditional unlink of a visible name. Copying and removing
    // that name could discard a concurrent edit or replacement.
    if (visibleSource || errnoOf(error) === "EEXIST") throw error;
    await copyFile(from, to, constants.COPYFILE_EXCL);
    const copy = await open(to, "r+");
    try { await copy.sync(); } finally { await copy.close(); }
  });
  await unlink(from).catch(error => { if (visibleSource) throw error; });
}

// Places `from`, an entry staged in the workspace trash, at `to` without
// replacing anything there, even an empty folder: a folder is created fresh,
// and each entry moves into it the same way. Answers the files, relative to
// `from`, that stayed in the trash; a folder dohc could not read stays whole
// under its own name. Never throws.
export async function placeBack(rootPath: string, from: string, to: string, sub = "", visibleSource = false): Promise<string[]> {
  let entries: string[];
  try {
    const entry = await lstat(from);
    if (entry.isSymbolicLink()) return [sub];
    if (!entry.isDirectory()) {
      await placeFile(rootPath, from, to, visibleSource);
      return [];
    }
    entries = await readdir(from);
    await checkPlacement(rootPath, to);
    await mkdir(dirname(to), { recursive: true });
    await mkdir(to);
  } catch {
    return [sub];
  }
  const left: string[] = [];
  for (const name of entries) left.push(...await placeBack(rootPath, join(from, name), join(to, name), sub ? `${sub}/${name}` : name, visibleSource));
  // Whichever folder is empty now goes: the staged one, or the fresh one when nothing reached it.
  await rmdir(left.length ? to : from).catch(() => undefined);
  return left;
}

// Whether `file`, relative to a staged entry, is among what placeBack left.
const stayed = (left: readonly string[], file: string) =>
  left.some(sub => sub === "" || file === sub || file.startsWith(`${sub}/`));

// From the workspace trash to the system trash. The entry never returns to
// its place first, where another program may have written since. When the
// system refuses, it stays in the workspace trash.
async function toSystemTrash(options: Pick<PathChangeOptions, "trashItem">, staged: string): Promise<boolean> {
  try {
    await options.trashItem(staged);
    return true;
  } catch {
    return false;
  }
}

export function assertMoveDocumentKind(from: string, to: string, word: "move" | "rename"): void {
  const fromKind = liveDocumentKindForPath(from), toKind = liveDocumentKindForPath(to);
  if (fromKind !== null && fromKind !== toKind) throw new Error(
    `A ${word} cannot change a live document's kind from ${fromKind} to ${toKind ?? "a plain file"}. Create a new file and copy the content instead.`);
}

type MoveOptions = Omit<PathChangeOptions, "capture"> & { capture: Pick<WorkspaceEngineCapture, "changePathsAs"> & Partial<Pick<WorkspaceEngineCapture, "beginFileRename">> | null; prepared?: Awaited<ReturnType<typeof prepareWorkspaceMove>>; markChanged?: () => void; onRecorded?: (path: string, operationId: string) => () => void; byHand?: boolean; admit?: () => Promise<void> };

export function prepareMoveWorkspacePathAs<Workspace extends PathChangeWorkspace, State>(
  operation: WorkspaceAuthorityOperation<Workspace, State>, input: { fromPath: string; toPath: string; overwrite?: boolean },
  author: MomentWriteAuthor, options: PathChangeOptions,
): Promise<() => Promise<CliResultByVerb["fileMove"]>> {
  return prepareMoveWorkspacePath(operation, input, author, options);
}

export async function moveWorkspacePathByHand(operation: PathChangeOperation, input: { fromPath: string; toPath: string },
  person: Extract<MomentWriteAuthor, { kind: "human" }>, options: Omit<MoveOptions, "capture" | "markChanged" | "byHand"> & { capture: Pick<WorkspaceEngineCapture, "changePathsAs" | "beginFileRename"> | null }): Promise<{ path: string; operationId?: string; undo: OperationRecovery["undo"] }> {
  return withExclusiveWorkspaceOperation(operation.workspace.rootPath, async markChanged => {
    assertWritable(operation);
    await options.admit?.();
    const prepared = await prepareWorkspaceMove(operation.workspace.rootPath, input.fromPath, input.toPath);
    const destinationError = workspaceDestinationError(prepared.physicalToPath, process.platform);
    if (destinationError) throw new Error(destinationError);
    if ((await stat(join(operation.workspace.rootPath, prepared.physicalFromPath))).isDirectory()) {
      if (options.capture) assertMoveDocumentKind(prepared.physicalFromPath, prepared.physicalToPath, "rename");
      const finishRename = await options.capture?.beginFileRename(prepared.physicalFromPath, prepared.physicalToPath);
      try {
        await movePath(operation.workspace.rootPath, prepared.physicalFromPath, prepared.physicalToPath);
        markChanged();
        await finishRename?.(true);
        return { path: prepared.visibleResultPath, undo: { available: false,
          reason: folderMoveReason(prepared.physicalFromPath, prepared.physicalToPath), paths: [] } };
      } catch (error) {
        await finishRename?.(false);
        throw error;
      }
    }
    const result = await (await prepareMoveWorkspacePath(operation, input, person, { ...options, byHand: true, markChanged, prepared }))();
    if (!result.ok) throw new Error(result.reason);
    return { path: result.toPath, operationId: result.operationId, undo: result.undo };
  });
}

async function prepareMoveWorkspacePath(operation: PathChangeOperation,
  input: { fromPath: string; toPath: string; overwrite?: boolean }, author: MomentWriteAuthor, options: MoveOptions,
): Promise<() => Promise<CliResultByVerb["fileMove"]>> {
  const workspace = operation.workspace, rootPath = workspace.rootPath;
  const failed = `dohc could not move ${input.fromPath}.`;
  const operationId = `${OPERATION_ID_PREFIX}${randomUUID()}`;
  try {
    assertWritable(operation);
    const change = async (markChanged: () => void) => {
      let gone: string[] = [];
      if (!options.byHand) await assertMoveParentCase(await realpath(rootPath), { fromPath: checkedPath(input.fromPath), toPath: checkedPath(input.toPath) });
      // The capture settles, closes and checks these endpoints before the hold.
      const prepared = options.prepared;
      if (prepared && options.capture) assertMoveDocumentKind(prepared.physicalFromPath, prepared.physicalToPath, "rename");
      const endpoints = prepared ? [prepared.physicalFromPath, prepared.physicalToPath] : [(await admitPath(rootPath, input.fromPath)).physical, (await admitPath(rootPath, input.toPath)).physical];
      const destinationError = workspaceDestinationError(endpoints[1]!, process.platform);
      if (destinationError) throw new Error(destinationError);
      const work = async (engine: AuthoredPathChanges | null): Promise<Changed<{ fromPath: string; toPath: string; withoutHistory: string[]; replacedWithoutHistory: string[]; recovery: DeleteRecoveryPlan | undefined; from: string; to: string; overwritten: boolean }, MoveFailure>> => {
          // Admission runs here, with capture held, right before the disk changes.
          assertWritable(operation);
          await options.admit?.();
          const checked = options.byHand ? await prepareWorkspaceMove(rootPath, input.fromPath, input.toPath) : undefined;
          const allowed = engine ? historyAdmission(engine.policy) : () => false;
          const to = await admitPath(rootPath, input.toPath);
          const spelledFrom = checked
            ? { path: checkedPath(input.fromPath), relative: checked.physicalFromPath, physical: checked.physicalFromPath }
            : await admitPath(rootPath, input.fromPath);
          if (checked) to.relative = checked.physicalToPath;
          if (!options.byHand) await assertMoveParentCase(await realpath(rootPath), { fromPath: spelledFrom.path, toPath: to.path });
          if (spelledFrom.physical !== endpoints[0] || (options.byHand ? to.relative : to.physical) !== endpoints[1]) {
            throw new Error(`${input.fromPath} or ${input.toPath} now leads somewhere else. Check both paths, then try again.`);
          }
          // Two spellings of one entry on disk are a rename of its case.
          const renamedTarget = join(dirname(spelledFrom.physical), basename(to.relative)).split(sep).join("/");
          const caseOnly = spelledFrom.physical === to.physical && renamedTarget !== spelledFrom.physical;
          if (caseOnly) to.relative = renamedTarget;
          const pairs = [[spelledFrom.path, to.path], [spelledFrom.relative, to.relative],
            ...(caseOnly ? [] : [[spelledFrom.physical, to.physical]])];
          for (const [a = "", b = ""] of pairs) {
            if (a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`)) {
              throw new Error(`Cannot move ${input.fromPath} to ${input.toPath}: one holds the other. Choose a destination outside both.`);
            }
          }
          const from = options.byHand
            ? { ...spelledFrom, relative: spelledFrom.physical, files: (engine ? await historyFilesUnder(rootPath, spelledFrom.physical, allowed,
              folder => historyExcludesSubtree(engine.policy, folder)) : []).map(file => file.slice(spelledFrom.physical.length).replace(/^\//u, "")).filter(sub => allowed(under(to.relative, sub))) }
            : await admitTree(rootPath, spelledFrom, allowed, [to.path, to.relative]);
          for (const sub of from.files) assertMoveDocumentKind(under(from.relative, sub), under(to.relative, sub), options.byHand ? "rename" : "move");
          const source = join(rootPath, from.relative);
          const target = join(rootPath, to.relative);
          let dest: AdmittedTree | undefined;
          if (await exists(target) && !caseOnly) {
            if (!input.overwrite) throw new Error(`${input.toPath} already exists. Choose another destination, or move with overwrite.`);
            dest = await admitTree(rootPath, to, allowed);
          }
          // A replaced destination is named by its entry on disk.
          const destBase = dest?.relative ?? to.relative;
          const fromFiles = from.files.map(sub => under(from.relative, sub));
          const destFiles = (dest?.files ?? []).map(sub => under(destBase, sub));
          // Oversized files and text with invalid UTF-8 move without a History row.
          const recorded = new Set(await engine?.recordDisk(from.relative, fromFiles) ?? []);
          const destRecorded = new Set(caseOnly ? [] : await engine?.recordDisk(destBase, destFiles) ?? []);
          const rebase = (path: string) => to.relative + path.slice(from.relative.length);
          const shownTo = (path: string) => to.path + path.slice(to.relative.length);
          const withoutHistory = fromFiles.filter(file => !recorded.has(file)).map(file => shownTo(rebase(file)));
          const replacedWithoutHistory = destFiles.filter(file => !destRecorded.has(file)).map(file => to.path + file.slice(destBase.length));

          const recovery = (await lstat(source)).isDirectory() ? undefined
            : await stageDeleteRecovery(operationId, source, from.relative, [...recorded]);
          const change: MoveProgress = { staged: undefined, sourceStaged: undefined, destDeleted: [], moved: false, renamed: [] };
          try {
            if (dest) {
              // The replaced destination waits in the workspace trash, so the
              // move can still put it back.
              change.staged = await moveIntoWorkspaceTrash(workspace, join(rootPath, destBase));
              markChanged();
              for (const sub of dest.files) {
                const path = under(destBase, sub);
                if (!destRecorded.has(path)) continue;
                change.destDeleted.push({ path, sub, momentId: await engine!.delete(path) });
              }
            }
            if (options.byHand) {
              await movePath(rootPath, from.relative, to.relative);
            } else if (engine && from.files.length === 1 && from.files[0] === "" && !caseOnly) {
              await mkdir(dirname(target), { recursive: true });
              // One rename that refuses to replace, where this filesystem has
              // one. Elsewhere the file leaves its visible name in one rename,
              // so the placement below only ever links and removes a private
              // copy, and copies only where links are refused.
              let moved: boolean;
              const before = await lstat(source, { bigint: true });
              try {
                moved = await engine!.moveFile(from.relative, to.relative);
              } catch (error) {
                // A lost reply can follow a completed rename. Only the same
                // disk entry at the target establishes that it moved.
                const after = await lstat(target, { bigint: true }).catch(() => undefined);
                change.moved = after !== undefined && before.ino !== 0n && before.dev === after.dev && before.ino === after.ino;
                if (!change.moved) {
                  const original = await lstat(source, { bigint: true }).catch(() => undefined);
                  change.uncertain = original === undefined || before.ino === 0n || before.dev !== original.dev || before.ino !== original.ino;
                }
                if (change.moved) markChanged();
                throw error;
              }
              if (!moved) {
                change.sourceStaged = await moveIntoWorkspaceTrash(workspace, source);
                markChanged();
                if ((await placeBack(rootPath, change.sourceStaged, target)).length) {
                  throw new Error(`Something new is at ${input.toPath}. Choose another destination.`);
                }
                change.sourceStaged = undefined;
              }
            } else {
              // A folder moves in one rename, so no half-moved folder is ever
              // visible. Its target was checked empty above; only an empty
              // folder made since then could be replaced, and it holds no bytes.
              await mkdir(dirname(target), { recursive: true });
              await rename(source, target);
            }
            change.moved = true;
            markChanged();
            if (caseOnly && !options.byHand) {
              const spelling = await realpath(rootPath).then(root => storedEntryPath(root, target)).catch(() => null);
              checkCaseRename(spelling, target, input);
            }
            for (const file of fromFiles) {
              if (!recorded.has(file)) continue;
              await engine!.rename(file, rebase(file));
              change.renamed.push(file);
            }
          } catch (error) {
            const undone = await undoMove(workspace, engine, change, from.relative, fromFiles, recorded, rebase, source, target,
              join(rootPath, destBase), caseOnly, input);
            gone = [...undone.destDeleted, ...undone.sourceDeleted];
            const rowless = undone.rowlessSource.map(({ path, atTarget }) =>
              atTarget ? shownTo(rebase(path)) : from.path + path.slice(from.relative.length));
            const replaced = change.staged === undefined || !undone.destLeft.length ? undefined : {
              path: to.path, trashed: false, trashPath: workspaceTrashPath(change.staged),
              withoutHistory: destFiles.filter(file => !destRecorded.has(file) && stayed(undone.destLeft, file.slice(destBase.length).replace(/^\//u, "")))
                .map(file => to.path + file.slice(destBase.length)),
            };
            const deleted = [...undone.destDeleted.map(path => to.path + path.slice(destBase.length)),
              ...undone.sourceDeleted.map(path => from.path + path.slice(from.relative.length))];
            return { failed: { ok: false as const, path: input.fromPath, reason: `${reason(error, failed)}${undone.notes}`,
              ...(deleted.length ? { deleted } : {}), ...(rowless.length ? { withoutHistory: rowless } : {}), ...(replaced ? { replaced } : {}) } };
          }
          gone = [from.relative, ...(dest ? [destBase] : [])];
          return { done: { fromPath: from.path, toPath: to.path, withoutHistory, replacedWithoutHistory, recovery, from: from.relative, to: to.relative, overwritten: dest !== undefined }, ...(change.staged !== undefined ? { trash: change.staged } : {}) };
        };
      const fallback = async () => {
        const finish = options.byHand ? await options.capture?.beginFileRename?.(endpoints[0]!, endpoints[1]!) : undefined;
        let ok = false;
        try { const changed = await work(null); ok = "done" in changed; return changed; }
        finally { await finish?.(ok); }
      };
      const changed = await (options.capture && endpoints.every(engineAddresses)
        ? options.capture.changePathsAs(endpoints, { operation: "move", author, operationId }, work, () => gone)
        : fallback());
      if ("failed" in changed) return changed;
      const { recovery, from, to, overwritten, ...done } = changed.done;
      if (!recovery) return { ...changed, done: { ...done, ...await finishFolderMoveRecovery(workspace, operationId, from, to) } };
      const release = recovery.record && !recovery.noUndo ? options.onRecorded?.(done.toPath, operationId) : undefined;
      try {
        const saved = await finishMoveRecovery(workspace, recovery, from, to, overwritten,
          options.linkRewrites ? {requestId: `move-links:${operationId}`, author} : undefined);
        if (saved.record && options.linkRewrites) scheduleLinkRewrite(workspace, saved.record, options.linkRewrites);
        return { ...changed, done: { ...done, ...saved.recovery } };
      } finally { release?.(); }
    };
    const changed = await (options.markChanged ? change(options.markChanged) : withExclusiveWorkspaceOperation(rootPath, change));
    if ("failed" in changed) return async () => changed.failed;
    // The replaced destination leaves the workspace trash for the system
    // trash, as a deleted file does, or stays when the system refuses.
    return async () => {
      const { withoutHistory, replacedWithoutHistory, ...done } = changed.done;
      const staged = changed.trash;
      const replaced = staged === undefined ? undefined : {
        path: done.toPath,
        trashed: await toSystemTrash(options, staged),
        withoutHistory: replacedWithoutHistory,
      };
      return { ok: true, ...done, ...(withoutHistory.length ? { withoutHistory } : {}),
        ...(replaced === undefined ? {} : { replaced: { ...replaced,
          ...(replaced.trashed || staged === undefined ? {} : { trashPath: workspaceTrashPath(staged) }) } }) };
    };
  } catch (error) {
    if (error instanceof StoredEntryIdentityUnavailable) error = moveIdentityUnavailable(input.fromPath, input.toPath);
    return async () => ({ ok: false, path: input.fromPath, reason: reason(error, failed) });
  }
}

interface MoveProgress {
  staged: string | undefined;
  // A single file's source, staged in the trash until it is placed.
  sourceStaged: string | undefined;
  destDeleted: Array<{ path: string; sub: string; momentId: string }>;
  moved: boolean;
  uncertain?: boolean;
  renamed: string[];
}

// Puts a failed move back without replacing anything that appeared since.
// Visible entries are staged in the trash first, so only private copies are
// ever placed and removed. The source goes back first, so undoing a binary
// file's rename finds the file where History puts it. What cannot go back
// returns to where the move put it, and what cannot go there either stays in
// the trash with its delete recorded. History follows each file it holds to
// where it is; a file it holds no row for only moves. Never throws: the
// notes say what stayed.
async function undoMove(workspace: PathChangeWorkspace, engine: AuthoredPathChanges | null, change: MoveProgress, fromBase: string,
  fromFiles: readonly string[], recorded: ReadonlySet<string>, rebase: (path: string) => string, source: string,
  target: string, destPlace: string, caseOnly: boolean, input: { fromPath: string; toPath: string },
): Promise<{ notes: string; destLeft: string[]; destDeleted: string[]; sourceDeleted: string[]; rowlessSource: { path: string; atTarget: boolean }[] }> {
  const rootPath = workspace.rootPath;
  const notes: string[] = change.uncertain
    ? [`dohc could not confirm where ${input.fromPath} is. Check both paths before trying again.`] : [];
  const sourceDeleted: string[] = [];
  const recordOrNote = (work: Promise<unknown>, note: string) => work.then(() => true, () => { notes.push(note); return false; });
  const subOf = (file: string) => file.slice(fromBase.length).replace(/^\//u, "");
  // Where each source file is now, and the trash entry that holds the rest.
  let where = (_file: string): "source" | "target" | "trash" => "source";
  let trashed: string | undefined;
  // Why the moved entry did not reach the workspace trash, from where it goes back.
  let notStaged: unknown;
  if (change.moved) {
    if (caseOnly) {
      const back = await rename(target, source).then(() => true, () => false);
      where = () => back ? "source" : "target";
    } else {
      trashed = await moveIntoWorkspaceTrash(workspace, target).catch((error: unknown) => { notStaged = error; return undefined; });
      const notBack = trashed === undefined ? [""] : await placeBack(rootPath, trashed, source);
      const inTrash = trashed === undefined || !notBack.length ? [] : await placeBack(rootPath, trashed, target);
      where = file => !stayed(notBack, subOf(file)) ? "source" : trashed !== undefined && stayed(inTrash, subOf(file)) ? "trash" : "target";
    }
  } else if (change.sourceStaged !== undefined) {
    trashed = change.sourceStaged;
    const notBack = await placeBack(rootPath, trashed, source);
    where = () => notBack.length ? "trash" : "source";
  }
  for (const file of [...fromFiles].reverse()) {
    if (!recorded.has(file)) continue;
    const renamed = change.renamed.includes(file);
    const now = where(file);
    if (now === "source" && renamed) await recordOrNote(engine!.rename(rebase(file), file), `History still shows ${file} at ${rebase(file)}.`);
    if (now === "target" && !renamed) await recordOrNote(engine!.rename(file, rebase(file)), `History still shows ${rebase(file)} at ${file}.`);
    if (now === "trash" && await recordOrNote(engine!.delete(renamed ? rebase(file) : file), `History still shows ${file}; its file is in ${workspaceTrashPath(trashed!)}.`)) {
      sourceDeleted.push(file);
    }
  }
  if (notStaged !== undefined) {
    const because = notStaged instanceof ICloudCheckRefusal ? notStaged.because : "dohc could not move it to the workspace trash to put it back";
    notes.push(`It stays at ${input.toPath}, because ${because}. ${moveBack(moveWord(input.fromPath, input.toPath))}`);
  } else if (fromFiles.some(file => where(file) === "target")) {
    notes.push(`Part of it stays at ${input.toPath}, because something new is at ${input.fromPath}.`);
  }
  if (trashed !== undefined && fromFiles.some(file => where(file) === "trash")) {
    notes.push(`Part of it stays in the workspace trash as ${workspaceTrashPath(trashed)}, because something new is at both paths.`);
  }
  const destDeleted: string[] = [];
  let destLeft: string[] = [];
  if (change.staged !== undefined) {
    const left = await placeBack(rootPath, change.staged, destPlace);
    destLeft = left;
    if (left.length) notes.push(`Part of the replaced ${input.toPath} stays in the workspace trash as ${workspaceTrashPath(change.staged)}.`);
    for (const { path, sub, momentId } of [...change.destDeleted].reverse()) {
      if (stayed(left, sub)) {
        // Still in the trash, with its delete recorded: `deleted` names it.
        destDeleted.push(path);
        continue;
      }
      // Back on disk. A delete row History would not take back is not a
      // deleted file: capture records the file again, without an author.
      await recordOrNote(engine!.undoDelete(path, momentId),
        `History still shows ${path} as deleted. The file is back at ${path}. History records it again as a local file edit.`);
    }
  }
  const rowlessSource = change.moved || change.sourceStaged !== undefined
    ? fromFiles.filter(file => !recorded.has(file)).map(path => ({ path, atTarget: where(path) === "target" }))
    : [];
  return { notes: notes.length ? ` ${notes.join(" ")}` : " dohc put everything back.", destLeft, destDeleted, sourceDeleted, rowlessSource };
}

export async function prepareDeleteWorkspacePathAs<Workspace extends PathChangeWorkspace, State>(
  operation: WorkspaceAuthorityOperation<Workspace, State>,
  path: string,
  author: MomentWriteAuthor,
  options: PathChangeOptions,
): Promise<() => Promise<CliResultByVerb["fileDelete"] & Partial<OperationRecovery>>> {
  const workspace = operation.workspace, rootPath = workspace.rootPath;
  const failed = `dohc could not delete ${path}.`;
  const operationId = `${OPERATION_ID_PREFIX}${randomUUID()}`;
  const releaseRecovery = beginPendingRecovery(operationId);
  try {
    assertWritable(operation);
    const changed = await withExclusiveWorkspaceOperation(rootPath, async markChanged => {
      let gone: string[] = [];
      // The capture settles, closes and checks this endpoint before the hold.
      const endpoint = (await admitPath(rootPath, path)).physical;
      const changed = await options.capture.changePathsAs<Changed<{ path: string; withoutHistory: string[]; recovery: DeleteRecoveryPlan }, DeleteFailure>>([endpoint],
        { operation: "delete", author, operationId },
        async engine => {
          // Admission runs here, with capture held, right before the disk changes.
          assertWritable(operation);
          const target = await admitTree(rootPath, await admitPath(rootPath, path), historyAdmission(engine.policy));
          if (target.relative !== endpoint) throw new Error(`${path} now leads somewhere else. Check the path, then try again.`);
          const files = target.files.map(sub => under(target.relative, sub));
          const shown = (file: string) => target.path + file.slice(target.relative.length);
          // Oversized files and text with invalid UTF-8 go without a History row.
          const recorded = new Set(await engine.recordDisk(target.relative, files));
          const withoutHistory = files.filter(file => !recorded.has(file)).map(shown);
          const original = join(rootPath, target.relative);
          // The workspace trash first, a move dohc can put back while History
          // records each file's delete.
          const staged = await moveIntoWorkspaceTrash(workspace, original);
          markChanged();
          const recovery = await stageDeleteRecovery(operationId, staged, target.relative, [...recorded]);
          const deleted: string[] = [];
          let at = 0;
          try {
            for (; at < files.length; at += 1) {
              const file = files[at]!;
              if (!recorded.has(file)) continue;
              await engine.delete(file);
              deleted.push(file);
            }
          } catch (error) {
            // Every file before the one History refused is gone: its delete
            // is recorded, or History holds no row for it. The rest go back.
            const left = files.slice(0, at);
            gone = left;
            for (const file of left) options.markDeleted(file);
            const kept = await restoreUnrecorded(rootPath, staged, original, target.files.slice(at), at === 0);
            const failedPath = shown(files[at] ?? target.relative);
            const trash = workspaceTrashPath(staged);
            const notes = [reason(error, `History could not record the delete of ${failedPath}.`)];
            if (deleted.length) {
              notes.push(`${deleted.map(shown).join(", ")} left ${target.path} for the workspace trash as ${trash}. Restore in History brings each back.`);
            }
            const noRow = left.filter(file => !recorded.has(file)).map(shown);
            if (noRow.length) notes.push(`${noRow.join(", ")} left ${target.path} for the workspace trash as ${trash}, with no History row.`);
            if (kept.length) {
              notes.push(`${kept.map(sub => under(target.path, sub)).join(", ")} stay in the workspace trash as ${trash}, because dohc could not put them back without replacing what is at their place.`);
            }
            return { failed: { ok: false as const, deleted: deleted.map(shown), path: failedPath, reason: notes.join(" "),
              ...(noRow.length ? { withoutHistory: noRow } : {}) } };
          }
          gone = [target.relative];
          options.markDeleted(target.relative);
          return { done: { path: target.path, withoutHistory, recovery }, trash: staged };
        },
        () => gone);
      if ("failed" in changed) return changed;
      const recovery = await finishDeleteRecovery(workspace, changed.done.recovery, { trashed: false, staged: changed.trash });
      return { ...changed, recovery };
    });
    if ("failed" in changed) { releaseRecovery(); return async () => changed.failed; }
    return async () => {
      try {
        const trashed = changed.trash !== undefined && await toSystemTrash(options, changed.trash);
        const { withoutHistory, recovery: plan, ...done } = changed.done;
        // Only this delete writes the record until releaseRecovery admits Undo.
        const recovery = trashed ? await finishDeleteRecovery(workspace, plan, { trashed: true }) : changed.recovery;
        return { ok: true, ...done, trashed, ...recovery,
          ...(trashed || changed.trash === undefined ? {} : { trashPath: workspaceTrashPath(changed.trash) }),
          ...(withoutHistory.length ? { withoutHistory } : {}) };
      } finally { releaseRecovery(); }
    };
  } catch (error) {
    releaseRecovery();
    if (error instanceof StoredEntryIdentityUnavailable) error = deleteIdentityUnavailable(path);
    return async () => ({ ok: false, deleted: [], path, reason: reason(error, failed) });
  }
}

// Puts back each staged file History did not record as deleted, without
// replacing anything that appeared at its place since. `whole` puts back the
// whole staged entry. Answers the files that stay in the trash.
async function restoreUnrecorded(rootPath: string, staged: string, original: string,
  unrecorded: readonly string[], whole: boolean): Promise<string[]> {
  if (whole) {
    const left = await placeBack(rootPath, staged, original);
    return unrecorded.filter(sub => stayed(left, sub));
  }
  const kept: string[] = [];
  for (const sub of unrecorded) {
    if ((await placeBack(rootPath, join(staged, sub), join(original, sub))).length) kept.push(sub);
  }
  return kept;
}

/**
 * A person's delete. An open document settles first, then the entry goes
 * from its own place to the system trash, whose Restore puts it back there;
 * the workspace trash takes it when the system refuses. History then records
 * each file's delete under the person, and a delete History refuses leaves
 * the entry in the trash, whole. Without capture, the trash move alone is
 * the delete. Throws, saying where the entry is, when the delete did not
 * finish.
 */
export async function deleteWorkspacePathByHand(
  operation: PathChangeOperation,
  path: string,
  person: Extract<MomentWriteAuthor, { kind: "human" }>,
  options: Omit<PathChangeOptions, "capture"> & { capture: PathChangeOptions["capture"] | null; emptyFolderOnly?: boolean; markChanged?: () => void; admit?: () => Promise<void> },
): Promise<{ trashed: boolean } & Partial<OperationRecovery>> {
  const workspace = operation.workspace, rootPath = workspace.rootPath;
  assertWritable(operation);
  const { capture } = options;
  const operationId = `${OPERATION_ID_PREFIX}${randomUUID()}`;
  const change = async (markChanged: () => void) => {
    if (options.emptyFolderOnly) {
      assertWritable(operation);
      if (await removeEmptyWorkspaceFolder(rootPath, path)) markChanged();
      return { trashed: false, refused: undefined };
    }
    const endpoint = await prepareWorkspaceDelete(rootPath, path);
    const trash = async (recorded: readonly string[]) => {
      assertWritable(operation);
      await options.admit?.();
      const plan = await stageDeleteRecovery(operationId, join(rootPath, endpoint), endpoint, recorded);
      let staged: string | undefined;
      const trashed = await deletePath(workspace, endpoint, options.trashItem, path => { staged = path; });
      markChanged();
      options.markDeleted(endpoint);
      const collected = staged === undefined ? plan : await stageDeleteRecovery(operationId, staged, endpoint, recorded);
      return { ...trashed, recovery: await finishDeleteRecovery(workspace, collected, { trashed: trashed.trashed, staged }) };
    };
    // History holds nothing the engine cannot address, and nothing is open there.
    if (capture === null || !engineAddresses(endpoint)) {
      return { ...await trash([]), refused: undefined };
    }
    let gone: string[] = [];
    return await capture.changePathsAs([endpoint], { operation: "delete", author: person, operationId },
      async engine => {
        // Checked again here, with capture held, right before the disk changes.
        assertWritable(operation);
        if (await prepareWorkspaceDelete(rootPath, path) !== endpoint) {
          throw new Error(`${path} now leads somewhere else. Check the path, then try again.`);
        }
        const files = await historyFilesUnder(rootPath, endpoint, historyAdmission(engine.policy),
          folder => historyExcludesSubtree(engine.policy, folder));
        // Edits capture has not seen yet land as their own rows first.
        const recorded = await engine.recordDisk(endpoint, files);
        const trashed = await trash(recorded);
        gone = [endpoint];
        for (const file of recorded) {
          try {
            await engine.delete(file);
          } catch (error) {
            return { ...trashed, refused: reason(error, `History could not record the delete of ${file}.`) };
          }
        }
        return { ...trashed, refused: undefined };
      },
      () => gone);
  };
  const outcome = await (options.markChanged ? change(options.markChanged) : withExclusiveWorkspaceOperation(rootPath, change));
  if (outcome.refused !== undefined) {
    const where = outcome.trashed ? "the system trash" : `the workspace trash, ${WORKSPACE_TRASH}`;
    throw new Error(`${path} is in ${where}. ${outcome.refused}`);
  }
  return { trashed: outcome.trashed, ...("recovery" in outcome ? outcome.recovery : {}) };
}
