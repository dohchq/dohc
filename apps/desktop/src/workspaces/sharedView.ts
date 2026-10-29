import { errorMessage } from "./workspaceError";
import { createHash } from "node:crypto";
import { atomicReplaceFile } from "../atomicReplaceFile";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import { pathCollisionKey } from "@dohc/workspace-contracts/path-floor";
import { readOwnedFile } from "@dohc/workspace-core/owned-file";
import { isInside } from "../security/pathContainment";
import { existingAncestor } from "./workspaceFiles";
import { absentAsNull, diskSpelling, lookAlikeSpelling } from "./diskSpelling";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";
import {
  ShareUnavailableError,
  RelayUnauthorizedError,
  type PullShareViewResult,
  type ShareViewChangedPath,
  type ShareViewRefusal,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import { shareViewTakesLocalWrites } from "./shareWriteGate";
import type { ShareViewSelector } from "./shareViewInfo";
import {
  type WorkspaceOperationLease,
  withExclusiveWorkspaceOperation,
  withOrderedWorkspaceTargetPath,
  withOrderedWorkspaceTargetPathInLease,
} from "./workspaceAssets";
import { readDiskContent, type DiskTextState } from "./workspaceEngineCapture";
import type {
  CaptureTextFileMetadata,
  CaptureVersionedTextStore,
} from "./workspaceEngineCaptureLiveStore";
import {
  assertActiveShareViewFilesOwner,
  type ShareViewFilesOwnerCapability,
  withActiveShareViewFilesOwnerOperation,
} from "./shareViewFilesOwner";
import {
  recordedShareSelector,
  SharePinInvalidError,
  unjournalablePathMessages,
  type UnjournalablePath,
} from "./shareViewRecords";
import {
  localStateFolder,
  LocalStateFolderError,
  LocalStateUnavailableError,
  readOwnedLocalStateFolder,
  type LocalStateWorkspace,
} from "./workspaceLocalState";

// The receive side of a relay share: a shared view is a local
// engine store fed exclusively by the share's filtered op log — no watcher,
// no capture, no push. This module owns the pull + disk materialization the
// openSharedView/refreshSharedView IPC handlers drive.

export type SharedViewRefreshStatus = "updated" | "unchanged" | "ended";

export interface RefreshSharedViewOutcome {
  status: SharedViewRefreshStatus;
  changedPaths: number;
  excludedPaths: string[];
  unjournalablePaths: UnjournalablePath[];
  collisionRecordQuarantined?: boolean;
  // Ops the pull refused. The pull skips them and keeps going, so without
  // this the view silently stops carrying part of what the granter shares.
  refusedOps: number;
  // The first refusal's message, for the UI. It names the constraint the op
  // broke; the whole list goes to the log.
  refusedDetail: string | null;
}

export type StandaloneShareViewRefreshOutcome =
  | ({
      ok: true;
      collisionRecordQuarantined: boolean;
    } & RefreshSharedViewOutcome)
  | { ok: false; changedPaths: number; errorMessage: string; errorKind?: "unauthorized" };

export interface CaptureSharedViewLocalDivergenceOutcome {
  capturedPaths: number;
  repairedPaths: number;
  unjournalablePaths: UnjournalablePath[];
  collisionRecordQuarantined: boolean;
  failedPaths?: string[];
  remainingPreservedPaths?: string[];
}

// Capture failing mid-pass still leaves whatever it fixed before the throw —
// the pending marker for the one unreadable path survives (capture's
// pending branch fails closed rather than guessing, per #867), but the
// repairs or edits capture already applied to every entry visited before it
// are real and already durable. This carries those counts on the error so a
// caller can account for the work completed before capture failed instead of
// treating the whole pass as though it changed nothing.
class CapturePartialFailureError extends Error {
  constructor(
    readonly capturedPaths: number,
    readonly repairedPaths: number,
    readonly path: string,
    readonly reason: "unreadable" | "other",
    options: { cause: unknown },
  ) {
    super(
      options.cause instanceof Error
        ? options.cause.message
        : String(options.cause),
      options,
    );
    this.name = "CapturePartialFailureError";
  }
}

// A failure while resolving or inspecting the target before a mutation runs.
// This keeps path access failures distinct from failures inside the store.
class SharedViewTargetAccessError extends Error {
  constructor(options: { cause: unknown }) {
    super(
      options.cause instanceof Error
        ? options.cause.message
        : String(options.cause),
      options,
    );
    this.name = "SharedViewTargetAccessError";
  }
}

function standaloneShareViewFailureOutcome(
  error: unknown,
  changedPaths: number,
): Extract<StandaloneShareViewRefreshOutcome, { ok: false }> {
  // A damaged pin never heals on retry. Main turns this into a specific
  // "record is damaged" message, so keep it as a rejection.
  if (error instanceof SharePinInvalidError) throw error;
  if (error instanceof CapturePartialFailureError) {
    return {
      ok: false,
      changedPaths: error.capturedPaths + error.repairedPaths,
      errorMessage:
        error.reason === "unreadable"
          ? (unjournalablePathMessages([
              { path: error.path, reason: "unreadable" },
            ])[0] ?? error.message)
          : error.message,
    };
  }
  return {
    ok: false,
    changedPaths,
    errorMessage: errorMessage(error),
    ...(error instanceof RelayUnauthorizedError ? { errorKind: "unauthorized" as const } : {}),
  };
}

// Containment before any disk write: the engine already restricts paths to
// validated workspace-relative ones, but a defense layer this close to
// fs writes is cheap and permanent.
function containedTarget(rootDir: string, relativePath: string): string {
  const target = resolve(rootDir, relativePath);
  const root = resolve(rootDir);
  if (!isInside(root, target)) {
    throw new Error(`Shared view path escapes the workspace: ${relativePath}`);
  }
  return target;
}

// A read-only projection may safely discard structural tampering because its
// canonical bytes live in the store. Remove links as links, and remove only
// non-directory ancestors; leave ordinary leaf files for collision handling.
async function healTamperedProjectionPath(
  realRoot: string,
  relativePath: string,
): Promise<void> {
  if (classifyEngineFilePath(relativePath).kind !== "tracked") return;
  const containedRoot = resolve(realRoot);
  let current = realRoot;
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]!);
    if (!isInside(containedRoot, current)) return;
    const stat = await lstat(current).catch(() => null);
    if (stat === null) return;
    if (stat.isSymbolicLink()) {
      await rm(current, { force: true });
      return;
    }
    const isAncestor = index < segments.length - 1;
    if (isAncestor && !stat.isDirectory()) {
      await rm(current, { recursive: true, force: true });
      return;
    }
  }
}

// Exported so a caller that must ask "what is at this path?" Before it acts
// resolves it exactly the way materialization itself will — an ancestor
// symlink can then never make a guard look at one entry while the write or
// removal that follows touches another. ShareViewFiles' in-app rename and
// delete primitives are those callers.
export async function resolvedShareViewTarget(
  rootDir: string,
  relativePath: string,
): Promise<string> {
  const { resolvedAbsolute } = await assertResolvedWorkspacePath({
    rootPath: rootDir,
    absolutePath: containedTarget(rootDir, relativePath),
    spelled: relativePath,
    label: "Shared view path",
    access: "entry",
  });
  return resolvedAbsolute;
}

// Every store mutation inside captureSharedViewLocalDivergence must run through
// this helper. There is no other correct way to mutate the store from here —
// a branch added later that calls store.deleteTextFile / writeDiskContentToStore
// / materializeSharedViewPaths directly, outside this helper, reintroduces the
// exact race this function exists to close (see the round-14 fix for the
// scanned-deletion branch, which used to skip locking entirely).
async function withCaptureMutationLock<T>(
  rootDir: string,
  path: string,
  workspaceLease: WorkspaceOperationLease | undefined,
  operation: (resolvedTarget: string) => Promise<T>,
): Promise<T> {
  let resolvedTarget: string;
  try {
    resolvedTarget = await resolvedShareViewTarget(rootDir, path);
  } catch (error) {
    throw new SharedViewTargetAccessError({ cause: error });
  }
  const run = () => operation(resolvedTarget);
  return workspaceLease === undefined
    ? withOrderedWorkspaceTargetPath(rootDir, resolvedTarget, run)
    : withOrderedWorkspaceTargetPathInLease(
        rootDir,
        workspaceLease,
        resolvedTarget,
        run,
      );
}

// Whether the disk might reach `path`'s file through another spelling, as the
// engine's `reaches_other_spelling` decides. A path with other than ASCII
// characters can differ in Unicode case or normalization, which this can't
// test, so it counts. An ASCII segment has two other spellings: its letters in
// the other case, and its `;`, `` ` `` and `K` as the only other characters
// Unicode normalizes to them. A disk that keeps every spelling apart needs no
// owner lookup.
async function reachesOtherSpelling(rootDir: string, path: string): Promise<boolean> {
  if (!/^[\x00-\x7f]*$/u.test(path)) return true;
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    const swapped = [...segment].map((c) => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()).join("");
    const composed = lookAlikeSpelling(segment);
    for (const spelling of [swapped, composed]) {
      if (spelling === segment) continue;
      const probe = [...segments.slice(0, index), spelling, ...segments.slice(index + 1)];
      if (await lstat(join(rootDir, ...probe)).then(() => true, () => false)) return true;
    }
  }
  return false;
}

// Live paths by how a disk that ignores case or Unicode normalization names
// them, so each key lists the spellings that can reach one file.
function spellingGroups(paths: Iterable<string>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const key = pathCollisionKey(path);
    const group = groups.get(key);
    if (group) group.push(path);
    else groups.set(key, [path]);
  }
  return groups;
}

// The first other spelling in `spellings` that `owns` accepts, by path, whose
// regular file is the one at `target`, as `Notes.md` reaches `notes.md`'s
// file on a disk that ignores case. The disk decides, so a folder that keeps
// case apart holds two files. Unknown identities stop materialization and
// exclude paths from capture; collision checks keep them as local collisions.
async function spellingSharingFile(
  rootDir: string,
  path: string,
  target: string,
  spellings: ReadonlyMap<string, readonly string[]>,
  owns: (other: string) => boolean = () => true,
): Promise<string | null> {
  const others = (spellings.get(pathCollisionKey(path)) ?? []).filter((other) => other !== path && owns(other)).sort();
  if (others.length === 0) return null;
  const file = await lstat(target, { bigint: true }).catch(absentAsNull);
  if (!file?.isFile()) return null;
  const realFile = await realpath(target).catch(absentAsNull);
  if (realFile === null) return null;
  let storedFile: Promise<string | null> | undefined;
  for (const other of others) {
    const otherTarget = containedTarget(rootDir, other);
    const otherFile = await lstat(otherTarget, { bigint: true }).catch(absentAsNull);
    if (!otherFile?.isFile()) continue;
    const realOther = await realpath(otherTarget).catch(absentAsNull);
    if (realOther === null) continue;
    if (realFile === realOther) return other;
    // Only Linux realpath keeps lookup case; elsewhere the realpath check above decides.
    if (process.platform === "linux" && basename(target) === basename(otherTarget)
      && file.dev === otherFile.dev && file.ino === otherFile.ino && file.ctimeNs === otherFile.ctimeNs) {
      const [parent, otherParent] = await Promise.all([
        stat(dirname(target), { bigint: true }).catch(absentAsNull),
        stat(dirname(otherTarget), { bigint: true }).catch(absentAsNull),
      ]);
      if (parent !== null && otherParent !== null && parent.ino !== 0n && parent.dev === otherParent.dev && parent.ino === otherParent.ino) return other;
    }
    storedFile ??= diskSpelling(rootDir, target);
    const [stored, storedOther] = await Promise.all([
      storedFile,
      diskSpelling(rootDir, otherTarget),
    ]);
    if (stored !== null && stored === storedOther) return other;
  }
  return null;
}

