import type { WatcherEvent } from "@dohc/workspace-core";
import { validateUserWritePath } from "@dohc/workspace-core";
import {
  classifyEngineFilePath,
  compareVersionFiles,
  createVersionedTextStore,
  type ActorNeutralWriteMetadata,
  type VersionFileChange,
  type VersionRecord,
  type VersionedTextConflictRecord,
  type VersionedTextMoment,
  type VersionedTextMomentSummary,
  type VersionedTextStore,
} from "@dohc/workspace-engine";
import { isTextMediaType, mediaTypeForPath, scanWorkspaceFiles } from "@dohc/workspace-fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { MAX_HISTORY_TEXT_SNAPSHOT_BYTES } from "./workspaceWatcher";

// PR 0M-3 watcher->engine capture + PR 0M-4 named-version operations +
// PR 0M-5 history/restore (which ended the 0M-3 interim dual-write).
//
// While a workspace's `experimental.workspaceEngineAlpha` flag is on, the
// engine is the workspace's SOLE history recorder: every settled watcher
// batch is captured into the versioned text store, the history UI reads
// engine moments, and restore routes through the engine. No legacy
// .dohc/history change set is written for flagged workspaces; unflagged
// workspaces keep the legacy path untouched. Engine state lives under
// `<root>/.dohc/engine/`.
//
// PR 0M-4: the workspace folder on disk always materializes the ACTIVE
// version (engine-owned, persisted in engine.db, default Main). Capture and
// reconciliation route to the active version — read per chain task, never
// cached across switches. Version operations (create/switch/compare/merge/
// resolve) run as tasks on the SAME chain, so they can never interleave with
// batch capture or with each other.
//
// What the engine owns (shared policy, not local heuristics):
//   - classifyEngineFilePath (workspace-engine) excludes ignored segments and
//     `.env`-style secret paths — the SAME classifier engine search uses.
//   - Only UTF-8 text files up to MAX_HISTORY_TEXT_SNAPSHOT_BYTES are
//     captured (the legacy history snapshot pipeline's text heuristics).
//     Binary, oversized, non-UTF-8, and secret files are skipped entirely —
//     no metadata-only engine moments; if a previously captured path stops
//     being engine-ownable text, it is removed from engine state so engine
//     state never goes stale-but-authoritative.
//   - The same boundary limits SWITCHING: versions cover engine-owned text
//     files; binary/secret/ignored files are untouched by a version switch
//     (the UI states this honestly).
//
// Single engine record per physical write:
//   - a settled batch carries one final on-disk state per path, so rapid
//     writes coalesce into at most one engine moment per path per batch;
//   - a batch whose content already equals engine state is a no-op (this
//     also makes startup reconciliation idempotent);
//   - engine-originated disk writes (restore flows, version switch/merge
//     materialization, coordinated renames) register expected events via
//     registerExpectedEngineEvents and the matching watcher observation skips
//     engine re-capture (consume-once with expiry, the
//     ActiveLocalOperation/expectedEvents precedent). With legacy recording
//     off for flagged workspaces this registry is the ONLY suppression a
//     self-write needs.
//
// Switch-flow crash ordering (the honest story): the engine records the
// DESTINATION as active BEFORE the disk is rewritten, and the recovery
// invariant is "disk state reconciles into whichever version is recorded as
// active". A failure mid-materialization (live error or process crash)
// therefore resolves the same way: the next reconcile — run immediately on a
// live error, or by the startup pass after a crash — captures the actual disk
// state into the destination version. Nothing is ever lost: the previous
// version's tip was captured in full before the switch began, and the
// destination's pre-switch tip remains in its moment history.
//
// Concurrency and failure:
//   - all engine work runs on one internal promise chain in the main process,
//     off the IPC hot path: batch capture, startup reconciliation, and
//     version operations are serialized against each other and never block
//     the renderer;
//   - engine failures are logged and surfaced via onError but never crash the
//     watcher (fail visible; the disk stays the source of record and the next
//     reconcile pass captures anything a failed batch missed). Version and
//     restore operations reject to their caller so the UI can surface the
//     failure.

export const EXPECTED_ENGINE_EVENT_EXPIRY_MS = 10_000;
export const MAX_ENGINE_CAPTURE_TEXT_BYTES = MAX_HISTORY_TEXT_SNAPSHOT_BYTES;

export interface ExpectedEngineEvent {
  path: string;
  operation: "write" | "delete";
  // sha256 of the written UTF-8 text; required for writes so a LATER user
  // edit to the same path can never be swallowed by a stale registration.
  sha256?: string;
}

export interface WorkspaceVersionsSnapshot {
  versions: VersionRecord[];
  activeVersionId: string;
}

export interface WorkspaceVersionSwitchResult {
  activeVersionId: string;
  changedFileCount: number;
}

export interface WorkspaceVersionMergeResult {
  mergedFileCount: number;
  unchangedFileCount: number;
  conflicts: VersionedTextConflictRecord[];
}

// One page of the ACTIVE version's timeline (the folder shows the active
// version, so its history is what the history UI shows).
export interface WorkspaceEngineMomentPage {
  moments: VersionedTextMomentSummary[];
  nextBeforeMomentOrder: number | null;
  latestMomentOrder: number;
  activeVersionId: string;
}

