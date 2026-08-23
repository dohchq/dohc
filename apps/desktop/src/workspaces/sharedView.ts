import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
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
  withExclusiveWorkspaceOperation,
  withOrderedWorkspaceTargetPath,
} from "./workspaceAssets";
import { readDiskContent, type DiskTextState } from "./workspaceEngineCapture";
import type { CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";
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
  | ({ ok: true; collisionRecordQuarantined: boolean } & RefreshSharedViewOutcome)
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
// are real and already durable. This carries those counts past the throw so
// a caller wrapping capture in a failure outcome doesn't report zero changes
// and skip the repaint those repairs earned.
class CapturePartialFailureError extends Error {
  constructor(
    readonly capturedPaths: number,
    readonly repairedPaths: number,
    readonly path: string,
    readonly reason: "unreadable" | "other",
    options: { cause: unknown },
  ) {
    super(
      options.cause instanceof Error ? options.cause.message : String(options.cause),
      options,
    );
    this.name = "CapturePartialFailureError";
  }
}

// A failure while resolving the target, before any lock or store mutation
// runs. This lets callers distinguish an unreachable path from a failure
// inside the locked operation while preserving the cause's message.
class SharedViewTargetResolutionError extends Error {
  constructor(options: { cause: unknown }) {
    super(
      options.cause instanceof Error ? options.cause.message : String(options.cause),
      options,
    );
    this.name = "SharedViewTargetResolutionError";
  }
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
  let current = realRoot;
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]!);
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
  operation: (resolvedTarget: string) => Promise<T>,
): Promise<T> {
  let resolvedTarget: string;
  try {
    resolvedTarget = await resolvedShareViewTarget(rootDir, path);
  } catch (error) {
    throw new SharedViewTargetResolutionError({ cause: error });
  }
  return withOrderedWorkspaceTargetPath(rootDir, resolvedTarget, () =>
    operation(resolvedTarget),
  );
}

