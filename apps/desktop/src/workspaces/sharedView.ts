import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import { existingAncestor } from "./workspaceFiles";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";
import {
  isShareAccessValue,
  isShareablePathList,
  isValidShareVersionId,
} from "@dohc/security-contract/share-selector";
import type { ShareViewSelector } from "./shareViewInfo";
import {
  ShareUnavailableError,
  type PullShareViewResult,
  type ShareViewChangedPath,
  type ShareViewRefusal,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import { shareViewTakesLocalWrites } from "./shareWriteGate";
import {
  withExclusiveWorkspaceOperation,
  withOrderedWorkspaceTargetPath,
} from "./workspaceAssets";
import { readDiskContent, type DiskTextState } from "./workspaceEngineCapture";
import {
  MAX_ENGINE_CAPTURE_BINARY_BYTES,
  MAX_ENGINE_CAPTURE_TEXT_BYTES,
} from "./workspaceEngineCaptureLimits";
import type { CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";
import { formatSize } from "../plugins/pluginFormat";

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
  // Ops the pull refused. The pull skips them and keeps going, so without
  // this the view silently stops carrying part of what the granter shares.
  refusedOps: number;
  // The first refusal's message, for the UI. It names the constraint the op
  // broke; the whole list goes to the log.
  refusedDetail: string | null;
}

export type StandaloneShareViewRefreshOutcome =
  | ({ ok: true } & RefreshSharedViewOutcome)
  | { ok: false; changedPaths: number; errorMessage: string };

export interface UnjournalablePath {
  path: string;
  reason:
    | "oversized-text"
    | "oversized-binary"
    | "non-utf8"
    | "non-file-replacement"
    | "local-collision"
    | "unreadable";
}

export interface CaptureSharedViewLocalDivergenceOutcome {
  capturedPaths: number;
  repairedPaths: number;
  unjournalablePaths: UnjournalablePath[];
}

function namedPaths(paths: readonly UnjournalablePath[]): string {
  const named = paths.slice(0, 3).map((entry) => entry.path).join(", ");
  return paths.length > 3 ? `${named}, and ${paths.length - 3} more` : named;
}

export function unjournalablePathMessages(
  paths: readonly UnjournalablePath[],
): string[] {
  const groups = new Map<UnjournalablePath["reason"], UnjournalablePath[]>();
  for (const path of paths) {
    const group = groups.get(path.reason) ?? [];
    group.push(path);
    groups.set(path.reason, group);
  }
  const messages: string[] = [];
  for (const reason of [
    "oversized-text",
    "oversized-binary",
    "non-utf8",
    "non-file-replacement",
    "local-collision",
    "unreadable",
  ] as const) {
    const group = groups.get(reason);
    if (!group || group.length === 0) continue;
    const names = namedPaths(group);
    const one = group.length === 1;
    if (reason === "oversized-text") {
      messages.push(
        `${names} ${one ? "is" : "are"} larger than the ${formatSize(MAX_ENGINE_CAPTURE_TEXT_BYTES)} text limit. ` +
          `Make ${one ? "this file" : "these files"} smaller.`,
      );
    } else if (reason === "oversized-binary") {
      messages.push(
        `${names} ${one ? "is" : "are"} larger than the ${formatSize(MAX_ENGINE_CAPTURE_BINARY_BYTES)} binary limit. ` +
          `Make ${one ? "this file" : "these files"} smaller.`,
      );
    } else if (reason === "non-utf8") {
      messages.push(
        `${names} ${one ? "is" : "are"} not readable as text. ` +
          `Save ${one ? "this file" : "these files"} as UTF-8 text.`,
      );
    } else if (reason === "non-file-replacement") {
      messages.push(
        `${names} ${one ? "replaces a tracked file" : "replace tracked files"} with a folder or another entry. ` +
          `Restore ${one ? "the file" : "the files"} or move ${one ? "the conflicting entry" : "the conflicting entries"}.`,
      );
    } else if (reason === "local-collision") {
      messages.push(
        `${names} ${one ? "already has a file" : "already have files"} from this machine. ` +
          `Move or remove ${one ? "this file" : "these files"} to receive the shared ${one ? "file" : "files"}.`,
      );
    } else {
      messages.push(
        `dohc could not read ${names}. ` +
          `Close anything using ${one ? "this file" : "these files"}, or wait.`,
      );
    }
  }
  return messages;
}

export function assertShareChangesJournalable(
  paths: readonly UnjournalablePath[],
): void {
  if (paths.length === 0) return;
  const one = paths.length === 1;
  throw new Error(
    `dohc did not send your changes. ${unjournalablePathMessages(paths).join(" ")} ` +
      `Fix ${one ? "this file" : "these files"}, then send your changes again.`,
  );
}

/**
 * Raised when a share record carries no readable pinned selector, so the
 * refresh did NOT pull.
 *
 * The pin is part of the record contract: both accept paths resolve a
 * selector from the relay and write it with the record, so a record without
 * one is damaged. It is NOT repaired from the relay. Re-asking would let a
 * relay that can damage or race a record restate a wider selector and have
 * that become the pin — the exact widening the pin exists to stop. The way
 * back is the accept flow, which pins before the record exists.
 */
export class SharePinInvalidError extends Error {
  constructor(readonly shareId: string) {
    super(
      `Share ${shareId} has no readable pinned selector; ` +
        "its record is damaged and the share must be added again.",
    );
    this.name = "SharePinInvalidError";
  }
}

/**
 * A registry record is data, not a contract: read the pinned selector back
 * defensively, against the relay's OWN rules for the selector it issued.
 * Anything the relay could not have issued is damage and reads as null, which
 * fails the refresh closed rather than reaching the engine.
 *
 * The user never sees or chooses this scope. Pinning only stops the relay
 * from restating a wider one on a later pull.
 */
export function recordedShareSelector(
  value: unknown,
): ShareViewSelector | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as {
    paths?: unknown;
    versionId?: unknown;
    access?: unknown;
  };
  if (!Array.isArray(candidate.paths)) return null;
  // One rule, one place: a path the relay could not have issued (empty,
  // unnormalized, untracked, secret) must not read back as a granted one.
  if (!isShareablePathList(candidate.paths)) return null;
  // The version dimension decides whether a no-paths selector grants the whole
  // tracked workspace, so a version id the relay could not have issued ("",
  // " v1", or an unbounded one) must never read as one. Same rule, same place,
  // as the relay applies at creation.
  if (candidate.versionId !== null && !isValidShareVersionId(candidate.versionId)) {
    return null;
  }
  // Selects nothing, by the relay's own rule: `validateShareSelector` refuses
  // to create a selector with neither a path nor a version, and
  // `pathVisibleThroughShare` serves nothing through one.
  if (candidate.paths.length === 0 && candidate.versionId === null) return null;
  // The level is part of the pin (#646). A record whose level the relay could
  // not have issued is damaged the same way a bad version id is, and the
  // refresh fails closed rather than pulling at a level nobody granted.
  if (!isShareAccessValue(candidate.access)) return null;
  return {
    paths: [...(candidate.paths as string[])],
    versionId: isValidShareVersionId(candidate.versionId)
      ? candidate.versionId
      : null,
    access: candidate.access,
  };
}