// `protectedPaths` are the paths this refresh or capture keeps its hands off,
// such as preserved paths and ones whose capture failed. Answers the deletes
// it left undone because a protected path owns their file, whose debt stays,
// and the spellings it gave a deleted spelling's file to.
async function materializeSharedViewPaths(
  rootDir: string,
  workspaceId: string,
  changedPaths: readonly ShareViewChangedPath[],
  store: CaptureVersionedTextStore,
  protectedPaths: ReadonlySet<string> = new Set(),
): Promise<{ kept: string[]; owners: string[] }> {
  const kept: string[] = [];
  const owners: string[] = [];
  if (changedPaths.length === 0) return { kept, owners };
  const realRoot = await realpath(rootDir);
  // Real containment for the write, not just the lexical check above: a
  // symlink planted inside the materialized tree (a linked directory or a
  // link at the target path) must never redirect relay-controlled bytes
  // outside the root. The parent is realpath-verified after mkdir, and the
  // target itself is removed then recreated exclusively so a final-component
  // link is deleted, never followed.
  async function preparedTarget(target: string): Promise<string> {
    // Containment before mkdir, not just after: a planted directory symlink
    // on the write path would otherwise have recursive mkdir create real
    // directories outside the projection before the post-check throws. The
    // deepest existing ancestor must already be inside the root.
    const realAncestor = await realpath(
      await existingAncestor(dirname(target)),
    );
    if (!isInside(realRoot, realAncestor)) {
      throw new Error(`Shared view parent escapes the workspace: ${target}`);
    }
    await mkdir(dirname(target), { recursive: true });
    const realParent = await realpath(dirname(target));
    if (!isInside(realRoot, realParent)) {
      throw new Error(`Shared view parent escapes the workspace: ${target}`);
    }
    await rm(target, { recursive: true, force: true });
    return target;
  }
  const main = await store.ensureMainVersion({ workspaceId });
  // The view's live paths, grouped by how a disk that ignores case or Unicode
  // normalization names them. Read once, at the first delete that needs them.
  let aliases: Map<string, string[]> | undefined;
  // The first other live path, by path, that reaches the regular file at
  // `target`: that path's head owns the file, as the engine decides for
  // workspace peers (#2157). A link or folder at the target has no owner; the
  // delete repairs it.
  async function aliasOwner(path: string, target: string): Promise<string | null> {
    if (!(await lstat(target).catch(absentAsNull))?.isFile()) return null;
    if (!(await reachesOtherSpelling(rootDir, path))) return null;
    aliases ??= spellingGroups(
      (await store.listTextFileMetadata({ workspaceId, versionId: main.id })).map((file) => file.path),
    );
    return spellingSharingFile(rootDir, path, target, aliases);
  }
  // Nothing when `target` already holds `owner`'s head under `owner`'s
  // spelling; otherwise the write of that head that replaces the file.
  async function ownerWrite(owner: string, target: string): Promise<ShareViewChangedPath | null> {
    const head = await store.readTextFile({ workspaceId, versionId: main.id, path: owner });
    if (head === null) return null;
    if (diskMatchesSnapshot(await readDiskContent(target), head)) {
      const real = await realpath(target).catch(() => null);
      if (real !== null && basename(real) === basename(owner)) return null;
      const spelling = await diskSpelling(rootDir, target).catch(() => null);
      if (spelling !== null && basename(spelling) === basename(owner)) return null;
    }
    return { path: owner, operation: "write", contentKind: head.contentKind === "binary" ? "binary" : "text" };
  }
  // Every delete before every write. On a disk that ignores case or Unicode
  // normalization, writing `notes.md` opens the `Notes.md` that a delete then
  // removes. A refresh merges its pull's pages, so the changes can arrive in
  // either order.
  const ordered = [
    ...changedPaths.filter((change) => change.operation === "delete"),
    ...changedPaths.filter((change) => change.operation !== "delete"),
  ];
  for (const change of ordered) {
    const target = containedTarget(rootDir, change.path);
    // A mount keeps its own engine store at <mount>/.dohc. Containment cannot
    // see that: an alias planted inside the projection (`docs -> .dohc`)
    // resolves inside the mount and would let relay-controlled bytes rewrite
    // the store that decides what the projection holds. The rule runs against
    // the MOUNT root, which is what `.dohc` means here.
    //
    // "entry" for both operations, because neither follows the leaf: a delete
    // is `rm`, and a write removes the target and recreates it with `wx`. So
    // the leaf is never a path this code reads or writes through, and a
    // tampered one is the thing being repaired. Following it here would refuse
    // a projected file someone replaced with a dangling, escaping, or
    // reserved-target link, and the refresh would throw before it commits its
    // cursor -- wedging every later replay on the same path instead of
    // healing it. The PARENT chain still resolves in full, so an alias into a
    // reserved area is still refused.
    //
    // The prepare, the removal, and the write all run on the resolution this
    // judged. Reusing the spelling would let a directory alias planted after
    // the check take the relay's bytes somewhere the rule never saw.
    const { resolvedAbsolute: resolvedTarget } =
      await assertResolvedWorkspacePath({
      rootPath: rootDir,
      absolutePath: target,
      spelled: change.path,
      label: "Shared view path",
      access: "entry",
    });
    if (change.operation === "delete") {
      // Deletes get the same REAL-parent containment as writes: a planted
      // directory symlink must not route the unlink outside the root. The
      // final component is safe either way — rm without `recursive`
      // removes a link as a link, never through it.
      const realParent = await realpath(dirname(resolvedTarget)).catch(
        () => null,
      );
      if (realParent === null) continue; // parent gone — nothing to delete
      if (!isInside(realRoot, realParent)) {
        throw new Error(`Shared view parent escapes the workspace: ${target}`);
      }
      // Another live spelling owns this file. The delete leaves it when it holds
      // that head, and otherwise writes that head there, under that spelling,
      // so capture never reads the deleted path's bytes as that file's (#2294).
      const owner = await aliasOwner(change.path, resolvedTarget);
      if (owner !== null) {
        // A protected owner, such as one whose local edits capture could not
        // save, keeps its file untouched. The delete keeps its debt, so a
        // capture after the owner is free settles the file.
        if (protectedPaths.has(owner)) {
          kept.push(change.path);
          continue;
        }
        const write = await ownerWrite(owner, resolvedTarget);
        if (write && !ordered.some((other) => other.path === owner && other.operation !== "delete")) ordered.push(write);
        owners.push(owner);
        continue;
      }
      // recursive: a locally tampered DIRECTORY at the target must not
      // wedge the refresh with EISDIR. Node's rm removes a symlink as a
      // link either way — it never recurses through one.
      await rm(resolvedTarget, { recursive: true, force: true });
      continue;
    }
    // Read the content before touching the projection. `preparedTarget`
    // removes the existing file, so a read that throws after it would leave a
    // hole where a good file was — and with the cursor uncommitted, every
    // later refresh would replay into the same hole.
    const content =
      change.contentKind === "binary"
        ? await store.readBinaryFile({
            workspaceId,
            versionId: main.id,
            path: change.path,
          })
        : ((
            await store.readTextFile({
              workspaceId,
              versionId: main.id,
              path: change.path,
            })
          )?.text ?? null);
    await preparedTarget(resolvedTarget);
    if (content === null) continue;
    await writeFile(
      resolvedTarget,
      content,
      typeof content === "string"
        ? { encoding: "utf8", flag: "wx" }
        : { flag: "wx" },
    );
  }
  return { kept, owners };
}

async function writeDiskContentToStore(input: {
  store: CaptureVersionedTextStore;
  workspaceId: string;
  versionId: string;
  path: string;
  content: DiskTextState & { kind: "text" | "binary" };
}): Promise<void> {
  if (input.content.kind === "text") {
    await input.store.writeTextFile({
      workspaceId: input.workspaceId,
      versionId: input.versionId,
      path: input.path,
      text: input.content.text,
      metadata: { origin: "local-file" },
    });
  } else {
    await input.store.writeBinaryFile({
      workspaceId: input.workspaceId,
      versionId: input.versionId,
      path: input.path,
      bytes: input.content.bytes,
      metadata: { origin: "local-file" },
    });
  }
}

// A shared view keeps three records of its refresh in its own
// `.dohc/local/share-refresh`, beside their temporary files and the
// `.invalid-<time>` copies of damaged ones. They describe what this computer
// did to its copy of the shared files, so they stay out of iCloud Drive. dohc
// neither reads nor moves the old copies at the top of `.dohc`, but an old
// collision record stops a refresh until the person moves it (see
// refuseOlderCollisionRecord).
//
// Only this computer's engine open makes `.dohc/local`, so every write waits
// for it, and a refused write stops the refresh or change before it touches
// the folder. A record dohc can't trust, because another user owns it or can
// change it, it has a second name, or its folder is not one only this user can
// change, never lets a refresh do more than it would with the record intact:
// - pull-in-flight.marker: anything at its name reads as a pull in flight, so
//   capture checks every tracked path. Only a missing marker means finished.
// - pending-materialization.json: reads as damaged. Capture sets it aside,
//   checks every tracked path, and deletes no file on its word.
// - share-collision-record.json: stops the refresh with nothing changed.
//   Without it, a refresh could replace the person's own files. dohc still
//   sets a damaged one aside and tells the person before the next capture.
const RECORDS_FOLDER = "share-refresh";
const PENDING_MATERIALIZATION_FILE = "pending-materialization.json";
const PULL_IN_FLIGHT_FILE = "pull-in-flight.marker";
// Refresh and Send changes both run the same capture path. Either action can
// resolve a collision and clear this record after the recipient moves its file.
const COLLISION_RECORD_FILE = "share-collision-record.json";
// Far above anything dohc writes: one path for each tracked file.
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const REFRESH_LIFECYCLE_LOCK = "refresh-lifecycle";
const NOT_UPDATED = "dohc did not update these shared files.";

/**
 * One shared view's records: the engine open of its store, whose
 * `.dohc/local` holds them, and their folder as a person finds it from the
 * workspace they opened.
 */
interface ShareViewRecords extends LocalStateWorkspace {
  readonly shown: string;
}

function shareViewRecords(
  owner: ShareViewFilesOwnerCapability,
  rootDir: string,
): ShareViewRecords {
  const resource = assertActiveShareViewFilesOwner(owner, { rootPath: rootDir });
  const view = relative(resource.schedulingRootPath, rootDir).split(sep).join("/");
  return {
    workspaceId: resource.storeWorkspaceId,
    rootPath: rootDir,
    ...(resource.attachmentId === undefined
      ? {}
      : { attachmentId: resource.attachmentId }),
    shown: posix.join(view, ".dohc", "local", RECORDS_FOLDER),
  };
}

// Where a record lives, as a lock key and in logs. Readers and writers reach
// it only through the folder checks below.
function recordPath(rootDir: string, name: string): string {
  return join(rootDir, ".dohc", "local", RECORDS_FOLDER, name);
}

function shareViewRefreshLifecycleLockKey(rootDir: string): string {
  return join(rootDir, ".dohc", REFRESH_LIFECYCLE_LOCK);
}

