import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { CliResultByVerb } from "@dohc/cli/protocol";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import { validateUserMaterializePath } from "@dohc/workspace-core";
import type { WorkspaceAuthorityOperation } from "./workspaceAuthorityOwner";
import { withExclusiveWorkspaceOperation } from "./workspaceAssets";
import type { AuthoredPathChanges, WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { historyPathAdmission, type WorkspaceEnginePolicySnapshot } from "./workspaceEnginePolicyFile";
import { moveIntoWorkspaceTrash } from "./workspaceFiles";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";

type PathChangeWorkspace = { rootPath: string; readOnly?: boolean; shareView?: unknown };

export interface PathChangeOptions {
  capture: Pick<WorkspaceEngineCapture, "changePathsAs">;
  requestId: string;
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
// trash runs after the hold, because a slow shell must not keep capture out.
type Changed<Done, Failed> = { done: Done; trash?: string } | { failed: Failed };

const under = (base: string, sub: string) => (sub ? `${base}/${sub}` : base);
const errnoOf = (error: unknown) => (error instanceof Error && "syscall" in error && "code" in error ? String(error.code) : undefined);
const exists = (absolute: string) => lstat(absolute).then(() => true, () => false);
const workspaceTrashPath = (staged: string) => `.dohc/trash/${basename(staged)}`;

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

function assertWritable(operation: WorkspaceAuthorityOperation<PathChangeWorkspace, unknown>) {
  operation.assertCurrent();
  if (operation.workspace.readOnly || operation.workspace.shareView !== undefined) {
    throw new Error("This workspace is read-only. Change files in the owning workspace.");
  }
}

function checkedPath(path: string): string {
  const checked = validateUserMaterializePath(path, { platform: process.platform });
  if (!checked.ok) throw new Error(`Cannot change ${path}: ${checked.reason}. Choose a visible workspace path.`);
  if (process.platform === "win32" && checked.normalized.split("/").some(segment => /[. ]$/u.test(segment))) {
    throw new Error(`Cannot change ${path}: Windows removes trailing dots and spaces. Choose a path without those endings.`);
  }
  return checked.normalized;
}

// The path as spelled and where it resolves. A move or delete renames the
// entry itself, so its last segment is not followed. An entry already on
// disk also answers to its own name there (`physical`), as
// prepareWorkspaceDelete does: on a disk that ignores case, Notes.txt then
// reaches the notes.txt History holds. A link keeps its spelled name, and
// admitTree refuses it.
async function admitPath(rootPath: string, path: string): Promise<AdmittedPath> {
  const normalized = checkedPath(path);
  const target = await assertResolvedWorkspacePath({ rootPath, absolutePath: join(rootPath, normalized),
    spelled: path, label: "Path", access: "entry" });
  const info = await lstat(target.resolvedAbsolute).catch(() => null);
  const physical = info && !info.isSymbolicLink()
    ? relative(await realpath(rootPath), await realpath(target.resolvedAbsolute)).split(sep).join("/")
    : target.relative;
  return { path: normalized, relative: target.relative, physical };
}

// Every entry at or under an existing path must be a regular file or folder
// History records at each of `bases`, as spelled and where it resolves. A
// reserved or ignored folder, such as .git or node_modules, refuses before
// dohc reads inside it.
async function admitTree(rootPath: string, spelled: string, allowed: (path: string) => boolean,
  otherBases: readonly string[] = []): Promise<AdmittedTree> {
  const admitted = await admitPath(rootPath, spelled);
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

// The policy the capture seam read for this change, once it left the queue.
function historyAdmission(policy: WorkspaceEnginePolicySnapshot): (path: string) => boolean {
  if (policy.errors.length) throw new Error(`dohc could not read the workspace file policy: ${policy.errors.join("; ")}. Fix the reported policy errors.`);
  return historyPathAdmission(policy);
}

// Places `from`, a file this change staged in the workspace trash, at `to`
// in the visible workspace only while nothing is at `to`: through a hard
// link, or an exclusive copy where links are refused. Only the private staged
// name is ever removed, so nothing another program writes at a visible path
// can be lost. When that name cannot be removed, a spare copy stays in the
// trash; the file is placed all the same. Throws, with nothing at `to`, when
// `to` is taken or leads outside the workspace or into a reserved area.
async function placeFile(rootPath: string, from: string, to: string): Promise<void> {
  await assertResolvedWorkspacePath({ rootPath, absolutePath: to, spelled: relative(rootPath, to).split(sep).join("/"),
    label: "Path", access: "entry" });
  await mkdir(dirname(to), { recursive: true });
  await link(from, to).catch(async (error: unknown) => {
    if (errnoOf(error) === "EEXIST") throw error;
    await copyFile(from, to, constants.COPYFILE_EXCL);
  });
  await unlink(from).catch(() => undefined);
}

// Places `from`, an entry staged in the workspace trash, at `to` without
// replacing anything there, even an empty folder: a folder is created fresh,
// and each entry moves into it the same way. Answers the files, relative to
// `from`, that stayed in the trash; a folder dohc could not read stays whole
// under its own name. Never throws.
async function placeBack(rootPath: string, from: string, to: string, sub = ""): Promise<string[]> {
  let entries: string[];
  try {
    if (!(await lstat(from)).isDirectory()) {
      await placeFile(rootPath, from, to);
      return [];
    }
    entries = await readdir(from);
    await assertResolvedWorkspacePath({ rootPath, absolutePath: to, spelled: relative(rootPath, to).split(sep).join("/"),
      label: "Path", access: "entry" });
    await mkdir(dirname(to), { recursive: true });
    await mkdir(to);
  } catch {
    return [sub];
  }
  const left: string[] = [];
  for (const name of entries) left.push(...await placeBack(rootPath, join(from, name), join(to, name), sub ? `${sub}/${name}` : name));
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
const toSystemTrash = (options: PathChangeOptions, staged: string) =>
  options.trashItem(staged).then(() => true, () => false);

export async function moveWorkspacePathAs<Workspace extends PathChangeWorkspace, State>(
  operation: WorkspaceAuthorityOperation<Workspace, State>,
  input: { fromPath: string; toPath: string; overwrite?: boolean },
  author: MomentWriteAuthor,
  options: PathChangeOptions,
): Promise<CliResultByVerb["fileMove"]> {
  const rootPath = operation.workspace.rootPath;
  const failed = `dohc could not move ${input.fromPath}.`;
  try {
    assertWritable(operation);
    const changed = await withExclusiveWorkspaceOperation(rootPath, async markChanged => {
      let gone: string[] = [];
      // The capture settles, closes and checks these endpoints before the hold.
      const endpoints = [(await admitPath(rootPath, input.fromPath)).physical, (await admitPath(rootPath, input.toPath)).physical];
      return await options.capture.changePathsAs<Changed<{ fromPath: string; toPath: string; withoutHistory: string[] }, MoveFailure>>(endpoints,
        { operation: "move", author, correlationId: `fileMove:${options.requestId}` },
        async engine => {
          // Admission runs here, with capture held, right before the disk changes.
          assertWritable(operation);
          const allowed = historyAdmission(engine.policy);
          const to = await admitPath(rootPath, input.toPath);
          const spelledFrom = await admitPath(rootPath, input.fromPath);
          if (spelledFrom.physical !== endpoints[0] || to.physical !== endpoints[1]) {
            throw new Error(`${input.fromPath} or ${input.toPath} now leads somewhere else. Check both paths, then try again.`);
          }
          // Two spellings of one entry on disk are a rename of its case.
          const caseOnly = spelledFrom.physical === to.physical && spelledFrom.relative !== to.relative;
          const pairs = [[spelledFrom.path, to.path], [spelledFrom.relative, to.relative],
            ...(caseOnly ? [] : [[spelledFrom.physical, to.physical]])];
          for (const [a = "", b = ""] of pairs) {
            if (a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`)) {
              throw new Error(`Cannot move ${input.fromPath} to ${input.toPath}: one holds the other. Choose a destination outside both.`);
            }
          }
          const from = await admitTree(rootPath, input.fromPath, allowed, [to.path, to.relative]);
          for (const sub of from.files) {
            const fromKind = liveDocumentKindForPath(under(from.relative, sub));
            const toKind = liveDocumentKindForPath(under(to.relative, sub));
            if (fromKind !== null && fromKind !== toKind) {
              throw new Error(`A move cannot change a live document's kind from ${fromKind} to ${toKind ?? "a plain file"}. Create a new file and copy the content instead.`);
            }
          }
          const source = join(rootPath, from.relative);
          const target = join(rootPath, to.relative);
          let dest: AdmittedTree | undefined;
          if (await exists(target) && !caseOnly) {
            if (!input.overwrite) throw new Error(`${input.toPath} already exists. Choose another destination, or move with overwrite.`);
            dest = await admitTree(rootPath, input.toPath, allowed);
          }
          // A replaced destination is named by its entry on disk.
          const destBase = dest?.relative ?? to.relative;
          const fromFiles = from.files.map(sub => under(from.relative, sub));
          const destFiles = (dest?.files ?? []).map(sub => under(destBase, sub));
          // History holds these; a regular file over the size it keeps moves
          // or goes with no row, and the answer names it.
          const recorded = new Set(await engine.recordDisk(from.relative, fromFiles));
          const destRecorded = new Set(caseOnly ? [] : await engine.recordDisk(destBase, destFiles));
          const rebase = (path: string) => to.relative + path.slice(from.relative.length);
          const shownTo = (path: string) => to.path + path.slice(to.relative.length);
          const withoutHistory = [...new Set([
            ...fromFiles.filter(file => !recorded.has(file)).map(file => shownTo(rebase(file))),
            ...destFiles.filter(file => !destRecorded.has(file)).map(file => to.path + file.slice(destBase.length)),
          ])];

          const change: MoveProgress = { staged: undefined, sourceStaged: undefined, destDeleted: [], moved: false, renamed: [] };
          try {
            if (dest) {
              // The replaced destination waits in the workspace trash, so the
              // move can still put it back.
              change.staged = await moveIntoWorkspaceTrash(rootPath, join(rootPath, destBase));
              markChanged();
              for (const sub of dest.files) {
                const path = under(destBase, sub);
                if (!destRecorded.has(path)) continue;
                change.destDeleted.push({ path, sub, momentId: await engine.delete(path) });
              }
            }
            if (from.files.length === 1 && from.files[0] === "" && !caseOnly) {
              await mkdir(dirname(target), { recursive: true });
              // One rename that refuses to replace, where this filesystem has
              // one. Elsewhere the file leaves its visible name in one rename,
              // so the placement below only ever links and removes a private
              // copy, and copies only where links are refused.
              if (!(await engine.moveFile(from.relative, to.relative))) {
                change.sourceStaged = await moveIntoWorkspaceTrash(rootPath, source);
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
            for (const file of fromFiles) {
              if (!recorded.has(file)) continue;
              await engine.rename(file, rebase(file));
              change.renamed.push(file);
            }
          } catch (error) {
            const undone = await undoMove(rootPath, engine, change, from.relative, fromFiles, recorded, rebase, source, target,
              join(rootPath, destBase), caseOnly, input);
            gone = [...undone.destDeleted, ...undone.sourceDeleted];
            const deleted = [...undone.destDeleted.map(path => to.path + path.slice(destBase.length)),
              ...undone.sourceDeleted.map(path => from.path + path.slice(from.relative.length))];
            return { failed: { ok: false as const, path: input.fromPath, reason: `${reason(error, failed)}${undone.notes}`,
              ...(deleted.length ? { deleted } : {}) } };
          }
          gone = [from.relative, ...(dest ? [destBase] : [])];
          return { done: { fromPath: from.path, toPath: to.path, withoutHistory }, ...(change.staged !== undefined ? { trash: change.staged } : {}) };
        },
        () => gone);
    });
    if ("failed" in changed) return changed.failed;
    // The replaced destination leaves the workspace trash for the system
    // trash, as a deleted file does, or stays when the system refuses.
    if (changed.trash !== undefined) await toSystemTrash(options, changed.trash);
    const { withoutHistory, ...done } = changed.done;
    return { ok: true, ...done, ...(withoutHistory.length ? { withoutHistory } : {}) };
  } catch (error) {
    return { ok: false, path: input.fromPath, reason: reason(error, failed) };
  }
}

interface MoveProgress {
  staged: string | undefined;
  // A single file's source, staged in the trash until it is placed.
  sourceStaged: string | undefined;
  destDeleted: Array<{ path: string; sub: string; momentId: string }>;
  moved: boolean;
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
async function undoMove(rootPath: string, engine: AuthoredPathChanges, change: MoveProgress, fromBase: string,
  fromFiles: readonly string[], recorded: ReadonlySet<string>, rebase: (path: string) => string, source: string,
  target: string, destPlace: string, caseOnly: boolean, input: { fromPath: string; toPath: string },
): Promise<{ notes: string; destDeleted: string[]; sourceDeleted: string[] }> {
  const notes: string[] = [];
  const sourceDeleted: string[] = [];
  const recordOrNote = (work: Promise<unknown>, note: string) => work.then(() => true, () => { notes.push(note); return false; });
  const subOf = (file: string) => file.slice(fromBase.length).replace(/^\//u, "");
  // Where each source file is now, and the trash entry that holds the rest.
  let where = (_file: string): "source" | "target" | "trash" => "source";
  let trashed: string | undefined;
  if (change.moved) {
    if (caseOnly) {
      const back = await rename(target, source).then(() => true, () => false);
      where = () => back ? "source" : "target";
    } else {
      trashed = await moveIntoWorkspaceTrash(rootPath, target).catch(() => undefined);
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
    if (now === "source" && renamed) await recordOrNote(engine.rename(rebase(file), file), `History still shows ${file} at ${rebase(file)}.`);
    if (now === "target" && !renamed) await recordOrNote(engine.rename(file, rebase(file)), `History still shows ${rebase(file)} at ${file}.`);
    if (now === "trash" && await recordOrNote(engine.delete(renamed ? rebase(file) : file), `History still shows ${file}; its file is in the workspace trash.`)) {
      sourceDeleted.push(file);
    }
  }
  if (fromFiles.some(file => where(file) === "target")) notes.push(`Part of it stays at ${input.toPath}, because something new is at ${input.fromPath}.`);
  if (trashed !== undefined && fromFiles.some(file => where(file) === "trash")) {
    notes.push(`Part of it stays in the workspace trash as ${workspaceTrashPath(trashed)}, because something new is at both paths.`);
  }
  const destDeleted: string[] = [];
  if (change.staged !== undefined) {
    const left = await placeBack(rootPath, change.staged, destPlace);
    if (left.length) notes.push(`Part of the replaced ${input.toPath} stays in the workspace trash as ${workspaceTrashPath(change.staged)}.`);
    for (const { path, sub, momentId } of [...change.destDeleted].reverse()) {
      if (stayed(left, sub)) {
        // Still in the trash, with its delete recorded: `deleted` names it.
        destDeleted.push(path);
        continue;
      }
      // Back on disk. A delete row History would not take back is not a
      // deleted file: capture records the file again, without an author.
      await recordOrNote(engine.undoDelete(path, momentId),
        `History still shows ${path} as deleted. The file is back at ${path}, and capture records it again without an author.`);
    }
  }
  return { notes: notes.length ? ` ${notes.join(" ")}` : " dohc put everything back.", destDeleted, sourceDeleted };
}

export async function deleteWorkspacePathAs<Workspace extends PathChangeWorkspace, State>(
  operation: WorkspaceAuthorityOperation<Workspace, State>,
  path: string,
  author: MomentWriteAuthor,
  options: PathChangeOptions,
): Promise<CliResultByVerb["fileDelete"]> {
  const rootPath = operation.workspace.rootPath;
  const failed = `dohc could not delete ${path}.`;
  try {
    assertWritable(operation);
    const changed = await withExclusiveWorkspaceOperation(rootPath, async markChanged => {
      let gone: string[] = [];
      // The capture settles, closes and checks this endpoint before the hold.
      const endpoint = (await admitPath(rootPath, path)).physical;
      return await options.capture.changePathsAs<Changed<{ path: string; withoutHistory: string[] }, DeleteFailure>>([endpoint],
        { operation: "delete", author, correlationId: `fileDelete:${options.requestId}` },
        async engine => {
          // Admission runs here, with capture held, right before the disk changes.
          assertWritable(operation);
          const target = await admitTree(rootPath, path, historyAdmission(engine.policy));
          if (target.relative !== endpoint) throw new Error(`${path} now leads somewhere else. Check the path, then try again.`);
          const files = target.files.map(sub => under(target.relative, sub));
          const shown = (file: string) => target.path + file.slice(target.relative.length);
          // History holds these; a regular file over the size it keeps goes
          // with no row, and the answer names it.
          const recorded = new Set(await engine.recordDisk(target.relative, files));
          const withoutHistory = files.filter(file => !recorded.has(file)).map(shown);
          const original = join(rootPath, target.relative);
          // The workspace trash first, a move dohc can put back while History
          // records each file's delete.
          const staged = await moveIntoWorkspaceTrash(rootPath, original);
          markChanged();
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
          return { done: { path: target.path, withoutHistory }, trash: staged };
        },
        () => gone);
    });
    if ("failed" in changed) return changed.failed;
    const trashed = changed.trash !== undefined && await toSystemTrash(options, changed.trash);
    const { withoutHistory, ...done } = changed.done;
    return { ok: true, ...done, trashed,
      ...(trashed || changed.trash === undefined ? {} : { trashPath: workspaceTrashPath(changed.trash) }),
      ...(withoutHistory.length ? { withoutHistory } : {}) };
  } catch (error) {
    return { ok: false, deleted: [], path, reason: reason(error, failed) };
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