/**
 * The selector to enroll this share view's sync identity with (#646 PR3-1),
 * or null when it must not enroll.
 *
 * A share view replicates through its SHARE, so it needs a sync identity of
 * its own before a local write can journal or a push can leave. This decides
 * whether to ask for one, and it fails closed on every tri-state — the same
 * guard sequence the chat push-back and the refresh already use:
 *
 * - no share view record, or the share has ended;
 * - a pinned grant this build cannot read completely (a damaged record);
 * - no dohc Cloud credentials;
 * - a session signed into a relay that is not this share's origin;
 * - a `view` share, which may push nothing, so it needs no identity and must
 *   not be given one.
 *
 * Returning null means SKIP, never fail. A share view that cannot enroll is
 * still readable, and its local writes stay local.
 */
export function shareViewIdentitySelector(input: {
  shareView:
    | {
        grantedSelector?: unknown;
        ended?: boolean;
        relayUrl?: string | null;
      }
    | null
    | undefined;
  relayUrl: string | null | undefined;
  relayUrlsMatch: (left: string, right: string) => boolean;
}): ShareViewSelector | null {
  const { shareView, relayUrl, relayUrlsMatch } = input;
  if (!shareView || shareView.ended === true) return null;
  const grantedSelector = recordedShareSelector(shareView.grantedSelector);
  if (!grantedSelector) return null;
  if (grantedSelector.access === "view") return null;
  if (!relayUrl) return null;
  if (shareView.relayUrl && !relayUrlsMatch(relayUrl, shareView.relayUrl)) {
    return null;
  }
  return grantedSelector;
}