// The refresh lifecycle lock is always the outermost lock for a view. Per-path
// locks, the pending-materialization lock, and the collision-record lock nest
// inside it as independent lock domains. Never acquire this lock while holding
// any nested lock.
export function withShareViewRefreshLifecycleLock<T>(
  rootDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withExclusiveWorkspaceOperation(
    shareViewRefreshLifecycleLockKey(rootDir),
    operation,
  );
}

async function syncFolder(folder: string): Promise<void> {
  const dir = await open(folder, "r");
  try {
    await dir.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || code !== "EPERM") throw error;
  } finally {
    await dir.close();
  }
}

// What a refresh says when the view's open has not prepared `.dohc/local`.
const NOT_OPENED_REFUSAL = "dohc did not update these shared files because the workspace has not finished opening. Try again when it opens.";

// The records folder for a writer, made 0700 when missing.
async function recordsFolderForWrite(records: ShareViewRecords): Promise<string> {
  try {
    return await localStateFolder(records, RECORDS_FOLDER, {
      path: records.shown,
      lead: NOT_UPDATED,
    });
  } catch (error) {
    if (!(error instanceof LocalStateUnavailableError)) throw error;
    throw new LocalStateUnavailableError(
      error.refusal,
      error.refusal === "not-opened"
        ? NOT_OPENED_REFUSAL
        : `dohc did not update these shared files because it can't keep ${posix.dirname(records.shown)} out of iCloud Drive. Restart dohc to try again.`,
    );
  }
}

