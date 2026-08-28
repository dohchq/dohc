import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import { isInside } from "../security/pathContainment";
import { existingAncestor } from "./workspaceFiles";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";
import {
  ShareUnavailableError,
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

// The receive side of a relay share (PR 18): a shared view is a local
// engine store fed EXCLUSIVELY by the share's filtered op log — no watcher,
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
  | { ok: false; changedPaths: number; errorMessage: string };

export interface CaptureSharedViewLocalDivergenceOutcome {
  capturedPaths: number;
  repairedPaths: number;
  unjournalablePaths: UnjournalablePath[];
  collisionRecordQuarantined: boolean;
}

// Capture failing mid-pass still leaves whatever it fixed before the throw —
// the pending marker for the ONE unreadable path survives (capture's
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
    errorMessage: error instanceof Error ? error.message : String(error),
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

// Exported so a caller that must ask "what is at this path?" BEFORE it acts
// resolves it exactly the way materialization itself will — an ancestor
// symlink can then never make a guard look at one entry while the write or
// removal that follows touches another. ShareViewFiles' in-app rename and
// delete primitives are those callers (#861).
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

// EVERY store mutation inside captureSharedViewLocalDivergence must run through
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

async function materializeSharedViewPaths(
  rootDir: string,
  workspaceId: string,
  changedPaths: readonly ShareViewChangedPath[],
  store: CaptureVersionedTextStore,
): Promise<void> {
  if (changedPaths.length === 0) return;
  const realRoot = await realpath(rootDir);
  // REAL containment for the write, not just the lexical check above: a
  // symlink planted inside the materialized tree (a linked directory or a
  // link at the target path) must never redirect relay-controlled bytes
  // outside the root. The parent is realpath-verified after mkdir, and the
  // target itself is removed then recreated exclusively so a final-component
  // link is deleted, never followed (gpt-5.6-sol P1).
  async function preparedTarget(target: string): Promise<string> {
    // Containment BEFORE mkdir, not just after: a planted directory symlink
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
  for (const change of changedPaths) {
    const target = containedTarget(rootDir, change.path);
    // A mount keeps its own engine store at <mount>/.dohc. Containment cannot
    // see that: an alias planted inside the projection (`docs -> .dohc`)
    // resolves inside the mount and would let relay-controlled bytes rewrite
    // the store that decides what the projection holds. The rule runs against
    // the MOUNT root, which is what `.dohc` means here.
    //
    // "entry" for BOTH operations, because neither follows the leaf: a delete
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
      // recursive: a locally tampered DIRECTORY at the target must not
      // wedge the refresh with EISDIR. Node's rm removes a symlink as a
      // link either way — it never recurses through one.
      await rm(resolvedTarget, { recursive: true, force: true });
      continue;
    }
    // Read the content BEFORE touching the projection. `preparedTarget`
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

const PENDING_MATERIALIZATION_FILE = "pending-materialization.json";
const PULL_IN_FLIGHT_FILE = "pull-in-flight.marker";
const REFRESH_LIFECYCLE_LOCK = "refresh-lifecycle";
// Refresh and Send changes both run the same capture path. Either action can
// resolve a collision and clear this record after the recipient moves its file.
const COLLISION_RECORD_FILE = "share-collision-record.json";

function pendingMaterializationPath(rootDir: string): string {
  return join(rootDir, ".dohc", PENDING_MATERIALIZATION_FILE);
}

function pullInFlightPath(rootDir: string): string {
  return join(rootDir, ".dohc", PULL_IN_FLIGHT_FILE);
}

function collisionRecordPath(rootDir: string): string {
  return join(rootDir, ".dohc", COLLISION_RECORD_FILE);
}

function shareViewRefreshLifecycleLockKey(rootDir: string): string {
  return join(rootDir, ".dohc", REFRESH_LIFECYCLE_LOCK);
}

async function ensureRealMetadataDirectory(rootDir: string): Promise<string> {
  const metadataDir = join(rootDir, ".dohc");
  let stat;
  try {
    stat = await lstat(metadataDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      await mkdir(metadataDir, { recursive: true });
      return metadataDir;
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `[desktop] .dohc metadata path at ${metadataDir} is not a real directory ` +
        `(found ${stat.isSymbolicLink() ? "a symlink" : "a non-directory"}); refusing to ` +
        "write through it.",
    );
  }
  return metadataDir;
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

async function syncMetadataDirectory(metadataDir: string): Promise<void> {
  const dir = await open(metadataDir, "r");
  try {
    await dir.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || code !== "EPERM") throw error;
  } finally {
    await dir.close();
  }
}

async function writeSidecarAtomically(
  rootDir: string,
  fileName: string,
  writeContent: (handle: FileHandle) => Promise<void>,
): Promise<void> {
  const metadataDir = await ensureRealMetadataDirectory(rootDir);
  const target = join(metadataDir, fileName);
  const temp = join(
    metadataDir,
    `.${fileName}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temp, "w");
    try {
      await writeContent(handle);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
    await syncMetadataDirectory(metadataDir);
  } finally {
    await rm(temp, { force: true });
  }
}

async function quarantineSidecar(
  target: string,
  context: string,
): Promise<boolean> {
  const quarantine = `${target}.invalid-${Date.now()}`;
  try {
    await rename(target, quarantine);
    return true;
  } catch (quarantineError) {
    console.error(
      `[desktop] could not quarantine ${context} at ${target}: ${String(quarantineError)}`,
    );
    return false;
  }
}

async function writePullInFlightMarker(rootDir: string): Promise<void> {
  await writeSidecarAtomically(rootDir, PULL_IN_FLIGHT_FILE, async () => {});
}

async function clearPullInFlightMarker(rootDir: string): Promise<void> {
  const metadataDir = join(rootDir, ".dohc");
  let stat;
  try {
    stat = await lstat(metadataDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw error;
  }
  if (!stat.isDirectory()) return;
  await rm(pullInFlightPath(rootDir), { force: true });
  await syncMetadataDirectory(metadataDir);
}

async function pullMayBeInFlight(rootDir: string): Promise<boolean> {
  const target = pullInFlightPath(rootDir);
  try {
    await lstat(target);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    console.error(
      `[desktop] pull-in-flight marker at ${target} could not be read; ` +
        `verifying every tracked path: ${String(error)}`,
    );
    return true;
  }
}

export async function readPendingMaterializationPaths(
  rootDir: string,
): Promise<Set<string>> {
  return withExclusiveWorkspaceOperation(
    pendingMaterializationPath(rootDir),
    async () => new Set(Object.keys(await readPendingFileUnlocked(rootDir))),
  );
}

async function readPendingMaterializationPathsForCapture(
  rootDir: string,
  trackedPaths: readonly string[],
): Promise<{
  paths: Set<string>;
  recordedPaths: Set<string>;
  canClearRecord: boolean;
  pullInFlight: boolean;
}> {
  const pullInFlight = await pullMayBeInFlight(rootDir);
  const target = pendingMaterializationPath(rootDir);
  return withExclusiveWorkspaceOperation(target, async () => {
    try {
      const recordedPaths = new Set(
        Object.keys(await readPendingFileUnlocked(rootDir)),
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
        `[desktop] pending materialization record at ${target} is unreadable; ` +
          "quarantining it and verifying every tracked path. Pending paths " +
          `that are no longer tracked cannot be recovered: ${String(error)}`,
      );
      const quarantined = await quarantineSidecar(
        target,
        "pending materialization record",
      );
      return {
        paths: new Set(trackedPaths),
        recordedPaths: new Set(),
        canClearRecord: quarantined,
        pullInFlight,
      };
    }
  });
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
  let serialized: string;
  try {
    serialized = await readFile(pendingMaterializationPath(rootDir), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return emptyPendingMaterializationCounts();
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
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
  rootDir: string,
  counts: Readonly<PendingMaterializationCounts>,
): Promise<void> {
  // Flush before publish so a host crash cannot lose the marker and make an
  // interrupted materialization look like a user edit.
  await writeSidecarAtomically(
    rootDir,
    PENDING_MATERIALIZATION_FILE,
    async (handle) => {
      await handle.writeFile(JSON.stringify({ counts }), "utf8");
    },
  );
}

async function writePendingMaterializationPaths(
  rootDir: string,
  paths: readonly string[],
): Promise<void> {
  await withExclusiveWorkspaceOperation(
    pendingMaterializationPath(rootDir),
    async () => {
      const counts = await readPendingFileUnlocked(rootDir);
      for (const path of new Set(paths)) {
        counts[path] = (counts[path] ?? 0) + 1;
      }
      await writePendingFileUnlocked(rootDir, counts);
    },
  );
}

async function clearPendingMaterializationPaths(
  rootDir: string,
  paths: readonly string[],
): Promise<void> {
  await withExclusiveWorkspaceOperation(
    pendingMaterializationPath(rootDir),
    async () => {
      await ensureRealMetadataDirectory(rootDir);
      const counts = await readPendingFileUnlocked(rootDir);
      for (const path of new Set(paths)) {
        const count = counts[path];
        if (count === undefined) continue;
        if (count <= 1) {
          delete counts[path];
        } else {
          counts[path] = count - 1;
        }
      }
      if (Object.keys(counts).length === 0) {
        await rm(pendingMaterializationPath(rootDir), { force: true });
      } else {
        await writePendingFileUnlocked(rootDir, counts);
      }
    },
  );
}

export function shareViewFilesProjection(owner: ShareViewFilesOwnerCapability) {
  const active = <T>(
    expected: Parameters<typeof assertActiveShareViewFilesOwner>[1],
    operation: () => Promise<T>,
  ): Promise<T> =>
    withActiveShareViewFilesOwnerOperation(owner, expected ?? {}, operation);
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
        writePendingMaterializationPaths(rootDir, paths),
      ),
    clearPending: (rootDir: string, paths: readonly string[]) =>
      active({ rootPath: rootDir }, () =>
        clearPendingMaterializationPaths(rootDir, paths),
      ),
    clearPullInFlight: (rootDir: string) =>
      active({ rootPath: rootDir }, () => clearPullInFlightMarker(rootDir)),
    recordCollisions: (
      rootDir: string,
      shareId: string,
      paths: readonly string[],
    ) =>
      active({ rootPath: rootDir, shareId }, () =>
        recordCollisionPaths(rootDir, shareId, paths),
      ),
  };
}

async function clearAllPendingMaterializationPaths(
  rootDir: string,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) return;
  await withExclusiveWorkspaceOperation(
    pendingMaterializationPath(rootDir),
    async () => {
      await ensureRealMetadataDirectory(rootDir);
      const counts = await readPendingFileUnlocked(rootDir);
      for (const path of new Set(paths)) delete counts[path];
      if (Object.keys(counts).length === 0) {
        await rm(pendingMaterializationPath(rootDir), { force: true });
      } else {
        await writePendingFileUnlocked(rootDir, counts);
      }
    },
  );
}

const INVALID_COLLISION_RECORD = "Invalid share collision record.";

async function readCollisionRecordUnlocked(
  rootDir: string,
  shareId: string,
): Promise<{ shareId: string; paths: Set<string> }> {
  let serialized: string;
  try {
    serialized = await readFile(collisionRecordPath(rootDir), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { shareId, paths: new Set() };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
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
  rootDir: string,
  shareId: string,
  paths: ReadonlySet<string>,
): Promise<void> {
  const metadataDir = await ensureRealMetadataDirectory(rootDir);
  const target = collisionRecordPath(rootDir);
  if (paths.size === 0) {
    await rm(target, { force: true });
    await syncMetadataDirectory(metadataDir);
    return;
  }
  await writeSidecarAtomically(
    rootDir,
    COLLISION_RECORD_FILE,
    async (handle) => {
      await handle.writeFile(
        JSON.stringify({ shareId, paths: [...paths].sort() }),
        "utf8",
      );
    },
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
async function readCollisionRecordLocked(
  rootDir: string,
  shareId: string,
  onQuarantine?: () => void,
): Promise<Set<string>> {
  const target = collisionRecordPath(rootDir);
  let record: { shareId: string; paths: Set<string> };
  try {
    record = await readCollisionRecordUnlocked(rootDir, shareId);
  } catch (error) {
    console.error(
      `[desktop] share collision record at ${target} is unreadable; quarantining it. ` +
        "A previously-excluded path will follow this share's ordinary capture " +
        `rules on the next capture: ${String(error)}`,
    );
    onQuarantine?.();
    await quarantineSidecar(target, "share collision record");
    return new Set<string>();
  }
  if (record.shareId !== shareId) {
    console.error(
      `[desktop] share collision record at ${target} belongs to share ` +
        `${record.shareId}, not ${shareId}; quarantining the stale record.`,
    );
    onQuarantine?.();
    await quarantineSidecar(target, "stale share collision record");
    return new Set<string>();
  }
  return record.paths;
}

async function readCollisionRecordPaths(
  rootDir: string,
  shareId: string,
  onQuarantine?: () => void,
): Promise<Set<string>> {
  return withExclusiveWorkspaceOperation(collisionRecordPath(rootDir), () =>
    readCollisionRecordLocked(rootDir, shareId, onQuarantine),
  );
}

async function peekCollisionRecordPaths(
  rootDir: string,
  shareId: string,
): Promise<Set<string>> {
  return withExclusiveWorkspaceOperation(
    collisionRecordPath(rootDir),
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

async function mutateCollisionRecord(
  rootDir: string,
  shareId: string,
  paths: readonly string[],
  mutate: (current: Set<string>, path: string) => void,
): Promise<void> {
  if (paths.length === 0) return;
  await withExclusiveWorkspaceOperation(
    collisionRecordPath(rootDir),
    async () => {
    const current = await readCollisionRecordLocked(rootDir, shareId);
    for (const path of paths) mutate(current, path);
    await writeCollisionRecordUnlocked(rootDir, shareId, current);
    },
  );
}

function recordCollisionPaths(
  rootDir: string,
  shareId: string,
  paths: readonly string[],
): Promise<void> {
  return mutateCollisionRecord(rootDir, shareId, paths, (set, path) =>
    set.add(path),
  );
}

function clearCollisionRecordPaths(
  rootDir: string,
  shareId: string,
  paths: readonly string[],
): Promise<void> {
  return mutateCollisionRecord(rootDir, shareId, paths, (set, path) =>
    set.delete(path),
  );
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
  rootDir: string,
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
  await clearPendingMaterializationPaths(rootDir, [path]);
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
  contentKind?: "text" | "binary";
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

function diskMatchesSnapshot(
  disk: DiskTextState,
  snapshot: CaptureSnapshotIdentity,
): boolean {
  if (disk.kind !== "text" && disk.kind !== "binary") return false;
  const contentKind = snapshot.contentKind === "binary" ? "binary" : "text";
  return (
    disk.kind === contentKind &&
    typeof snapshot.sha256 === "string" &&
    disk.sha256 === snapshot.sha256
  );
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
  workspaceLease?: WorkspaceOperationLease;
}): Promise<CaptureSharedViewLocalDivergenceOutcome> {
  const {
    rootDir,
    workspaceId,
    store,
    allowLocalJournaling,
    shareId,
    beforeCaptureWrite,
    paths,
    workspaceLease,
  } = input;
  const realRoot = await realpath(rootDir).catch(() => null);
  if (realRoot === null) {
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
  const tracked = (
    await store.listTextFileMetadata({
      workspaceId,
      versionId: main.id,
    })
  ).filter((entry) => pathIsInScope(entry.path));
  const pendingState = await readPendingMaterializationPathsForCapture(
    rootDir,
    tracked.map((entry) => entry.path),
  );
  const pendingPaths = new Set([...pendingState.paths].filter(pathIsInScope));
  let collisionRecordQuarantined = false;
  const collisionRecordedPaths = new Set(
    [
      ...(await readCollisionRecordPaths(rootDir, shareId, () => {
        collisionRecordQuarantined = true;
      })),
    ].filter(pathIsInScope),
  );
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

  const settlement = {
    capturedPaths: 0,
    repairedPaths: 0,
    unjournalablePaths: [] as UnjournalablePath[],
    resolvedCollisionPaths: [] as string[],
  };

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
        );
        return;
      case "materialize-delete":
        await materializeSharedViewPaths(
          rootDir,
          workspaceId,
          [{ path, operation: "delete", contentKind: "text" }],
          store,
        );
        return;
      default:
        return unreachableCaptureState(action);
    }
  };

  const executeWork = async (
    work: CaptureWorkItem,
  ): Promise<CaptureVerdict> => {
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
    if (verdict.resolveCollision) {
      settlement.resolvedCollisionPaths.push(work.path);
      return;
    }
    if (work.pending && !work.collision) {
      await clearCapturePendingMarker(
        rootDir,
        work.path,
        verdict.kind,
        pendingState,
      );
    }
  };

  let failurePath = "";
  try {
    for (const work of workByPath.values()) {
      failurePath = work.path;
      await settleWork(work, await executeWork(work));
    }

    if (settlement.resolvedCollisionPaths.length > 0) {
      failurePath = settlement.resolvedCollisionPaths[0]!;
      // Collision resolution discharges every retry count, then publishes the
      // collision record once for the whole pass.
      await clearAllPendingMaterializationPaths(
        rootDir,
        settlement.resolvedCollisionPaths,
      );
      await clearCollisionRecordPaths(
        rootDir,
        shareId,
        settlement.resolvedCollisionPaths,
      );
    }

    if (
      paths === undefined &&
      pendingState.pullInFlight &&
      settlement.unjournalablePaths.length === 0
    ) {
      // Only a full successful pass proves that broad crash debt is settled.
      failurePath = join(".dohc", PULL_IN_FLIGHT_FILE);
      await clearPullInFlightMarker(rootDir);
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

  return {
    capturedPaths: settlement.capturedPaths,
    repairedPaths: settlement.repairedPaths,
    unjournalablePaths: settlement.unjournalablePaths,
    collisionRecordQuarantined,
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
  workspaceLease?: WorkspaceOperationLease;
}): Promise<CaptureSharedViewLocalDivergenceOutcome> {
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
    workspaceLease: input.workspaceLease,
  });
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
  // Read BEFORE the pull and never repaired from the relay, so no pull ever
  // runs unscoped and no refresh can re-pin a wider selector.
  pinnedSelector: unknown;
  // Where a refused op is written down. Called before the cursor that skips
  // past it is committed, and idempotent by origin coordinate, because a
  // re-fetched page repeats refusals the record already holds.
  recordRefusals: (refusals: ShareViewRefusal[]) => Promise<void>;
  excludeFromMaterialization?: ReadonlySet<string>;
  unjournalablePaths?: readonly UnjournalablePath[];
  trackPendingMaterialization?: boolean;
  preTrackedPaths?: ReadonlySet<string>;
}): Promise<RefreshSharedViewOutcome> {
  const grantedSelector = recordedShareSelector(input.pinnedSelector);
  if (grantedSelector === null) throw new SharePinInvalidError(input.shareId);
  if (input.trackPendingMaterialization) {
    await writePullInFlightMarker(input.rootDir);
  }
  const recordedChangedPaths = new Set<string>();
  const recordChangedPaths = input.trackPendingMaterialization
    ? async (paths: readonly string[]) => {
        const newPaths = [...new Set(paths)].filter(
          (path) => !recordedChangedPaths.has(path),
        );
        if (newPaths.length === 0) return;
        await writePendingMaterializationPaths(input.rootDir, newPaths);
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
                  input.rootDir,
                  input.shareId,
                  newlyColliding,
                );
              }
            },
    });
  } catch (error) {
    if (error instanceof ShareUnavailableError) {
      if (input.trackPendingMaterialization) {
        await clearPullInFlightMarker(input.rootDir);
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
  if (input.preTrackedPaths !== undefined) {
    collisionRecordedPaths = await readCollisionRecordPaths(
      input.rootDir,
      input.shareId,
    );
    const newlyCollidingPaths: string[] = [];
    for (const change of pull.changedPaths) {
      if (materializationExclusions.has(change.path)) continue;

      if (collisionRecordedPaths.has(change.path)) {
        // Already-recorded: keep excluding every later write OR delete for
        // this path, regardless of whether the store now tracks it — this is
        // the persistence #854 adds. Only capture's resolution arm clears it.
        materializationExclusions.add(change.path);
        unjournalablePaths.push({
          path: change.path,
          reason: "local-collision",
        });
        continue;
      }

      if (input.preTrackedPaths.has(change.path)) continue;

      const target = await resolvedShareViewTarget(input.rootDir, change.path);
      const incoming = await inspectIncomingPath(target);
      if (incoming === "absent") continue;
      materializationExclusions.add(change.path);
      const reason =
        incoming === "non-file" ? "non-file-replacement" : "local-collision";
      unjournalablePaths.push({ path: change.path, reason });
      if (reason === "local-collision") newlyCollidingPaths.push(change.path);
    }
    if (newlyCollidingPaths.length > 0) {
      await recordCollisionPaths(
        input.rootDir,
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
      input.rootDir,
      excludedPaths.filter((path) => collisionRecordedPaths.has(path)),
    );
  }
  await materializeSharedViewPaths(
    input.rootDir,
    input.workspaceId,
    pathsToMaterialize,
    input.store,
  );
  if (input.trackPendingMaterialization) {
    // The latest canonical value discharges every earlier attempt recorded
    // for this path. A page retried after failing before cursor commit can
    // increment its debt more than once, so decrementing once would leave a
    // clean projection reported as pending.
    await clearAllPendingMaterializationPaths(
      input.rootDir,
      pendingMaterializationPaths,
    );
    await clearPullInFlightMarker(input.rootDir);
  }
  await pull.commitCursor();
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
    excludedPaths,
    unjournalablePaths,
    refusedOps: pull.refusalCount,
    refusedDetail: pull.refusals[0]?.detail ?? null,
  };
}

type ShareViewRefreshCompositionInput = Omit<
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
): Promise<RefreshSharedViewOutcome> {
  const { captured, ...refreshInput } = input;
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
      ...captured.unjournalablePaths.map((path) => path.path),
      ...(captured.collisionRecordQuarantined ? preTrackedPaths : []),
    ]),
    unjournalablePaths: captured.unjournalablePaths,
    trackPendingMaterialization: true,
    preTrackedPaths,
  });
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
): Promise<StandaloneShareViewRefreshOutcome> {
  let totalLocalChanges = 0;
  try {
    const { captured } = input;
    totalLocalChanges = captured.capturedPaths + captured.repairedPaths;
    const outcome = await refreshCapturedShareView(input);
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
  }, operation: () => Promise<T>): Promise<T> =>
    withActiveShareViewFilesOwnerOperation(
      owner,
      {
        rootPath: input.rootDir,
        storeWorkspaceId: input.workspaceId,
        shareId: input.shareId,
      },
      operation,
    );
  return {
    captureShared: (
      input: Parameters<typeof captureSharedViewLocalDivergence>[0],
    ) => {
      return active(input, () => captureSharedViewLocalDivergence(input));
    },
    captureStandalone: (
      input: Parameters<typeof captureStandaloneShareViewDivergence>[0],
    ) => {
      return active(input, () => captureStandaloneShareViewDivergence(input));
    },
    captureStandaloneRefresh: (
      input: Parameters<typeof captureStandaloneShareViewDivergence>[0],
    ) =>
      active(input, async () => {
        try {
          return {
            ok: true as const,
            captured: await captureStandaloneShareViewDivergence(input),
          };
        } catch (error) {
          return standaloneShareViewFailureOutcome(error, 0);
        }
      }),
    refreshOnce: (input: Parameters<typeof refreshSharedViewOnce>[0]) => {
      return active(input, () => refreshSharedViewOnce(input));
    },
    refreshCaptured: (
      input: Parameters<typeof refreshCapturedShareView>[0],
    ) => {
      return active(input, () => refreshCapturedShareView(input));
    },
    reconcileStandalone: (
      input: Parameters<typeof reconcileStandaloneShareView>[0],
    ) => {
      return active(input, () => reconcileStandaloneShareView(input));
    },
  };
}