// Containment before any disk write: the engine already restricts paths to
// validated workspace-relative ones, but a defense layer this close to
// fs writes is cheap and permanent.
function containedTarget(rootDir: string, relativePath: string): string {
  const target = resolve(rootDir, relativePath);
  const root = resolve(rootDir);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Shared view path escapes the workspace: ${relativePath}`);
  }
  return target;
}

async function resolvedShareViewTarget(
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
  const resolvedTarget = await resolvedShareViewTarget(rootDir, path);
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
    if (realAncestor !== realRoot && !realAncestor.startsWith(`${realRoot}${sep}`)) {
      throw new Error(`Shared view parent escapes the workspace: ${target}`);
    }
    await mkdir(dirname(target), { recursive: true });
    const realParent = await realpath(dirname(target));
    if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) {
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
      if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) {
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

const CAPTURE_IGNORED_DIRS = new Set([".dohc", "node_modules", ".git"]);
const PENDING_MATERIALIZATION_FILE = "pending-materialization.json";
const PULL_IN_FLIGHT_FILE = "pull-in-flight.marker";
const REFRESH_LIFECYCLE_LOCK = "refresh-lifecycle";

function pendingMaterializationPath(rootDir: string): string {
  return join(rootDir, ".dohc", PENDING_MATERIALIZATION_FILE);
}

function pullInFlightPath(rootDir: string): string {
  return join(rootDir, ".dohc", PULL_IN_FLIGHT_FILE);
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
// locks and the pending-materialization lock nest inside it as independent lock
// domains. Never acquire this lock while holding either nested lock.
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

async function writePullInFlightMarker(rootDir: string): Promise<void> {
  const metadataDir = await ensureRealMetadataDirectory(rootDir);
  const target = pullInFlightPath(rootDir);
  const temp = join(
    metadataDir,
    `.${PULL_IN_FLIGHT_FILE}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temp, "w");
    try {
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
}> {
  const verifyEveryTrackedPath = await pullMayBeInFlight(rootDir);
  const target = pendingMaterializationPath(rootDir);
  return withExclusiveWorkspaceOperation(target, async () => {
    try {
      const recordedPaths = new Set(
        Object.keys(await readPendingFileUnlocked(rootDir)),
      );
      const paths = new Set(recordedPaths);
      if (verifyEveryTrackedPath) {
        for (const path of trackedPaths) paths.add(path);
      }
      return {
        paths,
        recordedPaths,
        canClearRecord: true,
      };
    } catch (error) {
      console.error(
        `[desktop] pending materialization record at ${target} is unreadable; ` +
          "quarantining it and verifying every tracked path. Pending paths " +
          `that are no longer tracked cannot be recovered: ${String(error)}`,
      );
      const quarantine = `${target}.invalid-${Date.now()}`;
      try {
        await rename(target, quarantine);
        return {
          paths: new Set(trackedPaths),
          recordedPaths: new Set(),
          canClearRecord: true,
        };
      } catch (quarantineError) {
        console.error(
          `[desktop] could not quarantine pending materialization record at ` +
            `${target}: ${String(quarantineError)}`,
        );
        return {
          paths: new Set(trackedPaths),
          recordedPaths: new Set(),
          canClearRecord: false,
        };
      }
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
  const metadataDir = await ensureRealMetadataDirectory(rootDir);
  const target = pendingMaterializationPath(rootDir);
  const temp = join(
    metadataDir,
    `.${PENDING_MATERIALIZATION_FILE}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    // Flush before publish so a host crash cannot lose the marker and make an
    // interrupted materialization look like a user edit.
    const handle = await open(temp, "w");
    try {
      await handle.writeFile(JSON.stringify({ counts }), "utf8");
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

async function captureDiskPaths(rootDir: string): Promise<{
  filePaths: Set<string>;
  directoryPaths: Set<string>;
  unreadableDirs: Set<string>;
}> {
  const filePaths = new Set<string>();
  const directoryPaths = new Set<string>();
  const unreadableDirs = new Set<string>();
  async function walk(dir: string, relativeDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        unreadableDirs.add(relativeDir);
      }
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!CAPTURE_IGNORED_DIRS.has(entry.name)) {
          directoryPaths.add(path);
          await walk(join(dir, entry.name), path);
        }
      } else if (entry.isFile()) {
        filePaths.add(path);
      }
    }
  }
  await walk(rootDir, "");
  return { filePaths, directoryPaths, unreadableDirs };
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
  testHooks?: { beforeCaptureWrite?: (path: string) => Promise<void> },
): Promise<CaptureSharedViewLocalDivergenceOutcome> {
  const realRoot = await realpath(rootDir).catch(() => null);
  if (realRoot === null) {
    return { capturedPaths: 0, repairedPaths: 0, unjournalablePaths: [] };
  }

  const main = await store.ensureMainVersion({ workspaceId });
  if (!store.listTextFileMetadata) {
    throw new Error("Shared view reconciliation requires file metadata listing support.");
  }
  const tracked = await store.listTextFileMetadata({
    workspaceId,
    versionId: main.id,
  });
  const { filePaths, directoryPaths, unreadableDirs } =
    await captureDiskPaths(realRoot);
  const pendingState = await readPendingMaterializationPathsForCapture(
    rootDir,
    tracked.map((entry) => entry.path),
  );
  const pendingPaths = pendingState.paths;

  let capturedPaths = 0;
  let repairedPaths = 0;
  const unjournalablePaths: UnjournalablePath[] = [];
  const visitedPendingPaths = new Set<string>();
  const unreadableDirsList = [...unreadableDirs];

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

    if (pendingPaths.has(entry.path)) {
      visitedPendingPaths.add(entry.path);
      const result = await withCaptureMutationLock(
        rootDir,
        entry.path,
        async (resolvedTarget): Promise<
          | { kind: "captured" }
          | { kind: "repaired" }
          | { kind: "unjournalable"; path: UnjournalablePath }
          | { kind: "unchanged" }
        > => {
          let targetStat;
          try {
            targetStat = await lstat(resolvedTarget);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
            targetStat = null;
          }
          if (
            targetStat !== null &&
            (targetStat.isSymbolicLink() || !targetStat.isFile())
          ) {
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
      await clearCapturePendingMarker(
        rootDir,
        entry.path,
        result.kind,
        pendingState,
      );
      if (result.kind === "captured") capturedPaths += 1;
      if (result.kind === "repaired") repairedPaths += 1;
      if (result.kind === "unjournalable") {
        unjournalablePaths.push(result.path);
      }
      continue;
    }

    const belowUnreadableDirectory = unreadableDirsList.some(
      (directory) =>
        directory === "" ||
        entry.path === directory ||
        entry.path.startsWith(`${directory}/`),
    );
    if (belowUnreadableDirectory) {
      unjournalablePaths.push({ path: entry.path, reason: "unreadable" });
      continue;
    }

    let onDisk: "file" | "directory" | "symlink" | "absent";
    if (filePaths.has(entry.path)) {
      onDisk = "file";
    } else if (directoryPaths.has(entry.path)) {
      onDisk = "directory";
    } else {
      const stat = await lstat(resolve(realRoot, entry.path)).catch(() => null);
      onDisk =
        stat === null
          ? "absent"
          : stat.isSymbolicLink()
            ? "symlink"
            : stat.isDirectory()
              ? "directory"
              : "file";
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
        async (resolvedTarget): Promise<
          | "captured"
          | "repaired"
          | "unchanged"
          | { kind: "unjournalable"; path: UnjournalablePath }
        > => {
          try {
            if (!(await pathConfirmedAbsentOnDisk(resolvedTarget))) {
              return "unchanged";
            }
          } catch {
            return {
              kind: "unjournalable",
              path: { path: entry.path, reason: "unreadable" },
            };
          }
          if (!allowLocalJournaling) {
            await rematerializeHead(
              entry.path,
              entry.contentKind === "binary" ? "binary" : "text",
            );
            return "repaired";
          }
          await store.deleteTextFile({
            workspaceId,
            versionId: main.id,
            path: entry.path,
            metadata: { origin: "local-file" },
          });
          return "captured";
        },
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
          try {
            if (!(await pathConfirmedAbsentOnDisk(resolvedTarget))) {
              return "unchanged" as const;
            }
          } catch {
            return {
              kind: "unjournalable" as const,
              path: { path: entry.path, reason: "unreadable" as const },
            };
          }
          if (!allowLocalJournaling) {
            await rematerializeHead(
              entry.path,
              entry.contentKind === "binary" ? "binary" : "text",
            );
            return "repaired" as const;
          }
          await store.deleteTextFile({
            workspaceId,
            versionId: main.id,
            path: entry.path,
            metadata: { origin: "local-file" },
          });
          return "captured" as const;
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
        await testHooks?.beforeCaptureWrite?.(entry.path);
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
    const result = await withCaptureMutationLock(
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
    await clearCapturePendingMarker(rootDir, path, result.kind, pendingState);
    if (result.kind === "repaired") repairedPaths += 1;
    if (result.kind === "unjournalable") {
      unjournalablePaths.push(result.path);
    }
  }

  return { capturedPaths, repairedPaths, unjournalablePaths };
}

export async function captureStandaloneShareViewDivergence(input: {
  rootDir: string;
  workspaceId: string;
  store: CaptureVersionedTextStore;
  pinnedSelector: unknown;
  shareId: string;
  ended: boolean;
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
  );
}

// Verify the materialized projection against the local store and repair any
// drift. The pull only replays NEW relay deltas, so a mounted file modified
// or deleted locally (a rogue tool writing straight to disk — every dohc
// surface refuses) would otherwise persist while refreshes report
// "unchanged", breaking the read-only live-copy contract. Returns how many
// paths were re-materialized. Local ADDITIONS are left alone: they are
// indistinguishable from user data and harmless to the projection contract.
export async function repairSharedViewProjection(
  rootDir: string,
  workspaceId: string,
  store: CaptureVersionedTextStore,
): Promise<number> {
  // A root that doesn't exist yet (first refresh materializes it) has
  // nothing to repair.
  const maybeRealRoot = await realpath(rootDir).catch(() => null);
  if (maybeRealRoot === null) return 0;
  const realRoot: string = maybeRealRoot;
  const containsReal = (candidate: string) =>
    candidate === realRoot || candidate.startsWith(`${realRoot}${sep}`);
  // Self-heal a tampered tree: remove the first symlinked component on the
  // path (AS A LINK — rm without recursive never follows) so the
  // re-materialization below can rebuild the real directory chain instead
  // of wedging on the containment guard.
  async function healTamperedAncestors(relativePath: string): Promise<void> {
    let current: string = realRoot;
    const segments = relativePath.split("/");
    for (let index = 0; index < segments.length; index += 1) {
      current = resolve(current, segments[index]!);
      const stat = await lstat(current).catch(() => null);
      if (stat === null) return; // chain ends — nothing deeper exists
      if (stat.isSymbolicLink()) {
        await rm(current, { force: true });
        return;
      }
      // An ANCESTOR that is not a directory (a file squatting on the path)
      // blocks mkdir the same way a symlink misroutes it — remove it so the
      // real chain can rebuild. The final component is the target itself;
      // preparedTarget removes and recreates that one.
      const isAncestor = index < segments.length - 1;
      if (isAncestor && !stat.isDirectory()) {
        await rm(current, { recursive: true, force: true });
        return;
      }
    }
  }
  const damaged: ShareViewChangedPath[] = [];
  const main = await store.ensureMainVersion({ workspaceId });
  const snapshots = await store.listTextFiles({
    workspaceId,
    versionId: main.id,
  });
  for (const snapshot of snapshots) {
    const target = containedTarget(rootDir, snapshot.path);
    const contentKind = snapshot.contentKind === "binary" ? "binary" : "text";
    let intact = false;
    try {
      // REAL-parent containment before trusting anything on disk: a
      // symlinked ancestor would redirect the read to attacker-controlled
      // bytes that could pass the hash compare (CodeRabbit). Then lstat
      // the leaf: a symlink is damage regardless of what it points at.
      const realParent = await realpath(dirname(target));
      if (containsReal(realParent)) {
        const stat = await lstat(target);
        if (stat.isFile()) {
          const bytes = await readFile(target);
          if (typeof snapshot.sha256 === "string" && snapshot.sha256.length > 0) {
            intact =
              createHash("sha256").update(bytes).digest("hex") === snapshot.sha256;
          } else {
            intact = bytes.toString("utf8") === snapshot.text;
          }
        }
      }
    } catch {
      intact = false; // missing or unreadable — re-materialize
    }
    if (!intact) {
      await healTamperedAncestors(snapshot.path);
      damaged.push({ path: snapshot.path, operation: "write", contentKind });
    }
  }
  if (damaged.length > 0) {
    await materializeSharedViewPaths(rootDir, workspaceId, damaged, store);
  }
  return damaged.length;
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
  let pull;
  try {
    pull = await input.pull({
      rootDir: input.rootDir,
      workspaceId: input.workspaceId,
      relay: input.relay,
      shareId: input.shareId,
      grantedSelector,
      recordRefusals: input.recordRefusals,
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
  const unjournalablePaths = [...(input.unjournalablePaths ?? [])];
  if (input.preTrackedPaths !== undefined) {
    for (const change of pull.changedPaths) {
      if (
        materializationExclusions.has(change.path) ||
        input.preTrackedPaths.has(change.path)
      ) {
        continue;
      }
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
      unjournalablePaths.push({
        path: change.path,
        reason:
          targetStat.isSymbolicLink() || !targetStat.isFile()
            ? "non-file-replacement"
            : "local-collision",
      });
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
    await writePendingMaterializationPaths(
      input.rootDir,
      pendingMaterializationPaths,
    );
  }
  await materializeSharedViewPaths(
    input.rootDir,
    input.workspaceId,
    pathsToMaterialize,
    input.store,
  );
  if (input.trackPendingMaterialization) {
    await clearPendingMaterializationPaths(
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

export async function refreshStandaloneShareViewOnce(
  input: Parameters<typeof refreshSharedViewOnce>[0] & { ended: boolean },
): Promise<StandaloneShareViewRefreshOutcome> {
  return withShareViewRefreshLifecycleLock(input.rootDir, async () => {
    const captured = await captureStandaloneShareViewDivergence(input);
    const totalLocalChanges = captured.capturedPaths + captured.repairedPaths;
    try {
      const main = await input.store.ensureMainVersion({
        workspaceId: input.workspaceId,
      });
      if (!input.store.listTextFileMetadata) {
        throw new Error("Shared view reconciliation requires file metadata listing support.");
      }
      const preTrackedPaths = new Set(
        (
          await input.store.listTextFileMetadata({
            workspaceId: input.workspaceId,
            versionId: main.id,
          })
        ).map((entry) => entry.path),
      );
      const outcome = await refreshSharedViewOnce({
        ...input,
        excludeFromMaterialization: new Set(
          captured.unjournalablePaths.map((path) => path.path),
        ),
        unjournalablePaths: captured.unjournalablePaths,
        trackPendingMaterialization: true,
        preTrackedPaths,
      });
      return {
        ok: true,
        ...outcome,
        status:
          outcome.status === "unchanged" && totalLocalChanges > 0
            ? "updated"
            : outcome.status,
        changedPaths: outcome.changedPaths + totalLocalChanges,
      };
    } catch (error) {
      return {
        ok: false,
        changedPaths: totalLocalChanges,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