export async function materializeSharedViewPaths(
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
    const realAncestor = await realpath(await existingAncestor(dirname(target)));
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
    const { resolvedAbsolute: resolvedTarget } = await assertResolvedWorkspacePath({
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
      const realParent = await realpath(dirname(resolvedTarget)).catch(() => null);
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
        : (
            await store.readTextFile({
              workspaceId,
              versionId: main.id,
              path: change.path,
            })
          )?.text ?? null;
    await preparedTarget(resolvedTarget);
    if (content === null) continue;
    await writeFile(
      resolvedTarget,
      content,
      typeof content === "string" ? { encoding: "utf8", flag: "wx" } : { flag: "wx" },
    );
  }
}

export async function writeDiskContentToStore(input: {
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

export async function clearPullInFlightMarker(rootDir: string): Promise<void> {
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

export async function writePendingMaterializationPaths(
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

export async function clearPendingMaterializationPaths(
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
        typeof path === "string" && classifyEngineFilePath(path).kind === "tracked",
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

export async function readCollisionRecordPaths(
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
  await withExclusiveWorkspaceOperation(collisionRecordPath(rootDir), async () => {
    const current = await readCollisionRecordLocked(rootDir, shareId);
    for (const path of paths) mutate(current, path);
    await writeCollisionRecordUnlocked(rootDir, shareId, current);
  });
}

export function recordCollisionPaths(
  rootDir: string,
  shareId: string,
  paths: readonly string[],
): Promise<void> {
  return mutateCollisionRecord(rootDir, shareId, paths, (set, path) => set.add(path));
}

export function clearCollisionRecordPaths(
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

async function pathConfirmedAbsentOnDisk(resolvedTarget: string): Promise<boolean> {
  try {
    await lstat(resolvedTarget);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return true;
    throw error;
  }
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

// Capture out-of-app modifications and deletes for paths the standalone share
// view already tracks. A hand-placed file belongs to the recipient and stays
// outside the journal. Comparing disk with the engine head avoids echoing
// in-app writes and prior materialization.
export async function captureSharedViewLocalDivergence(
  rootDir: string,
  workspaceId: string,
  store: CaptureVersionedTextStore,
  allowLocalJournaling: boolean,
  shareId: string,
  options?: {
    beforeCaptureWrite?: (path: string) => Promise<void>;
    paths?: readonly string[];
  },
): Promise<CaptureSharedViewLocalDivergenceOutcome> {
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
  if (!store.listTextFileMetadata) {
    throw new Error("Shared view reconciliation requires file metadata listing support.");
  }
  const pathIsInScope = (path: string) =>
    options?.paths === undefined ||
    options.paths.some(
      (scope) => path === scope || path.startsWith(`${scope}/`),
    );
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
  const pendingPaths = new Set(
    [...pendingState.paths].filter(pathIsInScope),
  );
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
  const trackedPathSet = new Set(tracked.map((entry) => entry.path));

  let capturedPaths = 0;
  let repairedPaths = 0;
  const unjournalablePaths: UnjournalablePath[] = [];
  const resolvedCollisionPaths: string[] = [];
  const visitedPendingPaths = new Set<string>();

  const diskMatchesSnapshot = (
    disk: DiskTextState,
    snapshot: { contentKind?: "text" | "binary"; sha256?: string | null },
  ): boolean => {
    if (disk.kind !== "text" && disk.kind !== "binary") return false;
    const contentKind = snapshot.contentKind === "binary" ? "binary" : "text";
    return (
      disk.kind === contentKind &&
      typeof snapshot.sha256 === "string" &&
      disk.sha256 === snapshot.sha256
    );
  };

  async function rematerializeHead(
    path: string,
    contentKind: "text" | "binary",
  ): Promise<void> {
    await materializeSharedViewPaths(
      rootDir,
      workspaceId,
      [{ path, operation: "write", contentKind }],
      store,
    );
  }

  async function captureAbsentTrackedPath(
    path: string,
    contentKind: "text" | "binary",
    resolvedTarget: string,
  ): Promise<
    | "captured"
    | "repaired"
    | "unchanged"
    | { kind: "unjournalable"; path: UnjournalablePath }
  > {
    try {
      if (!(await pathConfirmedAbsentOnDisk(resolvedTarget))) {
        return "unchanged";
      }
    } catch {
      return {
        kind: "unjournalable",
        path: { path, reason: "unreadable" },
      };
    }
    if (!allowLocalJournaling) {
      await rematerializeHead(path, contentKind);
      return "repaired";
    }
    await store.deleteTextFile({
      workspaceId,
      versionId: main.id,
      path,
      metadata: { origin: "local-file" },
    });
    return "captured";
  }

  const unjournalableFromDisk = (
    path: string,
    disk: DiskTextState & { kind: "untracked-content" | "unreadable" },
  ): UnjournalablePath => {
    if (disk.kind === "unreadable") return { path, reason: "unreadable" };
    return {
      path,
      reason:
        disk.reason === "non-file"
          ? "non-file-replacement"
          : disk.reason,
    };
  };

  for (const entry of tracked) {
    // Defense in depth: the store already refuses secret paths, so ordinary
    // tracked metadata cannot reach this branch.
    if (classifyEngineFilePath(entry.path).kind === "secret") continue;

    if (collisionRecordedPaths.has(entry.path)) {
      visitedPendingPaths.add(entry.path);
      let result:
        | { kind: "repaired" }
        | { kind: "unchanged" }
        | { kind: "unjournalable"; path: UnjournalablePath };
      try {
        result = await withCaptureMutationLock(
          rootDir,
          entry.path,
          async (resolvedTarget) => {
            const disk = await readDiskContent(resolvedTarget);
            if (disk.kind === "unreadable") {
              return {
                kind: "unjournalable",
                path: { path: entry.path, reason: "unreadable" },
              };
            }
            const current = await store.readTextFile({
              workspaceId,
              versionId: main.id,
              path: entry.path,
            });
            if (current === null) {
              console.error(
                `[desktop] shared view store lost tracked path ${entry.path} ` +
                  `in workspace ${workspaceId} version ${main.id}`,
              );
              return { kind: "unchanged" };
            }
            const alreadyMatchesGranter = diskMatchesSnapshot(disk, {
              contentKind: current.contentKind === "binary" ? "binary" : "text",
              sha256: current.sha256 ?? null,
            });
            if (disk.kind !== "absent" && !alreadyMatchesGranter) {
              return {
                kind: "unjournalable",
                path: { path: entry.path, reason: "local-collision" },
              };
            }
            if (!alreadyMatchesGranter) {
              await materializeSharedViewPaths(
                rootDir,
                workspaceId,
                [
                  {
                    path: entry.path,
                    operation: "write",
                    contentKind:
                      current.contentKind === "binary" ? "binary" : "text",
                  },
                ],
                store,
              );
            }
            return { kind: "repaired" };
          },
        );
      } catch {
        unjournalablePaths.push({ path: entry.path, reason: "unreadable" });
        continue;
      }
      if (result.kind === "repaired") {
        repairedPaths += 1;
        resolvedCollisionPaths.push(entry.path);
      } else if (result.kind === "unjournalable") {
        unjournalablePaths.push(result.path);
      }
      continue;
    }

    if (pendingPaths.has(entry.path)) {
      visitedPendingPaths.add(entry.path);
      let result:
        | { kind: "captured" }
        | { kind: "repaired" }
        | { kind: "unjournalable"; path: UnjournalablePath }
        | { kind: "unchanged" };
      try {
        result = await withCaptureMutationLock(
          rootDir,
          entry.path,
          async (resolvedTarget): Promise<
            | { kind: "captured" }
            | { kind: "repaired" }
            | { kind: "unjournalable"; path: UnjournalablePath }
            | { kind: "unchanged" }
          > => {
            let targetStat: Stats | null;
            try {
              targetStat = await lstat(resolvedTarget);
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code !== "ENOENT" && code !== "ENOTDIR") {
                throw new CapturePartialFailureError(
                  capturedPaths,
                  repairedPaths,
                  entry.path,
                  "unreadable",
                  { cause: error },
                );
              }
              targetStat = null;
            }
            // `lstat` never follows the final component, so a symlink entry
            // already answers `isFile()` false — `isSymbolicLink()` decided
            // nothing this didn't.
            if (targetStat !== null && !targetStat.isFile()) {
              return {
                kind: "unjournalable",
                path: { path: entry.path, reason: "non-file-replacement" },
              };
            }

            const disk = await readDiskContent(resolvedTarget);
            const currentSnapshot = await store.readTextFile({
              workspaceId,
              versionId: main.id,
              path: entry.path,
            });
            const currentEntry: {
              contentKind: "text" | "binary";
              sha256: string | null;
              latestMomentId: string;
            } =
              currentSnapshot === null
                ? entry
                : {
                    ...entry,
                    contentKind:
                      currentSnapshot.contentKind === "binary" ? "binary" : "text",
                    sha256: currentSnapshot.sha256 ?? null,
                    latestMomentId: currentSnapshot.latestMomentId,
                  };
            if (diskMatchesSnapshot(disk, currentEntry)) {
              return {
                kind: pendingState.recordedPaths.has(entry.path)
                  ? "repaired"
                  : "unchanged",
              };
            }

            const latestMoment = await store.getMoment({
              workspaceId,
              momentId: currentEntry.latestMomentId,
            });
            const before = latestMoment?.payload.before;
            const matchesPreimage =
              latestMoment !== null &&
              (before === null
                ? disk.kind === "absent"
                : before !== undefined && diskMatchesSnapshot(disk, before));
            if (matchesPreimage) {
              await materializeSharedViewPaths(
                rootDir,
                workspaceId,
                [
                  {
                    path: entry.path,
                    operation: "write",
                    contentKind: currentEntry.contentKind,
                  },
                ],
                store,
              );
              return { kind: "repaired" };
            }

            if (disk.kind === "absent") {
              // A pending write removes the target before it writes. An absent
              // path here is an interrupted materialization, not a delete.
              await materializeSharedViewPaths(
                rootDir,
                workspaceId,
                [
                  {
                    path: entry.path,
                    operation: "write",
                    contentKind: currentEntry.contentKind,
                  },
                ],
                store,
              );
              return { kind: "repaired" };
            }
            if (disk.kind === "untracked-content" || disk.kind === "unreadable") {
              return {
                kind: "unjournalable",
                path: unjournalableFromDisk(entry.path, disk),
              };
            }
            if (disk.kind !== "text" && disk.kind !== "binary") {
              return { kind: "unchanged" };
            }
            if (!allowLocalJournaling) {
              await rematerializeHead(entry.path, currentEntry.contentKind);
              return { kind: "repaired" };
            }
            await writeDiskContentToStore({
              store,
              workspaceId,
              versionId: main.id,
              path: entry.path,
              content: disk,
            });
            return { kind: "captured" };
          },
        );
      } catch (error) {
        if (error instanceof CapturePartialFailureError) throw error;
        const reason =
          error instanceof SharedViewTargetResolutionError ? "unreadable" : "other";
        throw new CapturePartialFailureError(
          capturedPaths,
          repairedPaths,
          entry.path,
          reason,
          { cause: error },
        );
      }
      if (result.kind === "captured") capturedPaths += 1;
      if (result.kind === "repaired") repairedPaths += 1;
      if (result.kind === "unjournalable") {
        unjournalablePaths.push(result.path);
      }
      try {
        await clearCapturePendingMarker(
          rootDir,
          entry.path,
          result.kind,
          pendingState,
        );
      } catch (error) {
        throw new CapturePartialFailureError(
          capturedPaths,
          repairedPaths,
          entry.path,
          "other",
          { cause: error },
        );
      }
      continue;
    }

    let onDisk: "file" | "directory" | "symlink" | "absent";
    // On Windows, keep this pre-lock check: resolvedShareViewTarget throws on an
    // unreadable ancestor, rejecting capture instead of recording it and continuing.
    try {
      const stat = await lstat(resolve(realRoot, entry.path));
      onDisk = stat.isSymbolicLink()
        ? "symlink"
        : stat.isDirectory()
          ? "directory"
          : "file";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        onDisk = "absent";
      } else {
        unjournalablePaths.push({ path: entry.path, reason: "unreadable" });
        continue;
      }
    }

    if (onDisk === "symlink" || onDisk === "directory") {
      unjournalablePaths.push({
        path: entry.path,
        reason: "non-file-replacement",
      });
      continue;
    }

    if (onDisk === "absent") {
      const deleted = await withCaptureMutationLock(
        rootDir,
        entry.path,
        (resolvedTarget) =>
          captureAbsentTrackedPath(
            entry.path,
            entry.contentKind === "binary" ? "binary" : "text",
            resolvedTarget,
          ),
      );
      if (typeof deleted === "object") {
        unjournalablePaths.push(deleted.path);
      } else if (deleted === "captured") {
        capturedPaths += 1;
      } else if (deleted === "repaired") {
        repairedPaths += 1;
      }
      continue;
    }

    const result = await withCaptureMutationLock(
      rootDir,
      entry.path,
      async (resolvedTarget) => {
        const disk = await readDiskContent(resolvedTarget);
        if (disk.kind === "absent") {
          return captureAbsentTrackedPath(
            entry.path,
            entry.contentKind === "binary" ? "binary" : "text",
            resolvedTarget,
          );
        }
        if (disk.kind === "untracked-content" || disk.kind === "unreadable") {
          return {
            kind: "unjournalable" as const,
            path: unjournalableFromDisk(entry.path, disk),
          };
        }
        if (disk.kind !== "text" && disk.kind !== "binary") {
          return "unchanged" as const;
        }

        const current = await store.readTextFile({
          workspaceId,
          versionId: main.id,
          path: entry.path,
        });
        if (current === null) {
          console.error(
            `[desktop] shared view store lost tracked path ${entry.path} ` +
              `in workspace ${workspaceId} version ${main.id}`,
          );
          return "unchanged" as const;
        }
        const changed =
          (current.contentKind ?? "text") !== disk.kind ||
          current.sha256 !== disk.sha256;
        if (!changed) return "unchanged" as const;

        if (!allowLocalJournaling) {
          await rematerializeHead(
            entry.path,
            current.contentKind === "binary" ? "binary" : "text",
          );
          return "repaired" as const;
        }
        await options?.beforeCaptureWrite?.(entry.path);
        await writeDiskContentToStore({
          store,
          workspaceId,
          versionId: main.id,
          path: entry.path,
          content: disk,
        });
        return "captured" as const;
      },
    );
    if (result === "captured") capturedPaths += 1;
    if (result === "repaired") repairedPaths += 1;
    if (typeof result === "object" && result.kind === "unjournalable") {
      unjournalablePaths.push(result.path);
    }
  }

  for (const path of pendingPaths) {
    if (visitedPendingPaths.has(path)) continue;
    let result:
      | { kind: "repaired" }
      | { kind: "unchanged" }
      | { kind: "unjournalable"; path: UnjournalablePath };
    try {
      result = await withCaptureMutationLock(
        rootDir,
        path,
        async (resolvedTarget): Promise<
          | { kind: "repaired" }
          | { kind: "unchanged" }
          | { kind: "unjournalable"; path: UnjournalablePath }
        > => {
          try {
            if (await pathConfirmedAbsentOnDisk(resolvedTarget)) {
              return { kind: "repaired" };
            }
          } catch {
            return {
              kind: "unjournalable",
              path: { path, reason: "unreadable" },
            };
          }

          const disk = await readDiskContent(resolvedTarget);
          if (disk.kind === "absent") return { kind: "repaired" };

          const latestMoment = await latestMomentForPath(store, workspaceId, path);
          const preimage = latestMoment?.payload.before;
          if (
            preimage !== null &&
            preimage !== undefined &&
            diskMatchesSnapshot(disk, preimage)
          ) {
            await materializeSharedViewPaths(
              rootDir,
              workspaceId,
              [{ path, operation: "delete", contentKind: "text" }],
              store,
            );
            return { kind: "repaired" };
          }

          if (disk.kind === "untracked-content" || disk.kind === "unreadable") {
            return {
              kind: "unjournalable",
              path: unjournalableFromDisk(path, disk),
            };
          }
          // The store no longer tracks this path. Readable content that does not
          // match the delete preimage belongs to the recipient, so leave it on
          // disk and outside dohc's journal.
          return { kind: "unchanged" };
        },
      );
    } catch (error) {
      if (error instanceof CapturePartialFailureError) throw error;
      const reason =
        error instanceof SharedViewTargetResolutionError ? "unreadable" : "other";
      throw new CapturePartialFailureError(
        capturedPaths,
        repairedPaths,
        path,
        reason,
        { cause: error },
      );
    }
    if (result.kind === "repaired") repairedPaths += 1;
    if (result.kind === "unjournalable") {
      unjournalablePaths.push(result.path);
    }
    try {
      await clearCapturePendingMarker(rootDir, path, result.kind, pendingState);
    } catch (error) {
      throw new CapturePartialFailureError(
        capturedPaths,
        repairedPaths,
        path,
        "other",
        { cause: error },
      );
    }
  }

  for (const path of collisionRecordedPaths) {
    if (trackedPathSet.has(path)) continue;
    let result:
      | { kind: "repaired" }
      | { kind: "unjournalable"; path: UnjournalablePath };
    try {
      result = await withCaptureMutationLock(
        rootDir,
        path,
        async (resolvedTarget) => {
          const disk = await readDiskContent(resolvedTarget);
          if (disk.kind === "unreadable") {
            return {
              kind: "unjournalable",
              path: { path, reason: "unreadable" },
            };
          }
          if (disk.kind !== "absent") {
            return {
              kind: "unjournalable",
              path: { path, reason: "local-collision" },
            };
          }
          // The granter deleted the path while the collision was unresolved,
          // and the recipient's entry is now gone too. A later re-add must not
          // inherit this stale exclusion.
          return { kind: "repaired" };
        },
      );
    } catch {
      unjournalablePaths.push({ path, reason: "unreadable" });
      continue;
    }
    if (result.kind === "repaired") {
      repairedPaths += 1;
      resolvedCollisionPaths.push(path);
    } else {
      unjournalablePaths.push(result.path);
    }
  }

  if (resolvedCollisionPaths.length > 0) {
    // A pull can record the same collision on more than one applied page or
    // retry. Once the recipient resolves that collision, none of those
    // recovery counts describe outstanding materialization work anymore.
    await clearAllPendingMaterializationPaths(
      rootDir,
      resolvedCollisionPaths,
    );
    await clearCollisionRecordPaths(rootDir, shareId, resolvedCollisionPaths);
  }

  if (
    options?.paths === undefined &&
    pendingState.pullInFlight &&
    unjournalablePaths.length === 0
  ) {
    // A crashed pull asks capture to verify every tracked path. Only that full,
    // successful pass can prove the broad marker is no longer needed; a
    // save-time scoped capture must leave it for the later full repair.
    await clearPullInFlightMarker(rootDir);
  }

  return {
    capturedPaths,
    repairedPaths,
    unjournalablePaths,
    collisionRecordQuarantined,
  };
}

export async function captureStandaloneShareViewDivergence(input: {
  rootDir: string;
  workspaceId: string;
  store: CaptureVersionedTextStore;
  pinnedSelector: unknown;
  shareId: string;
  ended: boolean;
  paths?: readonly string[];
}): Promise<CaptureSharedViewLocalDivergenceOutcome> {
  const grantedSelector = recordedShareSelector(input.pinnedSelector);
  if (grantedSelector === null) throw new SharePinInvalidError(input.shareId);
  const allowLocalJournaling = shareViewTakesLocalWrites({
    access: grantedSelector.access,
    ended: input.ended,
  });
  return captureSharedViewLocalDivergence(
    input.rootDir,
    input.workspaceId,
    input.store,
    allowLocalJournaling,
    input.shareId,
    input.paths === undefined ? undefined : { paths: input.paths },
  );
}

// One refresh pass: pull the share's filtered ops into the local store,
// materialize what changed, then commit the cursor. Revocation (or a share
// that stopped existing for this account) comes back as status "ended" —
// the local files are left exactly as they were.
export async function refreshSharedViewOnce(input: {
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
        input.preTrackedPaths === undefined
          ? undefined
          : async (paths: readonly string[]) => {
              const newlyColliding: string[] = [];
              for (const path of paths) {
                if (input.preTrackedPaths!.has(path)) continue;
                const target = await resolvedShareViewTarget(input.rootDir, path);
                let targetStat;
                try {
                  targetStat = await lstat(target);
                } catch (error) {
                  const code = (error as NodeJS.ErrnoException).code;
                  if (code === "ENOENT" || code === "ENOTDIR") continue;
                  throw error;
                }
                if (!targetStat.isSymbolicLink() && targetStat.isFile()) {
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
        unjournalablePaths.push({ path: change.path, reason: "local-collision" });
        continue;
      }

      if (input.preTrackedPaths.has(change.path)) continue;

      const target = await resolvedShareViewTarget(input.rootDir, change.path);
      let targetStat;
      try {
        targetStat = await lstat(target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        throw error;
      }
      materializationExclusions.add(change.path);
      const reason =
        targetStat.isSymbolicLink() || !targetStat.isFile()
          ? "non-file-replacement"
          : "local-collision";
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

export async function refreshCapturedShareView(
  input: ShareViewRefreshCompositionInput & {
    captured: CaptureSharedViewLocalDivergenceOutcome;
  },
): Promise<RefreshSharedViewOutcome & { collisionRecordQuarantined: boolean }> {
  const { captured, ...refreshInput } = input;
  const localChanges = captured.capturedPaths + captured.repairedPaths;
  const main = await refreshInput.store.ensureMainVersion({
    workspaceId: refreshInput.workspaceId,
  });
  if (!refreshInput.store.listTextFileMetadata) {
    throw new Error(
      "Shared view reconciliation requires file metadata listing support.",
    );
  }
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
    collisionRecordQuarantined: captured.collisionRecordQuarantined,
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
export async function reconcileStandaloneShareView(
  input: ShareViewRefreshCompositionInput & {
    ended: boolean;
    captured?: CaptureSharedViewLocalDivergenceOutcome;
  },
): Promise<StandaloneShareViewRefreshOutcome> {
  let totalLocalChanges = 0;
  try {
    const { captured: suppliedCapture, ...refreshInput } = input;
    const captured =
      suppliedCapture ?? (await captureStandaloneShareViewDivergence(input));
    totalLocalChanges = captured.capturedPaths + captured.repairedPaths;
    const outcome = await refreshCapturedShareView({
      ...refreshInput,
      captured,
    });
    return {
      ok: true,
      ...outcome,
    };
  } catch (error) {
    // A damaged pin never heals on retry; main.ts turns it into a specific
    // "record is damaged" message and depends on it escaping as a
    // rejection, not becoming a generic outcome.
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
      changedPaths: totalLocalChanges,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}
