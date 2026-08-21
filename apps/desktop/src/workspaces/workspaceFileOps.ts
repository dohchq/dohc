import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  validateUserMaterializePath,
  validateUserWritePath,
  type WritePathValidation,
} from "@dohc/workspace-core";
import {
  SharedFileReadOnlyError,
  type ShareViewChangedPath,
} from "@dohc/workspace-contracts/relay";
import {
  clearPendingMaterializationPaths,
  materializeSharedViewPaths,
  writeDiskContentToStore,
  writePendingMaterializationPaths,
} from "./sharedView";
import {
  shareViewTakesLocalWrites,
  type ShareViewWriteScope,
} from "./shareWriteGate";
import {
  copyIntoWorkspace,
  createFile,
  createFolder,
  deletePath,
  importDroppedPaths,
  importNameFor,
  movePath,
  resolveImportDestination,
  screenDroppedPaths,
  type ImportCopyOutcome,
} from "./workspaceFiles";
import { readDiskContent } from "./workspaceEngineCapture";
import type { CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";

// THE OTHER FOUR WRITES A SHARE VIEW ADMITS — create, rename, delete, import
// (#646, issue #802), each routed the way `routeWorkspaceTextWrite` routes the
// text save.
//
// The rule that module states holds here unchanged. An ORDINARY workspace's
// folder is the source of truth, so these four write it and the watcher turns
// what landed into moments. A SHARE VIEW is the other way round: its engine
// store is the source and its folder is a projection, nothing watches the
// folder, and a change with no moment is a change the recipient can never
// send. So the write goes through the engine and the projection follows it.
//
// Each operation asks the level ONCE, through `shareViewTakesLocalWrites`, at
// the seam that would otherwise write. `assertWritableWorkspace` is untouched:
// it still refuses a share view on PRESENCE at every level.
//
// THE PROJECTION IS NOT DOHC'S TO SPEND. A share view's folder holds two kinds
// of file: the projection of the store, which this module rewrites freely, and
// whatever the recipient put there themselves, which is their own data and
// which no moment describes — `repairSharedViewProjection` leaves those alone
// for exactly that reason. Every operation here therefore asks BOTH sides
// before it writes either, and refuses when it would touch content the store
// cannot state. Refusing is the whole fix: dohc does not carry those files
// along, and does not invent a trash to put them in.

/** A share view, plus the granter a refusal has to name. */
export type ShareViewFileOpTarget = ShareViewWriteScope & {
  granterEmail: string | null;
};

export interface ShareViewFileOpScope {
  workspaceId: string;
  rootPath: string;
  // The share view this workspace IS, or null for an ordinary workspace.
  shareView: ShareViewFileOpTarget | null;
  // The share view's engine store. Resolved lazily: an ordinary workspace must
  // never open one on a file operation.
  shareViewStore: () => CaptureVersionedTextStore;
}

/**
 * The refusal every level but edit takes, at every one of these seams.
 *
 * The same sentence for `view` and `comment`, so a refusal never tells the
 * recipient which level they hold, and the granter named the way the ordinary
 * write gate names them — a person who cannot change a file needs to know who
 * can.
 */
function readOnlyRefusal(shareView: ShareViewFileOpTarget): string {
  const granter = shareView.granterEmail ?? "the person who shared it";
  return `This shared view is read-only for you. Ask ${granter} for changes.`;
}

// A folder is not a thing the engine can hold, so this is true at every level.
// It replaces no gate: `routeWorkspaceFolderCreate` refuses a share view on
// PRESENCE, exactly as `assertWritableWorkspace` did, and only chooses which
// true sentence to say.
const NO_EMPTY_FOLDER =
  "A shared view can't hold an empty folder. Make a file in the folder you want.";

/**
 * The path is in the folder but not in the store, so no moment describes it —
 * a file the recipient put there by hand, or one a stale explorer still shows.
 * A change dohc cannot state is a change the granter can never receive, so say
 * that, and say where the person can act instead.
 */
function notInThisShareView(path: string, action: "Rename" | "Delete"): string {
  return `${path} is not part of this shared view, so dohc cannot send that change. ${action} it in your file manager to change your own copy.`;
}

/**
 * A folder holding files the store never had. Naming them is the point: the
 * person has to know which files to move before the operation can run.
 */
function untrackedUnderRefusal(folder: string, untracked: readonly string[]): string {
  const named = untracked.slice(0, 3).join(", ");
  const rest = untracked.length > 3 ? `, and ${untracked.length - 3} more` : "";
  const one = untracked.length === 1;
  return `${folder} holds ${untracked.length} ${one ? "file that is" : "files that are"} not part of this shared view: ${named}${rest}. Move ${one ? "it" : "them"} out of the folder first.`;
}

function refuseUnlessWritable(shareView: ShareViewFileOpTarget): void {
  if (!shareViewTakesLocalWrites(shareView)) {
    throw new SharedFileReadOnlyError(readOnlyRefusal(shareView));
  }
}

async function materializeWithPendingRecord(
  rootPath: string,
  workspaceId: string,
  changed: readonly ShareViewChangedPath[],
  store: CaptureVersionedTextStore,
): Promise<void> {
  const paths = changed.map((change) => change.path);
  await writePendingMaterializationPaths(rootPath, paths);
  await materializeSharedViewPaths(rootPath, workspaceId, changed, store);
  await clearPendingMaterializationPaths(rootPath, paths);
}

export async function routeWorkspaceFileCreate(
  input: ShareViewFileOpScope & { relativePath: string; initialText: string },
): Promise<string> {
  if (input.shareView) {
    refuseUnlessWritable(input.shareView);
    return shareViewCreate(input);
  }
  return createFile(input.rootPath, input.relativePath, input.initialText);
}

/**
 * A folder, which a share view cannot hold at any level.
 *
 * This is a refusal, not a route: nothing below it writes a share view, and
 * the share view branch is decided on PRESENCE, never on the grant. The level
 * chooses the sentence and nothing else, so there is no rule here to widen.
 */
export async function routeWorkspaceFolderCreate(input: {
  rootPath: string;
  relativePath: string;
  // No store resolver: this refuses every share view, so no branch below it
  // could ever open one.
  shareView: ShareViewFileOpTarget | null;
}): Promise<string> {
  if (input.shareView) {
    throw new SharedFileReadOnlyError(
      shareViewTakesLocalWrites(input.shareView)
        ? NO_EMPTY_FOLDER
        : readOnlyRefusal(input.shareView),
    );
  }
  return createFolder(input.rootPath, input.relativePath);
}

export async function routeWorkspacePathMove(
  input: ShareViewFileOpScope & { fromPath: string; toPath: string },
): Promise<string> {
  if (input.shareView) {
    refuseUnlessWritable(input.shareView);
    return shareViewMove(input);
  }
  return movePath(input.rootPath, input.fromPath, input.toPath);
}

export async function routeWorkspacePathDelete(
  input: ShareViewFileOpScope & {
    relativePath: string;
    trashItem: (absolutePath: string) => Promise<void>;
  },
): Promise<{ trashed: boolean }> {
  if (input.shareView) {
    refuseUnlessWritable(input.shareView);
    return shareViewDelete(input);
  }
  return deletePath(input.rootPath, input.relativePath, input.trashItem);
}

export async function routeWorkspaceFileImport(
  input: ShareViewFileOpScope & {
    absolutePaths: string[];
    // The registered workspace roots to screen against, for the OS drag-in.
    // Null for the main-process file dialog, whose picks the user made.
    screenAgainstRoots: string[] | null;
    targetDir: string | undefined;
  },
): Promise<ImportCopyOutcome> {
  if (input.shareView) {
    refuseUnlessWritable(input.shareView);
    return shareViewImport(input);
  }
  return input.screenAgainstRoots === null
    ? copyIntoWorkspace(input.rootPath, input.absolutePaths, input.targetDir)
    : importDroppedPaths(
        input.rootPath,
        input.absolutePaths,
        input.screenAgainstRoots,
        input.targetDir,
      );
}

/**
 * A new file in a share view: a moment first, then the projection.
 *
 * A create never clobbers, and BOTH sides can be occupied: the store, and the
 * projection, which may hold a file the recipient put there by hand. The disk
 * writer answers this with `wx` and a swallowed EEXIST; this answers it before
 * it journals a moment over either one.
 *
 * THIS IS ALSO WHERE A FOLDER WOULD GO, AND WHY IT DOES NOT. The engine has no
 * folder object: `VersionedTextStore` names files, a moment names one file's
 * path, and `materializeSharedViewPaths` makes a directory only as the parent
 * of a file it writes. So an empty folder is nothing a recipient could send.
 * A recipient makes a folder by making a file in it — the explorer already
 * takes a typed path with a `/` as root-relative — and the folder appears with
 * it. `routeWorkspaceFolderCreate` says so.
 */
async function shareViewCreate(
  input: ShareViewFileOpScope & { relativePath: string; initialText: string },
): Promise<string> {
  const path = requireValidPath(
    validateUserMaterializePath(input.relativePath),
    "file path",
    input.relativePath,
  );
  if (await projectionHolds(input.rootPath, path)) return path;
  const store = input.shareViewStore();
  const main = await store.ensureMainVersion({ workspaceId: input.workspaceId });
  const existing = await store.readTextFile({
    workspaceId: input.workspaceId,
    versionId: main.id,
    path,
  });
  if (existing !== null) {
    // The store has it and the folder does not, so the projection lost a file
    // the recipient can still see in the explorer. Put it back rather than
    // reporting success over a path that stays missing.
    await materializeWithPendingRecord(
      input.rootPath,
      input.workspaceId,
      [
        {
          path,
          operation: "write",
          contentKind: existing.contentKind === "binary" ? "binary" : "text",
        },
      ],
      store,
    );
    return path;
  }
  await store.writeTextFile({
    workspaceId: input.workspaceId,
    versionId: main.id,
    path,
    text: input.initialText,
    metadata: { origin: "local-file" },
  });
  await materializeWithPendingRecord(
    input.rootPath,
    input.workspaceId,
    [{ path, operation: "write", contentKind: "text" }],
    store,
  );
  return path;
}

/**
 * A rename or move in a share view.
 *
 * A FOLDER is its files. The store holds no folder, so moving one is moving
 * every path under it, each as its own moment — the same net change an
 * ordinary workspace's watcher records for a folder rename, and which the
 * submit lane consolidates per file exactly as it does for a single rename.
 *
 * Everything is decided before anything is applied: what moves, what it would
 * land on, and whether the folder holds files no moment describes. A failure
 * part way through then puts back what already moved, because half a renamed
 * folder is a set of changes nobody asked to send.
 */
async function shareViewMove(
  input: ShareViewFileOpScope & { fromPath: string; toPath: string },
): Promise<string> {
  const from = requireValidPath(
    validateUserWritePath(input.fromPath),
    "move source",
    input.fromPath,
  );
  const to = requireValidPath(
    validateUserMaterializePath(input.toPath),
    "move destination",
    input.toPath,
  );
  if (to === from || to.startsWith(`${from}/`)) {
    throw new Error(`Cannot move a path into itself: ${input.fromPath}`);
  }
  const store = input.shareViewStore();
  const main = await store.ensureMainVersion({ workspaceId: input.workspaceId });
  const held = await shareViewPaths(store, input.workspaceId, main.id);
  const sources = pathsUnder(held, from);
  if (sources.length === 0) {
    throw new Error(notInThisShareView(from, "Rename"));
  }
  await refuseUntrackedUnder(input.rootPath, from, held);
  // The DESTINATION is screened too. A folder move merges into whatever is
  // already there, and the ordinary `movePath` refuses that outright; the files
  // the store holds are checked one by one below, so what is left to ask is
  // whether the destination holds anything the store does not. Skipped when the
  // two are the same entry, which is what a case-only rename is.
  const renamesInPlace = await sameProjectionEntry(input.rootPath, from, to);
  if (!renamesInPlace) await refuseUntrackedUnder(input.rootPath, to, held);
  const moves = sources.map((path) => ({
    from: path,
    to: path === from ? to : `${to}/${path.slice(from.length + 1)}`,
  }));
  // Every destination, before ANY of them is applied. A collision found half
  // way through would otherwise leave the files before it already moved.
  for (const move of moves) {
    if (held.has(move.to) || (await projectionOccupies(input.rootPath, move))) {
      throw new Error(`Destination already exists: ${move.to}`);
    }
  }

  const applied: { from: string; to: string }[] = [];
  try {
    for (const move of moves) {
      await store.renameTextFile({
        workspaceId: input.workspaceId,
        versionId: main.id,
        fromPath: move.from,
        toPath: move.to,
        metadata: { origin: "local-file" },
      });
      applied.push(move);
    }
  } catch (error) {
    await putBackMoves(store, input.workspaceId, main.id, applied);
    throw error;
  }

  const changed: ShareViewChangedPath[] = [];
  for (const move of moves) {
    changed.push({ path: move.from, operation: "delete", contentKind: "text" });
    changed.push({
      path: move.to,
      operation: "write",
      contentKind: held.get(move.from) ?? "text",
    });
  }
  // A FOLDER source has no file of its own to remove, so its entry goes last:
  // with every file under it gone, what is left is the empty directory the
  // projection made for them.
  //
  // Unless the source and the destination are the SAME folder, which is what a
  // case-only folder rename is. Removing it there removes the files this rename
  // just wrote into it.
  if (!held.has(from) && !renamesInPlace) {
    changed.push({ path: from, operation: "delete", contentKind: "text" });
  }
  await materializeWithPendingRecord(
    input.rootPath,
    input.workspaceId,
    changed,
    store,
  );
  return to;
}

/**
 * Put back the renames that landed before one failed.
 *
 * The projection has not moved yet — it follows the store, and the store is
 * being returned to where it started — so this leaves both sides as they were.
 * A compensation that itself fails is the one case that must be loud: the
 * store is then half moved, and every half is a change the recipient could
 * send without ever having asked to.
 */
async function putBackMoves(
  store: CaptureVersionedTextStore,
  workspaceId: string,
  versionId: string,
  applied: readonly { from: string; to: string }[],
): Promise<void> {
  const stranded: { from: string; to: string }[] = [];
  let firstFailure: unknown = null;
  for (const move of [...applied].reverse()) {
    try {
      await store.renameTextFile({
        workspaceId,
        versionId,
        fromPath: move.to,
        toPath: move.from,
        metadata: { origin: "local-file" },
      });
    } catch (cause) {
      // EVERY reversal is attempted. Abandoning the list at the first failure
      // strands the files after it too, and those are files this same call
      // moved and could still have put back.
      stranded.push(move);
      firstFailure ??= cause;
    }
  }
  if (stranded.length > 0) {
    throw new Error(
      `dohc moved these files and could not put them back: ${stranded
        .map((move) => `${move.to} is not at ${move.from}`)
        .join("; ")}. Check the folder before you send changes.`,
      { cause: firstFailure },
    );
  }
}

/**
 * A delete in a share view.
 *
 * A folder is its files here too, and the same two questions are asked first:
 * does the store hold anything at this path, and does the folder hold anything
 * the store does not. One projection removal then covers both shapes —
 * `materializeSharedViewPaths` removes the named entry recursively, so a file
 * goes and so does the directory its files were in.
 *
 * `trashed: false` states the truth for this branch — nothing was moved to a
 * trash. The reverse path is the review itself: the granter's copy is
 * untouched until they accept, and the recipient can withdraw the change
 * before then.
 */
async function shareViewDelete(
  input: ShareViewFileOpScope & { relativePath: string },
): Promise<{ trashed: boolean }> {
  const target = requireValidPath(
    validateUserWritePath(input.relativePath),
    "delete path",
    input.relativePath,
  );
  const store = input.shareViewStore();
  const main = await store.ensureMainVersion({ workspaceId: input.workspaceId });
  const held = await shareViewPaths(store, input.workspaceId, main.id);
  const targets = pathsUnder(held, target);
  if (targets.length === 0) {
    throw new Error(notInThisShareView(target, "Delete"));
  }
  await refuseUntrackedUnder(input.rootPath, target, held);

  const applied: string[] = [];
  try {
    for (const path of targets) {
      await store.deleteTextFile({
        workspaceId: input.workspaceId,
        versionId: main.id,
        path,
        metadata: { origin: "local-file" },
      });
      applied.push(path);
    }
  } catch (error) {
    // A delete cannot be put back, so the other rule applies: what happened is
    // visible. The projection follows the store for the files that actually
    // went, so nothing is left describing content the store no longer has.
    await materializeWithPendingRecord(
      input.rootPath,
      input.workspaceId,
      applied.map((path) => ({
        path,
        operation: "delete" as const,
        contentKind: "text" as const,
      })),
      store,
    );
    throw error;
  }
  await materializeWithPendingRecord(
    input.rootPath,
    input.workspaceId,
    [{ path: target, operation: "delete", contentKind: "text" }],
    store,
  );
  return { trashed: false };
}

/**
 * An import into a share view: the bytes become moments, and the projection
 * follows.
 *
 * Everything the ordinary import decides is decided the same way — the same
 * drag-in screen, the same destination rule, the same collision ladder, the
 * same skipped count. What differs is the destination: content the engine
 * cannot own is refused HERE, before anything lands, rather than copied to
 * disk and left there as a file no moment states.
 */
async function shareViewImport(
  input: ShareViewFileOpScope & {
    absolutePaths: string[];
    screenAgainstRoots: string[] | null;
    targetDir: string | undefined;
  },
): Promise<ImportCopyOutcome> {
  const screened =
    input.screenAgainstRoots === null
      ? { usable: input.absolutePaths, refused: 0 }
      : await screenDroppedPaths(input.absolutePaths, input.screenAgainstRoots);
  const { absDir, relDir } = await resolveImportDestination(
    input.rootPath,
    input.targetDir,
  );
  const store = input.shareViewStore();
  const main = await store.ensureMainVersion({ workspaceId: input.workspaceId });
  const held = await shareViewPaths(store, input.workspaceId, main.id);
  // Names already occupied, on BOTH sides. The store is what a change is made
  // of; the projection can also hold a file the recipient put there by hand,
  // and the disk copy this replaces would never have overwritten it.
  //
  // The projection half is a FILESYSTEM probe, not a set of `readdir` strings:
  // where the filesystem folds case, `Note.md` and `note.md` are one file, and
  // a string set says the name is free right before the write destroys it. The
  // ordinary import is safe here because COPYFILE_EXCL asks the filesystem the
  // same question; this asks it too.
  const heldInDir = new Set<string>(
    [...held.keys()]
      .filter((path) => (relDir === "" ? !path.includes("/") : path.startsWith(`${relDir}/`)))
      .map((path) => (relDir === "" ? path : path.slice(relDir.length + 1))),
  );
  // Names claimed EARLIER IN THIS RUN have nothing on disk to probe yet, so
  // they are compared case-folded: the conservative direction, and the only one
  // available before the projection is written.
  const claimed = new Set<string>();
  const nameTaken = async (candidate: string): Promise<boolean> =>
    heldInDir.has(candidate) ||
    claimed.has(candidate.toLowerCase()) ||
    (await projectionHolds(
      input.rootPath,
      relDir === "" ? candidate : `${relDir}/${candidate}`,
    ));

  const imported: string[] = [];
  const changed: ShareViewChangedPath[] = [];
  let skipped = screened.refused;
  try {
    for (const source of screened.usable) {
      const validated = validateUserMaterializePath(basename(source));
      if (!validated.ok) {
        skipped += 1;
        continue;
      }
      // Read the content BEFORE claiming a name: a source the engine cannot
      // own must not consume a collision variant it never used.
      const content = await readDiskContent(source);
      if (content.kind !== "text" && content.kind !== "binary") {
        skipped += 1;
        continue;
      }
      const name = await importNameFor(validated.normalized, absDir, nameTaken);
      if (name === null) {
        skipped += 1;
        continue;
      }
      claimed.add(name.toLowerCase());
      const path = relDir === "" ? name : `${relDir}/${name}`;
      await writeDiskContentToStore({
        store,
        workspaceId: input.workspaceId,
        versionId: main.id,
        path,
        content,
      });
      imported.push(path);
      changed.push({ path, operation: "write", contentKind: content.kind });
    }
  } finally {
    // What landed is materialized even when a later source fails, so the
    // projection never lags the store.
    await materializeWithPendingRecord(
      input.rootPath,
      input.workspaceId,
      changed,
      store,
    );
  }
  return { imported, skipped };
}

/**
 * The store paths this operation is about: the path itself when it names a
 * file, every path beneath it when it names a folder.
 *
 * Sorted, because a folder's files are applied in order and put back in the
 * reverse of it.
 */
function pathsUnder(held: ReadonlyMap<string, unknown>, target: string): string[] {
  return [...held.keys()]
    .filter((path) => path === target || path.startsWith(`${target}/`))
    .sort();
}

/**
 * Refuse when a FOLDER holds files the store does not.
 *
 * Both operations that take a whole folder — move and delete — remove the
 * folder from the projection when they finish, and that removal cannot tell a
 * projected file from one the recipient put there. So neither runs while such
 * a file is under it.
 *
 * A file target has nothing to scan: the store holds it, which is what made it
 * a target.
 */
async function refuseUntrackedUnder(
  rootPath: string,
  target: string,
  held: ReadonlyMap<string, unknown>,
): Promise<void> {
  if (held.has(target)) return;
  const untracked = (await projectionFilesUnder(rootPath, target)).filter(
    (path) => !held.has(path),
  );
  if (untracked.length > 0) {
    throw new Error(untrackedUnderRefusal(target, untracked));
  }
}

/**
 * Every file the projection holds under a folder, workspace-relative.
 *
 * A symlink is counted as a file whatever it points at: `readdir` does not
 * follow one, and a link is content dohc did not put there either.
 */
async function projectionFilesUnder(
  rootPath: string,
  folder: string,
): Promise<string[]> {
  const found: string[] = [];
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(join(rootPath, relative), {
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else found.push(child);
    }
  }
  await walk(folder);
  return found.sort();
}

/**
 * Is something already at this path in the projection?
 *
 * `lstat`, never `stat`: a symlink leaf is an occupied name whatever it points
 * at, and following it would ask about a file somewhere else entirely.
 */
async function projectionHolds(rootPath: string, path: string): Promise<boolean> {
  return lstat(join(rootPath, path)).then(
    () => true,
    () => false,
  );
}

/**
 * CASE IDENTITY IS THE FILESYSTEM'S ANSWER, NEVER A STRING'S.
 *
 * On a case-insensitive filesystem `docs/Plans` and `docs/plans` are one
 * directory, and `Note.md` and `note.md` are one file. Every seam here that
 * asks "is this the same entry?" or "is this name taken?" asks through this one
 * probe, because a string comparison answers those questions wrongly on exactly
 * the platform dohc ships on first — and two of the places that asked with
 * strings answered by destroying data.
 *
 * Both ends must resolve for them to BE the same entry: a path that resolves to
 * nothing is not the same as anything, which keeps every caller failing closed.
 */
async function sameProjectionEntry(
  rootPath: string,
  left: string,
  right: string,
): Promise<boolean> {
  const [leftReal, rightReal] = await Promise.all([
    realpath(join(rootPath, left)).catch(() => null),
    realpath(join(rootPath, right)).catch(() => null),
  ]);
  return leftReal !== null && rightReal !== null && leftReal === rightReal;
}

/**
 * Would this move land on something the projection already holds?
 *
 * The case-only carve-out `movePath` makes, for the same reason: the
 * destination "exists" because it IS the source, and refusing there would block
 * a rename the user plainly meant.
 */
async function projectionOccupies(
  rootPath: string,
  move: { from: string; to: string },
): Promise<boolean> {
  if (!(await projectionHolds(rootPath, move.to))) return false;
  return !(await sameProjectionEntry(rootPath, move.from, move.to));
}

/** Every path the share view's store holds, with the kind its projection needs. */
async function shareViewPaths(
  store: CaptureVersionedTextStore,
  workspaceId: string,
  versionId: string,
): Promise<Map<string, "text" | "binary">> {
  const snapshots = await store.listTextFiles({ workspaceId, versionId });
  return new Map(
    snapshots.map((snapshot) => [
      snapshot.path,
      snapshot.contentKind === "binary" ? "binary" : "text",
    ]),
  );
}

function requireValidPath(
  validated: WritePathValidation,
  label: string,
  spelled: string,
): string {
  if (!validated.ok) {
    throw new Error(`Invalid ${label} (${validated.reason}): ${spelled}`);
  }
  return validated.normalized;
}