export interface WorkspaceEngineRestoreResult {
  // "text" wrote the pre-moment snapshot back; "deleted" removed a file the
  // moment had created.
  restored: "text" | "deleted";
  // The forward moment the restore recorded (restore never rewrites history).
  // Undo = restore to before THIS moment through the same API.
  restoredMomentId: string;
  path: string;
}

// Finishes an engine-coordinated single-file rename: call with ok=true after
// the disk move succeeded, ok=false to roll the engine rename back.
export type WorkspaceEngineRenameFinisher = (ok: boolean) => Promise<void>;

export type WorkspaceVersionConflictResolution =
  | { kind: "keep-current" }
  | { kind: "apply-incoming" }
  | { kind: "apply-merged"; text: string };

export interface WorkspaceVersionConflictResolveOutcome {
  conflict: VersionedTextConflictRecord;
  remaining: VersionedTextConflictRecord[];
}

export interface WorkspaceEngineCapture {
  // Kicks the background startup reconciliation (closed-period edits — and,
  // after a mid-switch crash, the recovery pass). Runs on the capture chain,
  // so it cannot interleave with live batch capture.
  start(): void;
  // Enqueues a settled watcher batch for engine capture. Synchronous and
  // non-throwing: the watcher's record chain never waits on the engine.
  captureBatch(events: readonly WatcherEvent[]): void;
  // Registers engine-originated disk writes the watcher is about to observe;
  // matching observations skip engine re-capture. Returns a cancel function.
  registerExpectedEngineEvents(events: readonly ExpectedEngineEvent[]): () => void;
  // Version operations (PR 0M-4). Mutating operations run on the capture
  // chain; reads are served directly by the store (which already orders
  // reads after its own writes). All reject to the caller on failure.
  listVersions(): Promise<WorkspaceVersionsSnapshot>;
  // Creates a named version forked from the ACTIVE version's current disk
  // state and makes it active. Disk content is untouched (the fork starts as
  // an identical copy).
  createVersion(name: string): Promise<WorkspaceVersionsSnapshot>;
  // Captures current disk state into the active version, then rewrites the
  // workspace folder to the target version's engine-owned text files.
  switchVersion(versionId: string): Promise<WorkspaceVersionSwitchResult>;
  // Changed paths between a version and a target (default Main), computed
  // after capturing the latest disk edits so the answer is never stale.
  compareVersions(
    sourceVersionId: string,
    targetVersionId?: string,
  ): Promise<VersionFileChange[]>;
  // Merges a named version into Main through the engine merge API. When Main
  // is the active version, merged results are materialized to disk.
  mergeVersionIntoMain(sourceVersionId: string): Promise<WorkspaceVersionMergeResult>;
  listOpenConflicts(): Promise<VersionedTextConflictRecord[]>;
  resolveConflict(
    conflictId: string,
    resolution: WorkspaceVersionConflictResolution,
  ): Promise<WorkspaceVersionConflictResolveOutcome>;
  // History reads (PR 0M-5): the ACTIVE version's moment timeline and one
  // moment's full payload. Reads DRAIN the capture chain first so the
  // timeline the UI paints always includes the batch whose onRecorded
  // notification triggered the refresh (read-your-writes; the chain never
  // rejects, so this can only wait, not fail).
  listMoments(input?: {
    limit?: number;
    beforeMomentOrder?: number;
  }): Promise<WorkspaceEngineMomentPage>;
  readMoment(momentId: string): Promise<VersionedTextMoment | null>;
  // Engine restore (PR 0M-5): returns the file to its state BEFORE the given
  // moment. Runs on the capture chain; records a forward "Restored <file>"
  // moment (history is never rewritten) and materializes the result to disk
  // with expected-event registration so the watcher's observation of our own
  // write is not re-captured. Undo = call again with the returned
  // restoredMomentId.
  restoreFileToBeforeMoment(momentId: string): Promise<WorkspaceEngineRestoreResult>;
  // Stable-identity seam for the linked-chat rail: the active version's
  // engine object id for a path, or null when the engine does not own it.
  fileObjectIdForPath(path: string): Promise<string | null>;
  // Engine-coordinated single-file rename (product rename flows call this
  // BEFORE moving the file on disk). When both sides are engine-owned text,
  // the engine records a rename moment — preserving the stable object id the
  // linked-chat rail keys on — and registers the expected watcher
  // observations. All other shapes (folders, binary, untracked) return a
  // no-op finisher and are captured as delete+write by the normal path.
  beginFileRename(fromPath: string, toPath: string): Promise<WorkspaceEngineRenameFinisher>;
  // Resolves when everything enqueued so far has been captured (tests).
  flush(): Promise<void>;
  // Stops accepting work and resolves once in-flight capture is durably
  // written — the workspace shutdown chain awaits this so the last capture
  // is never dropped.
  stop(): Promise<void>;
}

export interface WorkspaceEngineCaptureOptions {
  workspaceId: string;
  rootPath: string;
  // Injectable for tests; defaults to the workspace's .dohc/engine store.
  store?: VersionedTextStore;
  now?: () => number;
  onError?: (context: string, error: unknown) => void;
  // Outcome of each background HISTORY-CAPTURE task (batch capture and
  // reconciliation passes). With the engine as a flagged workspace's SOLE
  // recorder, a persistently failing store means history capture fails
  // silently — this hook lets the product raise a capture-failure notice on
  // ok:false and clear it when a later pass succeeds. Deliberately narrower
  // than onError: version/restore operations reject to their caller (the UI
  // surfaces those directly) and best-effort rename coordination falls back
  // to plain capture, so neither means history is silently missing.
  onCaptureOutcome?: (outcome: { ok: boolean }) => void;
  // Injectable disk mutation seam so tests can exercise mid-switch failures
  // without real fs faults. Defaults to careful direct fs writes with
  // containment checks.
  diskWriter?: EngineDiskWriter;
}