async function writeRecord(
  records: ShareViewRecords,
  name: string,
  content: string,
): Promise<void> {
  const folder = await recordsFolderForWrite(records);
  // Flush before publish, so a crash can't lose a record that protects work.
  await atomicReplaceFile(join(folder, name), async (temporary) => {
    // 0600 whatever the umask: the reader refuses a record others can write.
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
  await syncFolder(folder);
}

async function removeRecord(
  records: ShareViewRecords,
  name: string,
): Promise<void> {
  const folder = await recordsFolderForWrite(records);
  await rm(join(folder, name), { force: true });
  await syncFolder(folder);
}

async function quarantineRecord(
  records: ShareViewRecords,
  name: string,
  context: string,
): Promise<boolean> {
  try {
    const target = join(await recordsFolderForWrite(records), name);
    await rename(target, `${target}.invalid-${Date.now()}`);
    return true;
  } catch (quarantineError) {
    console.error(
      `[desktop] could not quarantine ${context} at ${recordPath(records.rootPath, name)}: ${String(quarantineError)}`,
    );
    return false;
  }
}

type RecordRead =
  | { readonly status: "missing" }
  | { readonly status: "read"; readonly content: string }
  | {
      readonly status: "untrusted";
      readonly place: "file" | "folder";
      readonly reason: string;
      // Set when `.dohc` or `.dohc/local` itself is the problem, in words
      // that name the way out.
      readonly words?: string;
    };

// A record only when its folders and the file are this user's alone: read
// folder-first, then on one handle that checks owner, mode and links.
// Creates nothing. Waits for the engine only on Windows, for an open under way.
async function readRecord(rootDir: string, name: string): Promise<RecordRead> {
  try {
    return await readOwnedLocalStateFolder(rootDir, RECORDS_FOLDER, (folder) => recordIn(folder, name));
  } catch (error) {
    // On Windows nothing in `.dohc/local` is read unless the view's open
    // holds it throughout, which is no reason to distrust the records.
    if (error instanceof LocalStateUnavailableError) throw new LocalStateUnavailableError(error.refusal, NOT_OPENED_REFUSAL);
    return {
      status: "untrusted",
      place: "folder",
      reason: String(error),
      ...(error instanceof LocalStateFolderError ? { words: error.message } : {}),
    };
  }
}

async function recordIn(folder: string | null | "unusable", name: string): Promise<RecordRead> {
  if (folder === null) return { status: "missing" };
  if (folder === "unusable") {
    return { status: "untrusted", place: "folder", reason: "unusable folder" };
  }
  const path = join(folder, name);
  const read = await readOwnedFile(path, MAX_RECORD_BYTES).catch(
    (error: unknown) => String(error),
  );
  if (typeof read === "string") {
    return { status: "untrusted", place: "file", reason: read };
  }
  if (read.status === "read") return read;
  if (read.status === "missing") return { status: "missing" };
  return { status: "untrusted", place: "file", reason: read.status };
}

async function writePullInFlightMarker(records: ShareViewRecords): Promise<void> {
  await writeRecord(records, PULL_IN_FLIGHT_FILE, "");
}

// With no marker there is nothing to remove, so nothing waits for the open.
async function clearPullInFlightMarker(records: ShareViewRecords): Promise<void> {
  const read = await readRecord(records.rootPath, PULL_IN_FLIGHT_FILE);
  if (read.status !== "missing") await removeRecord(records, PULL_IN_FLIGHT_FILE);
}

async function pullMayBeInFlight(rootDir: string): Promise<boolean> {
  const read = await readRecord(rootDir, PULL_IN_FLIGHT_FILE);
  if (read.status === "untrusted") {
    console.error(
      `[desktop] pull-in-flight marker at ${recordPath(rootDir, PULL_IN_FLIGHT_FILE)} can't be trusted ` +
        `(${read.reason}); verifying every tracked path.`,
    );
  }
  return read.status !== "missing";
}

export async function readPendingMaterializationPaths(
  rootDir: string,
): Promise<Set<string>> {
  return withExclusiveWorkspaceOperation(
    recordPath(rootDir, PENDING_MATERIALIZATION_FILE),
    async () => new Set(Object.keys(await readPendingFileUnlocked(rootDir))),
  );
}

async function readPendingMaterializationPathsForCapture(
  records: ShareViewRecords,
  trackedPaths: readonly string[],
): Promise<{
  paths: Set<string>;
  recordedPaths: Set<string>;
  canClearRecord: boolean;
  pullInFlight: boolean;
}> {
  const pullInFlight = await pullMayBeInFlight(records.rootPath);
  return withExclusiveWorkspaceOperation(
    recordPath(records.rootPath, PENDING_MATERIALIZATION_FILE),
    async () => {
      try {
        const recordedPaths = new Set(
          Object.keys(await readPendingFileUnlocked(records.rootPath)),
        );
        const paths = new Set(recordedPaths);
        if (pullInFlight) {
          for (const path of trackedPaths) paths.add(path);
        }
        return {
          paths,
          recordedPaths,
          canClearRecord: true,
          pullInFlight,
        };
      } catch (error) {
        console.error(
          `[desktop] pending materialization record at ${recordPath(records.rootPath, PENDING_MATERIALIZATION_FILE)} ` +
            "is unreadable; quarantining it and verifying every tracked path. Pending paths " +
            `that are no longer tracked cannot be recovered: ${String(error)}`,
        );
        const quarantined = await quarantineRecord(
          records,
          PENDING_MATERIALIZATION_FILE,
          "pending materialization record",
        );
        return {
          paths: new Set(trackedPaths),
          recordedPaths: new Set(),
          canClearRecord: quarantined,
          pullInFlight,
        };
      }
    },
  );
}

type PendingMaterializationCounts = Record<string, number>;
const INVALID_PENDING_MATERIALIZATION_RECORD =
  "Invalid pending-materialization record.";

function emptyPendingMaterializationCounts(): PendingMaterializationCounts {
  return Object.create(null) as PendingMaterializationCounts;
}

async function readPendingFileUnlocked(
  rootDir: string,
): Promise<PendingMaterializationCounts> {
  const read = await readRecord(rootDir, PENDING_MATERIALIZATION_FILE);
  if (read.status === "missing") return emptyPendingMaterializationCounts();
  // Read like a damaged record, so capture checks every tracked path.
  if (read.status === "untrusted") {
    throw new Error(
      `Untrusted pending-materialization record (${read.reason}).`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.content);
  } catch {
    throw new Error(INVALID_PENDING_MATERIALIZATION_RECORD);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !("counts" in parsed) ||
    parsed.counts === null ||
    typeof parsed.counts !== "object" ||
    Array.isArray(parsed.counts) ||
    !Object.entries(parsed.counts).every(
      ([path, count]) =>
        classifyEngineFilePath(path).kind === "tracked" &&
        typeof count === "number" &&
        Number.isInteger(count) &&
        count > 0,
    )
  ) {
    throw new Error(INVALID_PENDING_MATERIALIZATION_RECORD);
  }
  return Object.assign(
    emptyPendingMaterializationCounts(),
    parsed.counts as PendingMaterializationCounts,
  );
}

async function writePendingFileUnlocked(
  records: ShareViewRecords,
  counts: Readonly<PendingMaterializationCounts>,
): Promise<void> {
  if (Object.keys(counts).length === 0) {
    await removeRecord(records, PENDING_MATERIALIZATION_FILE);
  } else {
    // Durable before the projection changes, so a crash can't make an
    // interrupted materialization look like a user edit.
    await writeRecord(
      records,
      PENDING_MATERIALIZATION_FILE,
      JSON.stringify({ counts }),
    );
  }
}

async function writePendingMaterializationPaths(
  records: ShareViewRecords,
  paths: readonly string[],
): Promise<void> {
  await withExclusiveWorkspaceOperation(
    recordPath(records.rootPath, PENDING_MATERIALIZATION_FILE),
    async () => {
      const counts = await readPendingFileUnlocked(records.rootPath);
      for (const path of new Set(paths)) {
        counts[path] = (counts[path] ?? 0) + 1;
      }
      await writePendingFileUnlocked(records, counts);
    },
  );
}

// Clears each path's debt by one, or entirely. Writes only when a path was
// recorded, so a clear with nothing to clear waits for nothing.
async function clearPendingCounts(
  records: ShareViewRecords,
  paths: readonly string[],
  all: boolean,
): Promise<void> {
  if (paths.length === 0) return;
  await withExclusiveWorkspaceOperation(
    recordPath(records.rootPath, PENDING_MATERIALIZATION_FILE),
    async () => {
      const counts = await readPendingFileUnlocked(records.rootPath);
      let changed = false;
      for (const path of new Set(paths)) {
        const count = counts[path];
        if (count === undefined) continue;
        changed = true;
        if (all || count <= 1) {
          delete counts[path];
        } else {
          counts[path] = count - 1;
        }
      }
      if (changed) await writePendingFileUnlocked(records, counts);
    },
  );
}

function clearPendingMaterializationPaths(
  records: ShareViewRecords,
  paths: readonly string[],
): Promise<void> {
  return clearPendingCounts(records, paths, false);
}

function clearAllPendingMaterializationPaths(
  records: ShareViewRecords,
  paths: readonly string[],
): Promise<void> {
  return clearPendingCounts(records, paths, true);
}

export function shareViewFilesProjection(owner: ShareViewFilesOwnerCapability) {
  const active = <T>(
    expected: Parameters<typeof assertActiveShareViewFilesOwner>[1],
    operation: () => Promise<T>,
  ): Promise<T> =>
    withActiveShareViewFilesOwnerOperation(owner, expected ?? {}, operation);
  const records = (rootDir: string) => shareViewRecords(owner, rootDir);
  return {
    resolvedTarget: (rootDir: string, relativePath: string) =>
      active({ rootPath: rootDir }, () =>
        resolvedShareViewTarget(rootDir, relativePath),
      ),
    materialize: (
      rootDir: string,
      workspaceId: string,
      changedPaths: readonly ShareViewChangedPath[],
      store: CaptureVersionedTextStore,
    ) =>
      active({ rootPath: rootDir, storeWorkspaceId: workspaceId }, () =>
        materializeSharedViewPaths(rootDir, workspaceId, changedPaths, store),
      ),
    writeStoreContent: (input: {
      store: CaptureVersionedTextStore;
      workspaceId: string;
      versionId: string;
      path: string;
      content: DiskTextState & { kind: "text" | "binary" };
    }) =>
      active({ storeWorkspaceId: input.workspaceId }, () =>
        writeDiskContentToStore(input),
      ),
    markPending: (rootDir: string, paths: readonly string[]) =>
      active({ rootPath: rootDir }, () =>
        writePendingMaterializationPaths(records(rootDir), paths),
      ),
    clearPending: (rootDir: string, paths: readonly string[]) =>
      active({ rootPath: rootDir }, () =>
        clearPendingMaterializationPaths(records(rootDir), paths),
      ),
    clearPullInFlight: (rootDir: string) =>
      active({ rootPath: rootDir }, () =>
        clearPullInFlightMarker(records(rootDir)),
      ),
    recordCollisions: (
      rootDir: string,
      shareId: string,
      paths: readonly string[],
    ) =>
      active({ rootPath: rootDir, shareId }, () =>
        recordCollisionPaths(records(rootDir), shareId, paths),
      ),
  };
}

const INVALID_COLLISION_RECORD = "Invalid share collision record.";

// A collision record dohc can't trust or read. Unlike a damaged one, it is
// not set aside: without it a refresh could replace the person's own files.
class UntrustedCollisionRecordError extends Error {
  constructor(readonly read: Extract<RecordRead, { status: "untrusted" }>) {
    super(`Untrusted share collision record (${read.reason}).`);
    this.name = "UntrustedCollisionRecordError";
  }
}

function untrustedCollisionRecordRefusal(
  records: ShareViewRecords,
  error: UntrustedCollisionRecordError,
): Error {
  const { read } = error;
  const file = posix.join(records.shown, COLLISION_RECORD_FILE);
  const keeps = "a refresh from replacing your own files.";
  let words: string;
  if (read.words !== undefined) {
    words = `${NOT_UPDATED} ${read.words}`;
  } else if (read.place === "folder") {
    words =
      `dohc did not update these shared files because it can't trust ${records.shown}. ` +
      `Its records keep ${keeps} Make it a folder only you can change, then try again.`;
  } else if (read.reason === "linked") {
    // Changing the mode can't take away a second name.
    words =
      `dohc did not update these shared files because ${file} has a second name elsewhere. ` +
      `It keeps ${keeps} Remove the other name, or replace this file with a copy of it, then try again.`;
  } else {
    words =
      `dohc did not update these shared files because it can't trust ${file}. ` +
      `It keeps ${keeps} Make it a file only you can change, then try again.`;
  }
  return new Error(words, { cause: error });
}

// Before #2372 the collision record lived at the top of `.dohc`. A view
// updated from then may have one there still keeping a person's files apart,
// and reading no new record as "no collisions" would let the next capture
// replace them. So a view with no new record refuses while the old one is
// there. Only its presence is checked, never what it says. Remove this check
// once no view can still have the old record.
class OlderCollisionRecordError extends Error {
  constructor() {
    super("An older share collision record is still in .dohc.");
    this.name = "OlderCollisionRecordError";
  }
}

async function refuseOlderCollisionRecord(rootDir: string): Promise<void> {
  const there = await lstat(join(rootDir, ".dohc", COLLISION_RECORD_FILE)).then(
    () => true,
    (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
  );
  if (there) throw new OlderCollisionRecordError();
}

function olderCollisionRecordRefusal(
  records: ShareViewRecords,
  error: OlderCollisionRecordError,
): Error {
  const older = posix.join(
    posix.dirname(posix.dirname(records.shown)),
    COLLISION_RECORD_FILE,
  );
  return new Error(
    `dohc did not update these shared files because an older record at ${older} may be keeping your own files apart from the share. ` +
      "Move the files it lists out of the shared folder, then remove the record and try again. " +
      "Files you leave in place are no longer kept apart. A refresh may replace them or count them as your edits.",
    { cause: error },
  );
}

async function readCollisionRecordUnlocked(
  rootDir: string,
  shareId: string,
): Promise<{ shareId: string; paths: Set<string> }> {
  const read = await readRecord(rootDir, COLLISION_RECORD_FILE);
  if (read.status === "missing") {
    await refuseOlderCollisionRecord(rootDir);
    return { shareId, paths: new Set() };
  }
  if (read.status === "untrusted") throw new UntrustedCollisionRecordError(read);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.content);
  } catch {
    throw new Error(INVALID_COLLISION_RECORD);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !("shareId" in parsed) ||
    typeof parsed.shareId !== "string" ||
    parsed.shareId.length === 0 ||
    !("paths" in parsed) ||
    !Array.isArray(parsed.paths) ||
    !parsed.paths.every(
      (path): path is string =>
        typeof path === "string" &&
        classifyEngineFilePath(path).kind === "tracked",
    )
  ) {
    throw new Error(INVALID_COLLISION_RECORD);
  }
  return {
    shareId: parsed.shareId,
    paths: new Set(parsed.paths as string[]),
  };
}

async function writeCollisionRecordUnlocked(
  records: ShareViewRecords,
  shareId: string,
  paths: ReadonlySet<string>,
): Promise<void> {
  if (paths.size === 0) {
    await removeRecord(records, COLLISION_RECORD_FILE);
    return;
  }
  await writeRecord(
    records,
    COLLISION_RECORD_FILE,
    JSON.stringify({ shareId, paths: [...paths].sort() }),
  );
}

// Called while already holding the collision-record lock. Quarantines a
// corrupt or stale record and starts fresh rather than guessing which paths
// were excluded. A lost record cannot be reconstructed. Guessing at each
// path's status here would be irreversible before the recipient could see it
// happen, so the capture pass that discovers the quarantine makes no
// mutations at all. See the early return keyed on
// `collisionRecordQuarantined` in `captureSharedViewLocalDivergence`. The
// refresh completes and the caller shows a notice. What happens to a
// previously protected path begins with the next capture, after the user has
// been told. For a view or comment share, that capture repairs every diverged
// tracked path unconditionally. The projection is canonical for non-edit
// shares, as #862 established, so this overwrites a previously protected local
// file with the granter's version by design. For an edit share, that capture
// instead adopts a diverged tracked path as the recipient's edit. The bytes
// stay on disk, but the next Send changes can propose content the recipient
// did not mean to share unless they review it out first.
//
// A record dohc can't trust or read is not quarantined. It refuses, and
// changes nothing, until the person makes it trustworthy again. So does an
// older record left at the top of `.dohc`.
async function readCollisionRecordLocked(
  records: ShareViewRecords,
  shareId: string,
  onQuarantine?: () => void,
): Promise<Set<string>> {
  const target = recordPath(records.rootPath, COLLISION_RECORD_FILE);
  let record: { shareId: string; paths: Set<string> };
  try {
    record = await readCollisionRecordUnlocked(records.rootPath, shareId);
  } catch (error) {
    if (error instanceof UntrustedCollisionRecordError) {
      throw untrustedCollisionRecordRefusal(records, error);
    }
    if (error instanceof OlderCollisionRecordError) {
      throw olderCollisionRecordRefusal(records, error);
    }
    console.error(
      `[desktop] share collision record at ${target} is unreadable; quarantining it. ` +
        "A previously-excluded path will follow this share's ordinary capture " +
        `rules on the next capture: ${String(error)}`,
    );
    onQuarantine?.();
    await quarantineRecord(records, COLLISION_RECORD_FILE, "share collision record");
    return new Set<string>();
  }
  if (record.shareId !== shareId) {
    console.error(
      `[desktop] share collision record at ${target} belongs to share ` +
        `${record.shareId}, not ${shareId}; quarantining the stale record.`,
    );
    onQuarantine?.();
    await quarantineRecord(
      records,
      COLLISION_RECORD_FILE,
      "stale share collision record",
    );
    return new Set<string>();
  }
  return record.paths;
}

async function readCollisionRecordPaths(
  records: ShareViewRecords,
  shareId: string,
  onQuarantine?: () => void,
): Promise<Set<string>> {
  return withExclusiveWorkspaceOperation(
    recordPath(records.rootPath, COLLISION_RECORD_FILE),
    () => readCollisionRecordLocked(records, shareId, onQuarantine),
  );
}

async function peekCollisionRecordPaths(
  rootDir: string,
  shareId: string,
): Promise<Set<string>> {
  return withExclusiveWorkspaceOperation(
    recordPath(rootDir, COLLISION_RECORD_FILE),
    async () => {
      const record = await readCollisionRecordUnlocked(rootDir, shareId);
      if (record.shareId !== shareId) {
        throw new Error(
          `Share collision record belongs to ${record.shareId}, not ${shareId}.`,
        );
      }
      return record.paths;
    },
  );
}

// Adds or removes paths. Writes only when that changes the record, so a clear
// with nothing to clear waits for nothing.
async function mutateCollisionRecord(
  records: ShareViewRecords,
  shareId: string,
  paths: readonly string[],
  change: "add" | "delete",
): Promise<void> {
  if (paths.length === 0) return;
  await withExclusiveWorkspaceOperation(
    recordPath(records.rootPath, COLLISION_RECORD_FILE),
    async () => {
      const current = await readCollisionRecordLocked(records, shareId);
      const before = current.size;
      for (const path of paths) current[change](path);
      if (current.size !== before) {
        await writeCollisionRecordUnlocked(records, shareId, current);
      }
    },
  );
}

function recordCollisionPaths(
  records: ShareViewRecords,
  shareId: string,
  paths: readonly string[],
): Promise<void> {
  return mutateCollisionRecord(records, shareId, paths, "add");
}

function clearCollisionRecordPaths(
  records: ShareViewRecords,
  shareId: string,
  paths: readonly string[],
): Promise<void> {
  return mutateCollisionRecord(records, shareId, paths, "delete");
}

export async function readSharedViewProjectionDebt(
  rootDir: string,
  shareId: string,
): Promise<{
  pendingPaths: Set<string>;
  collisionPaths: Set<string>;
  pullInFlight: boolean;
}> {
  const [pendingPaths, collisionPaths, pullInFlight] = await Promise.all([
    readPendingMaterializationPaths(rootDir),
    peekCollisionRecordPaths(rootDir, shareId),
    pullMayBeInFlight(rootDir),
  ]);
  return { pendingPaths, collisionPaths, pullInFlight };
}

type IncomingPathState = "absent" | "file" | "non-file";

async function inspectIncomingPath(
  resolvedTarget: string,
): Promise<IncomingPathState> {
  try {
    const stat = await lstat(resolvedTarget);
    return !stat.isSymbolicLink() && stat.isFile() ? "file" : "non-file";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "absent";
    throw error;
  }
}

async function pathConfirmedAbsentOnDisk(
  resolvedTarget: string,
): Promise<boolean> {
  return (await inspectIncomingPath(resolvedTarget)) === "absent";
}

async function latestMomentForPath(
  store: CaptureVersionedTextStore,
  workspaceId: string,
  path: string,
) {
  let beforeMomentOrder: number | undefined;
  for (;;) {
    const page = await store.listMoments({
      workspaceId,
      limit: 500,
      ...(beforeMomentOrder === undefined ? {} : { beforeMomentOrder }),
    });
    const summary = page.moments.find((moment) => moment.path === path);
    if (summary) {
      return await store.getMoment({
        workspaceId,
        momentId: summary.id,
      });
    }
    if (page.nextBeforeMomentOrder === null) return null;
    beforeMomentOrder = page.nextBeforeMomentOrder;
  }
}

// The only rule this function's markers ever follow: unjournalable content is
// never resolved, so its marker must survive to protect it on the next pass.
// Everything else (captured, repaired, unchanged) is resolved, so its marker
// clears — but only if it was actually recorded, not merely swept in by a
// verify-everything pass that found nothing to clear in the first place.
async function clearCapturePendingMarker(
  records: ShareViewRecords,
  path: string,
  resultKind: "captured" | "repaired" | "unchanged" | "unjournalable",
  pendingState: {
    canClearRecord: boolean;
    recordedPaths: ReadonlySet<string>;
  },
): Promise<void> {
  if (resultKind === "unjournalable") return;
  if (!pendingState.canClearRecord) return;
  if (!pendingState.recordedPaths.has(path)) return;
  await clearPendingMaterializationPaths(records, [path]);
}

type CaptureWorkItem = {
  path: string;
  tracked: CaptureTextFileMetadata | null;
  pending: boolean;
  collision: boolean;
};

type CaptureWorkRow =
  | "tracked-collision"
  | "untracked-collision"
  | "tracked-pending"
  | "untracked-pending"
  | "tracked-ordinary";

type CaptureSnapshotIdentity = {
  sha256?: string | null;
};

type CaptureCurrentEntry = {
  contentKind: "text" | "binary";
  sha256: string | null;
  latestMomentId: string;
};

type CaptureObservation =
  | {
      row: "tracked-collision";
      path: string;
      disk: DiskTextState;
      current: CaptureCurrentEntry | null;
    }
  | {
      row: "untracked-collision";
      path: string;
      disk: DiskTextState;
    }
  | {
      row: "tracked-pending";
      path: string;
      disk: DiskTextState;
      current: CaptureCurrentEntry;
      before: CaptureSnapshotIdentity | null | undefined;
      pendingRecorded: boolean;
      pullInFlight: boolean;
    }
  | {
      row: "untracked-pending";
      path: string;
      disk: DiskTextState;
      before: CaptureSnapshotIdentity | null | undefined;
    }
  | {
      row: "tracked-ordinary";
      path: string;
      disk: DiskTextState | { kind: "raced-present" };
      current: CaptureCurrentEntry | null;
      trackedContentKind: "text" | "binary";
    };

type CaptureAction =
  | { kind: "none" }
  | {
      kind: "write-store";
      content: DiskTextState & { kind: "text" | "binary" };
      beforeWrite: boolean;
    }
  | { kind: "delete-store" }
  | { kind: "materialize-write"; contentKind: "text" | "binary" }
  | { kind: "materialize-delete" };

type CaptureVerdict =
  | {
      kind: "captured";
      action: CaptureAction;
      resolveCollision: false;
    }
  | {
      kind: "repaired";
      action: CaptureAction;
      resolveCollision: boolean;
    }
  | {
      kind: "unchanged";
      action: { kind: "none" };
      resolveCollision: false;
      reportMissingTracked?: boolean;
    }
  | {
      kind: "unjournalable";
      action: { kind: "none" };
      resolveCollision: false;
      path: UnjournalablePath;
    };

function unreachableCaptureState(value: never): never {
  throw new Error(`Unhandled capture state: ${String(value)}`);
}

function captureWorkRow(work: CaptureWorkItem): CaptureWorkRow {
  if (work.collision) {
    return work.tracked === null ? "untracked-collision" : "tracked-collision";
  }
  if (work.pending) {
    return work.tracked === null ? "untracked-pending" : "tracked-pending";
  }
  if (work.tracked !== null) return "tracked-ordinary";
  throw new Error(`Capture work has no source: ${work.path}`);
}

// Equal bytes are an unchanged file. A snapshot stored as binary before its
// path was read as text still matches the same bytes on disk.
function diskMatchesSnapshot(
  disk: DiskTextState,
  snapshot: CaptureSnapshotIdentity,
): boolean {
  if (disk.kind !== "text" && disk.kind !== "binary") return false;
  return typeof snapshot.sha256 === "string" && disk.sha256 === snapshot.sha256;
}

function unjournalableFromDisk(
  path: string,
  disk: DiskTextState & { kind: "untracked-content" | "unreadable" },
): UnjournalablePath {
  if (disk.kind === "unreadable") return { path, reason: "unreadable" };
  return {
    path,
    reason: disk.reason === "non-file" ? "non-file-replacement" : disk.reason,
  };
}

function unjournalableVerdict(
  path: string,
  reason: UnjournalablePath["reason"],
): CaptureVerdict {
  return {
    kind: "unjournalable",
    action: { kind: "none" },
    resolveCollision: false,
    path: { path, reason },
  };
}

function classifyCaptureObservation(
  observation: CaptureObservation,
  allowLocalJournaling: boolean,
): CaptureVerdict {
  switch (observation.row) {
    case "tracked-collision": {
      if (observation.disk.kind === "unreadable") {
        return unjournalableVerdict(observation.path, "unreadable");
      }
      if (observation.current === null) {
        return {
          kind: "unchanged",
          action: { kind: "none" },
          resolveCollision: false,
          reportMissingTracked: true,
        };
      }
      const alreadyMatchesGranter = diskMatchesSnapshot(
        observation.disk,
        observation.current,
      );
      if (observation.disk.kind !== "absent" && !alreadyMatchesGranter) {
        return unjournalableVerdict(observation.path, "local-collision");
      }
      return {
        kind: "repaired",
        action: alreadyMatchesGranter
          ? { kind: "none" }
          : {
              kind: "materialize-write",
              contentKind: observation.current.contentKind,
            },
        resolveCollision: true,
      };
    }
    case "untracked-collision":
      if (observation.disk.kind === "unreadable") {
        return unjournalableVerdict(observation.path, "unreadable");
      }
      if (observation.disk.kind !== "absent") {
        return unjournalableVerdict(observation.path, "local-collision");
      }
      return {
        kind: "repaired",
        action: { kind: "none" },
        resolveCollision: true,
      };
    case "tracked-pending": {
      if (diskMatchesSnapshot(observation.disk, observation.current)) {
        return {
          kind: observation.pendingRecorded ? "repaired" : "unchanged",
          action: { kind: "none" },
          resolveCollision: false,
        };
      }
      const matchesPreimage =
        observation.before === null
          ? observation.disk.kind === "absent"
          : observation.before !== undefined &&
            diskMatchesSnapshot(observation.disk, observation.before);
      if (matchesPreimage || observation.disk.kind === "absent") {
        return {
          kind: "repaired",
          action: {
            kind: "materialize-write",
            contentKind: observation.current.contentKind,
          },
          resolveCollision: false,
        };
      }
      if (
        observation.pullInFlight &&
        (observation.disk.kind === "text" || observation.disk.kind === "binary")
      ) {
        return unjournalableVerdict(observation.path, "local-collision");
      }
      if (
        observation.disk.kind === "untracked-content" ||
        observation.disk.kind === "unreadable"
      ) {
        return {
          kind: "unjournalable",
          action: { kind: "none" },
          resolveCollision: false,
          path: unjournalableFromDisk(observation.path, observation.disk),
        };
      }
      return allowLocalJournaling
        ? {
            kind: "captured",
            action: {
              kind: "write-store",
              content: observation.disk,
              beforeWrite: false,
            },
            resolveCollision: false,
          }
        : {
            kind: "repaired",
            action: {
              kind: "materialize-write",
              contentKind: observation.current.contentKind,
            },
            resolveCollision: false,
          };
    }
    case "untracked-pending":
      if (observation.disk.kind === "absent") {
        return {
          kind: "repaired",
          action: { kind: "none" },
          resolveCollision: false,
        };
      }
      if (
        observation.before !== null &&
        observation.before !== undefined &&
        diskMatchesSnapshot(observation.disk, observation.before)
      ) {
        return {
          kind: "repaired",
          action: { kind: "materialize-delete" },
          resolveCollision: false,
        };
      }
      if (
        observation.disk.kind === "untracked-content" ||
        observation.disk.kind === "unreadable"
      ) {
        return {
          kind: "unjournalable",
          action: { kind: "none" },
          resolveCollision: false,
          path: unjournalableFromDisk(observation.path, observation.disk),
        };
      }
      return {
        kind: "unchanged",
        action: { kind: "none" },
        resolveCollision: false,
      };
    case "tracked-ordinary": {
      if (observation.disk.kind === "raced-present") {
        return {
          kind: "unchanged",
          action: { kind: "none" },
          resolveCollision: false,
        };
      }
      if (observation.disk.kind === "absent") {
        return allowLocalJournaling
          ? {
              kind: "captured",
              action: { kind: "delete-store" },
              resolveCollision: false,
            }
          : {
              kind: "repaired",
              action: {
                kind: "materialize-write",
                contentKind: observation.trackedContentKind,
              },
              resolveCollision: false,
            };
      }
      if (
        observation.disk.kind === "untracked-content" ||
        observation.disk.kind === "unreadable"
      ) {
        return {
          kind: "unjournalable",
          action: { kind: "none" },
          resolveCollision: false,
          path: unjournalableFromDisk(observation.path, observation.disk),
        };
      }
      if (observation.current === null) {
        return {
          kind: "unchanged",
          action: { kind: "none" },
          resolveCollision: false,
          reportMissingTracked: true,
        };
      }
      if (diskMatchesSnapshot(observation.disk, observation.current)) {
        return {
          kind: "unchanged",
          action: { kind: "none" },
          resolveCollision: false,
        };
      }
      return allowLocalJournaling
        ? {
            kind: "captured",
            action: {
              kind: "write-store",
              content: observation.disk,
              beforeWrite: true,
            },
            resolveCollision: false,
          }
        : {
            kind: "repaired",
            action: {
              kind: "materialize-write",
              contentKind: observation.current.contentKind,
            },
            resolveCollision: false,
          };
    }
    default:
      return unreachableCaptureState(observation);
  }
}

// Capture out-of-app modifications and deletes for paths the standalone share
// view already tracks. A hand-placed file belongs to the recipient and stays
// outside the journal. Comparing disk with the engine head avoids echoing
// in-app writes and prior materialization.
async function captureSharedViewLocalDivergence(input: {
  rootDir: string;
  workspaceId: string;
  store: CaptureVersionedTextStore;
  allowLocalJournaling: boolean;
  shareId: string;
  beforeCaptureWrite?: (path: string) => Promise<void>;
  paths?: readonly string[];
  preservedPaths?: readonly string[] | null;
  bestEffort?: boolean;
  workspaceLease?: WorkspaceOperationLease;
}, records: ShareViewRecords): Promise<CaptureSharedViewLocalDivergenceOutcome> {
  const {
    rootDir,
    workspaceId,
    store,
    allowLocalJournaling,
    shareId,
    beforeCaptureWrite,
    paths,
    preservedPaths = [],
    bestEffort = false,
    workspaceLease,
  } = input;
  const preserved = new Set(preservedPaths ?? []);
  const realRoot = await realpath(rootDir).catch(() => null);
  if (realRoot === null) {
    if (bestEffort || preservedPaths === null || preserved.size > 0) throw new Error("The share folder could not be read before access changed.");
    return {
      capturedPaths: 0,
      repairedPaths: 0,
      unjournalablePaths: [],
      collisionRecordQuarantined: false,
    };
  }

  const main = await store.ensureMainVersion({ workspaceId });
  const pathIsInScope = (path: string) =>
    paths === undefined ||
    paths.some((scope) => path === scope || path.startsWith(`${scope}/`));
  const everyTracked = await store.listTextFileMetadata({
    workspaceId,
    versionId: main.id,
  });
  const tracked = everyTracked.filter((entry) => pathIsInScope(entry.path));
  const spellings = spellingGroups(everyTracked.map((entry) => entry.path));
  if (preservedPaths === null) {
    for (const entry of tracked) preserved.add(entry.path);
  }
  const pendingState = await readPendingMaterializationPathsForCapture(
    records,
    tracked.map((entry) => entry.path),
  );
  const pendingPaths = new Set([...pendingState.paths].filter(pathIsInScope));
  let collisionRecordQuarantined = false;
  // Every recorded path, in this capture's scope or not: a recorded spelling
  // outside a scoped capture is still held, so it owns no file here.
  const everyCollisionRecordedPath = new Set(
    await readCollisionRecordPaths(records, shareId, () => {
      collisionRecordQuarantined = true;
    }),
  );
  const collisionRecordedPaths = new Set(
    [...everyCollisionRecordedPath].filter(pathIsInScope),
  );
  if (preservedPaths === null) {
    for (const path of [...pendingPaths, ...collisionRecordedPaths]) preserved.add(path);
  }
  if (collisionRecordQuarantined) {
    // A quarantined record cannot identify which paths it protected. Do no
    // mutations in this pass so the caller can show the notice before the
    // next capture applies the share's ordinary rules.
    return {
      capturedPaths: 0,
      repairedPaths: 0,
      unjournalablePaths: [],
      collisionRecordQuarantined: true,
    };
  }
  if (!allowLocalJournaling) {
    // Capture resolves real parents before it repairs missing tracked paths.
    // Heal structural obstructions first so that safety check cannot wedge a
    // read-only mount on a planted link or a file squatting on a directory.
    for (const entry of tracked) {
      if (preserved.has(entry.path)) continue;
      await healTamperedProjectionPath(realRoot, entry.path);
    }
  }
  const workByPath = new Map<string, CaptureWorkItem>();
  for (const entry of tracked) {
    if (classifyEngineFilePath(entry.path).kind === "secret") continue;
    workByPath.set(entry.path, {
      path: entry.path,
      tracked: entry,
      pending: pendingPaths.has(entry.path),
      collision: collisionRecordedPaths.has(entry.path),
    });
  }
  const markDebt = (path: string, debt: "pending" | "collision") => {
    const existing = workByPath.get(path);
    if (existing !== undefined) {
      existing[debt] = true;
      return;
    }
    const inserted: CaptureWorkItem = {
      path,
      tracked: null,
      pending: false,
      collision: false,
    };
    inserted[debt] = true;
    workByPath.set(path, inserted);
  };
  for (const path of pendingPaths) {
    markDebt(path, "pending");
  }
  for (const path of collisionRecordedPaths) {
    markDebt(path, "collision");
  }
  for (const path of preserved) {
    if (classifyEngineFilePath(path).kind === "secret") continue;
    if (pathIsInScope(path) && !workByPath.has(path)) markDebt(path, "collision");
  }

  const settlement = {
    capturedPaths: 0,
    repairedPaths: 0,
    unjournalablePaths: [] as UnjournalablePath[],
    resolvedCollisionPaths: [] as string[],
    failedPaths: [] as string[],
  };
  // The paths capture keeps its hands off so far: preserved ones, and ones it
  // could not capture or journal, except a spelling collision, whose file is
  // another spelling's.
  const captureProtected = () => new Set([
    ...preserved,
    ...settlement.failedPaths,
    ...settlement.unjournalablePaths.filter((path) => path.reason !== "spelling-collision").map((path) => path.path),
  ]);

  const currentEntry = (
    current: Awaited<ReturnType<CaptureVersionedTextStore["readTextFile"]>>,
  ): CaptureCurrentEntry | null =>
    current === null
      ? null
      : {
          contentKind: current.contentKind === "binary" ? "binary" : "text",
          sha256: current.sha256 ?? null,
          latestMomentId: current.latestMomentId,
        };

  const observeLocked = async (
    work: CaptureWorkItem,
    row: CaptureWorkRow,
    resolvedTarget: string,
    ordinaryPreLock?: IncomingPathState,
  ): Promise<CaptureObservation> => {
    switch (row) {
      case "tracked-collision": {
        const disk = await readDiskContent(resolvedTarget);
        return {
          row,
          path: work.path,
          disk,
          current:
            disk.kind === "unreadable"
              ? null
              : currentEntry(
                  await store.readTextFile({
                    workspaceId,
                    versionId: main.id,
                    path: work.path,
                  }),
                ),
        };
      }
      case "untracked-collision":
        return {
          row,
          path: work.path,
          disk: await readDiskContent(resolvedTarget),
        };
      case "tracked-pending": {
        let incoming: IncomingPathState;
        try {
          incoming = await inspectIncomingPath(resolvedTarget);
        } catch (error) {
          throw new SharedViewTargetAccessError({ cause: error });
        }
        const disk: DiskTextState =
          incoming === "non-file"
            ? { kind: "untracked-content", reason: "non-file" }
            : await readDiskContent(resolvedTarget);
        const current =
          currentEntry(
            await store.readTextFile({
              workspaceId,
              versionId: main.id,
              path: work.path,
            }),
          ) ?? work.tracked!;
        const latestMoment = diskMatchesSnapshot(disk, current)
          ? null
          : await store.getMoment({
              workspaceId,
              momentId: current.latestMomentId,
            });
        return {
          row,
          path: work.path,
          disk,
          current,
          before: latestMoment?.payload.before,
          pendingRecorded: pendingState.recordedPaths.has(work.path),
          pullInFlight: pendingState.pullInFlight,
        };
      }
      case "untracked-pending": {
        let disk: DiskTextState;
        try {
          disk = (await pathConfirmedAbsentOnDisk(resolvedTarget))
            ? { kind: "absent" }
            : await readDiskContent(resolvedTarget);
        } catch {
          return {
            row,
            path: work.path,
            disk: { kind: "unreadable" },
            before: undefined,
          };
        }
        const latestMoment =
          disk.kind === "absent"
            ? null
            : await latestMomentForPath(store, workspaceId, work.path);
        return {
          row,
          path: work.path,
          disk,
          before: latestMoment?.payload.before,
        };
      }
      case "tracked-ordinary": {
        let disk: Extract<
          CaptureObservation,
          { row: "tracked-ordinary" }
        >["disk"];
        if (ordinaryPreLock === "absent") {
          try {
            disk = (await pathConfirmedAbsentOnDisk(resolvedTarget))
              ? { kind: "absent" }
              : { kind: "raced-present" };
          } catch {
            disk = { kind: "unreadable" };
          }
        } else {
          disk = await readDiskContent(resolvedTarget);
          if (disk.kind === "absent") {
            try {
              if (!(await pathConfirmedAbsentOnDisk(resolvedTarget))) {
                disk = { kind: "raced-present" };
              }
            } catch {
              disk = { kind: "unreadable" };
            }
          }
        }
        const needsCurrent = disk.kind === "text" || disk.kind === "binary";
        return {
          row,
          path: work.path,
          disk,
          current: needsCurrent
            ? currentEntry(
                await store.readTextFile({
                  workspaceId,
                  versionId: main.id,
                  path: work.path,
                }),
              )
            : work.tracked,
          trackedContentKind: work.tracked!.contentKind,
        };
      }
      default:
        return unreachableCaptureState(row);
    }
  };

  const applyAction = async (
    path: string,
    action: CaptureAction,
  ): Promise<void> => {
    switch (action.kind) {
      case "none":
        return;
      case "write-store":
        if (action.beforeWrite) await beforeCaptureWrite?.(path);
        await writeDiskContentToStore({
          store,
          workspaceId,
          versionId: main.id,
          path,
          content: action.content,
        });
        return;
      case "delete-store":
        await store.deleteTextFile({
          workspaceId,
          versionId: main.id,
          path,
          metadata: { origin: "local-file" },
        });
        return;
      case "materialize-write":
        await materializeSharedViewPaths(
          rootDir,
          workspaceId,
          [{ path, operation: "write", contentKind: action.contentKind }],
          store,
          captureProtected(),
        );
        return;
      case "materialize-delete": {
        const { owners } = await materializeSharedViewPaths(
          rootDir,
          workspaceId,
          [{ path, operation: "delete", contentKind: "text" }],
          store,
          captureProtected(),
        );
        // A spelling given the file owns it now, for the rows after this one too.
        if (owners.length > 0) {
          await clearCollisionRecordPaths(records, shareId, owners);
          for (const owner of owners) {
            collisionRecordedPaths.delete(owner);
            everyCollisionRecordedPath.delete(owner);
          }
        }
        return;
      }
      default:
        return unreachableCaptureState(action);
    }
  };

  // Held spellings: their files are other spellings', not unsaved work.
  const held = new Set<string>();
  const knownSpellings = spellingGroups(new Set([...spellings.values()].flat().concat([...pendingState.paths, ...everyCollisionRecordedPath])));
  const executeWork = async (
    work: CaptureWorkItem,
  ): Promise<CaptureVerdict> => {
    // A spelling a refresh held back, whose file another live spelling owns,
    // sends and repairs nothing, even when preserved (#2416). Its record
    // keeps it from reading as deleted if that file goes, and ends once it is
    // no longer live.
    if (work.collision) {
      const owner = await withCaptureMutationLock(rootDir, work.path, workspaceLease, (resolvedTarget) =>
        spellingSharingFile(rootDir, work.path, resolvedTarget, spellings, (other) => !everyCollisionRecordedPath.has(other)),
      ).catch(() => undefined);
      if (owner === undefined) return unjournalableVerdict(work.path, "unreadable");
      if (owner !== null && work.tracked === null) {
        return { kind: "repaired", action: { kind: "none" }, resolveCollision: true };
      }
      if (owner !== null) {
        held.add(work.path);
        return { kind: "unjournalable", action: { kind: "none" }, resolveCollision: false, path: { path: work.path, reason: "spelling-collision", owner } };
      }
    }
    // A recorded spelling whose file is gone, or is the file of another
    // spelling, is never unsaved work of its own, so its collision row
    // settles it instead. Other spellings count when tracked, pending or
    // recorded, as a crashed pull's deleted owner still is. A person's own
    // separate file keeps the preserved branch.
    const sharedSpelling = collisionRecordedPaths.has(work.path)
      && (knownSpellings.get(pathCollisionKey(work.path)) ?? []).some((other) => other !== work.path)
      && await withCaptureMutationLock(rootDir, work.path, workspaceLease, async (resolvedTarget) =>
        !(await lstat(resolvedTarget).then(() => true, () => false))
          || (await spellingSharingFile(rootDir, work.path, resolvedTarget, knownSpellings)) !== null,
      ).catch(() => undefined);
    if (sharedSpelling === undefined) return unjournalableVerdict(work.path, "unreadable");
    if (preserved.has(work.path) && !sharedSpelling) {
      // These bytes predate the restriction. Journal them locally before
      // releasing protection, even when this copy is now read-only.
      return withCaptureMutationLock(
        rootDir, work.path, workspaceLease, async resolvedTarget => {
          const disk = await readDiskContent(resolvedTarget);
          if (disk.kind === "unreadable" || disk.kind === "untracked-content") {
            return unjournalableVerdict(work.path, unjournalableFromDisk(work.path, disk).reason);
          }
          if (disk.kind === "absent" && !(await pathConfirmedAbsentOnDisk(resolvedTarget))) {
            return unjournalableVerdict(work.path, "unreadable");
          }
          await applyAction(work.path, disk.kind === "absent"
            ? work.tracked ? { kind: "delete-store" } : { kind: "none" }
            : { kind: "write-store", content: disk, beforeWrite: false });
          return { kind: "captured", action: { kind: "none" }, resolveCollision: false };
        },
      );
    }
    const row = captureWorkRow(work);
    let ordinaryPreLock: IncomingPathState | undefined;
    if (row === "tracked-ordinary") {
      // On Windows, keep this pre-lock check: target resolution must not turn
      // an unreadable ancestor into a journaled delete.
      try {
        ordinaryPreLock = await inspectIncomingPath(
          resolve(realRoot, work.path),
        );
      } catch {
        return unjournalableVerdict(work.path, "unreadable");
      }
      if (ordinaryPreLock === "non-file") {
        return unjournalableVerdict(work.path, "non-file-replacement");
      }
    }
    try {
      return await withCaptureMutationLock(
        rootDir,
        work.path,
        workspaceLease,
        async (resolvedTarget) => {
          const observation = await observeLocked(
            work,
            row,
            resolvedTarget,
            ordinaryPreLock,
          );
          const verdict = classifyCaptureObservation(
            observation,
            allowLocalJournaling,
          );
          if (
            "reportMissingTracked" in verdict &&
            verdict.reportMissingTracked
          ) {
            console.error(
              `[desktop] shared view store lost tracked path ${work.path} ` +
                `in workspace ${workspaceId} version ${main.id}`,
            );
          }
          await applyAction(work.path, verdict.action);
          return verdict;
        },
      );
    } catch (error) {
      if (
        error instanceof SharedViewTargetAccessError &&
        (row === "tracked-collision" || row === "untracked-collision")
      ) {
        return unjournalableVerdict(work.path, "unreadable");
      }
      throw error;
    }
  };

  const settleWork = async (
    work: CaptureWorkItem,
    verdict: CaptureVerdict,
  ): Promise<void> => {
    switch (verdict.kind) {
      case "captured":
        settlement.capturedPaths += 1;
        break;
      case "repaired":
        settlement.repairedPaths += 1;
        break;
      case "unchanged":
        break;
      case "unjournalable":
        settlement.unjournalablePaths.push(verdict.path);
        break;
      default:
        unreachableCaptureState(verdict);
    }
    if (verdict.resolveCollision || (preserved.has(work.path) && verdict.kind !== "unjournalable")) {
      settlement.resolvedCollisionPaths.push(work.path);
      // The rows after this one see a resolved spelling as an owner.
      collisionRecordedPaths.delete(work.path);
      everyCollisionRecordedPath.delete(work.path);
      return;
    }
    if (work.pending && !work.collision) {
      await clearCapturePendingMarker(
        records,
        work.path,
        verdict.kind,
        pendingState,
      );
    }
  };

  let failurePath = "";
  try {
    // Collision rows run last: a file the person deleted then reads as the
    // delete of the spelling they saw before a held spelling takes it back.
    const works = [...workByPath.values()].sort((left, right) => Number(left.collision) - Number(right.collision));
    for (const work of works) {
      failurePath = work.path;
      try {
        await settleWork(work, await executeWork(work));
      } catch (error) {
        if (!bestEffort) throw error;
        settlement.failedPaths.push(work.path);
      }
    }

    if (settlement.resolvedCollisionPaths.length > 0) {
      failurePath = settlement.resolvedCollisionPaths[0]!;
      // Collision resolution discharges every retry count, then publishes the
      // collision record once for the whole pass.
      await clearAllPendingMaterializationPaths(
        records,
        settlement.resolvedCollisionPaths,
      );
      await clearCollisionRecordPaths(
        records,
        shareId,
        settlement.resolvedCollisionPaths,
      );
    }

    if (
      paths === undefined &&
      pendingState.pullInFlight &&
      // A spelling collision is a settled state, not a crash's debt.
      settlement.unjournalablePaths.every((path) => path.reason === "spelling-collision") &&
      settlement.failedPaths.length === 0
    ) {
      // Only a full successful pass proves that broad crash debt is settled.
      failurePath = posix.join(records.shown, PULL_IN_FLIGHT_FILE);
      await clearPullInFlightMarker(records);
    }
  } catch (error) {
    throw new CapturePartialFailureError(
      settlement.capturedPaths,
      settlement.repairedPaths,
      failurePath,
      error instanceof SharedViewTargetAccessError
        ? "unreadable"
        : "other",
      { cause: error },
    );
  }

  const resolvedPaths = new Set(settlement.resolvedCollisionPaths);
  return {
    capturedPaths: settlement.capturedPaths,
    repairedPaths: settlement.repairedPaths,
    unjournalablePaths: settlement.unjournalablePaths,
    collisionRecordQuarantined,
    ...(settlement.failedPaths.length > 0 ? { failedPaths: settlement.failedPaths } : {}),
    ...(input.preservedPaths !== undefined && (preservedPaths !== null || paths === undefined) ? {
      remainingPreservedPaths: [...preserved].filter(path => !resolvedPaths.has(path) && !held.has(path)),
    } : {}),
  };
}

async function captureStandaloneShareViewDivergence(input: {
  rootDir: string;
  workspaceId: string;
  store: CaptureVersionedTextStore;
  pinnedSelector: unknown;
  shareId: string;
  ended: boolean;
  paths?: readonly string[];
  preservedPaths?: readonly string[] | null;
  bestEffort?: boolean;
  workspaceLease?: WorkspaceOperationLease;
}, records: ShareViewRecords): Promise<CaptureSharedViewLocalDivergenceOutcome> {
  const grantedSelector = recordedShareSelector(input.pinnedSelector);
  if (grantedSelector === null) throw new SharePinInvalidError(input.shareId);
  const allowLocalJournaling = shareViewTakesLocalWrites({
    access: grantedSelector.access,
    ended: input.ended,
  });
  return captureSharedViewLocalDivergence({
    rootDir: input.rootDir,
    workspaceId: input.workspaceId,
    store: input.store,
    allowLocalJournaling,
    shareId: input.shareId,
    paths: input.paths,
    preservedPaths: input.preservedPaths,
    bestEffort: input.bestEffort,
    workspaceLease: input.workspaceLease,
  }, records);
}

// One refresh pass: pull the share's filtered ops into the local store,
// materialize what changed, then commit the cursor. Revocation (or a share
// that stopped existing for this account) comes back as status "ended" —
// the local files are left exactly as they were.
async function refreshSharedViewOnce(input: {
  rootDir: string;
  workspaceId: string;
  relay: SyncRelayConnection;
  shareId: string;
  // Required at the factory boundary: every rooted caller must explicitly
  // select its relay implementation, so no call can drift back to the legacy
  // TypeScript SQLite path.
  pull: (input: {
    rootDir: string;
    workspaceId: string;
    relay: SyncRelayConnection;
    shareId: string;
    grantedSelector: ShareViewSelector;
    recordRefusals: (refusals: ShareViewRefusal[]) => Promise<void>;
    recordCollisions?: (paths: readonly string[]) => Promise<void>;
    recordChangedPaths?: (paths: readonly string[]) => Promise<void>;
  }) => Promise<PullShareViewResult>;
  // Required at the factory boundary for the same reason: every rooted caller
  // must explicitly select its store implementation.
  store: CaptureVersionedTextStore;
  // The scope this refresh enforces, exactly as the share record holds it.
  // Read before the pull and never repaired from the relay, so no pull ever
  // runs unscoped and no refresh can re-pin a wider selector.
  pinnedSelector: unknown;
  // Where a refused op is written down. Called before the cursor that skips
  // past it is committed, and idempotent by origin coordinate, because a
  // re-fetched page repeats refusals the record already holds.
  recordRefusals: (refusals: ShareViewRefusal[]) => Promise<void>;
  onCursorCommitted?: (cursor: number) => void;
  excludeFromMaterialization?: ReadonlySet<string>;
  // Excluded paths whose files hold local work capture keeps aside, such as
  // preserved paths and ones it could not capture. Nothing removes or rewrites
  // their files, even to settle another spelling.
  protectedPaths?: ReadonlySet<string>;
  unjournalablePaths?: readonly UnjournalablePath[];
  trackPendingMaterialization?: boolean;
  preTrackedPaths?: ReadonlySet<string>;
}, records: ShareViewRecords): Promise<RefreshSharedViewOutcome> {
  const grantedSelector = recordedShareSelector(input.pinnedSelector);
  if (grantedSelector === null) throw new SharePinInvalidError(input.shareId);
  if (input.trackPendingMaterialization) {
    // A pull that can't say it is in flight doesn't start.
    await writePullInFlightMarker(records);
  }
  const recordedChangedPaths = new Set<string>();
  const recordChangedPaths = input.trackPendingMaterialization
    ? async (paths: readonly string[]) => {
        const newPaths = [...new Set(paths)].filter(
          (path) => !recordedChangedPaths.has(path),
        );
        if (newPaths.length === 0) return;
        await writePendingMaterializationPaths(records, newPaths);
        for (const path of newPaths) recordedChangedPaths.add(path);
      }
    : undefined;
  const preTrackedPaths = input.preTrackedPaths;
  let pull;
  try {
    pull = await input.pull({
      rootDir: input.rootDir,
      workspaceId: input.workspaceId,
      relay: input.relay,
      shareId: input.shareId,
      grantedSelector,
      recordRefusals: input.recordRefusals,
      recordChangedPaths,
      recordCollisions:
        preTrackedPaths === undefined
          ? undefined
          : async (paths: readonly string[]) => {
              const newlyColliding: string[] = [];
              for (const path of paths) {
                if (preTrackedPaths.has(path)) continue;
                const target = await resolvedShareViewTarget(
                  input.rootDir,
                  path,
                );
                if ((await inspectIncomingPath(target)) === "file") {
                  newlyColliding.push(path);
                }
              }
              if (newlyColliding.length > 0) {
                await recordCollisionPaths(
                  records,
                  input.shareId,
                  newlyColliding,
                );
              }
            },
    });
  } catch (error) {
    if (error instanceof ShareUnavailableError) {
      if (input.trackPendingMaterialization) {
        // The share ended either way. A marker dohc could not remove only
        // makes the next capture check every tracked path.
        await clearPullInFlightMarker(records).catch((clearError: unknown) => {
          console.error(
            `[desktop] share ${input.shareId} ended, and its pull-in-flight marker stays: ${String(clearError)}`,
          );
        });
      }
      return {
        status: "ended",
        changedPaths: 0,
        excludedPaths: [],
        unjournalablePaths: [...(input.unjournalablePaths ?? [])],
        refusedOps: 0,
        refusedDetail: null,
      };
    }
    throw error;
  }
  const materializationExclusions = new Set(
    input.excludeFromMaterialization ?? [],
  );
  if (recordChangedPaths) {
    // Non-daemon test adapters and alternate transports may not implement the
    // page callback yet. Persist anything the completed pull returned before
    // touching the projection; the daemon path records it earlier, per page.
    await recordChangedPaths(pull.changedPaths.map((change) => change.path));
  }
  const unjournalablePaths = [...(input.unjournalablePaths ?? [])];
  let collisionRecordedPaths = new Set<string>();
  // Spellings this pull holds back for an earlier spelling in it, by path.
  const heldSpellings = new Map<string, string>();
  if (input.preTrackedPaths !== undefined) {
    collisionRecordedPaths = await readCollisionRecordPaths(
      records,
      input.shareId,
    );
    const newlyCollidingPaths: string[] = [];
    // A file in the way is either this machine's or, on a disk that ignores
    // case, the file of another shared spelling that is not itself held.
    const preTrackedPaths = input.preTrackedPaths;
    let spellings: Map<string, string[]> | undefined;
    const collisionEntry = async (path: string, target: string): Promise<UnjournalablePath> => {
      spellings ??= spellingGroups(preTrackedPaths);
      const owner = await spellingSharingFile(input.rootDir, path, target, spellings, (other) => !collisionRecordedPaths.has(other)).catch(() => null);
      return owner === null ? { path, reason: "local-collision" } : { path, reason: "spelling-collision", owner };
    };
    for (const change of pull.changedPaths) {
      if (materializationExclusions.has(change.path)) continue;

      if (collisionRecordedPaths.has(change.path)) {
        // Already-recorded: keep excluding every later write OR delete for
        // this path, regardless of whether the store now tracks it — this is
        // the persistence #854 adds. Only capture's resolution arm clears it.
        materializationExclusions.add(change.path);
        unjournalablePaths.push(
          await resolvedShareViewTarget(input.rootDir, change.path).then(
            (target) => collisionEntry(change.path, target),
            () => ({ path: change.path, reason: "local-collision" as const }),
          ),
        );
        continue;
      }

      if (input.preTrackedPaths.has(change.path)) continue;

      const target = await resolvedShareViewTarget(input.rootDir, change.path);
      const incoming = await inspectIncomingPath(target);
      if (incoming === "absent") continue;
      materializationExclusions.add(change.path);
      const entry: UnjournalablePath =
        incoming === "non-file"
          ? { path: change.path, reason: "non-file-replacement" }
          : await collisionEntry(change.path, target);
      unjournalablePaths.push(entry);
      if (entry.reason !== "non-file-replacement") newlyCollidingPaths.push(change.path);
    }
    // Two spellings of one path in this pull, such as `notes.md` and
    // `Notes.md`, share one file on a disk that ignores case. The first is
    // written. Each later one is held back, recorded before that write, and
    // released below if the disk gives it its own file (#2416).
    const firstSpellings = new Map<string, string>();
    for (const change of pull.changedPaths) {
      if (change.operation === "delete" || materializationExclusions.has(change.path)) continue;
      const key = pathCollisionKey(change.path);
      const first = firstSpellings.get(key) ?? change.path;
      firstSpellings.set(key, first);
      if (first === change.path) continue;
      materializationExclusions.add(change.path);
      heldSpellings.set(change.path, first);
      unjournalablePaths.push({ path: change.path, reason: "spelling-collision", owner: first });
      newlyCollidingPaths.push(change.path);
    }
    if (newlyCollidingPaths.length > 0) {
      await recordCollisionPaths(
        records,
        input.shareId,
        newlyCollidingPaths,
      );
    }
  }
  const excludedPaths = pull.changedPaths
    .filter((change) => materializationExclusions.has(change.path))
    .map((change) => change.path);
  const pathsToMaterialize = pull.changedPaths.filter(
    (change) => !materializationExclusions.has(change.path),
  );
  const pendingMaterializationPaths = pathsToMaterialize.map(
    (change) => change.path,
  );
  if (input.trackPendingMaterialization) {
    // A collision record is durable debt of its own. Clear duplicate pending
    // counts only for those paths. Other exclusions, including the one-pass
    // protection after a damaged collision record is quarantined, must keep
    // their pending debt until a later capture materializes them.
    await clearAllPendingMaterializationPaths(
      records,
      excludedPaths.filter((path) => collisionRecordedPaths.has(path)),
    );
  }
  const { kept, owners } = await materializeSharedViewPaths(
    input.rootDir,
    input.workspaceId,
    pathsToMaterialize,
    input.store,
    input.protectedPaths,
  );
  // A spelling given a deleted spelling's file owns it now, so it is no
  // longer held, and the spellings still held behind it see it as owner.
  if (owners.length > 0) await clearCollisionRecordPaths(records, input.shareId, owners);
  // A held spelling that reaches none of its group's written files has its
  // own, on a disk that keeps them apart. It is written, and its record ends,
  // one at a time, so a later one that reaches it stays held behind it.
  const releasedPaths = new Set<string>();
  const written = new Map<string, string[]>();
  for (const change of pull.changedPaths) {
    const first = heldSpellings.get(change.path);
    if (first === undefined) continue;
    const key = pathCollisionKey(first);
    const group = written.get(key) ?? [first];
    written.set(key, group);
    const target = await resolvedShareViewTarget(input.rootDir, change.path);
    const owner = await spellingSharingFile(input.rootDir, change.path, target, new Map([[key, group]]));
    if (owner !== null) {
      const entry = unjournalablePaths.find((held) => held.path === change.path && held.reason === "spelling-collision");
      if (entry) entry.owner = owner;
      continue;
    }
    await materializeSharedViewPaths(input.rootDir, input.workspaceId, [change], input.store, input.protectedPaths);
    await clearCollisionRecordPaths(records, input.shareId, [change.path]);
    group.push(change.path);
    releasedPaths.add(change.path);
    pendingMaterializationPaths.push(change.path);
  }
  if (input.trackPendingMaterialization) {
    // The latest canonical value discharges every earlier attempt recorded
    // for this path. A page retried after failing before cursor commit can
    // increment its debt more than once, so decrementing once would leave a
    // clean projection reported as pending. A delete left undone keeps its debt.
    await clearAllPendingMaterializationPaths(
      records,
      pendingMaterializationPaths.filter((path) => !kept.includes(path)),
    );
    await clearPullInFlightMarker(records);
  }
  await pull.commitCursor();
  input.onCursorCommitted?.(pull.nextCursor);
  // Logged one line per refusal, because the count alone cannot be diagnosed.
  // The engine's message names the constraint, and for a version refusal its
  // limit, unit and observed usage.
  for (const refusal of pull.refusals) {
    console.error(
      `[desktop] share ${input.shareId} skipped ${refusal.opKind} ` +
        `${refusal.originId}@${refusal.originSeq} (${refusal.code}): ${refusal.detail}`,
    );
  }
  return {
    status: pull.changedPaths.length > 0 ? "updated" : "unchanged",
    changedPaths: pull.changedPaths.length,
    excludedPaths: excludedPaths.filter((path) => !releasedPaths.has(path)),
    unjournalablePaths: unjournalablePaths.filter((entry) => !releasedPaths.has(entry.path)),
    refusedOps: pull.refusalCount,
    refusedDetail: pull.refusals[0]?.detail ?? null,
  };
}

type ShareViewRefreshCompositionInput = { preservedPaths?: readonly string[] | null } & Omit<
  Parameters<typeof refreshSharedViewOnce>[0],
  | "excludeFromMaterialization"
  | "unjournalablePaths"
  | "trackPendingMaterialization"
  | "preTrackedPaths"
>;

async function refreshCapturedShareView(
  input: ShareViewRefreshCompositionInput & {
    captured: CaptureSharedViewLocalDivergenceOutcome;
  },
  records: ShareViewRecords,
): Promise<RefreshSharedViewOutcome> {
  const { captured, preservedPaths = [], ...refreshInput } = input;
  const localChanges = captured.capturedPaths + captured.repairedPaths;
  const main = await refreshInput.store.ensureMainVersion({
    workspaceId: refreshInput.workspaceId,
  });
  const preTrackedPaths = new Set(
    (
      await refreshInput.store.listTextFileMetadata({
        workspaceId: refreshInput.workspaceId,
        versionId: main.id,
      })
    ).map((entry) => entry.path),
  );
  const outcome = await refreshSharedViewOnce({
    ...refreshInput,
    excludeFromMaterialization: new Set([
      ...(preservedPaths ?? preTrackedPaths),
      ...(captured.failedPaths ?? []),
      ...captured.unjournalablePaths.map((path) => path.path),
      ...(captured.collisionRecordQuarantined ? preTrackedPaths : []),
    ]),
    // A spelling collision is left out: its file is another spelling's, which
    // a delete of that spelling settles.
    protectedPaths: new Set([
      ...(preservedPaths ?? preTrackedPaths),
      ...(captured.failedPaths ?? []),
      ...captured.unjournalablePaths.filter((path) => path.reason !== "spelling-collision").map((path) => path.path),
      ...(captured.collisionRecordQuarantined ? preTrackedPaths : []),
    ]),
    unjournalablePaths: captured.unjournalablePaths,
    trackPendingMaterialization: true,
    preTrackedPaths,
  }, records);
  return {
    ...outcome,
    ...(captured.collisionRecordQuarantined
      ? { collisionRecordQuarantined: true }
      : {}),
    status:
      outcome.status === "unchanged" && localChanges > 0
        ? "updated"
        : outcome.status,
    changedPaths: outcome.changedPaths + localChanges,
  };
}

// The ShareViewFiles owner holds the refresh lifecycle lock around this body.
// Keeping this function unlocked avoids reacquiring that same tail and
// deadlocking the operation that already owns it.
async function reconcileStandaloneShareView(
  input: ShareViewRefreshCompositionInput & {
    captured: CaptureSharedViewLocalDivergenceOutcome;
  },
  records: ShareViewRecords,
): Promise<StandaloneShareViewRefreshOutcome> {
  let totalLocalChanges = 0;
  try {
    const { captured } = input;
    totalLocalChanges = captured.capturedPaths + captured.repairedPaths;
    const outcome = await refreshCapturedShareView(input, records);
    return {
      ok: true,
      ...outcome,
      collisionRecordQuarantined: captured.collisionRecordQuarantined,
    };
  } catch (error) {
    return standaloneShareViewFailureOutcome(error, totalLocalChanges);
  }
}

export function createShareViewLifecycle(owner: ShareViewFilesOwnerCapability) {
  const active = <T>(input: {
    rootDir: string;
    workspaceId: string;
    shareId: string;
  }, operation: (records: ShareViewRecords) => Promise<T>): Promise<T> =>
    withActiveShareViewFilesOwnerOperation(
      owner,
      {
        rootPath: input.rootDir,
        storeWorkspaceId: input.workspaceId,
        shareId: input.shareId,
      },
      () => operation(shareViewRecords(owner, input.rootDir)),
    );
  return {
    captureShared: (
      input: Parameters<typeof captureSharedViewLocalDivergence>[0],
    ) => {
      return active(input, (records) =>
        captureSharedViewLocalDivergence(input, records),
      );
    },
    captureStandalone: (
      input: Parameters<typeof captureStandaloneShareViewDivergence>[0],
    ) => {
      return active(input, (records) =>
        captureStandaloneShareViewDivergence(input, records),
      );
    },
    captureStandaloneRefresh: (
      input: Parameters<typeof captureStandaloneShareViewDivergence>[0],
    ) =>
      active(input, async (records) => {
        try {
          return {
            ok: true as const,
            captured: await captureStandaloneShareViewDivergence(input, records),
          };
        } catch (error) {
          return standaloneShareViewFailureOutcome(error, 0);
        }
      }),
    refreshOnce: (input: Parameters<typeof refreshSharedViewOnce>[0]) => {
      return active(input, (records) => refreshSharedViewOnce(input, records));
    },
    refreshCaptured: (
      input: Parameters<typeof refreshCapturedShareView>[0],
    ) => {
      return active(input, (records) =>
        refreshCapturedShareView(input, records),
      );
    },
    reconcileStandalone: (
      input: Parameters<typeof reconcileStandaloneShareView>[0],
    ) => {
      return active(input, (records) =>
        reconcileStandaloneShareView(input, records),
      );
    },
  };
}
