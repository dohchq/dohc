import type { WatcherEvent } from "@dohc/workspace-core";
import { validateUserWritePath } from "@dohc/workspace-core";
import {
  classifyEngineFilePath,
  compareVersionFiles,
  createSecretFileStore,
  createVersionedTextStore,
  MAX_VERSIONED_BINARY_FILE_BYTES,
  resolveEffectivePolicy,
  type ActorNeutralWriteMetadata,
  type MomentAuthor,
  type SecretFileMoment,
  type SecretFileStore,
  type VersionFileChange,
  type VersionRecord,
  type VersionedTextConflictRecord,
  type VersionedTextMoment,
  type VersionedTextMomentSummary,
  type VersionedTextStore,
  type RelayMaterializedPath,
} from "@dohc/workspace-engine";
import {
  isTextMediaType,
  mediaTypeForPath,
  scanWorkspaceFilesTolerant,
} from "@dohc/workspace-fs";
import {
  WorkspaceKernelClient,
  defaultWorkspaceKernelBinaryPath,
  defaultWorkspaceKernelDebugBinaryPath,
  defaultWorkspaceKernelPackagedBinaryPath,
} from "@dohc/workspace-kernel-client";
import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  MAX_HISTORY_TEXT_SNAPSHOT_BYTES,
  type ActiveAgentRun,
} from "./workspaceWatcher";
import {
  readWorkspaceEnginePolicy,
  type WorkspaceEnginePolicySnapshot,
} from "./workspaceEnginePolicyFile";

export const WORKSPACE_KERNEL_FAILURE_DISABLE_THRESHOLD = 3;

// The JSON-RPC protocol version this desktop build speaks. A stale/incompatible
// kernel binary that answers handshake with a different version (or that does
// not advertise kernel.scan) is rejected before its scan output is ever trusted.
export const WORKSPACE_KERNEL_PROTOCOL_VERSION = 1;

// A kernel scan result is only trusted when every entry carries a hex sha256.
const KERNEL_SHA256_RE = /^[0-9a-f]{64}$/;

interface WorkspaceKernelRuntimeOptions {
  isPackaged: boolean;
  resourcesPath?: string;
  repoRoot?: string;
}

let workspaceKernelRuntime: WorkspaceKernelRuntimeOptions = { isPackaged: false };
let workspaceKernelConsecutiveFailures = 0;
let workspaceKernelDisabledForProcess = false;

export function configureWorkspaceKernelRuntime(options: WorkspaceKernelRuntimeOptions): void {
  workspaceKernelRuntime = { ...options };
}

export function resetWorkspaceKernelRuntimeForTests(): void {
  workspaceKernelRuntime = { isPackaged: false };
  workspaceKernelConsecutiveFailures = 0;
  workspaceKernelDisabledForProcess = false;
}

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
//   - resolveEffectivePolicy (workspace-engine) decides engine ownership: the
//     classifyEngineFilePath hard floor (ignored segments, `.env`-style
//     secret paths — the SAME floor engine search uses) that .dohc policy
//     files can NEVER override, plus workspace policy from .dohc/files.toml
//     which can only narrow (tracked = false), never widen.
//   - Only UTF-8 text files up to MAX_HISTORY_TEXT_SNAPSHOT_BYTES are
//     captured (the legacy history snapshot pipeline's text heuristics).
//     Binary, oversized, non-UTF-8, and secret files are skipped entirely —
//     no metadata-only engine moments; if a previously captured path stops
//     being engine-ownable text, it is removed from engine state so engine
//     state never goes stale-but-authoritative.
//   - The same boundary limits SWITCHING: versions cover engine-owned text
//     files; binary/secret/ignored files are untouched by a version switch
//     (the UI states this honestly).
//   - `.dohc/files.toml` and `.dohc/visibility.toml` are re-read at the top
//     of every serialized capture/version task. `.dohc/**` is already ignored
//     by the watcher, so policy edits do not generate watcher events; the
//     fresh-read rule makes the next capture pass or version operation honor
//     policy changes without cache invalidation.
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
export const MAX_ENGINE_CAPTURE_BINARY_BYTES = MAX_VERSIONED_BINARY_FILE_BYTES;

export interface ExpectedEngineEvent {
  path: string;
  operation: "write" | "delete";
  // sha256 of the written UTF-8 text or raw binary bytes; required for writes so a LATER user
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

// One timeline row for the history UI: text moments and PROTECTED (secret)
// moments share this shape. Protected rows are metadata-only by construction
// (SecretFileMoment has no content field) and carry no objectId/author.
export interface WorkspaceEngineMomentSummary {
  id: string;
  versionId: string;
  objectId?: string;
  path: string;
  recordedAtMs: number;
  operation: "write" | "rename" | "delete";
  contentKind?: "text" | "binary";
  byteLength?: number;
  metadata: ActorNeutralWriteMetadata;
  author?: MomentAuthor;
  momentOrder: number;
  protected: boolean;
}

// One page of the ACTIVE version's timeline (the folder shows the active
// version, so its history is what the history UI shows). Secret moments are
// interleaved by recording time; pagination stays keyed on the TEXT
// timeline's momentOrder (see listMoments for the window rule).
export interface WorkspaceEngineMomentPage {
  moments: WorkspaceEngineMomentSummary[];
  nextBeforeMomentOrder: number | null;
  latestMomentOrder: number;
  activeVersionId: string;
}

// The diff page's payload: a text moment carries its full before/after
// payload; a protected moment is metadata-only ("Contents are protected").
export type WorkspaceEngineMomentDetail =
  | { protected: false; moment: VersionedTextMoment }
  | { protected: true; moment: SecretFileMoment };

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
  readMoment(momentId: string): Promise<WorkspaceEngineMomentDetail | null>;
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
  // Relay sync runs on the same capture chain as local batch capture and
  // version operations. The task owns engine push/pull; returned
  // active-version paths are materialized with expected-event suppression so
  // watcher observations of sync writes never become new local moments.
  // Data-safety contract: the pull's relay fetch cursor commits ONLY after
  // materialization succeeds — runRelaySync invokes the result's
  // commitFetchCursor once every fast-forwarded path is safely on disk, so a
  // failed materialization leaves the cursor behind and the next pass
  // retries the same ops instead of permanently skipping them.
  runRelaySync<
    T extends {
      fastForwardedPaths: readonly RelayMaterializedPath[];
      commitFetchCursor?: () => Promise<void>;
    },
  >(task: () => Promise<T>): Promise<T>;
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
  // Injectable for tests; defaults to the workspace's encrypted secret store
  // (PR 08) sharing the same engine.db.
  secretStore?: SecretFileStore;
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
  // The live agent-run slot (workspaceActivity owns it; AgentIntegration sets
  // it while a dohc-tracked run is open). PR 0N-1 attribution rule — the SAME
  // rule the legacy recorder used: the slot is read once when the batch
  // SETTLES (captureBatch is called from the watcher's settle path), never
  // when the capture chain later executes. A run that ends between settle and
  // capture still owns the batch it caused; writes that settle after the run
  // ended are actor-neutral. Reconciliation passes and version operations
  // never read the slot — only physically observed watcher batches carry an
  // author.
  activeAgentRun?: () => ActiveAgentRun | null;
}