export interface EngineDiskWriter {
  writeTextFile(absolutePath: string, text: string): Promise<void>;
  deletePath(absolutePath: string): Promise<void>;
}

const ENGINE_MAIN_VERSION_ID = "main";

interface RegisteredExpectedEngineEvent extends ExpectedEngineEvent {
  expiresAtMs: number;
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

type DiskTextState =
  // Confirmed absent (ENOENT/ENOTDIR): the engine file, if any, was deleted.
  | { kind: "absent" }
  // Engine-ownable UTF-8 text within the size cap.
  | { kind: "text"; text: string; sha256: string }
  // Present but not engine-ownable (binary, oversized, or non-UTF-8 text).
  | { kind: "untracked-content" }
  // Transiently unreadable (EACCES/EBUSY/...): leave engine state alone.
  | { kind: "unreadable" };

async function readDiskTextState(rootPath: string, path: string): Promise<DiskTextState> {
  const absolute = join(rootPath, path);
  try {
    // lstat, never stat: a symlink LEAF dereferences outside the workspace
    // (notes/today.md -> /outside/secret.md), and capturing its target would
    // record foreign content into durable engine history as owned text. The
    // scan path (scanWorkspaceFiles) and versionedFileWorkspace already
    // refuse symlinks; the live watcher can still emit the symlink path
    // itself, so this shared read refuses it too.
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) return { kind: "untracked-content" };
    if (!info.isFile()) return { kind: "untracked-content" };
    if (!isTextMediaType(mediaTypeForPath(path), path)) return { kind: "untracked-content" };
    if (info.size > MAX_ENGINE_CAPTURE_TEXT_BYTES) return { kind: "untracked-content" };
    const bytes = await readFile(absolute);
    if (bytes.length > MAX_ENGINE_CAPTURE_TEXT_BYTES) return { kind: "untracked-content" };
    const text = bytes.toString("utf8");
    // The engine only stores text that round-trips through UTF-8; anything
    // else is binary in disguise, not engine-ownable.
    if (!Buffer.from(text, "utf8").equals(bytes)) return { kind: "untracked-content" };
    return { kind: "text", text, sha256: sha256Utf8(text) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "unreadable" };
  }
}

// A disk mutation the engine performs when materializing a version's text
// files (switch, merge into the active version, conflict resolution).
type MaterializeOperation =
  | { kind: "write"; path: string; text: string }
  | { kind: "delete"; path: string };

function assertEngineWritablePath(path: string): void {
  const check = validateUserWritePath(path);
  if (!check.ok || check.normalized !== path) {
    throw new Error(`Engine refused to write unsafe workspace path: ${path}`);
  }
  if (classifyEngineFilePath(path).kind !== "tracked") {
    throw new Error(`Engine refused to write non-engine-owned path: ${path}`);
  }
}

// Exported for direct regression tests of the containment invariants below;
// production code always goes through WorkspaceEngineCaptureOptions.diskWriter
// defaulting.
export function createDefaultDiskWriter(rootPath: string): EngineDiskWriter {
  // Symlink containment (the same defense versionedFileWorkspace applies to
  // its write path):
  //   1. BEFORE mkdir, the nearest EXISTING ancestor must resolve inside the
  //      workspace root, so `mkdir -p` can never create directories through
  //      a symlinked ancestor outside the workspace;
  //   2. after mkdir, the real parent directory must still resolve inside
  //      the root;
  //   3. the leaf itself must not be a symlink — writeFile follows symlinks,
  //      so an unchecked leaf would redirect engine content outside the
  //      workspace (or clobber an arbitrary user file).
  async function assertContainedDir(absoluteDir: string): Promise<void> {
    const [realRoot, realDir] = await Promise.all([
      realpath(resolve(rootPath)),
      realpath(absoluteDir),
    ]);
    if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
      throw new Error(`Engine write escaped the workspace root: ${absoluteDir}`);
    }
  }
  async function assertContainedNearestAncestor(absoluteDir: string): Promise<void> {
    let candidate = resolve(absoluteDir);
    const rootResolved = resolve(rootPath);
    for (;;) {
      try {
        await assertContainedDir(candidate);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Missing segment: walk up to the nearest existing ancestor. Any
        // other failure (including escape) is a refusal.
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
      const parent = dirname(candidate);
      if (parent === candidate || candidate === rootResolved) {
        throw new Error(`Engine write escaped the workspace root: ${absoluteDir}`);
      }
      candidate = parent;
    }
  }
  async function assertLeafNotSymlink(absolutePath: string): Promise<void> {
    try {
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        throw new Error(`Engine refused to write through a symlink: ${absolutePath}`);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw error;
    }
  }
  return {
    async writeTextFile(absolutePath, text) {
      const dir = dirname(absolutePath);
      await assertContainedNearestAncestor(dir);
      await mkdir(dir, { recursive: true });
      await assertContainedDir(dir);
      await assertLeafNotSymlink(absolutePath);
      await writeFile(absolutePath, text, "utf8");
    },
    async deletePath(absolutePath) {
      await assertContainedDir(dirname(absolutePath));
      // rm on a symlink removes the link itself, never the target, so a
      // symlink leaf needs no extra handling here.
      await rm(absolutePath, { force: true });
    },
  };
}

