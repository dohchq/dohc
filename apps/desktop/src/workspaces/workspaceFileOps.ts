import { lstat, readdir } from "node:fs/promises";
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
import { materializeSharedViewPaths } from "./sharedView";
import {
  shareViewTakesLocalWrites,
  type ShareViewWriteScope,
} from "./shareWriteGate";
import {
  copyIntoWorkspace,
  createFile,
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
// it still refuses a share view on PRESENCE at every level, which is what the
// handlers it guards need, and `createWorkspaceFolder` is one of them — see
// `shareViewCreate` for why a folder has nothing to state.

// The refusal every level but edit takes, at every one of these seams. One
// string for all four, and the same string for `view` and `comment`, so a
// refusal never tells the recipient which level they hold.
const SHARE_VIEW_READ_ONLY = "This shared view is read-only for you.";

export interface ShareViewFileOpScope {
  workspaceId: string;
  rootPath: string;
  // The share view this workspace IS, or null for an ordinary workspace.
  shareView: ShareViewWriteScope | null;
  // The share view's engine store. Resolved lazily: an ordinary workspace must
  // never open one on a file operation.
  shareViewStore: () => CaptureVersionedTextStore;
}

/**
 * The path is in the folder but not in the store, so no moment describes it —
 * a file the recipient put there by hand, or one a stale explorer still shows.
 * A change dohc cannot state is a change the granter can never receive, so say
 * that, and say where the person can act instead.
 */
function notInThisShareView(path: string, action: "Rename" | "Delete"): string {
  return `${path} is not part of this shared view, so dohc cannot send that change. ${action} it in your file manager to change your own copy.`;
}

function refuseUnlessWritable(shareView: ShareViewWriteScope): void {
  if (!shareViewTakesLocalWrites(shareView)) {
    throw new SharedFileReadOnlyError(SHARE_VIEW_READ_ONLY);
  }
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
 * A file the store already holds is left exactly as it is and its path
 * returned, which is what `createFile` does on disk — a create never clobbers,
 * and a create that journaled an empty moment over someone's work would be
 * worse than one that did nothing.
 *
 * THIS IS ALSO WHERE A FOLDER WOULD GO, AND WHY IT DOES NOT. The engine has no
 * folder object: `VersionedTextStore` names files, a moment names one file's
 * path, and `materializeSharedViewPaths` makes a directory only as the parent
 * of a file it writes. So an empty folder is nothing a recipient could send,
 * and `createWorkspaceFolder` keeps the blanket refusal. A recipient makes a
 * folder by making a file in it — the explorer already takes a typed path with
 * a `/` as root-relative — and the folder appears with it.
 */
async function shareViewCreate(
  input: ShareViewFileOpScope & { relativePath: string; initialText: string },
): Promise<string> {
  const path = requireValidPath(
    validateUserMaterializePath(input.relativePath),
    "file path",
    input.relativePath,
  );
  // A create never clobbers, and BOTH sides can be occupied: the store, and
  // the projection, which may hold a file the recipient put there by hand —
  // `repairSharedViewProjection` leaves such additions alone precisely because
  // they are user data. The disk writer answers this with `wx` and a swallowed
  // EEXIST; this answers it before it journals a moment over either one.
  if (await projectionHolds(input.rootPath, path)) return path;
  const store = input.shareViewStore();
  const main = await store.ensureMainVersion({ workspaceId: input.workspaceId });
  const existing = await store.readTextFile({
    workspaceId: input.workspaceId,
    versionId: main.id,
    path,
  });
  if (existing !== null) return path;
  await store.writeTextFile({
    workspaceId: input.workspaceId,
    versionId: main.id,
    path,
    text: input.initialText,
    metadata: { origin: "local-file" },
  });
  await materializeSharedViewPaths(
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
 * every path under it, each as its own moment — which is the same net change
 * an ordinary workspace's watcher records for a folder rename, and which the
 * submit lane consolidates per file exactly as it does for a single rename.
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
  // The destination question is the STORE's: a rename moves an engine record,
  // and the engine refuses `target-path-exists` against its own paths.
  const moves = [...held.keys()]
    .filter((path) => path === from || path.startsWith(`${from}/`))
    .sort()
    .map((path) => ({
      from: path,
      to: path === from ? to : `${to}/${path.slice(from.length + 1)}`,
    }));
  if (moves.length === 0) {
    throw new Error(notInThisShareView(input.fromPath, "Rename"));
  }
  const changed: ShareViewChangedPath[] = [];
  for (const move of moves) {
    await store.renameTextFile({
      workspaceId: input.workspaceId,
      versionId: main.id,
      fromPath: move.from,
      toPath: move.to,
      metadata: { origin: "local-file" },
    });
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
  if (!held.has(from)) {
    changed.push({ path: from, operation: "delete", contentKind: "text" });
  }
  await materializeSharedViewPaths(input.rootPath, input.workspaceId, changed, store);
  return to;
}

/**
 * A delete in a share view.
 *
 * A folder is its files here too. One projection removal covers both shapes:
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
  const deletes = [...held.keys()]
    .filter((path) => path === target || path.startsWith(`${target}/`))
    .sort();
  if (deletes.length === 0) {
    throw new Error(notInThisShareView(input.relativePath, "Delete"));
  }
  for (const path of deletes) {
    await store.deleteTextFile({
      workspaceId: input.workspaceId,
      versionId: main.id,
      path,
      metadata: { origin: "local-file" },
    });
  }
  await materializeSharedViewPaths(
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
  const taken = new Set<string>([
    ...[...held.keys()]
      .filter((path) => (relDir === "" ? !path.includes("/") : path.startsWith(`${relDir}/`)))
      .map((path) => (relDir === "" ? path : path.slice(relDir.length + 1))),
    ...(await readdir(absDir)),
  ]);

  const imported: string[] = [];
  const changed: ShareViewChangedPath[] = [];
  let skipped = screened.refused;
  for (const source of screened.usable) {
    const validated = validateUserMaterializePath(basename(source));
    if (!validated.ok) {
      skipped += 1;
      continue;
    }
    // Read the content BEFORE claiming a name: a source the engine cannot own
    // must not consume a collision variant it never used.
    const content = await readDiskContent(source);
    if (content.kind !== "text" && content.kind !== "binary") {
      skipped += 1;
      continue;
    }
    const name = importNameFor(validated.normalized, absDir, (candidate) =>
      taken.has(candidate),
    );
    if (name === null) {
      skipped += 1;
      continue;
    }
    taken.add(name);
    const path = relDir === "" ? name : `${relDir}/${name}`;
    if (content.kind === "text") {
      await store.writeTextFile({
        workspaceId: input.workspaceId,
        versionId: main.id,
        path,
        text: content.text,
        metadata: { origin: "local-file" },
      });
    } else {
      await store.writeBinaryFile({
        workspaceId: input.workspaceId,
        versionId: main.id,
        path,
        bytes: content.bytes,
        metadata: { origin: "local-file" },
      });
    }
    imported.push(path);
    changed.push({ path, operation: "write", contentKind: content.kind });
  }
  await materializeSharedViewPaths(input.rootPath, input.workspaceId, changed, store);
  return { imported, skipped };
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
