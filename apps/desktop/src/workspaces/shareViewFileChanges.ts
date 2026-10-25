import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readdir, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  validateUserMaterializePath,
  validateUserWritePath,
  type FsEntryIdentity,
  type WritePathValidation,
} from "@dohc/workspace-core";
import type { ShareViewChangedPath } from "@dohc/workspace-contracts/relay";
import { isInside } from "../security/pathContainment";
import { shareViewFilesProjection } from "./sharedView";
import {
  assertActiveShareViewFilesOwner,
  type ShareViewFilesOwnerCapability,
  withActiveShareViewFilesOwnerOperation,
} from "./shareViewFilesOwner";
import {
  type UnjournalablePath,
  unjournalablePathMessages,
} from "./shareViewRecords";
import {
  droppedEntryParent,
  importNameFor,
  ImportPathChangedError,
  ImportSkips,
  movePath,
  nameSkip,
  openDroppedFile,
  resolveImportDestination,
  screenDroppedPaths,
  verifyDroppedFolder,
  type DroppedEntry,
  type DroppedFolderCheck,
  type DroppedSource,
  type ImportCopyOutcome,
  type ImportSkipReason,
  type ImportSource,
} from "./workspaceFiles";
import type { WorkspaceTextWriteResult } from "./workspaceAssets";
import { readDiskContent, readOpenedDiskContent, type DiskTextState } from "./workspaceEngineCapture";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import type { CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";
import { isEngineTransportFailure } from "./shareViewEngineFailure";
import { diskSpelling } from "./diskSpelling";

// Internal file-change primitives for ShareViewFiles. Authority, lifecycle, and
// workspace scheduling belong to that owner. This module handles only the
// store mutation and its recoverable folder projection.
//
// THE PROJECTION IS NOT DOHC'S TO SPEND. A share view's folder holds two kinds
// of file: the projection of the store, which this module rewrites freely, and
// whatever the recipient put there themselves, which is their own data and
// which no moment describes. Reconciliation leaves those additions alone for
// exactly that reason. Every operation here therefore asks both sides
// before it writes either, and refuses when it would touch content the store
// cannot state. Refusing is the whole fix: dohc does not carry those files
// along, and does not invent a trash to put them in.

interface ShareViewFileChangeScope {
  workspaceId: string;
  rootPath: string;
  shareViewStore: () => CaptureVersionedTextStore;
  assertPathAllowed?: (path: string) => void;
  owner: ShareViewFilesOwnerCapability;
  projection: ReturnType<typeof shareViewFilesProjection>;
}

type PublicShareViewFileChangeScope = Omit<
  ShareViewFileChangeScope,
  "owner" | "projection" | "workspaceId" | "rootPath"
>;

export function createShareViewFileChanges(
  owner: ShareViewFilesOwnerCapability,
) {
  const projection = shareViewFilesProjection(owner);
  const owned = <T extends PublicShareViewFileChangeScope, Result>(
    input: T,
    operation: (
      ownedInput: T &
        Pick<
          ShareViewFileChangeScope,
          "owner" | "projection" | "workspaceId" | "rootPath"
        >,
    ) => Promise<Result>,
  ) =>
    withActiveShareViewFilesOwnerOperation(
      owner,
      {},
      () => {
        const resource = assertActiveShareViewFilesOwner(owner);
        return operation({
          ...input,
          workspaceId: resource.storeWorkspaceId,
          rootPath: resource.rootPath,
          owner,
          projection,
        });
      },
    );
  return {
    writeText: async (
      input: PublicShareViewFileChangeScope & {
        relativePath: string;
        text: string;
        expectedContentHash: string;
      },
    ) => owned(input, applyShareViewTextWrite),
    createFile: async (
      input: PublicShareViewFileChangeScope & {
        relativePath: string;
        initialText: string;
      },
    ) => owned(input, applyShareViewFileCreate),
    movePath: async (
      input: PublicShareViewFileChangeScope & {
        fromPath: string;
        toPath: string;
      },
    ) => owned(input, applyShareViewPathMove),
    deletePath: async (
      input: PublicShareViewFileChangeScope & { relativePath: string },
    ) => owned(input, applyShareViewPathDelete),
    importFiles: async (
      input: PublicShareViewFileChangeScope & {
        absolutePaths: string[];
        screenAgainstRoots: string[] | null;
        targetDir: string | undefined;
      },
    ) => owned(input, applyShareViewFileImport),
  };
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

/**
 * A folder holding files the store never had. Naming them is the point: the
 * person has to know which files to move before the operation can run.
 */
function untrackedUnderRefusal(
  folder: string,
  untracked: readonly string[],
): string {
  const named = untracked.slice(0, 3).join(", ");
  const rest = untracked.length > 3 ? `, and ${untracked.length - 3} more` : "";
  const one = untracked.length === 1;
  return `${folder} holds ${untracked.length} ${one ? "file that is" : "files that are"} not part of this shared view: ${named}${rest}. Move ${one ? "it" : "them"} out of the folder first.`;
}

async function materializeWithPendingRecord(
  input: ShareViewFileChangeScope,
  changed: readonly ShareViewChangedPath[],
  store: CaptureVersionedTextStore,
): Promise<void> {
  if (changed.length === 0) return;
  const paths = changed.map((change) => change.path);
  await input.projection.markPending(input.rootPath, paths);
  await input.projection.materialize(
    input.rootPath,
    input.workspaceId,
    changed,
    store,
  );
  await input.projection.clearPending(input.rootPath, paths);
}

async function markMutateMaterializeAndClear(
  input: ShareViewFileChangeScope,
  targets: {
    paths: readonly string[];
    changed: readonly ShareViewChangedPath[];
  },
  store: CaptureVersionedTextStore,
  mutate: () => Promise<void>,
): Promise<void> {
  const { paths, changed } = targets;
  if (paths.length > 0) {
    await input.projection.markPending(input.rootPath, paths);
  }
  await mutate();
  if (changed.length > 0) {
    await input.projection.materialize(
      input.rootPath,
      input.workspaceId,
      changed,
      store,
    );
  }
  if (paths.length > 0) {
    await input.projection.clearPending(input.rootPath, paths);
  }
  }

function mutateWithOwner<T>(
  input: Pick<ShareViewFileChangeScope, "owner" | "rootPath" | "workspaceId">,
  mutation: () => Promise<T>,
): Promise<T> {
  assertActiveShareViewFilesOwner(input.owner, {
    rootPath: input.rootPath,
    storeWorkspaceId: input.workspaceId,
  });
  return mutation();
}

/**
 * A received share's store is canonical, so its hash decides whether a text
 * save still targets the version the editor read. The projection follows the
 * moment through the same debt record and materializer as every other change.
 */
async function applyShareViewTextWrite(
  input: ShareViewFileChangeScope & {
  relativePath: string;
  text: string;
  expectedContentHash: string;
  },
): Promise<WorkspaceTextWriteResult> {
  const path = requireValidPath(
    validateUserWritePath(input.relativePath),
    "write path",
    input.relativePath,
  );
  const store = input.shareViewStore();
  const main = await store.ensureMainVersion({
    workspaceId: input.workspaceId,
  });
  const snapshot = await store.readTextFile({
    workspaceId: input.workspaceId,
    versionId: main.id,
    path,
  });
  const current =
    snapshot === null
      ? null
      : (snapshot.sha256 ??
        createHash("sha256").update(snapshot.text, "utf8").digest("hex"));
  if (current !== input.expectedContentHash) {
    return { status: "conflict", currentContentHash: current };
  }
  const changed = [
    { path, operation: "write" as const, contentKind: "text" as const },
  ];
  await markMutateMaterializeAndClear(
    input,
    { paths: [path], changed },
    store,
    async () => {
      await mutateWithOwner(input, () =>
        store.writeTextFile({
        workspaceId: input.workspaceId,
        versionId: main.id,
        path,
        text: input.text,
        metadata: { origin: "local-file" },
        }),
      );
    },
  );
  return {
    status: "written",
    contentHash: createHash("sha256").update(input.text).digest("hex"),
  };
}

/**
 * A new file in a share view: a moment first, then the projection.
 *
 * A create never clobbers, and both sides can be occupied: the store, and the
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
 * it.
 */
async function applyShareViewFileCreate(
  input: ShareViewFileChangeScope & {
    relativePath: string;
    initialText: string;
  },
): Promise<string> {
  const path = requireValidPath(
    validateUserMaterializePath(input.relativePath, { platform: process.platform }),
    "file path",
    input.relativePath,
  );
  const store = input.shareViewStore();
  const main = await store.ensureMainVersion({
    workspaceId: input.workspaceId,
  });
  const existing = await store.readTextFile({
    workspaceId: input.workspaceId,
    versionId: main.id,
    path,
  });
  if (existing !== null) {
    if (!(await projectionHolds(input.rootPath, path))) {
      // The store has it and the folder does not, so the projection lost a file
      // the recipient can still see in the explorer. Put it back rather than
      // reporting success over a path that stays missing.
      await materializeWithPendingRecord(
        input,
        [
          {
            path,
            operation: "write",
            contentKind: existing.contentKind === "binary" ? "binary" : "text",
          },
        ],
        store,
      );
    }
    return path;
  }
  if (await projectionHolds(input.rootPath, path)) {
    throw new Error(`Destination already exists: ${path}`);
  }
  const changed = [
    { path, operation: "write" as const, contentKind: "text" as const },
  ];
  await markMutateMaterializeAndClear(
    input,
    { paths: [path], changed },
    store,
    async () => {
      await mutateWithOwner(input, () =>
        store.writeTextFile({
        workspaceId: input.workspaceId,
        versionId: main.id,
        path,
        text: input.initialText,
        metadata: { origin: "local-file" },
        }),
      );
    },
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
async function applyShareViewPathMove(
  input: ShareViewFileChangeScope & { fromPath: string; toPath: string },
): Promise<string> {
  const from = requireValidPath(
    validateUserWritePath(input.fromPath),
    "move source",
    input.fromPath,
  );
  const to = requireValidPath(
    validateUserMaterializePath(input.toPath, { platform: process.platform }),
    "move destination",
    input.toPath,
  );
  if (to === from || to.startsWith(`${from}/`)) {
    throw new Error(`Cannot move a path into itself: ${input.fromPath}`);
  }
  const store = input.shareViewStore();
  const main = await store.ensureMainVersion({
    workspaceId: input.workspaceId,
  });
  const held = await shareViewPaths(store, input.workspaceId, main.id);
  const sources = pathsUnder(held, from);
  if (sources.length === 0) {
    throw new Error(notInThisShareView(from, "Rename"));
  }
  const { renamesInPlace } = await preflightProjectionMoveIdentity(
    input,
    from,
    to,
  );
  await refuseNonFileReplacement(input, from, "Rename", held, sources);
  await refuseUntrackedUnder(input.rootPath, from, held);
  // The DESTINATION is screened too. A folder move merges into whatever is
  // already there, and the ordinary `movePath` refuses that outright; the files
  // the store holds are checked one by one below, so what is left to ask is
  // whether the destination holds anything the store does not. Skipped when the
  // two are the same entry, which is what a case-only rename is.
  if (!renamesInPlace) await refuseUntrackedUnder(input.rootPath, to, held);
  if (!renamesInPlace && pathsUnder(held, to).length > 0) {
    throw new Error(`Destination already exists: ${to}`);
  }
  const moves = sources.map((path) => ({
    from: path,
    to: path === from ? to : `${to}/${path.slice(from.length + 1)}`,
  }));
  // Every destination, before any of them is applied. A collision found half
  // way through would otherwise leave the files before it already moved.
  for (const move of moves) {
    if (held.has(move.to) || (!renamesInPlace && (await projectionHolds(input.rootPath, move.to)))) {
      throw new Error(`Destination already exists: ${move.to}`);
    }
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
  // Unless the source and the destination are the same folder, which is what a
  // case-only folder rename is. Removing it there removes the files this rename
  // just wrote into it.
  if (!held.has(from) && !renamesInPlace) {
    changed.push({ path: from, operation: "delete", contentKind: "text" });
  }
  const paths = changed.map((change) => change.path);
  await markMutateMaterializeAndClear(
    input,
    { paths, changed },
    store,
    async () => {
      try {
        for (const move of moves) {
          await mutateWithOwner(input, () =>
            store.renameTextFile({
            workspaceId: input.workspaceId,
            versionId: main.id,
            fromPath: move.from,
            toPath: move.to,
            metadata: { origin: "local-file" },
            }),
          );
        }
        // Rewriting the files through their new paths does not change an
        // existing directory entry's spelling on a case-insensitive disk.
        // Rename that entry while the pending record is still held; a refusal
        // enters the same store-compensation branch as a failed file rename.
        if (renamesInPlace && !held.has(from)) {
          await mutateWithOwner(input, () =>
            movePath(input.rootPath, from, to),
          );
        }
      } catch (error) {
        // A transport failure does not prove whether the current rename
        // landed. Compensating would issue a second mutation against an
        // unknown state and can move the wrong file. Leave every marker for
        // reconciliation and report the operation as indeterminate above.
        if (isEngineTransportFailure(error)) throw error;
        const current = await shareViewPaths(
          store,
          input.workspaceId,
          main.id,
        ).catch(() => null);
        if (current === null) throw error;
        const landed = moves.filter(
          (move) => !current.has(move.from) && current.has(move.to),
        );
        const accountedFor = moves.every(
          (move) =>
            (current.has(move.from) && !current.has(move.to)) ||
            (!current.has(move.from) && current.has(move.to)),
        );
        if (!accountedFor) throw error;
        await putBackMoves(input, store, main.id, landed);
        // The store is back where it started, and materialization has not run.
        // These markers no longer describe work that needs recovery.
        await input.projection.clearPending(input.rootPath, paths);
        throw error;
      }
    },
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
  input: Pick<
    ShareViewFileChangeScope,
    "owner" | "rootPath" | "workspaceId"
  >,
  store: CaptureVersionedTextStore,
  versionId: string,
  applied: readonly { from: string; to: string }[],
): Promise<void> {
  const stranded: { from: string; to: string }[] = [];
  let firstFailure: unknown = null;
  for (const move of [...applied].reverse()) {
    try {
      await mutateWithOwner(input, () =>
        store.renameTextFile({
        workspaceId: input.workspaceId,
        versionId,
        fromPath: move.to,
        toPath: move.from,
        metadata: { origin: "local-file" },
        }),
      );
    } catch (cause) {
      // Every reversal is attempted. Abandoning the list at the first failure
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
async function applyShareViewPathDelete(
  input: ShareViewFileChangeScope & { relativePath: string },
): Promise<{ trashed: boolean }> {
  const target = requireValidPath(
    validateUserWritePath(input.relativePath),
    "delete path",
    input.relativePath,
  );
  const store = input.shareViewStore();
  const main = await store.ensureMainVersion({
    workspaceId: input.workspaceId,
  });
  const held = await shareViewPaths(store, input.workspaceId, main.id);
  const targets = pathsUnder(held, target);
  if (targets.length === 0) {
    throw new Error(notInThisShareView(target, "Delete"));
  }
  await refuseNonFileReplacement(input, target, "Delete", held, targets);
  await refuseUntrackedUnder(input.rootPath, target, held);

  const changed = [
    {
      path: target,
      operation: "delete" as const,
      contentKind: "text" as const,
    },
  ];
  await markMutateMaterializeAndClear(
    input,
    { paths: targets, changed },
    store,
    async () => {
      const applied: string[] = [];
      try {
        for (const path of targets) {
          await mutateWithOwner(input, () =>
            store.deleteTextFile({
            workspaceId: input.workspaceId,
            versionId: main.id,
            path,
            metadata: { origin: "local-file" },
            }),
          );
          applied.push(path);
        }
      } catch (error) {
        // A delete cannot be put back, so the other rule applies: what happened is
        // visible. The projection follows the store for the files that actually
        // went, so nothing is left describing content the store no longer has.
        await materializeWithPendingRecord(
          input,
          applied.map((path) => ({
            path,
            operation: "delete" as const,
            contentKind: "text" as const,
          })),
          store,
        );
        throw error;
      }
    },
  );
  return { trashed: false };
}

/**
 * An import into a share view: the bytes become moments, and the projection
 * follows.
 *
 * Everything the ordinary import decides is decided the same way — the same
 * drag-in screen, the same destination rule, the same collision ladder, the
 * same skip reasons. What differs is the destination: content the engine
 * cannot own is refused here, before anything lands, rather than copied to
 * disk and left there as a file no moment states.
 */
async function applyShareViewFileImport(
  input: ShareViewFileChangeScope & {
    absolutePaths: string[];
    screenAgainstRoots: string[] | null;
    targetDir: string | undefined;
  },
): Promise<ImportCopyOutcome> {
  const store = input.shareViewStore();
  const main = await store.ensureMainVersion({
    workspaceId: input.workspaceId,
  });
  const held = await shareViewPaths(store, input.workspaceId, main.id);
  await repairMissingCanonicalImportFolder(input, input.targetDir, held, store);
  const { absDir, relDir } = await resolveImportDestination(
    input.rootPath,
    input.targetDir,
  );
  const screened =
    input.screenAgainstRoots === null
      ? { usable: input.absolutePaths, skips: new ImportSkips() }
      : await screenDroppedPaths(input.absolutePaths, input.screenAgainstRoots, relDir);
  const skips = screened.skips;
  const landedPath = (path: string) => (relDir === "" ? path : `${relDir}/${path}`);
  // Names already occupied, on both sides. The store is what a change is made
  // of; the projection can also hold a file the recipient put there by hand,
  // and the disk copy this replaces would never have overwritten it.
  //
  // The projection half is a FILESYSTEM probe, not a set of `readdir` strings:
  // where the filesystem folds case, `Note.md` and `note.md` are one file, and
  // a string set says the name is free right before the write destroys it. The
  // ordinary import is safe here because COPYFILE_EXCL asks the filesystem the
  // same question; this asks it too.
  //
  // Store-held names can also have no projection to probe, so use the same
  // conservative case fold as `claimed` below.
  // A held file deeper down takes its top folder's name here, so a dropped
  // folder named like it lands beside it, never inside it.
  const heldInDir = new Set<string>(
    [...held.keys()]
      .filter((path) => relDir === "" || path.startsWith(`${relDir}/`))
      .map((path) =>
        (relDir === "" ? path : path.slice(relDir.length + 1)).split("/")[0]!.toLowerCase(),
      ),
  );
  // Names claimed EARLIER IN THIS RUN have nothing on disk to probe yet, so
  // they are compared case-folded: the conservative direction, and the only one
  // available before the projection is written.
  const claimed = new Set<string>();
  const nameTaken = async (candidate: string): Promise<boolean> =>
    heldInDir.has(candidate.toLowerCase()) ||
    claimed.has(candidate.toLowerCase()) ||
    (await projectionHolds(input.rootPath, landedPath(candidate)));

  // Every source whose name lands as it is spelled. The store holds files,
  // not folders, so a folder lands through the files in it, and one with no
  // file in it is skipped.
  const planned: { source: ImportSource; name: string }[] = [];
  for (const source of screened.usable) {
    const name = basename(typeof source === "string" ? source : source.source);
    const files = typeof source === "string" || source.entries === null
      || source.entries.some((entry) => !entry.folder);
    const unusable = nameSkip(landedPath(name)) ?? (files ? null : "no-files");
    if (unusable !== null) {
      skips.add(name, unusable);
      continue;
    }
    planned.push({ source, name });
  }
  // Each source claims its final name, in drop order, before anything is
  // written, so the grant below decides the paths that will land. A file is
  // read first, so one the engine cannot own claims no collision variant.
  const landings: { source: ImportSource; name: string }[] = [];
  for (const { source, name: wanted } of planned) {
    if (!isFolderSource(source)) {
      const content = await readSourceContent(source, landedPath(wanted));
      if (!isOwnable(content)) {
        skips.add(wanted, contentSkip(content, wanted));
        continue;
      }
    }
    const name = await importNameFor(wanted, absDir, nameTaken);
    if (name === null) {
      skips.add(wanted, "taken");
      continue;
    }
    claimed.add(name.toLowerCase());
    landings.push({ source, name });
  }
  // The grant decides every file before the first write, so a file it
  // refuses, such as a .env, stops the import before anything lands, and the
  // refusal names that file.
  for (const { source, name } of landings) {
    const paths = isFolderSource(source)
      ? source.entries.filter((entry) => !entry.folder).map((entry) => `${name}/${entry.path}`)
      : [name];
    for (const path of paths) input.assertPathAllowed?.(landedPath(path));
  }

  const imported: string[] = [];
  const changed: ShareViewChangedPath[] = [];
  // A skip names what the person dropped, not the collision name it claimed.
  const wantedName = new Map(planned.map(({ source, name }) => [source, name]));
  const write = async (name: string, content: OwnableContent) => {
    const path = landedPath(name);
    input.assertPathAllowed?.(path);
    await input.projection.markPending(input.rootPath, [path]);
    await input.projection.writeStoreContent({
      store,
      workspaceId: input.workspaceId,
      versionId: main.id,
      path,
      content,
    });
    imported.push(path);
    changed.push({ path, operation: "write", contentKind: content.kind });
  };
  try {
    for (const { source, name } of landings) {
      if (!isFolderSource(source)) {
        // Read again: the first read only decided whether the file claims a
        // name, and holding every dropped file's bytes would cost memory.
        const content = await readSourceContent(source, landedPath(name));
        if (!isOwnable(content)) {
          skips.add(wantedName.get(source) ?? name, contentSkip(content, name));
          continue;
        }
        await write(name, content);
        continue;
      }
      await verifyDroppedFolder(source.source, source.identity);
      for (const entry of source.entries) {
        const from = join(source.source, entry.path);
        // A folder is checked before the files below it are read.
        if (entry.folder) {
          await verifyDroppedFolder(from, entry.identity);
          continue;
        }
        const path = `${name}/${entry.path}`;
        const content = await readDroppedContent(from, entry.identity, landedPath(path), droppedEntryParent(source, entry));
        if (!isOwnable(content)) {
          skips.add(`${wantedName.get(source) ?? name}/${entry.path}`, contentSkip(content, path));
          continue;
        }
        await write(path, content);
      }
    }
  } finally {
    // What landed is materialized even when a later source fails, so the
    // projection never lags the store.
    await input.projection.materialize(
      input.rootPath,
      input.workspaceId,
      changed,
      store,
    );
    await input.projection.clearPending(
      input.rootPath,
      changed.map((change) => change.path),
    );
  }
  return { imported, ...skips.outcome() };
}

type OwnableContent = Extract<DiskTextState, { kind: "text" | "binary" }>;

function isOwnable(content: DiskTextState): content is OwnableContent {
  return content.kind === "text" || content.kind === "binary";
}

// Why the engine cannot own a file's content. Text that is not UTF-8 counts
// against the limit for other files, so only a drawing is refused for its
// bytes alone.
function contentSkip(content: Exclude<DiskTextState, OwnableContent>, path: string): ImportSkipReason {
  switch (content.kind) {
    case "absent":
    case "unreadable":
      return "unreadable";
    case "untracked-content":
      switch (content.reason) {
        case "oversized-text": return "too-large-text";
        case "oversized-binary": return "too-large";
        case "non-file": return "not-a-file";
        case "non-utf8": return liveDocumentKindForPath(path) === "scene" ? "unreadable" : "too-large";
      }
  }
}

function isFolderSource(source: ImportSource): source is DroppedSource & { entries: DroppedEntry[] } {
  return typeof source !== "string" && source.entries !== null;
}

function readSourceContent(source: string | DroppedSource, landing: string): Promise<DiskTextState> {
  return typeof source === "string"
    ? readDiskContent(source)
    : readDroppedContent(source.source, source.identity, landing, undefined);
}

// A dropped file's content, read from the handle its identity check opened
// and classified by the path it lands at, as capture classifies it. A file
// that changed stops the import. A file that cannot be read is skipped, as
// the path reader skips it.
async function readDroppedContent(
  path: string,
  identity: FsEntryIdentity,
  landing: string,
  parent: DroppedFolderCheck | undefined,
): Promise<DiskTextState> {
  let handle: FileHandle;
  try {
    handle = await openDroppedFile(path, identity, parent);
  } catch (error) {
    return unreadOrThrow(error);
  }
  try {
    return await readOpenedDiskContent(handle, landing);
  } catch (error) {
    return unreadOrThrow(error);
  } finally {
    await handle.close();
  }
}

function unreadOrThrow(error: unknown): DiskTextState {
  if (error instanceof ImportPathChangedError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" ? { kind: "absent" } : { kind: "unreadable" };
}

/**
 * The explorer can still name a canonical folder after its projection was
 * removed outside dohc. Restore that folder before the ordinary import guard
 * requires it to exist on disk. A file, link, or unreadable component is not
 * repaired here; the destination guard keeps refusing those shapes.
 */
async function repairMissingCanonicalImportFolder(
  input: ShareViewFileChangeScope,
  targetDir: string | undefined,
  held: ReadonlyMap<string, "text" | "binary">,
  store: CaptureVersionedTextStore,
): Promise<void> {
  if (targetDir === undefined || targetDir === "") return;
  const validated = validateUserMaterializePath(targetDir, { platform: process.platform });
  if (!validated.ok) return;
  const folder = validated.normalized;
  const canonicalFiles = [...held.entries()].filter(([path]) =>
    path.startsWith(`${folder}/`),
  );
  if (
    canonicalFiles.length === 0 ||
    !(await projectionFolderIsMissing(input.rootPath, folder))
  ) {
    return;
  }
  await materializeWithPendingRecord(
    input,
    canonicalFiles.map(([path, contentKind]) => ({
      path,
      operation: "write",
      contentKind,
    })),
    store,
  );
}

/** Missing, rather than replaced by a file or routed through a symlink. */
async function projectionFolderIsMissing(
  rootPath: string,
  folder: string,
): Promise<boolean> {
  let current = rootPath;
  for (const segment of folder.split("/")) {
    current = join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  return false;
}

/**
 * The store paths this operation is about: the path itself when it names a
 * file, every path beneath it when it names a folder.
 *
 * Sorted, because a folder's files are applied in order and put back in the
 * reverse of it.
 */
function pathsUnder(
  held: ReadonlyMap<string, unknown>,
  target: string,
): string[] {
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
 * Refuse when the operation's own path — or a FILE the store holds under it —
 * now names something else on disk.
 *
 * Something outside dohc replaced it after the projection last matched the
 * store. `materializeSharedViewPaths` removes whatever sits at a target path
 * recursively, so a rename or delete that mutated the store over one of
 * these paths would delete a directory — and everything in it — that the
 * store never described. The refresh side already refuses this under the
 * same reason; this asks the same question, of the same disk entry,
 * before either operation is allowed to touch the store at all.
 *
 * Two shapes, because a folder is checked differently from the files under
 * it. A store leaf must be a FILE: the store never held a folder, so
 * anything else there replaced one. The operation's own path, when it is not
 * itself a leaf, must be a real DIRECTORY: a symlink standing in for it would
 * route every leaf lstat below through the link — those resolve the same
 * ancestor chain materialization does — and land this whole refusal on the
 * files at wherever the link points, not the ones the store lost.
 */
async function refuseNonFileReplacement(
  input: ShareViewFileChangeScope,
  operationPath: string,
  action: "Rename" | "Delete",
  held: ReadonlyMap<string, unknown>,
  leaves: readonly string[],
): Promise<void> {
  const messages: string[] = [];
  // The operation's own path, checked separately from the leaves below: a
  // share view has no tracked FOLDER for `unjournalablePathMessages`'s
  // file-flavored copy to name, so this states the folder in its own words
  // rather than telling the reader to "restore the file" a share view never
  // held.
  if (!held.has(operationPath)) {
    const entry = await nonFileReplacementEntry(input, operationPath);
    if (entry !== null && !entry.isDirectory()) {
      messages.push(
        `${operationPath} replaces this shared folder with a link or another entry. ` +
          `Restore the folder or move the conflicting entry.`,
      );
    }
  }
  const replacedLeaves: UnjournalablePath[] = [];
  for (const path of leaves) {
    const entry = await nonFileReplacementEntry(input, path);
    if (entry !== null && !entry.isFile()) {
      replacedLeaves.push({ path, reason: "non-file-replacement" });
    }
  }
  if (replacedLeaves.length > 0) {
    messages.push(...unjournalablePathMessages(replacedLeaves));
  }
  if (messages.length > 0) {
    throw new Error(
      `dohc did not ${action.toLowerCase()} ${operationPath}. ${messages.join(" ")}`,
    );
  }
}

/**
 * The disk entry at a tracked path, resolved the same way
 * `materializeSharedViewPaths` resolves it: `resolvedShareViewTarget` follows
 * every ancestor symlink and holds back only the leaf itself. Guard and
 * action then always agree on where a path leads, so an ancestor symlink
 * can never make this check pass an entry that materialization then reaches
 * by a different route.
 */
async function nonFileReplacementEntry(
  input: ShareViewFileChangeScope,
  path: string,
): Promise<Stats | null> {
  const resolvedAbsolute = await input.projection.resolvedTarget(
    input.rootPath,
    path,
  );
  try {
    return await lstat(resolvedAbsolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
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
    }).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      throw error;
    });
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
async function projectionHolds(
  rootPath: string,
  path: string,
): Promise<boolean> {
  return lstat(join(rootPath, path)).then(
    () => true,
    () => false,
  );
}

/**
 * Resolve one physical identity snapshot for the whole top-level move.
 *
 * Relative path spelling cannot answer this on a case-insensitive filesystem
 * or through an in-workspace alias. Both entries resolve through the same
 * projection boundary materialization uses. The source must still exist:
 * without it, a later recursive source cleanup could remove a newly
 * materialized case alias. The destination may be absent, because its resolved
 * target still carries the canonical existing ancestor and unresolved tail.
 */
async function preflightProjectionMoveIdentity(
  input: ShareViewFileChangeScope,
  from: string,
  to: string,
): Promise<{ renamesInPlace: boolean }> {
  const sourceTarget = await input.projection.resolvedTarget(
    input.rootPath,
    from,
  );
  try {
    await realpath(sourceTarget);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(
        `dohc did not rename ${from}. The file or folder is missing from this shared view. Refresh the shared view and try again.`,
      );
    }
    throw error;
  }
  const identityUnavailable = () => new Error(
    `dohc did not rename ${from} to ${to}. dohc could not tell which files or folders on disk they are. Check both paths in your file manager before trying again.`,
  );
  const source = await diskSpelling(input.rootPath, sourceTarget).catch(() => null);
  if (source === null) throw identityUnavailable();

  const destinationTarget = await input.projection.resolvedTarget(
    input.rootPath,
    to,
  );
  let ancestor = destinationTarget;
  const missing: string[] = [];
  for (;;) {
    try {
      await realpath(ancestor);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw identityUnavailable();
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  // resolvedTarget resolves links in the existing ancestors, but Linux can
  // keep their lookup case. Only the missing tail keeps its given spelling.
  const storedAncestor = await diskSpelling(input.rootPath, ancestor).catch(() => null);
  if (storedAncestor === null) throw identityUnavailable();
  const destination = join(storedAncestor, ...missing);
  const renamesInPlace = source === destination;
  if (!renamesInPlace && isInside(source, destination)) {
    throw new Error(`Cannot move a path into itself: ${from}`);
  }
  return { renamesInPlace };
}

/** Every path the share view's store holds, with the kind its projection needs. */
async function shareViewPaths(
  store: CaptureVersionedTextStore,
  workspaceId: string,
  versionId: string,
): Promise<Map<string, "text" | "binary">> {
  const snapshots = await store.listTextFileMetadata({
    workspaceId,
    versionId,
  });
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