export function createWorkspaceEngineCapture(
  options: WorkspaceEngineCaptureOptions,
): WorkspaceEngineCapture {
  const { workspaceId, rootPath } = options;
  const now = options.now ?? (() => Date.now());
  const onError =
    options.onError ??
    ((context: string, error: unknown) => {
      console.error(
        `[desktop] workspace engine capture ${context} failed for ${rootPath}:`,
        error,
      );
    });
  const diskWriter = options.diskWriter ?? createDefaultDiskWriter(rootPath);

  let store: VersionedTextStore | null = options.store ?? null;
  let expectedEvents: RegisteredExpectedEngineEvent[] = [];
  let stopped = false;

  // THE serialization point: batch capture, reconciliation, and version
  // operations all run here, strictly in order. A failed background task logs
  // and the chain stays alive; a failed version operation rejects to its
  // caller and the chain stays alive. Work enqueued before stop() still runs
  // (stop refuses only NEW work), so the final settled batch is never dropped
  // on shutdown.
  let chain: Promise<void> = Promise.resolve();
  function enqueue(context: string, task: () => Promise<void>): void {
    if (stopped) return;
    chain = chain.then(async () => {
      try {
        await task();
      } catch (error) {
        onError(context, error);
      }
    });
  }

  // Chain task whose result (or failure) belongs to the caller — used by the
  // version operations so the IPC layer can surface real errors. The chain
  // itself never rejects.
  function enqueueResult<T>(context: string, task: () => Promise<T>): Promise<T> {
    if (stopped) {
      return Promise.reject(
        new Error(`Workspace engine is shutting down (${context}).`),
      );
    }
    const result = chain.then(task);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  let initialized: Promise<VersionedTextStore> | null = null;
  function engineStore(): Promise<VersionedTextStore> {
    if (!initialized) {
      const attempt = (async () => {
        store ??= createVersionedTextStore(rootPath);
        await store.ensureMainVersion({ workspaceId });
        return store;
      })();
      initialized = attempt;
      // A failed open must not be cached forever: the next capture task
      // retries, so a transient failure can recover (and clear the
      // capture-failure notice) instead of poisoning the whole session.
      attempt.catch(() => {
        if (initialized === attempt) initialized = null;
      });
    }
    return initialized;
  }

  // The active version is read PER TASK on the chain — never cached across
  // tasks — so a batch enqueued before a switch and captured after it can
  // never write into the wrong version.
  async function activeVersionIdOf(engine: VersionedTextStore): Promise<string> {
    const active = await engine.getActiveVersion({ workspaceId });
    return active?.id ?? ENGINE_MAIN_VERSION_ID;
  }

  function consumeExpectedEvent(
    operation: "write" | "delete",
    path: string,
    sha256?: string,
  ): boolean {
    const nowMs = now();
    expectedEvents = expectedEvents.filter((event) => event.expiresAtMs > nowMs);
    const index = expectedEvents.findIndex(
      (event) =>
        event.path === path &&
        event.operation === operation &&
        (operation === "delete" || event.sha256 === sha256),
    );
    if (index < 0) return false;
    expectedEvents.splice(index, 1);
    return true;
  }

  function registerExpectedEngineEvents(
    events: readonly ExpectedEngineEvent[],
  ): () => void {
    const registered: RegisteredExpectedEngineEvent[] = events.map((event) => ({
      ...event,
      expiresAtMs: now() + EXPECTED_ENGINE_EVENT_EXPIRY_MS,
    }));
    expectedEvents.push(...registered);
    return () => {
      expectedEvents = expectedEvents.filter((event) => !registered.includes(event));
    };
  }

  async function deleteIfTracked(
    engine: VersionedTextStore,
    versionId: string,
    path: string,
    metadata: ActorNeutralWriteMetadata,
  ): Promise<boolean> {
    const current = await engine.readTextFile({ workspaceId, versionId, path });
    if (!current) return false;
    await engine.deleteTextFile({ workspaceId, versionId, path, metadata });
    return true;
  }

  async function writeIfChanged(
    engine: VersionedTextStore,
    versionId: string,
    path: string,
    disk: { text: string; sha256: string },
    metadata: ActorNeutralWriteMetadata,
  ): Promise<boolean> {
    const current = await engine.readTextFile({ workspaceId, versionId, path });
    // Content equality is the no-op rule: it keeps one engine record per
    // physical write across settle windows and makes reconciliation
    // idempotent.
    if (current && current.text === disk.text) return false;
    await engine.writeTextFile({ workspaceId, versionId, path, text: disk.text, metadata });
    return true;
  }

  async function captureOnePath(
    engine: VersionedTextStore,
    versionId: string,
    event: WatcherEvent,
    metadata: ActorNeutralWriteMetadata,
  ): Promise<void> {
    if (classifyEngineFilePath(event.path).kind !== "tracked") return;
    // Deletes trust the watcher's confirmed-absent check; updates re-read the
    // CURRENT disk state so rapid successive writes coalesce to the final
    // content instead of replaying stale event snapshots.
    if (event.operation === "delete") {
      if (consumeExpectedEvent("delete", event.path)) return;
      await deleteIfTracked(engine, versionId, event.path, metadata);
      return;
    }
    const disk = await readDiskTextState(rootPath, event.path);
    if (disk.kind === "unreadable") return;
    if (disk.kind === "absent") {
      if (consumeExpectedEvent("delete", event.path)) return;
      await deleteIfTracked(engine, versionId, event.path, metadata);
      return;
    }
    if (disk.kind === "untracked-content") {
      // The path stopped being engine-ownable text: retire it from engine
      // state rather than leaving a stale snapshot behind.
      await deleteIfTracked(engine, versionId, event.path, {
        ...metadata,
        summary: "Stopped tracking non-text content",
      });
      return;
    }
    if (consumeExpectedEvent("write", event.path, disk.sha256)) return;
    await writeIfChanged(engine, versionId, event.path, disk, metadata);
  }

  // Disk -> engine reconciliation for one version: after it completes, the
  // version's engine state mirrors the workspace folder's engine-ownable text
  // files exactly. Used for startup (closed-period edits), as the
  // nothing-is-ever-lost capture before a switch, and as the crash-honest
  // recovery when a switch fails mid-materialization.
  async function reconcileDiskIntoVersion(
    engine: VersionedTextStore,
    versionId: string,
    metadata: ActorNeutralWriteMetadata,
  ): Promise<void> {
    const scanned = await scanWorkspaceFiles(rootPath);
    const diskPaths = new Set<string>();
    for (const file of scanned) {
      if (classifyEngineFilePath(file.path).kind !== "tracked") continue;
      diskPaths.add(file.path);
      const disk = await readDiskTextState(rootPath, file.path);
      if (disk.kind === "unreadable") continue;
      if (disk.kind === "text") {
        await writeIfChanged(engine, versionId, file.path, disk, metadata);
      } else {
        // absent (raced a delete) or no longer engine-ownable text.
        await deleteIfTracked(engine, versionId, file.path, metadata);
        diskPaths.delete(file.path);
      }
    }
    // Files the engine tracked that no longer exist on disk were deleted
    // outside a live capture window; reconcile the deletions too.
    const tracked = await engine.listTextFiles({ workspaceId, versionId });
    for (const snapshot of tracked) {
      if (diskPaths.has(snapshot.path)) continue;
      await deleteIfTracked(engine, versionId, snapshot.path, metadata);
    }
  }

  async function reconcile(): Promise<void> {
    const engine = await engineStore();
    // One actor-neutral correlation id ties the pass's per-file moments
    // together as "reconciled offline edits" without inventing an author.
    const metadata: ActorNeutralWriteMetadata = {
      origin: "local-file",
      summary: "Reconciled offline edits",
      correlationId: `reconcile-${randomUUID()}`,
    };
    // Routes to the ACTIVE version: after a mid-switch crash this is the
    // recovery pass (the destination was recorded active before the disk was
    // rewritten, so the actual disk state reconciles into it).
    const versionId = await activeVersionIdOf(engine);
    await reconcileDiskIntoVersion(engine, versionId, metadata);
  }

  // Applies engine-owned text state to the workspace folder, registering
  // every write/delete as an expected engine event (sha256 for writes) so the
  // watcher's observation of our own writes never re-captures them. Throws on
  // the first failed operation; the failed operation's registration is
  // cancelled so it can never swallow a later real user edit.
  async function materialize(operations: readonly MaterializeOperation[]): Promise<void> {
    for (const operation of operations) {
      assertEngineWritablePath(operation.path);
      const absolute = join(rootPath, operation.path);
      const cancel =
        operation.kind === "write"
          ? registerExpectedEngineEvents([
              { path: operation.path, operation: "write", sha256: sha256Utf8(operation.text) },
            ])
          : registerExpectedEngineEvents([
              { path: operation.path, operation: "delete" },
            ]);
      try {
        if (operation.kind === "write") {
          await diskWriter.writeTextFile(absolute, operation.text);
        } else {
          await diskWriter.deletePath(absolute);
        }
      } catch (error) {
        cancel();
        throw new Error(
          `Could not update ${operation.path} on disk: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    }
  }

  // Diff a version's engine state against the CURRENT disk state and plan the
  // disk mutations that make the folder show that version. Binary, secret,
  // ignored, oversized, and transiently unreadable paths are never touched.
  async function planMaterialization(
    engine: VersionedTextStore,
    targetVersionId: string,
    previousVersionId: string,
  ): Promise<MaterializeOperation[]> {
    const targetFiles = await engine.listTextFiles({
      workspaceId,
      versionId: targetVersionId,
    });
    const targetPaths = new Set(targetFiles.map((file) => file.path));
    const operations: MaterializeOperation[] = [];
    for (const file of targetFiles) {
      const disk = await readDiskTextState(rootPath, file.path);
      // Never clobber content the engine does not own (binary-in-disguise,
      // oversized) and never write over a transiently unreadable path.
      if (disk.kind === "untracked-content" || disk.kind === "unreadable") continue;
      if (disk.kind === "text" && disk.text === file.text) continue;
      operations.push({ kind: "write", path: file.path, text: file.text });
    }
    // Only paths the PREVIOUS version tracked are deletable: the pre-switch
    // reconcile captured every engine-ownable text file into it, so this set
    // is exactly "text files the engine owns on disk right now".
    const previousFiles = await engine.listTextFiles({
      workspaceId,
      versionId: previousVersionId,
    });
    for (const file of previousFiles) {
      if (targetPaths.has(file.path)) continue;
      const disk = await readDiskTextState(rootPath, file.path);
      if (disk.kind !== "text") continue;
      operations.push({ kind: "delete", path: file.path });
    }
    return operations;
  }

  async function versionsSnapshot(
    engine: VersionedTextStore,
  ): Promise<WorkspaceVersionsSnapshot> {
    const [versions, activeVersionId] = await Promise.all([
      engine.listVersions({ workspaceId }),
      activeVersionIdOf(engine),
    ]);
    return { versions, activeVersionId };
  }

  // Wraps one background capture task so its overall outcome (ok / failed)
  // reaches onCaptureOutcome, whether the failure was a thrown task (store
  // unavailable) or per-path errors the task swallowed to keep the batch
  // going. Rethrows so enqueue's catch still logs via onError.
  async function reportCaptureOutcome(task: () => Promise<boolean>): Promise<void> {
    let ok = false;
    try {
      ok = await task();
    } finally {
      options.onCaptureOutcome?.({ ok });
    }
  }

  return {
    start() {
      enqueue("startup reconciliation", () =>
        reportCaptureOutcome(async () => {
          await reconcile();
          return true;
        }),
      );
    },

    captureBatch(events) {
      if (events.length === 0) return;
      const batch = events.map((event) => ({ ...event }));
      enqueue("batch capture", () =>
        reportCaptureOutcome(async () => {
          const engine = await engineStore();
          const versionId = await activeVersionIdOf(engine);
          const metadata: ActorNeutralWriteMetadata = { origin: "local-file" };
          let pathFailures = 0;
          for (const event of batch) {
            try {
              await captureOnePath(engine, versionId, event, metadata);
            } catch (error) {
              // One bad path must not drop the rest of the batch.
              pathFailures += 1;
              onError(`batch capture of ${event.path}`, error);
            }
          }
          return pathFailures === 0;
        }),
      );
    },

    registerExpectedEngineEvents,

    async listVersions() {
      const engine = await engineStore();
      return versionsSnapshot(engine);
    },

    createVersion(name) {
      return enqueueResult("create version", async () => {
        const engine = await engineStore();
        const fromVersionId = await activeVersionIdOf(engine);
        // Fork from exactly what's on disk right now — capture the latest
        // edits first so the new version starts as a faithful copy.
        await reconcileDiskIntoVersion(engine, fromVersionId, {
          origin: "local-file",
          summary: "Saved latest edits",
          correlationId: `version-create-${randomUUID()}`,
        });
        const version = await engine.createNamedVersion({
          workspaceId,
          name,
          fromVersionId,
        });
        // Create-and-switch: the fork is content-identical to the disk, so no
        // materialization is needed.
        await engine.setActiveVersion({ workspaceId, versionId: version.id });
        return versionsSnapshot(engine);
      });
    },

    switchVersion(versionId) {
      return enqueueResult("switch version", async () => {
        const engine = await engineStore();
        const fromVersionId = await activeVersionIdOf(engine);
        if (versionId === fromVersionId) {
          return { activeVersionId: fromVersionId, changedFileCount: 0 };
        }
        // Fail closed before any mutation: an unknown target throws here.
        await engine.listTextFiles({ workspaceId, versionId });
        // Nothing is ever lost: the current disk state (including edits still
        // inside the watcher settle window) is captured into the version the
        // user is leaving.
        const correlationId = `version-switch-${randomUUID()}`;
        await reconcileDiskIntoVersion(engine, fromVersionId, {
          origin: "local-file",
          summary: "Saved latest edits before switching versions",
          correlationId,
        });
        const operations = await planMaterialization(engine, versionId, fromVersionId);
        // Record the destination BEFORE rewriting the disk (see the module
        // note on crash ordering): recovery always reconciles disk state into
        // the version recorded as active.
        await engine.setActiveVersion({ workspaceId, versionId });
        try {
          await materialize(operations);
        } catch (error) {
          // Live-failure recovery mirrors crash recovery: capture the actual
          // (possibly partial) disk state into the now-active destination so
          // engine and disk agree, then surface the failure.
          await reconcileDiskIntoVersion(engine, versionId, {
            origin: "local-file",
            summary: "Recovered from an interrupted version switch",
            correlationId,
          }).catch((recoveryError) => {
            onError("switch recovery reconciliation", recoveryError);
          });
          throw error;
        }
        return { activeVersionId: versionId, changedFileCount: operations.length };
      });
    },

    compareVersions(sourceVersionId, targetVersionId = ENGINE_MAIN_VERSION_ID) {
      return enqueueResult("compare versions", async () => {
        const engine = await engineStore();
        // Capture the latest disk edits first so the comparison reflects what
        // the user actually sees in the folder.
        const activeVersionId = await activeVersionIdOf(engine);
        await reconcileDiskIntoVersion(engine, activeVersionId, {
          origin: "local-file",
          summary: "Saved latest edits",
          correlationId: `version-compare-${randomUUID()}`,
        });
        return compareVersionFiles(engine, {
          workspaceId,
          sourceVersionId,
          targetVersionId,
        });
      });
    },

    mergeVersionIntoMain(sourceVersionId) {
      return enqueueResult("merge version into Main", async () => {
        const engine = await engineStore();
        const activeVersionId = await activeVersionIdOf(engine);
        const correlationId = `version-merge-${randomUUID()}`;
        // Capture the latest disk edits so the merge sees them (whichever
        // side is active).
        await reconcileDiskIntoVersion(engine, activeVersionId, {
          origin: "local-file",
          summary: "Saved latest edits",
          correlationId,
        });
        const versions = await engine.listVersions({ workspaceId });
        const source = versions.find((version) => version.id === sourceVersionId);
        if (!source || source.kind !== "named") {
          throw new Error("Only a named version can merge into Main.");
        }
        const metadata: ActorNeutralWriteMetadata = {
          origin: "api",
          summary: `Merged version "${source.name}" into Main`,
          correlationId,
        };
        // Paths identical on both sides need no merge; everything else goes
        // through the engine's three-way per-file merge (which preserves
        // base/current/incoming when it conflicts).
        const changes = await compareVersionFiles(engine, {
          workspaceId,
          sourceVersionId,
          targetVersionId: ENGINE_MAIN_VERSION_ID,
        });
        // Re-running the merge RESUMES: a path that already has an open
        // conflict for this version pair re-surfaces that conflict instead of
        // recording a duplicate.
        const openConflicts = await engine.listTextConflicts({
          workspaceId,
          status: "open",
        });
        const openConflictByPath = new Map(
          openConflicts
            .filter(
              (conflict) =>
                conflict.sourceVersionId === sourceVersionId &&
                conflict.targetVersionId === ENGINE_MAIN_VERSION_ID,
            )
            .map((conflict) => [conflict.path, conflict]),
        );
        const materializations: MaterializeOperation[] = [];
        const conflicts: VersionedTextConflictRecord[] = [];
        let mergedFileCount = 0;
        let unchangedFileCount = 0;
        for (const change of changes) {
          const existingConflict = openConflictByPath.get(change.path);
          if (existingConflict) {
            conflicts.push(existingConflict);
            continue;
          }
          const result = await engine.mergeTextFileFromVersion({
            workspaceId,
            targetVersionId: ENGINE_MAIN_VERSION_ID,
            sourceVersionId,
            path: change.path,
            metadata,
          });
          if (result.kind === "unchanged") {
            unchangedFileCount += 1;
            continue;
          }
          if (result.kind === "conflict") {
            conflicts.push(result.conflict);
            continue;
          }
          mergedFileCount += 1;
          if (result.operation === "write") {
            materializations.push({
              kind: "write",
              path: change.path,
              text: result.write.snapshot.text,
            });
          } else {
            materializations.push({ kind: "delete", path: change.path });
          }
        }
        // The folder shows the active version; only a merge into the active
        // version changes what is on disk.
        if (activeVersionId === ENGINE_MAIN_VERSION_ID) {
          await materialize(materializations);
        }
        return { mergedFileCount, unchangedFileCount, conflicts };
      });
    },

    async listOpenConflicts() {
      const engine = await engineStore();
      return engine.listTextConflicts({ workspaceId, status: "open" });
    },

    resolveConflict(conflictId, resolution) {
      return enqueueResult("resolve conflict", async () => {
        const engine = await engineStore();
        const result = await engine.resolveTextConflict({
          workspaceId,
          conflictId,
          resolution,
          metadata: {
            origin: "api",
            summary: "Resolved a merge conflict",
            correlationId: `conflict-${conflictId}`,
          },
        });
        // Materialize only when the resolution changed the ACTIVE version's
        // state (keep-current writes nothing; a resolution into a version
        // that is not on disk changes nothing visible).
        const activeVersionId = await activeVersionIdOf(engine);
        if (result.conflict.targetVersionId === activeVersionId) {
          if (result.write) {
            await materialize([
              {
                kind: "write",
                path: result.write.snapshot.path,
                text: result.write.snapshot.text,
              },
            ]);
          } else if (result.delete) {
            await materialize([{ kind: "delete", path: result.delete.before.path }]);
          }
        }
        const remaining = await engine.listTextConflicts({
          workspaceId,
          status: "open",
        });
        return { conflict: result.conflict, remaining };
      });
    },

    async listMoments(input = {}) {
      await chain;
      const engine = await engineStore();
      const activeVersionId = await activeVersionIdOf(engine);
      const page = await engine.listMoments({
        workspaceId,
        versionId: activeVersionId,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.beforeMomentOrder !== undefined
          ? { beforeMomentOrder: input.beforeMomentOrder }
          : {}),
      });
      return { ...page, activeVersionId };
    },

    async readMoment(momentId) {
      await chain;
      const engine = await engineStore();
      return engine.getMoment({ workspaceId, momentId });
    },

    restoreFileToBeforeMoment(momentId) {
      return enqueueResult("restore file", async () => {
        const engine = await engineStore();
        const activeVersionId = await activeVersionIdOf(engine);
        const moment = await engine.getMoment({ workspaceId, momentId });
        if (!moment) {
          throw new Error("This history moment is no longer available.");
        }
        if (moment.versionId !== activeVersionId) {
          throw new Error(
            "This moment belongs to a different version. Switch to that version to restore it.",
          );
        }
        if (moment.operation === "rename") {
          throw new Error("A rename can't be restored directly.");
        }
        const path = moment.path;
        const correlationId = `restore-${randomUUID()}`;
        // Capture the file's latest disk state first so a restore can never
        // destroy an edit the engine has not recorded yet — the pre-restore
        // content stays one moment back in history.
        const disk = await readDiskTextState(rootPath, path);
        if (disk.kind === "unreadable") {
          throw new Error(`Could not read the current ${path} on disk.`);
        }
        if (disk.kind === "untracked-content") {
          throw new Error(
            `Only text files can be restored — ${path} is no longer a text file.`,
          );
        }
        const saveMetadata: ActorNeutralWriteMetadata = {
          origin: "local-file",
          summary: "Saved latest edits",
          correlationId,
        };
        if (disk.kind === "text") {
          await writeIfChanged(engine, activeVersionId, path, disk, saveMetadata);
        } else {
          // Confirmed absent: reconcile the deletion so engine and disk agree
          // before the restore moment is recorded.
          await deleteIfTracked(engine, activeVersionId, path, saveMetadata);
        }
        const target = moment.payload.before;
        const metadata: ActorNeutralWriteMetadata = {
          origin: "restore",
          summary: `Restored ${path}`,
          correlationId,
        };
        const current = await engine.readTextFile({
          workspaceId,
          versionId: activeVersionId,
          path,
        });
        if (target) {
          if (current && current.text === target.text) {
            // Already in the pre-moment state. Returning the SAME moment id
            // keeps undo a no-op (undoing an idempotent restore restores the
            // identical state again).
            return { restored: "text" as const, restoredMomentId: momentId, path };
          }
          const result = await engine.writeTextFile({
            workspaceId,
            versionId: activeVersionId,
            path,
            text: target.text,
            metadata,
          });
          await materialize([{ kind: "write", path, text: target.text }]);
          return {
            restored: "text" as const,
            restoredMomentId: result.moment.id,
            path,
          };
        }
        // The moment created the file: restoring to before it removes it.
        if (!current) {
          return { restored: "deleted" as const, restoredMomentId: momentId, path };
        }
        const result = await engine.deleteTextFile({
          workspaceId,
          versionId: activeVersionId,
          path,
          metadata,
        });
        await materialize([{ kind: "delete", path }]);
        return {
          restored: "deleted" as const,
          restoredMomentId: result.moment.id,
          path,
        };
      });
    },

    async fileObjectIdForPath(path) {
      // Drain the chain so a just-captured file is immediately chat-able.
      await chain;
      const engine = await engineStore();
      const activeVersionId = await activeVersionIdOf(engine);
      const snapshot = await engine.readTextFile({
        workspaceId,
        versionId: activeVersionId,
        path,
      });
      return snapshot?.objectId ?? null;
    },

    beginFileRename(fromPath, toPath) {
      return enqueueResult("prepare rename", async () => {
        const noop: WorkspaceEngineRenameFinisher = async () => {};
        // Only a clean single-file rename between two engine-owned text paths
        // goes through the engine rename (preserving the stable object id);
        // everything else falls back to the watcher's delete+write capture.
        if (
          classifyEngineFilePath(fromPath).kind !== "tracked" ||
          classifyEngineFilePath(toPath).kind !== "tracked"
        ) {
          return noop;
        }
        const toCheck = validateUserWritePath(toPath);
        if (!toCheck.ok || toCheck.normalized !== toPath) return noop;
        const engine = await engineStore();
        const versionId = await activeVersionIdOf(engine);
        const disk = await readDiskTextState(rootPath, fromPath);
        if (disk.kind !== "text") return noop;
        try {
          // Sync the latest disk content first so the rename moment carries
          // exactly what moves on disk.
          await writeIfChanged(engine, versionId, fromPath, disk, {
            origin: "local-file",
            summary: "Saved latest edits",
          });
          await engine.renameTextFile({
            workspaceId,
            versionId,
            fromPath,
            toPath,
            metadata: {
              origin: "local-file",
              summary: `Renamed ${fromPath} to ${toPath}`,
            },
          });
        } catch (error) {
          // Best-effort coordination: an engine refusal (for example the
          // destination already tracked) must never block the disk rename —
          // the watcher's plain capture takes over.
          onError(`prepare rename of ${fromPath}`, error);
          return noop;
        }
        const cancel = registerExpectedEngineEvents([
          { path: fromPath, operation: "delete" },
          { path: toPath, operation: "write", sha256: disk.sha256 },
        ]);
        return async (ok: boolean) => {
          if (ok) return;
          cancel();
          // The disk move failed after the engine recorded the rename: rename
          // back so engine state keeps mirroring the folder. Forward history —
          // both rename moments stay visible.
          await enqueueResult("rename rollback", async () => {
            await engine.renameTextFile({
              workspaceId,
              versionId,
              fromPath: toPath,
              toPath: fromPath,
              metadata: {
                origin: "local-file",
                summary: `Rename of ${fromPath} did not complete`,
              },
            });
          }).catch((error) => {
            onError("rename rollback", error);
          });
        };
      });
    },

    flush() {
      return chain;
    },

    async stop() {
      // Everything already enqueued (including the watcher's final settled
      // batch) still runs; only NEW work is refused.
      stopped = true;
      await chain;
      // Release the SQLite handle for the store THIS capture created, so
      // repeated workspace switches never accumulate handles/WAL locks. An
      // injected store belongs to its creator and is left open.
      if (!options.store && store) {
        await store.close().catch(() => undefined);
      }
    },
  };
}