export interface EngineDiskWriter {
  writeTextFile(absolutePath: string, text: string): Promise<void>;
  writeBinaryFile(absolutePath: string, bytes: Uint8Array): Promise<void>;
  deletePath(absolutePath: string): Promise<void>;
}

const ENGINE_MAIN_VERSION_ID = "main";

interface RegisteredExpectedEngineEvent extends ExpectedEngineEvent {
  expiresAtMs: number;
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pathBasename(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

type DiskTextState =
  // Confirmed absent (ENOENT/ENOTDIR): the engine file, if any, was deleted.
  | { kind: "absent" }
  // Engine-ownable UTF-8 text within the size cap.
  | { kind: "text"; text: string; sha256: string }
  // Engine-ownable binary content within the binary cap.
  | { kind: "binary"; bytes: Buffer; sha256: string; byteLength: number }
  // Present but not engine-ownable (binary, oversized, or non-UTF-8 text).
  | { kind: "untracked-content" }
  // Transiently unreadable (EACCES/EBUSY/...): leave engine state alone.
  | { kind: "unreadable" };

type ReconcileScanFile = { path: string };

// A reconciliation disk listing plus the workspace-relative paths (files or
// directory prefixes) the tolerant scan could NOT read. Failed paths are
// carried alongside the listing so the retire pass never mistakes
// "unreadable right now" for "deleted while dohc was closed".
type ReconcileScan = {
  files: readonly ReconcileScanFile[];
  failedPaths: readonly string[];
};

function isUnderScanFailedPath(path: string, failedPaths: readonly string[]): boolean {
  return failedPaths.some(
    (failed) => failed === "." || path === failed || path.startsWith(`${failed}/`),
  );
}

// TS-CONFIRMED delete gate (the false-delete defense for a default-on kernel):
// the reconcile scan (kernel or TS) drives adds/updates, but a scan is NOT
// trusted to authorize a DELETE. A kernel that returns a plausible-but-
// INCOMPLETE files list (wrong-but-valid, so fail-open never fires) would omit
// a still-present tracked file and the retire pass would false-delete it. Before
// retiring ANY previously-tracked path absent from the scan, this confirms the
// absence with a direct lstat: only a genuinely gone path (ENOENT/ENOTDIR) is
// retired. A path that still exists in any form — even transiently unreadable —
// is left tracked, so an incomplete scan can never drive a false delete on any
// platform. lstat (never stat) so a symlink leaf is treated as present, matching
// readDiskTextState's symlink handling.
async function pathConfirmedAbsentOnDisk(rootPath: string, path: string): Promise<boolean> {
  try {
    await lstat(join(rootPath, path));
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

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
    if (!isTextMediaType(mediaTypeForPath(path), path)) {
      if (info.size > MAX_ENGINE_CAPTURE_BINARY_BYTES) return { kind: "untracked-content" };
      const bytes = await readFile(absolute);
      if (bytes.length > MAX_ENGINE_CAPTURE_BINARY_BYTES) return { kind: "untracked-content" };
      return { kind: "binary", bytes, sha256: sha256Bytes(bytes), byteLength: bytes.byteLength };
    }
    // Text-media ordering (WS-G1 review fix): the BINARY cap decides
    // readability here, because a text-suffixed path can be binary in
    // disguise (invalid UTF-8) and the store accepts that as binary up to
    // MAX_ENGINE_CAPTURE_BINARY_BYTES. Only content that genuinely IS text
    // (round-trips through UTF-8) is held to the smaller text cap.
    if (info.size > MAX_ENGINE_CAPTURE_BINARY_BYTES) return { kind: "untracked-content" };
    const bytes = await readFile(absolute);
    if (bytes.length > MAX_ENGINE_CAPTURE_BINARY_BYTES) return { kind: "untracked-content" };
    const text = bytes.toString("utf8");
    // The engine only stores text that round-trips through UTF-8; anything
    // else is binary in disguise, not engine-ownable as text.
    if (!Buffer.from(text, "utf8").equals(bytes)) {
      return { kind: "binary", bytes, sha256: sha256Bytes(bytes), byteLength: bytes.byteLength };
    }
    // Genuine text over the text cap stays untracked (established behavior —
    // oversized text is neither snapshotted nor demoted to bytes).
    if (bytes.length > MAX_ENGINE_CAPTURE_TEXT_BYTES) return { kind: "untracked-content" };
    return { kind: "text", text, sha256: sha256Utf8(text) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "unreadable" };
  }
}

// Like readDiskTextState but for secret-classified paths: `.env` has no text
// media type, so the media-type heuristic is skipped — any regular file whose
// bytes round-trip through UTF-8 within the size cap is capturable secret
// text. Everything else mirrors the text rules (symlink refusal, size cap,
// confirmed-absent vs transiently-unreadable).
async function readDiskSecretState(rootPath: string, path: string): Promise<DiskTextState> {
  const absolute = join(rootPath, path);
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) return { kind: "untracked-content" };
    if (!info.isFile()) return { kind: "untracked-content" };
    if (info.size > MAX_ENGINE_CAPTURE_TEXT_BYTES) return { kind: "untracked-content" };
    const bytes = await readFile(absolute);
    if (bytes.length > MAX_ENGINE_CAPTURE_TEXT_BYTES) return { kind: "untracked-content" };
    const text = bytes.toString("utf8");
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
// `protected: true` marks a secret-backed file: its plaintext exists only in
// this in-memory operation on its way to the workspace folder (the single
// authorized materialization boundary) and is validated against the secret
// floor instead of the tracked-path policy.
type MaterializeOperation =
  | { kind: "write"; path: string; text: string; protected?: boolean }
  | { kind: "write-binary"; path: string; bytes: Uint8Array }
  | { kind: "delete"; path: string; protected?: boolean };

function policyTracksPath(path: string, policy: WorkspaceEnginePolicySnapshot): boolean {
  return resolveEffectivePolicy({
    path,
    filesPolicy: policy.filesPolicy,
    visibilityPolicy: policy.visibilityPolicy,
  }).tracked;
}

// The secret floor decides which paths the encrypted driver owns. Policy is
// deliberately NOT consulted: the floor can never be unmarked by .dohc files.
function isSecretPath(path: string): boolean {
  return classifyEngineFilePath(path).kind === "secret";
}

function assertEngineWritablePath(
  path: string,
  policy: WorkspaceEnginePolicySnapshot,
  options: { protected?: boolean } = {},
): void {
  const check = validateUserWritePath(path);
  if (!check.ok || check.normalized !== path) {
    throw new Error(`Engine refused to write unsafe workspace path: ${path}`);
  }
  if (options.protected) {
    // A protected materialization may only ever land on a secret-classified
    // path — plaintext from the secret store can never be redirected to an
    // ordinary (searchable, exportable, text-captured) location.
    if (!isSecretPath(path)) {
      throw new Error(`Engine refused to write protected content to a non-secret path: ${path}`);
    }
    return;
  }
  if (isSecretPath(path)) {
    throw new Error(`Engine refused to write secret path through the text flow: ${path}`);
  }
  if (!policyTracksPath(path, policy)) {
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
    async writeBinaryFile(absolutePath, bytes) {
      const dir = dirname(absolutePath);
      await assertContainedNearestAncestor(dir);
      await mkdir(dir, { recursive: true });
      await assertContainedDir(dir);
      await assertLeafNotSymlink(absolutePath);
      await writeFile(absolutePath, bytes);
    },
    async deletePath(absolutePath) {
      await assertContainedDir(dirname(absolutePath));
      // rm on a symlink removes the link itself, never the target, so a
      // symlink leaf needs no extra handling here.
      await rm(absolutePath, { force: true });
    },
  };
}

function isExistingFile(path: string): boolean {
  // statSync().isFile() (not existsSync): a directory, socket, or dangling
  // entry at the resolved path is not a runnable kernel binary. existsSync
  // would accept any of them and hand a non-executable path to spawn.
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function firstExistingWorkspaceKernelBinaryPath(): string | null {
  const packagedPath = defaultWorkspaceKernelPackagedBinaryPath(workspaceKernelRuntime);
  // The DOHC_KERNEL_BINARY_PATH override is a DEV/non-packaged escape hatch
  // only: in a packaged build the bundled resource is the sole trusted source,
  // so an env var can never point production at a stale/incompatible binary.
  const configuredPath = workspaceKernelRuntime.isPackaged
    ? null
    : process.env.DOHC_KERNEL_BINARY_PATH?.trim() || null;
  const releasePath = defaultWorkspaceKernelBinaryPath(workspaceKernelRuntime.repoRoot);
  const debugPath = defaultWorkspaceKernelDebugBinaryPath(workspaceKernelRuntime.repoRoot);
  for (const candidate of [packagedPath, configuredPath, releasePath, debugPath]) {
    if (candidate && isExistingFile(candidate)) return candidate;
  }
  return null;
}

// Runtime validation of a kernel.scan result BEFORE any of it is trusted as the
// authoritative disk listing. A malformed-but-valid JSON-RPC result (e.g.
// `{}` -> files: undefined, or an entry with a traversal path / non-hex sha)
// throws here, INSIDE the try, so the existing catch takes the tolerant TS
// path and the failure counts toward the disable-after-N guard. Each entry must
// carry a safe normalized RELATIVE path (same validation the TS write path
// uses), a finite non-negative size, a hex sha256, and a string mediaType.
// Duplicate paths are de-duped (first wins).
function validateKernelScanFiles(result: unknown): ReconcileScanFile[] {
  if (typeof result !== "object" || result === null) {
    throw new Error("Kernel scan returned a non-object result.");
  }
  const files = (result as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    throw new Error("Kernel scan result is missing a files array.");
  }
  const seen = new Set<string>();
  const validated: ReconcileScanFile[] = [];
  for (const entry of files) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("Kernel scan returned a non-object file entry.");
    }
    const record = entry as Record<string, unknown>;
    const path = record.path;
    if (typeof path !== "string") {
      throw new Error("Kernel scan returned a file entry without a string path.");
    }
    const check = validateUserWritePath(path);
    if (!check.ok || check.normalized !== path) {
      throw new Error(`Kernel scan returned an unsafe file path: ${path}`);
    }
    if (
      typeof record.size !== "number" ||
      !Number.isFinite(record.size) ||
      record.size < 0
    ) {
      throw new Error(`Kernel scan returned an invalid size for ${path}.`);
    }
    if (typeof record.sha256 !== "string" || !KERNEL_SHA256_RE.test(record.sha256)) {
      throw new Error(`Kernel scan returned an invalid sha256 for ${path}.`);
    }
    if (typeof record.mediaType !== "string") {
      throw new Error(`Kernel scan returned an invalid mediaType for ${path}.`);
    }
    if (seen.has(path)) continue;
    seen.add(path);
    validated.push({ path });
  }
  return validated;
}

async function fallbackReconcileScan(rootPath: string): Promise<ReconcileScan> {
  const scan = await scanWorkspaceFilesTolerant(rootPath);
  return { files: scan.files, failedPaths: scan.failures.map((failure) => failure.path) };
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
  let secretStore: SecretFileStore | null = options.secretStore ?? null;
  let expectedEvents: RegisteredExpectedEngineEvent[] = [];
  let stopped = false;

  // The encrypted secret store (PR 08) shares engine.db; opened lazily so
  // workspaces without secret files never touch the key path.
  function secretStoreFor(): SecretFileStore {
    secretStore ??= createSecretFileStore(rootPath);
    return secretStore;
  }

  // Reconciliation-tolerant listing (WS-H1 gate fix): an unreadable or racy
  // path is skipped and reported as a failed path instead of aborting the
  // whole scan, so one bad directory can never stop every OTHER existing
  // file from seeding the engine on a cold adoption.
  async function scanWorkspaceFilesForReconcile(): Promise<ReconcileScan> {
    if (process.env.DOHC_KERNEL_SIDECAR === "0") {
      return fallbackReconcileScan(rootPath);
    }
    if (workspaceKernelDisabledForProcess) {
      return fallbackReconcileScan(rootPath);
    }
    const binaryPath = firstExistingWorkspaceKernelBinaryPath();
    if (!binaryPath) {
      return fallbackReconcileScan(rootPath);
    }
    const client = new WorkspaceKernelClient({
      binaryPath,
      timeoutMs: 30_000,
      // One-shot reconcile client: a binary that cannot even start is a hard
      // failure for this scan, and restarting a broken/incompatible binary an
      // extra time only wastes a spawn per pass. dispose() during a scheduled
      // restart could also leak a sidecar, so keep the supervisor off here.
      maxRestarts: 0,
    });
    try {
      // Handshake gate (before ANY scan output is trusted): a stale/incompatible
      // binary can speak enough JSON-RPC to answer with wrong results, so verify
      // the protocol version matches and kernel.scan is an advertised capability
      // first. A mismatch throws here -> the catch below falls back to TS and
      // counts this as a kernel failure toward the disable-after-N guard.
      const handshake = await client.handshake();
      if (
        handshake.protocolVersion !== WORKSPACE_KERNEL_PROTOCOL_VERSION ||
        !Array.isArray(handshake.capabilities) ||
        !handshake.capabilities.includes("kernel.scan")
      ) {
        throw new Error(
          `Kernel handshake mismatch (protocolVersion=${handshake.protocolVersion}).`,
        );
      }
      const result = await client.scan(rootPath);
      // Validate the shape INSIDE the try so a malformed-but-valid result falls
      // back to TS instead of throwing outside the fallback during reconcile.
      const files = validateKernelScanFiles(result);
      workspaceKernelConsecutiveFailures = 0;
      return { files, failedPaths: [] };
    } catch (error) {
      workspaceKernelConsecutiveFailures += 1;
      if (workspaceKernelConsecutiveFailures >= WORKSPACE_KERNEL_FAILURE_DISABLE_THRESHOLD) {
        workspaceKernelDisabledForProcess = true;
      }
      onError("kernel scan fallback", error);
      return fallbackReconcileScan(rootPath);
    } finally {
      await client.dispose().catch(() => undefined);
    }
  }

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

  async function readPolicyForTask(): Promise<WorkspaceEnginePolicySnapshot> {
    const policy = await readWorkspaceEnginePolicy(rootPath);
    if (policy.errors.length > 0) {
      onError("workspace policy validation", new Error(policy.errors.join("; ")));
    }
    return policy;
  }

  async function deleteIfTracked(
    engine: VersionedTextStore,
    versionId: string,
    path: string,
    metadata: ActorNeutralWriteMetadata,
    author?: MomentAuthor,
  ): Promise<boolean> {
    const current = await engine.readTextFile({ workspaceId, versionId, path });
    if (!current) return false;
    await engine.deleteTextFile({
      workspaceId,
      versionId,
      path,
      metadata,
      ...(author !== undefined ? { author } : {}),
    });
    return true;
  }

  async function writeIfChanged(
    engine: VersionedTextStore,
    versionId: string,
    path: string,
    disk:
      | { kind: "text"; text: string; sha256: string }
      | { kind: "binary"; bytes: Uint8Array; sha256: string; byteLength: number },
    metadata: ActorNeutralWriteMetadata,
    author?: MomentAuthor,
  ): Promise<boolean> {
    const current = await engine.readTextFile({ workspaceId, versionId, path });
    // Content equality is the no-op rule: it keeps one engine record per
    // physical write across settle windows and makes reconciliation
    // idempotent.
    if (disk.kind === "binary") {
      if (current?.contentKind === "binary" && current.sha256 === disk.sha256) return false;
      // A tracked text file whose bytes stop round-tripping as UTF-8 keeps its
      // object identity; the moment says so honestly instead of pretending it
      // was an ordinary update (the pre-WS-G1 path retired the file here).
      const becameBinary = current !== null && current.contentKind !== "binary";
      await engine.writeBinaryFile({
        workspaceId,
        versionId,
        path,
        bytes: disk.bytes,
        metadata: {
          ...metadata,
          summary:
            metadata.summary ??
            (becameBinary ? "Became a binary file" : `Updated ${pathBasename(path)}`),
        },
        ...(author !== undefined ? { author } : {}),
      });
      return true;
    }
    if (current && current.contentKind !== "binary" && current.text === disk.text) return false;
    // The mirror transition: a binary-tracked path whose content is UTF-8
    // text again continues as the same object with an honest moment.
    const becameText = current?.contentKind === "binary";
    await engine.writeTextFile({
      workspaceId,
      versionId,
      path,
      text: disk.text,
      metadata: becameText
        ? { ...metadata, summary: metadata.summary ?? "Became a text file" }
        : metadata,
      ...(author !== undefined ? { author } : {}),
    });
    return true;
  }

  // Secret-path capture (PR 08): the file's on-disk plaintext goes INTO the
  // encrypted store; the recorded moment is metadata-only ("Updated .env" —
  // never content, never diffs). Attribution is deliberately actor-neutral:
  // secret moments never carry an author. The store's content-equality no-op
  // rule keeps one moment per real change, same as text capture.
  async function captureSecretPath(
    versionId: string,
    path: string,
    metadata: ActorNeutralWriteMetadata,
  ): Promise<void> {
    const secrets = secretStoreFor();
    const disk = await readDiskSecretState(rootPath, path);
    if (disk.kind === "unreadable") return;
    if (disk.kind === "text") {
      if (consumeExpectedEvent("write", path, disk.sha256)) return;
      await secrets.writeSecretFile({
        workspaceId,
        versionId,
        path,
        text: disk.text,
        metadata: { ...metadata, summary: `Updated ${pathBasename(path)}` },
      });
      return;
    }
    // Confirmed absent, or no longer capturable UTF-8 text: retire it so the
    // protected state never goes stale-but-authoritative (the delete no-ops
    // when nothing was tracked).
    if (disk.kind === "absent" && consumeExpectedEvent("delete", path)) return;
    await secrets.deleteSecretFile({
      workspaceId,
      versionId,
      path,
      metadata: { ...metadata, summary: `Deleted ${pathBasename(path)}` },
    });
  }

  async function captureOnePath(
    engine: VersionedTextStore,
    versionId: string,
    event: WatcherEvent,
    policy: WorkspaceEnginePolicySnapshot,
    metadata: ActorNeutralWriteMetadata,
    author?: MomentAuthor,
  ): Promise<void> {
    // The secret floor outranks policy: secret paths route to the encrypted
    // driver and never reach the plaintext text store (which would refuse
    // them anyway — the store has its own gate).
    if (isSecretPath(event.path)) {
      await captureSecretPath(versionId, event.path, metadata);
      return;
    }
    if (!policyTracksPath(event.path, policy)) return;
    // Deletes trust the watcher's confirmed-absent check; updates re-read the
    // CURRENT disk state so rapid successive writes coalesce to the final
    // content instead of replaying stale event snapshots.
    if (event.operation === "delete") {
      if (consumeExpectedEvent("delete", event.path)) return;
      await deleteIfTracked(engine, versionId, event.path, metadata, author);
      return;
    }
    const disk = await readDiskTextState(rootPath, event.path);
    if (disk.kind === "unreadable") return;
    if (disk.kind === "absent") {
      if (consumeExpectedEvent("delete", event.path)) return;
      await deleteIfTracked(engine, versionId, event.path, metadata, author);
      return;
    }
    if (disk.kind === "untracked-content") {
      // The path stopped being engine-ownable text: retire it from engine
      // state rather than leaving a stale snapshot behind. The batch author
      // rides along — the run's write is what retired it.
      await deleteIfTracked(
        engine,
        versionId,
        event.path,
        { ...metadata, summary: "Stopped tracking non-text content" },
        author,
      );
      return;
    }
    if (consumeExpectedEvent("write", event.path, disk.sha256)) return;
    await writeIfChanged(engine, versionId, event.path, disk, metadata, author);
  }

  // Disk -> engine reconciliation for one version: after it completes, the
  // version's engine state mirrors the workspace folder's engine-ownable text
  // files exactly. Used for startup (closed-period edits), as the
  // nothing-is-ever-lost capture before a switch, and as the crash-honest
  // recovery when a switch fails mid-materialization.
  async function reconcileDiskIntoVersion(
    engine: VersionedTextStore,
    versionId: string,
    policy: WorkspaceEnginePolicySnapshot,
    metadata: ActorNeutralWriteMetadata,
    // Callers that must pin the disk listing to the START of their task
    // (before other per-task reads run) pass the scan in — and own its
    // failed paths (the startup pass degrades and reports). Everyone else
    // lets this function scan, and a scan failure FAILS the operation
    // (version operations reject to their caller, exactly as the strict
    // scan made them before).
    scan?: ReconcileScan,
  ): Promise<void> {
    const { files: scanned, failedPaths } = scan ?? (await scanWorkspaceFilesForReconcile());
    if (!scan && failedPaths.length > 0) {
      throw new Error(
        `Could not scan workspace paths: ${failedPaths.join(", ")}`,
      );
    }
    const diskPaths = new Set<string>();
    // Secret paths reconcile into the ENCRYPTED store (PR 08): capture the
    // current disk plaintext (metadata-only moments), and retire entries
    // whose files vanished. Transiently unreadable secrets are left alone.
    const secretDiskPaths = new Set<string>();
    const secretUnreadablePaths = new Set<string>();
    for (const file of scanned) {
      if (isSecretPath(file.path)) {
        const disk = await readDiskSecretState(rootPath, file.path);
        if (disk.kind === "unreadable") {
          secretUnreadablePaths.add(file.path);
          continue;
        }
        if (disk.kind === "text") {
          secretDiskPaths.add(file.path);
          await secretStoreFor().writeSecretFile({
            workspaceId,
            versionId,
            path: file.path,
            text: disk.text,
            metadata: { ...metadata, summary: `Updated ${pathBasename(file.path)}` },
          });
        }
        // absent/untracked-content fall through to the retire pass below.
        continue;
      }
      if (!policyTracksPath(file.path, policy)) {
        // A path .dohc/files.toml stopped tracking is RETIRED from engine
        // state on the next reconcile pass — the same never-stale-but-
        // authoritative rule as content that stops being engine-ownable
        // text — with an honest summary (not the pass's generic one). The
        // disk file itself is untouched, and prior moments remain in
        // history. Live batch capture just skips untracked paths; this
        // convergence happens here.
        await deleteIfTracked(engine, versionId, file.path, {
          ...metadata,
          summary: "Stopped tracking by policy",
        });
        continue;
      }
      diskPaths.add(file.path);
      const disk = await readDiskTextState(rootPath, file.path);
      if (disk.kind === "unreadable") continue;
      if (disk.kind === "text" || disk.kind === "binary") {
        await writeIfChanged(engine, versionId, file.path, disk, metadata);
      } else {
        // absent (raced a delete) or no longer engine-ownable text.
        await deleteIfTracked(engine, versionId, file.path, metadata);
        diskPaths.delete(file.path);
      }
    }
    // Files the engine tracked that no longer exist on disk were deleted
    // outside a live capture window; reconcile the deletions too. A tracked
    // path the tolerant scan FAILED to read (unreadable directory, racy
    // delete) is left alone: absent-from-a-degraded-listing is not evidence
    // of deletion, and retiring it here would record a false delete moment.
    const tracked = await engine.listTextFiles({ workspaceId, versionId });
    for (const snapshot of tracked) {
      if (diskPaths.has(snapshot.path)) continue;
      if (isUnderScanFailedPath(snapshot.path, failedPaths)) continue;
      // TS-confirm the absence before retiring: the scan (kernel or TS) is
      // trusted for adds/updates but never to authorize a delete on its own.
      if (!(await pathConfirmedAbsentOnDisk(rootPath, snapshot.path))) continue;
      await deleteIfTracked(engine, versionId, snapshot.path, metadata);
    }
    // Same rule for the encrypted store: protected files deleted while dohc
    // was closed retire from the secret state (metadata-only moment).
    const trackedSecrets = await secretStoreFor().listSecretFiles({
      workspaceId,
      versionId,
    });
    for (const stat of trackedSecrets) {
      if (secretDiskPaths.has(stat.path)) continue;
      if (secretUnreadablePaths.has(stat.path)) continue;
      if (isUnderScanFailedPath(stat.path, failedPaths)) continue;
      // Same TS-confirmed delete gate for protected files: an incomplete scan
      // must never retire a secret whose file is still on disk.
      if (!(await pathConfirmedAbsentOnDisk(rootPath, stat.path))) continue;
      await secretStoreFor().deleteSecretFile({
        workspaceId,
        versionId,
        path: stat.path,
        metadata: { ...metadata, summary: `Deleted ${pathBasename(stat.path)}` },
      });
    }
  }

  // Returns true when the pass covered the whole tree; false when the
  // tolerant scan had to skip paths (the pass still seeded everything
  // readable, but the outcome is DEGRADED and must reach the capture
  // notice, never pass silently).
  async function reconcile(): Promise<boolean> {
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
    // Scan BEFORE the policy read: the pass reconciles the files present
    // when the task began; edits landing while this task's own per-task
    // reads run belong to the next serialized batch, not to this pass.
    // Routed through the kernel-aware scan, which falls back to the TS path.
    const scan = await scanWorkspaceFilesForReconcile();
    if (scan.failedPaths.length > 0) {
      onError(
        "reconciliation scan",
        new Error(`skipped unreadable paths: ${scan.failedPaths.join(", ")}`),
      );
    }
    const policy = await readPolicyForTask();
    await reconcileDiskIntoVersion(engine, versionId, policy, metadata, scan);
    return scan.failedPaths.length === 0;
  }

  // Applies engine-owned text state to the workspace folder, registering
  // every write/delete as an expected engine event (sha256 for writes) so the
  // watcher's observation of our own writes never re-captures them. Throws on
  // the first failed operation; the failed operation's registration is
  // cancelled so it can never swallow a later real user edit.
  async function materialize(
    operations: readonly MaterializeOperation[],
    policy: WorkspaceEnginePolicySnapshot,
  ): Promise<void> {
    for (const operation of operations) {
      assertEngineWritablePath(operation.path, policy, {
        ...(operation.kind !== "write-binary" && operation.protected ? { protected: true } : {}),
      });
      const absolute = join(rootPath, operation.path);
      const cancel =
        operation.kind === "write" || operation.kind === "write-binary"
          ? registerExpectedEngineEvents([
              {
                path: operation.path,
                operation: "write",
                sha256:
                  operation.kind === "write"
                    ? sha256Utf8(operation.text)
                    : sha256Bytes(operation.bytes),
              },
            ])
          : registerExpectedEngineEvents([
              { path: operation.path, operation: "delete" },
            ]);
      try {
        if (operation.kind === "write") {
          await diskWriter.writeTextFile(absolute, operation.text);
        } else if (operation.kind === "write-binary") {
          await diskWriter.writeBinaryFile(absolute, operation.bytes);
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
  // disk mutations that make the folder show that version. In-cap binaries
  // now follow versions; oversized, ignored, secret, and transiently
  // unreadable paths are never touched.
  async function planMaterialization(
    engine: VersionedTextStore,
    targetVersionId: string,
    previousVersionId: string,
    policy: WorkspaceEnginePolicySnapshot,
  ): Promise<MaterializeOperation[]> {
    const targetFiles = await engine.listTextFiles({
      workspaceId,
      versionId: targetVersionId,
    });
    const targetPaths = new Set(targetFiles.map((file) => file.path));
    const operations: MaterializeOperation[] = [];
    for (const file of targetFiles) {
      if (!policyTracksPath(file.path, policy)) continue;
      const disk = await readDiskTextState(rootPath, file.path);
      // Never clobber content the engine does not own (oversized/symlinked)
      // and never write over a transiently unreadable path.
      if (disk.kind === "untracked-content" || disk.kind === "unreadable") continue;
      if (file.contentKind === "binary") {
        if (disk.kind === "binary" && disk.sha256 === file.sha256) continue;
        const bytes = await engine.readBinaryFile({
          workspaceId,
          versionId: targetVersionId,
          path: file.path,
        });
        if (!bytes) continue;
        operations.push({ kind: "write-binary", path: file.path, bytes });
        continue;
      }
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
      if (!policyTracksPath(file.path, policy)) continue;
      const disk = await readDiskTextState(rootPath, file.path);
      if (disk.kind !== "text" && disk.kind !== "binary") continue;
      operations.push({ kind: "delete", path: file.path });
    }
    return operations;
  }

  // The secret half of a version switch (PR 08): protected files follow the
  // version. Plaintext is produced here through the store's SINGLE authorized
  // materialization accessor, held only in the in-memory operation list on
  // its way to the workspace folder, and every write/delete registers an
  // expected engine event. A pre-existing non-text/unreadable file at a
  // secret path is never clobbered (same never-clobber rule as text).
  async function planSecretMaterialization(
    targetVersionId: string,
    previousVersionId: string,
  ): Promise<MaterializeOperation[]> {
    const secrets = secretStoreFor();
    const operations: MaterializeOperation[] = [];
    const targetSecrets = await secrets.listSecretFiles({
      workspaceId,
      versionId: targetVersionId,
    });
    const targetPaths = new Set(targetSecrets.map((stat) => stat.path));
    for (const stat of targetSecrets) {
      const disk = await readDiskSecretState(rootPath, stat.path);
      if (disk.kind === "untracked-content" || disk.kind === "unreadable") continue;
      const materialized = await secrets.materializeSecretFile({
        workspaceId,
        versionId: targetVersionId,
        path: stat.path,
      });
      if (!materialized.present) continue;
      if (disk.kind === "text" && disk.text === materialized.text) continue;
      operations.push({
        kind: "write",
        path: stat.path,
        text: materialized.text,
        protected: true,
      });
    }
    const previousSecrets = await secrets.listSecretFiles({
      workspaceId,
      versionId: previousVersionId,
    });
    for (const stat of previousSecrets) {
      if (targetPaths.has(stat.path)) continue;
      const disk = await readDiskSecretState(rootPath, stat.path);
      if (disk.kind !== "text") continue;
      operations.push({ kind: "delete", path: stat.path, protected: true });
    }
    return operations;
  }

  async function materializeWriteForSnapshot(
    engine: VersionedTextStore,
    snapshot: { versionId: string; path: string; contentKind?: "text" | "binary"; text: string },
  ): Promise<MaterializeOperation> {
    if (snapshot.contentKind === "binary") {
      const bytes = await engine.readBinaryFile({
        workspaceId,
        versionId: snapshot.versionId,
        path: snapshot.path,
      });
      if (!bytes) {
        throw new Error(`Binary content for ${snapshot.path} is no longer available.`);
      }
      return { kind: "write-binary", path: snapshot.path, bytes };
    }
    return { kind: "write", path: snapshot.path, text: snapshot.text };
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
        // reconcile() reports false when the tolerant scan skipped paths:
        // everything readable seeded, but the pass is degraded, so the
        // capture-failure notice raises instead of a silent partial pass.
        reportCaptureOutcome(() => reconcile()),
      );
    },

    captureBatch(events) {
      if (events.length === 0) return;
      const batch = events.map((event) => ({ ...event }));
      // Attribution is decided HERE, at settle (captureBatch runs on the
      // watcher's settle path), not when the chain task executes — the legacy
      // recorder's rule, kept: a dohc-tracked run owns every batch that
      // settles while it is active, even if the run ends before the capture
      // chain drains. The stamp is a synchronous slot read; no extra IO.
      const run = options.activeAgentRun?.() ?? null;
      const author: MomentAuthor | undefined = run
        ? {
            kind: "agent",
            agentId: run.agentId,
            onBehalfOf: run.onBehalfOf,
            agentRunId: run.agentRunId,
          }
        : undefined;
      enqueue("batch capture", () =>
        reportCaptureOutcome(async () => {
          const policy = await readPolicyForTask();
          const engine = await engineStore();
          const versionId = await activeVersionIdOf(engine);
          const metadata: ActorNeutralWriteMetadata = { origin: "local-file" };
          let pathFailures = 0;
          for (const event of batch) {
            try {
              await captureOnePath(engine, versionId, event, policy, metadata, author);
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
        const policy = await readPolicyForTask();
        const engine = await engineStore();
        const fromVersionId = await activeVersionIdOf(engine);
        // Fork from exactly what's on disk right now — capture the latest
        // edits first so the new version starts as a faithful copy.
        await reconcileDiskIntoVersion(
          engine,
          fromVersionId,
          policy,
          {
            origin: "local-file",
            summary: "Saved latest edits",
            correlationId: `version-create-${randomUUID()}`,
          },
        );
        const version = await engine.createNamedVersion({
          workspaceId,
          name,
          fromVersionId,
        });
        // Secrets follow versions (PR 08): the fork starts with an identical
        // ENCRYPTED copy of the source version's secret files (ciphertext
        // copy — no plaintext involved).
        await secretStoreFor().forkVersion({
          workspaceId,
          fromVersionId,
          toVersionId: version.id,
        });
        // Create-and-switch: the fork is content-identical to the disk, so no
        // materialization is needed.
        await engine.setActiveVersion({ workspaceId, versionId: version.id });
        return versionsSnapshot(engine);
      });
    },

    switchVersion(versionId) {
      return enqueueResult("switch version", async () => {
        const policy = await readPolicyForTask();
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
        await reconcileDiskIntoVersion(
          engine,
          fromVersionId,
          policy,
          {
            origin: "local-file",
            summary: "Saved latest edits before switching versions",
            correlationId,
          },
        );
        const operations = [
          ...(await planMaterialization(engine, versionId, fromVersionId, policy)),
          // Secrets follow the switch through the encrypted path.
          ...(await planSecretMaterialization(versionId, fromVersionId)),
        ];
        // Record the destination BEFORE rewriting the disk (see the module
        // note on crash ordering): recovery always reconciles disk state into
        // the version recorded as active.
        await engine.setActiveVersion({ workspaceId, versionId });
        try {
          await materialize(operations, policy);
        } catch (error) {
          // Live-failure recovery mirrors crash recovery: capture the actual
          // (possibly partial) disk state into the now-active destination so
          // engine and disk agree, then surface the failure.
          await reconcileDiskIntoVersion(
            engine,
            versionId,
            policy,
            {
              origin: "local-file",
              summary: "Recovered from an interrupted version switch",
              correlationId,
            },
          ).catch((recoveryError) => {
            onError("switch recovery reconciliation", recoveryError);
          });
          throw error;
        }
        return { activeVersionId: versionId, changedFileCount: operations.length };
      });
    },

    compareVersions(sourceVersionId, targetVersionId = ENGINE_MAIN_VERSION_ID) {
      return enqueueResult("compare versions", async () => {
        const policy = await readPolicyForTask();
        const engine = await engineStore();
        // Capture the latest disk edits first so the comparison reflects what
        // the user actually sees in the folder.
        const activeVersionId = await activeVersionIdOf(engine);
        await reconcileDiskIntoVersion(
          engine,
          activeVersionId,
          policy,
          {
            origin: "local-file",
            summary: "Saved latest edits",
            correlationId: `version-compare-${randomUUID()}`,
          },
        );
        const textChanges = await compareVersionFiles(engine, {
          workspaceId,
          sourceVersionId,
          targetVersionId,
        });
        // Protected rows (PR 08): secret files report path + status ONLY —
        // "Protected file changed", never contents, never diffs.
        const secretChanges = await secretStoreFor().compareSecretFileVersions({
          workspaceId,
          targetVersionId,
          sourceVersionId,
        });
        return [
          ...textChanges,
          ...secretChanges.map(
            (change): VersionFileChange => ({
              path: change.path,
              status: change.status,
              protected: true,
            }),
          ),
        ].sort((a, b) => a.path.localeCompare(b.path));
      });
    },

    mergeVersionIntoMain(sourceVersionId) {
      return enqueueResult("merge version into Main", async () => {
        const policy = await readPolicyForTask();
        const engine = await engineStore();
        const activeVersionId = await activeVersionIdOf(engine);
        const correlationId = `version-merge-${randomUUID()}`;
        // Capture the latest disk edits so the merge sees them (whichever
        // side is active).
        await reconcileDiskIntoVersion(
          engine,
          activeVersionId,
          policy,
          {
            origin: "local-file",
            summary: "Saved latest edits",
            correlationId,
          },
        );
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
            materializations.push(await materializeWriteForSnapshot(engine, result.write.snapshot));
          } else {
            materializations.push({ kind: "delete", path: change.path });
          }
        }
        // Secret files merge through the encrypted path (PR 08): whole-file,
        // fork-base-aware, and NEVER a conflict record (conflict records
        // carry side texts, which protected contents must never ride). When
        // the source changed a secret since its fork, the source side wins
        // and Main's previous state stays one protected moment back in
        // history — restorable, so nothing is lost.
        const secrets = secretStoreFor();
        const secretChanges = await secrets.compareSecretFileVersions({
          workspaceId,
          targetVersionId: ENGINE_MAIN_VERSION_ID,
          sourceVersionId,
        });
        for (const change of secretChanges) {
          const applied = await secrets.applySecretFileFromVersion({
            workspaceId,
            targetVersionId: ENGINE_MAIN_VERSION_ID,
            sourceVersionId,
            path: change.path,
            metadata: {
              origin: "api",
              summary: `Updated ${pathBasename(change.path)} from version "${source.name}"`,
              correlationId,
            },
          });
          if (!applied.changed) {
            unchangedFileCount += 1;
            continue;
          }
          mergedFileCount += 1;
          if (activeVersionId === ENGINE_MAIN_VERSION_ID) {
            const materialized = await secrets.materializeSecretFile({
              workspaceId,
              versionId: ENGINE_MAIN_VERSION_ID,
              path: change.path,
            });
            materializations.push(
              materialized.present
                ? {
                    kind: "write",
                    path: change.path,
                    text: materialized.text,
                    protected: true,
                  }
                : { kind: "delete", path: change.path, protected: true },
            );
          }
        }
        // The folder shows the active version; only a merge into the active
        // version changes what is on disk.
        if (activeVersionId === ENGINE_MAIN_VERSION_ID) {
          await materialize(materializations, policy);
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
        const policy = await readPolicyForTask();
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
            await materialize(
              [await materializeWriteForSnapshot(engine, result.write.snapshot)],
              policy,
            );
          } else if (result.delete) {
            await materialize(
              [{ kind: "delete", path: result.delete.before.path }],
              policy,
            );
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
      const textMoments: WorkspaceEngineMomentSummary[] = page.moments.map(
        (moment) => ({ ...moment, protected: false }),
      );
      // Interleave PROTECTED (secret) moments by recording time (PR 08).
      // Pagination stays keyed on the text timeline's momentOrder; each page
      // carries the secret moments recorded inside its half-open time window
      // [oldest-text-moment, previous-page-cursor-moment) so pages never
      // duplicate or drop a protected row. The secret timeline is short by
      // nature (.env edits are rare), so it is read whole per page.
      let upperMs = Number.POSITIVE_INFINITY;
      if (input.beforeMomentOrder !== undefined) {
        // The cursor is the previous page's oldest text moment; its
        // timestamp bounds this page's window from above (exclusive).
        const cursorPage = await engine.listMoments({
          workspaceId,
          versionId: activeVersionId,
          limit: 1,
          beforeMomentOrder: input.beforeMomentOrder + 1,
        });
        upperMs = cursorPage.moments[0]?.recordedAtMs ?? Number.POSITIVE_INFINITY;
      }
      const lowerMs =
        page.nextBeforeMomentOrder === null
          ? Number.NEGATIVE_INFINITY
          : (page.moments[page.moments.length - 1]?.recordedAtMs ??
            Number.NEGATIVE_INFINITY);
      const secretMoments = await secretStoreFor().listSecretMoments({
        workspaceId,
        versionId: activeVersionId,
      });
      const protectedInWindow: WorkspaceEngineMomentSummary[] = secretMoments
        .filter(
          (moment) => moment.recordedAtMs >= lowerMs && moment.recordedAtMs < upperMs,
        )
        .map((moment) => ({
          id: moment.id,
          versionId: moment.versionId,
          path: moment.path,
          recordedAtMs: moment.recordedAtMs,
          operation: moment.operation,
          metadata: moment.metadata,
          momentOrder: moment.momentOrder,
          protected: true,
        }));
      // Merge newest-first; ties keep text before protected (stable).
      const merged = [...textMoments, ...protectedInWindow].sort(
        (a, b) => b.recordedAtMs - a.recordedAtMs,
      );
      return {
        moments: merged,
        nextBeforeMomentOrder: page.nextBeforeMomentOrder,
        latestMomentOrder: page.latestMomentOrder,
        activeVersionId,
      };
    },

    async readMoment(momentId) {
      await chain;
      const engine = await engineStore();
      const moment = await engine.getMoment({ workspaceId, momentId });
      if (moment) return { protected: false, moment };
      // Protected moments live in the secret store; the detail is
      // metadata-only ("Contents are protected" — no payload exists at all).
      const secretMoment = await secretStoreFor().getSecretMoment({
        workspaceId,
        momentId,
      });
      if (secretMoment) return { protected: true, moment: secretMoment };
      return null;
    },

    restoreFileToBeforeMoment(momentId) {
      return enqueueResult("restore file", async () => {
        const policy = await readPolicyForTask();
        const engine = await engineStore();
        const activeVersionId = await activeVersionIdOf(engine);
        const moment = await engine.getMoment({ workspaceId, momentId });
        if (!moment) {
          // Protected restore (PR 08): the whole round trip stays encrypted —
          // the store copies the prior CIPHERTEXT forward, and plaintext only
          // appears for the final authorized disk materialization.
          const secrets = secretStoreFor();
          const secretMoment = await secrets.getSecretMoment({ workspaceId, momentId });
          if (!secretMoment) {
            throw new Error("This history moment is no longer available.");
          }
          if (secretMoment.versionId !== activeVersionId) {
            throw new Error(
              "This moment belongs to a different version. Switch to that version to restore it.",
            );
          }
          const secretPath = secretMoment.path;
          const secretCorrelationId = `restore-${randomUUID()}`;
          // Capture the file's latest disk state first so a restore can never
          // destroy an edit the store has not recorded yet.
          const disk = await readDiskSecretState(rootPath, secretPath);
          if (disk.kind === "unreadable") {
            throw new Error(`Could not read the current ${secretPath} on disk.`);
          }
          if (disk.kind === "untracked-content") {
            throw new Error(
              `Only text files can be restored — ${secretPath} is no longer a text file.`,
            );
          }
          if (disk.kind === "text") {
            await secrets.writeSecretFile({
              workspaceId,
              versionId: activeVersionId,
              path: secretPath,
              text: disk.text,
              metadata: {
                origin: "local-file",
                summary: "Saved latest edits",
                correlationId: secretCorrelationId,
              },
            });
          } else {
            await secrets.deleteSecretFile({
              workspaceId,
              versionId: activeVersionId,
              path: secretPath,
              metadata: {
                origin: "local-file",
                summary: "Saved latest edits",
                correlationId: secretCorrelationId,
              },
            });
          }
          const result = await secrets.restoreSecretFileToBeforeMoment({
            workspaceId,
            momentId,
            metadata: {
              origin: "restore",
              summary: `Restored ${pathBasename(secretPath)}`,
              correlationId: secretCorrelationId,
            },
          });
          const materialized = await secrets.materializeSecretFile({
            workspaceId,
            versionId: activeVersionId,
            path: secretPath,
          });
          // Idempotent restore/undo: skip the disk write when the target
          // state already matches (mirrors planSecretMaterialization) — an
          // unconditional .env rewrite fires watchers and dev-server reloads
          // for identical bytes.
          const currentDisk = await readDiskTextState(rootPath, secretPath);
          const alreadyCurrent = materialized.present
            ? currentDisk.kind === "text" && currentDisk.text === materialized.text
            : currentDisk.kind === "absent";
          if (!alreadyCurrent) {
            await materialize(
              [
                materialized.present
                  ? {
                      kind: "write",
                      path: secretPath,
                      text: materialized.text,
                      protected: true,
                    }
                  : { kind: "delete", path: secretPath, protected: true },
              ],
              policy,
            );
          }
          return {
            restored: result.restored,
            restoredMomentId: result.restoredMomentId,
            path: secretPath,
          };
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
            `Only engine-owned files can be restored — ${path} is no longer capturable.`,
          );
        }
        const saveMetadata: ActorNeutralWriteMetadata = {
          origin: "local-file",
          summary: "Saved latest edits",
          correlationId,
        };
        if (disk.kind === "text" || disk.kind === "binary") {
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
          if (
            current &&
            (target.contentKind === "binary"
              ? current.contentKind === "binary" && current.sha256 === target.sha256
              : current.contentKind !== "binary" && current.text === target.text)
          ) {
            // Already in the pre-moment state. Returning the SAME moment id
            // keeps undo a no-op (undoing an idempotent restore restores the
            // identical state again).
            return { restored: "text" as const, restoredMomentId: momentId, path };
          }
          const result =
            target.contentKind === "binary"
              ? await (async () => {
                  const bytes = await engine.readBinaryBlob({
                    workspaceId,
                    sha256: target.sha256 ?? "",
                  });
                  if (!bytes) {
                    throw new Error(`Binary content for ${path} is no longer available.`);
                  }
                  return engine.writeBinaryFile({
                    workspaceId,
                    versionId: activeVersionId,
                    path,
                    bytes,
                    metadata,
                  });
                })()
              : await engine.writeTextFile({
                  workspaceId,
                  versionId: activeVersionId,
                  path,
                  text: target.text,
                  metadata,
                });
          await materialize([await materializeWriteForSnapshot(engine, result.snapshot)], policy);
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
        await materialize([{ kind: "delete", path }], policy);
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
        const policy = await readPolicyForTask();
        const noop: WorkspaceEngineRenameFinisher = async () => {};
        // Only a clean single-file rename between two engine-owned text paths
        // goes through the engine rename (preserving the stable object id);
        // everything else falls back to the watcher's delete+write capture.
        if (
          !policyTracksPath(fromPath, policy) ||
          !policyTracksPath(toPath, policy)
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

    runRelaySync(task) {
      return enqueueResult("relay sync", async () => {
        const result = await task();
        const changed = result.fastForwardedPaths;
        if (changed.length > 0) {
          // Policy/engine reads only when there is disk work: a quiescent
          // relay tick must not pay for policy I/O it never uses.
          const policy = await readPolicyForTask();
          const engine = await engineStore();
          const activeVersionId = await activeVersionIdOf(engine);
          const materializations: MaterializeOperation[] = [];
          for (const change of changed) {
            if (change.operation === "delete") {
              materializations.push({ kind: "delete", path: change.path });
              continue;
            }
            const snapshot = await engine.readTextFile({
              workspaceId,
              versionId: activeVersionId,
              path: change.path,
            });
            if (!snapshot) continue;
            materializations.push(await materializeWriteForSnapshot(engine, snapshot));
          }
          await materialize(materializations, policy);
        }
        // Only NOW is the pulled state durable on disk — commit the relay
        // fetch cursor. A throw above leaves the cursor behind so the next
        // pass re-fetches and retries the materialization.
        await result.commitFetchCursor?.();
        return result;
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
      // Release the SQLite handles for the stores THIS capture created, so
      // repeated workspace switches never accumulate handles/WAL locks. An
      // injected store belongs to its creator and is left open.
      if (!options.store && store) {
        await store.close().catch(() => undefined);
      }
      if (!options.secretStore && secretStore) {
        await secretStore.close().catch(() => undefined);
      }
    },
  };
}
