import type { WatcherEvent } from "@dohc/workspace-core";
import {
  validateUserMaterializePath,
  validateUserReadPath,
  validateUserWritePath,
} from "@dohc/workspace-core";
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
  type YDocContentKind,
} from "@dohc/workspace-engine";
import {
  openEngineYDocProviderSession,
  type EngineYDocProviderSession,
} from "../collab/ydocEngineProviderSession";
import {
  openEngineYdocProviderSessionRust,
  type EngineYdocProviderSessionRust,
  type EngineYdocProviderSessionRustOptions,
} from "../collab/ydocEngineProviderSessionRust";
import {
  isYdocSessionNotFoundRefusal,
  YdocReleasedWithSettleFailureError,
  type EngineTransport,
} from "@dohc/workspace-engine-client";
import * as Y from "yjs";
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
import {
  isEngineSessionReconnectError,
  type EngineWorkspaceSessions,
} from "./engineWorkspaceSessions";
import {
  createCaptureLiveStores,
  type CaptureTextFileMetadata,
  type CaptureVersionedTextStore,
} from "./workspaceEngineCaptureLiveStore";

export const WORKSPACE_KERNEL_FAILURE_DISABLE_THRESHOLD = 3;
export const DAEMON_CAPTURE_HEALTH_POLL_MS = 5_000;

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

export interface WorkspaceGeneratedTextWriteResult {
  path: string;
  objectId: string;
  changed: boolean;
}

export interface WorkspaceGeneratedTextArchiveResult {
  fromPath: string;
  path: string;
  objectId: string;
  changed: boolean;
}

export type WorkspaceGeneratedTextIdentityValidator = (text: string) => boolean;

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
  // Updates the daemon capture owner's live authorship state. Starting a run
  // is ordered before the caller launches agent work; clearing first flushes
  // the daemon so every write observed during the run retains its author.
  setActiveAgentRun(run: ActiveAgentRun | null): Promise<void>;
  // Registers engine-originated disk writes the watcher is about to observe;
  // matching observations skip engine re-capture. Returns a cancel function.
  registerExpectedEngineEvents(events: readonly ExpectedEngineEvent[]): () => void;
  // WS-G2-C-2 editor binding: open a live engine Y.Doc session for one rich
  // file, REUSING this capture's VersionedTextStore instance (single-writer
  // safety — a second store on the same engine.db is a second write connection
  // and node:sqlite deadlocks). The session journals editor edits as
  // ydoc.update ops and, on each debounced settle, projects the markdown to
  // engine.db AND writes the on-disk .md through this capture's contained disk
  // writer. While the session is live its path is marked live-ydoc-driven, so
  // the watcher's observation of the settle's own .md write is DEFERRED (never
  // re-captured as an ordinary moment.append — which on a shared workspace
  // would double-replicate and collide (P0D) with the ydoc.update stream). The
  // returned session's close() lifts the guard. Rejects (secret path,
  // not-found, already-live) propagate to the caller, which falls back.
  openYDocSession(input: {
    path: string;
    onRemoteUpdate: (update: Uint8Array) => void;
    contentKind?: YDocContentKind;
  }): Promise<EngineYDocProviderSession>;
  // WS-G2-C-2 (gate fix 3): flush + release any live Y.Doc session at OR under a
  // path before a destructive op that does NOT run through the capture chain
  // itself (the delete IPC deletes on disk directly). Without this, a later
  // settle would resurrect the deleted file / orphan the object. No-op when
  // nothing is live at the path.
  settleAndCloseLiveSessionsForPath(pathOrPrefix: string): Promise<void>;
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
  // Reverse lookup for projections that must name a linked object's current
  // active-version path after renames.
  filePathForObjectId(objectId: string): Promise<string | null>;
  // Writes a generated Markdown artifact through this capture's canonical
  // VersionedTextStore and then materializes it to disk on the SAME serialized
  // chain as capture/version work. `expectedObjectId` is the update authority:
  // callers omit it only on first creation or an identical crash-retry.
  writeGeneratedTextFile(input: {
    path: string;
    text: string;
    expectedObjectId?: string;
    // Strict first-create mode: any existing engine object or disk file is a
    // collision, even when its bytes happen to equal the generated text.
    createOnly?: true;
    // Marker-validated recovery for legacy or crash-interrupted generated
    // files whose stable object id was not persisted by the caller. Existing
    // engine and disk text must both pass inside the serialized write.
    recoverExistingText?: WorkspaceGeneratedTextIdentityValidator;
    metadata?: ActorNeutralWriteMetadata;
  }): Promise<WorkspaceGeneratedTextWriteResult>;
  // Moves a generated Markdown artifact to another visible Markdown path,
  // preserving its stable engine object id. Repeating a completed archive is
  // a no-op that also repairs any unfinished disk materialization.
  archiveGeneratedTextFile(input: {
    fromPath: string;
    toPath: string;
    expectedObjectId?: string;
    // When expectedObjectId was not durably recorded, recover it atomically
    // from either the live source or an already-renamed archive destination.
    recoverExistingText?: WorkspaceGeneratedTextIdentityValidator;
    metadata?: ActorNeutralWriteMetadata;
  }): Promise<WorkspaceGeneratedTextArchiveResult>;
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
  // Injectable id seam (oracle/tests) for the correlationId stamped on every
  // capture/version/restore write. Omitted ⇒ a real randomUUID, identical to
  // today's behavior.
  createId?: () => string;
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
  // The reconnect-safe session owner supplies the daemon-backed text, secret,
  // and Y.Doc paths. Injectable stores still take precedence in focused tests.
  rustEngineSessions?: EngineWorkspaceSessions;
  // The real Rust daemon owns filesystem observation and version
  // materialization. Tests backed by the in-process loopback omit this because
  // that transport has no autonomous watcher or disk writer.
  daemonOwnsCapture?: boolean;
  // Injectable only to simulate daemon generations in focused restart tests.
  openRustYDocProviderSession?: (
    options: EngineYdocProviderSessionRustOptions,
  ) => Promise<EngineYdocProviderSessionRust>;
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

// A materialize/write refused SOLELY because the filename is not writable on
// THIS host (a Windows-illegal name — colon/ADS, device name, 8.3 alias —
// arriving from a sync peer, or generated for one). Distinct from a generic
// "unsafe path" so the desktop can surface it as an actionable, user-facing
// diagnostic ("unsupported filename for this platform") instead of a silent
// console line. The file stays safe in engine state; only THIS host's disk
// cannot represent the name.
export class UnsupportedWorkspacePathError extends Error {
  readonly code = "unsupported-name" as const;
  constructor(readonly workspacePath: string) {
    super(
      `This filename can't be written on this platform and was skipped on disk: ${workspacePath}`,
    );
    this.name = "UnsupportedWorkspacePathError";
  }
}

// Exported for direct tests of the typed host-unsafe rejection; production
// callers omit `platform` so it defaults to the real host. This is a
// materialize boundary (generated Markdown is written to the local disk), so
// it opts into the host-unsafe-name check, gated to Windows.
export function assertGeneratedMarkdownPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const check = validateUserMaterializePath(path, { platform });
  if (!check.ok && check.reason === "unsupported-name") {
    throw new UnsupportedWorkspacePathError(path);
  }
  if (
    !check.ok ||
    check.normalized !== path ||
    !check.normalized.toLocaleLowerCase("en-US").endsWith(".md")
  ) {
    throw new Error(`Generated text must use a safe visible Markdown path: ${path}`);
  }
  return check.normalized;
}

function assertGeneratedTextRecoveryIdentity(
  path: string,
  text: string,
  validate: WorkspaceGeneratedTextIdentityValidator,
): void {
  let matches = false;
  try {
    matches = validate(text);
  } catch {
    // A recovery validator is evidence, not an execution surface: any parser
    // failure is simply a non-match and must fail closed.
  }
  if (!matches) {
    throw new Error(`Generated Markdown ownership marker does not match: ${path}`);
  }
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
  // The disk-materialize boundary runs Check A + Check B (win32): a name that
  // cannot be written on THIS disk is refused here (and surfaced) while
  // classification/capture/store writes stayed permissive (Check A only).
  const check = validateUserMaterializePath(path);
  if (!check.ok && check.reason === "unsupported-name") {
    throw new UnsupportedWorkspacePathError(path);
  }
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
// authoritative disk listing. A malformed RESULT ENVELOPE (non-object, missing
// files array, non-object entry, non-string path, or an entry with a bad
// size/sha/mediaType) throws here INSIDE the try, so the catch takes the
// tolerant TS path and the failure counts toward the disable-after-N guard —
// that shape of garbage means the kernel itself is broken. A well-formed entry
// whose PATH fails read validation is different: it is one bad/unportable path,
// not a kernel fault, so it is collected as a skipped failedPath (deduped) and
// the scan keeps every OTHER real file. Each accepted entry carries a safe
// normalized RELATIVE path (read validation — capture must see host-legal
// names), a finite non-negative size, a hex sha256, and a string mediaType.
// Duplicate paths are de-duped (first wins).
function validateKernelScanFiles(result: unknown): {
  files: ReconcileScanFile[];
  failedPaths: string[];
} {
  if (typeof result !== "object" || result === null) {
    throw new Error("Kernel scan returned a non-object result.");
  }
  const files = (result as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    throw new Error("Kernel scan result is missing a files array.");
  }
  const seen = new Set<string>();
  const validated: ReconcileScanFile[] = [];
  const failedPaths: string[] = [];
  for (const entry of files) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("Kernel scan returned a non-object file entry.");
    }
    const record = entry as Record<string, unknown>;
    const path = record.path;
    if (typeof path !== "string") {
      throw new Error("Kernel scan returned a file entry without a string path.");
    }
    // Capture is a READ: a scan lists files that already exist on disk, so
    // host-legal names must be captured, never rejected (read validation
    // applies traversal/absolute/reserved/normalization but not the
    // Windows-write-only host-unsafe-name checks). A path that still fails
    // (traversal, .dohc, non-normalized) is a bad entry — but a single bad
    // path is not a whole-kernel fault: collect it as a skipped failure and
    // keep seeding every OTHER real file, never throw-and-disable the fast
    // scanner for the workspace.
    // A "." (or empty) path is not a real subtree the scan skipped — as a
    // failedPath it would make isUnderScanFailedPath treat EVERY snapshot as
    // unreadable and silently freeze all delete reconciliation. That is
    // whole-result garbage, so force the tolerant TS fallback instead.
    if (path === "." || path === "") {
      throw new Error(`Kernel scan returned a degenerate file path: ${JSON.stringify(path)}.`);
    }
    const check = validateUserReadPath(path);
    if (!check.ok || check.normalized !== path) {
      if (!seen.has(path)) {
        seen.add(path);
        failedPaths.push(path);
      }
      continue;
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
  return { files: validated, failedPaths };
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
  const createId = options.createId ?? (() => randomUUID());
  const reportError =
    options.onError ??
    ((context: string, error: unknown) => {
      console.error(
        `[desktop] workspace engine capture ${context} failed for ${rootPath}:`,
        error,
      );
    });
  // The diagnostic sink runs inside the catch handlers of the daemon-recovery
  // path, where a throw becomes an unhandled rejection — in Electron main, a
  // crash dialog. Reporting a failure must never be able to cause one.
  const onError = (context: string, error: unknown): void => {
    try {
      reportError(context, error);
    } catch {
      // There is nothing left to report the reporting failure to.
    }
  };
  const diskWriter = options.diskWriter ?? createDefaultDiskWriter(rootPath);

  const useRustEngine =
    !options.store &&
    !options.secretStore &&
    options.rustEngineSessions !== undefined;
  let liveStores: ReturnType<typeof createCaptureLiveStores> | null = null;
  function daemonStores() {
    if (!options.rustEngineSessions) {
      throw new Error("Rust engine workspace sessions are unavailable.");
    }
    liveStores ??= createCaptureLiveStores(
      { workspaceId, rootPath },
      options.rustEngineSessions,
    );
    return liveStores;
  }

  let store: CaptureVersionedTextStore | null = options.store ?? null;
  let secretStore: SecretFileStore | null = options.secretStore ?? null;
  let expectedEvents: RegisteredExpectedEngineEvent[] = [];
  let stopped = false;
  let daemonCaptureHealthTimer: ReturnType<typeof setTimeout> | null = null;
  // A healthy watcher batch cannot clear the workspace notice while any dead
  // editor session is still rejecting the user's edits.
  const deadYDocSessions = new Set<object>();
  // Dead-session failures are an independent penalty, so retain the latest
  // watcher/health result when that penalty is added and later removed.
  let backgroundCaptureHealthy = true;

  const publishCaptureOutcome = (): void => {
    options.onCaptureOutcome?.({
      ok: backgroundCaptureHealthy && deadYDocSessions.size === 0,
    });
  };

  const emitCaptureOutcome = (ok: boolean): void => {
    backgroundCaptureHealthy = ok;
    publishCaptureOutcome();
  };

  const clearDeadYDocSession = (token: object): void => {
    if (!deadYDocSessions.delete(token)) return;
    if (deadYDocSessions.size === 0) publishCaptureOutcome();
  };

  // THE AUTHORITATIVE live-session registry (WS-G2-C-2 gate fix). One entry per
  // path with a LIVE engine Y.Doc session; the single-canonical reservation
  // guarantees at most one session per path. Every lifecycle op that rewrites
  // or removes a path (version switch/merge/create, rename, delete) coordinates
  // through this registry — flushing + releasing the session FIRST — so a later
  // settle can never write a stale projection into a new version, resurrect a
  // moved/deleted path, or orphan the object.
  //
  // Capture coexistence is now sha-precise, NOT a blanket skip: a healthy live
  // session's own settle .md self-write is suppressed by its expected-event sha
  // (registered in onSettled BEFORE the disk write), so a GENUINE external edit
  // to a live path is captured normally instead of silently dropped. Only a
  // session whose teardown is FAILING is blanket-deferred (its reservation may
  // still be held and the on-disk state is indeterminate).
  interface LiveYDocSession {
    path: string;
    // The version active when the session opened. A version op invalidates it,
    // which is exactly why every version op must vacate live sessions first.
    versionId: string;
    session: EngineYDocProviderSession;
    // "live": healthy; sha-precise suppression, external edits captured.
    // "dead-generation": the daemon generation died; the canonical doc still
    // holds the user's text and a later op can rebuild a generation around it.
    // "failing-close": close/settle threw during TEARDOWN; the reservation may
    // still be held and the on-disk state is indeterminate. Only teardown
    // clears this — a recovering generation must never lift it.
    status: "live" | "dead-generation" | "failing-close";
    // Flush + tear down, releasing the reservation, then drop the registry
    // entry — ONLY on success. On failure the entry is retained as
    // failing-close and the error propagates (never swallowed on this
    // data-integrity-critical teardown). Reused by the returned session's
    // close(), the renderer close IPC, and every lifecycle op below.
    close: (opts?: { settle?: boolean; summary?: string }) => Promise<void>;
  }
  const liveYDocSessions = new Map<string, LiveYDocSession>();

  async function openRestartSafeRustYDocSession(input: {
    versionId: string;
    path: string;
    contentKind?: YDocContentKind;
    onDead: () => void;
    onAlive: () => void;
    onRemoteUpdate: (update: Uint8Array) => void;
    onSettled: (result: {
      sha256: string;
      markdown: string;
    }) => void | Promise<void>;
  }): Promise<EngineYDocProviderSession> {
    const sessions = options.rustEngineSessions!;
    const openProvider =
      options.openRustYDocProviderSession ??
      openEngineYdocProviderSessionRust;
    const workspace = { workspaceId, rootPath };
    let canonicalDoc: Y.Doc | null = null;
    let current: EngineYdocProviderSessionRust | null = null;
    let releaseObligation: EngineYdocProviderSessionRust | null = null;
    let closed = false;
    let dead = false;
    const deadSessionToken = {};
    let operationChain: Promise<void> = Promise.resolve();
    const openingRemoteUpdates = new WeakMap<
      EngineYdocProviderSessionRust,
      { updates: Uint8Array[]; installed: boolean }
    >();

    const append = <T>(operation: () => Promise<T>): Promise<T> => {
      const pending = operationChain.then(operation);
      operationChain = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    };

    const markDead = (
      unreleased: EngineYdocProviderSessionRust | null,
    ): void => {
      releaseObligation ??= unreleased;
      current = null;
      input.onDead();
      if (dead) return;
      dead = true;
      deadYDocSessions.add(deadSessionToken);
      publishCaptureOutcome();
    };

    // A dead session that later rebuilds a generation is live again — leaving
    // it marked dead would defer capture of the path forever and keep an honest
    // workspace notice up about a session that recovered. The dead generation's
    // lease went with it (a live one would have made this open refuse), so the
    // release obligation it left behind is discharged too.
    const markAlive = (): void => {
      releaseObligation = null;
      if (!dead) return;
      dead = false;
      clearDeadYDocSession(deadSessionToken);
      input.onAlive();
    };

    const releaseGeneration = async (
      generation: EngineYdocProviderSessionRust,
    ): Promise<void> => {
      try {
        await generation.close({ settle: false });
      } catch (error) {
        if (isYdocSessionNotFoundRefusal(error)) return;
        try {
          await generation.close({ settle: true });
        } catch (settlingCloseError) {
          if (isYdocSessionNotFoundRefusal(settlingCloseError)) return;
          throw settlingCloseError;
        }
      }
    };

    // `seedAbsentLineage: false` for every generation after the first. A hard
    // daemon kill can lose the object's durable lineage, and a reopen would
    // then seed a fresh doc from the .md — a new client id whose state does not
    // overlap the canonical doc, so merging it would append a SECOND copy of
    // the file. The canonical doc is the renderer's truth; the replacement
    // starts empty and the replay re-establishes it.
    const openGeneration = async (
      seedAbsentLineage: boolean,
    ): Promise<EngineYdocProviderSessionRust> =>
      await sessions.run(
        workspace,
        async (binding) => {
          if (typeof binding.client.onEvent !== "function") {
            throw new Error(
              "Rust engine client does not expose Y.Doc event delivery.",
            );
          }
          let opened: EngineYdocProviderSessionRust | null = null;
          const opening = { updates: [] as Uint8Array[], installed: false };
          const requestReconnect = (error: unknown): void => {
            if (
              opened === null ||
              closed ||
              !isEngineSessionReconnectError(error)
            ) {
              return;
            }
            const failed = opened;
            void append(async () => {
              if (current === failed) await rebind(failed);
            }).catch((rebindError: unknown) => {
              onError(`Y.Doc rebind of ${input.path}`, rebindError);
            });
          };
          opened = await openProvider({
            transport: binding.client as EngineTransport,
            workspace: binding.workspace,
            versionId: input.versionId,
            path: input.path,
            seedAbsentLineage,
            ...(input.contentKind
              ? { contentKind: input.contentKind }
              : {}),
            onRemoteUpdate: (update) => {
              if (current !== opened || canonicalDoc === null) {
                if (!opening.installed) opening.updates.push(update);
                return;
              }
              Y.applyUpdate(canonicalDoc, update);
              input.onRemoteUpdate(update);
            },
            onLocalEditError: requestReconnect,
            onSessionError: requestReconnect,
            onSettled: input.onSettled,
          });
          openingRemoteUpdates.set(opened, opening);
          return opened;
        },
        { retryTransportErrors: true },
      );

    // Reconcile a freshly opened generation against the canonical doc and
    // install it: daemon-side edits land in the canonical doc first, then every
    // renderer edit the replacement is missing is replayed into it. The exposed
    // Y.Doc never changes identity across daemon generations.
    const adoptGeneration = async (
      doc: Y.Doc,
      replacement: EngineYdocProviderSessionRust,
    ): Promise<void> => {
      try {
        const opening = openingRemoteUpdates.get(replacement);
        const updatesIncludedInRemoteDelta = opening?.updates.length ?? 0;

        const remoteDelta = Y.encodeStateAsUpdate(
          replacement.doc,
          Y.encodeStateVector(doc),
        );
        if (remoteDelta.byteLength > 2) {
          Y.applyUpdate(doc, remoteDelta);
          input.onRemoteUpdate(remoteDelta);
        }
        const replay = Y.encodeStateAsUpdate(
          doc,
          Y.encodeStateVector(replacement.doc),
        );
        if (replay.byteLength > 2) {
          await replacement.applyLocalUpdate(replay);
        }
        current = replacement;
        if (opening) {
          opening.installed = true;
          openingRemoteUpdates.delete(replacement);
          for (const update of opening.updates.slice(
            updatesIncludedInRemoteDelta,
          )) {
            Y.applyUpdate(doc, update);
            input.onRemoteUpdate(update);
          }
        }
      } catch (error) {
        openingRemoteUpdates.delete(replacement);
        try {
          await releaseGeneration(replacement);
          markDead(null);
        } catch {
          markDead(replacement);
        }
        throw error;
      }
      markAlive();
    };

    const rebind = async (
      failed: EngineYdocProviderSessionRust,
      options?: { releaseBeforeOpen?: boolean },
    ): Promise<void> => {
      if (current !== failed || canonicalDoc === null || closed) return;
      const doc = canonicalDoc;
      if (options?.releaseBeforeOpen) {
        try {
          await releaseGeneration(failed);
        } catch (error) {
          markDead(failed);
          throw error;
        }
        if (current !== failed || closed) return;
        current = null;
      }
      let replacement: EngineYdocProviderSessionRust;
      try {
        replacement = await openGeneration(false);
      } catch (error) {
        markDead(failed);
        throw error;
      }
      await adoptGeneration(doc, replacement);
      // A reconnect-class failure means the prior daemon/workspace binding is
      // gone. Opening the replacement first is the release boundary; sending a
      // close through the broken transport can only fail and must not turn a
      // recoverable daemon restart into a dead session.
    };

    // A session whose generation died leaves the canonical doc as the only
    // holder of the renderer's text. Rebuild a generation around it so a dead
    // session heals on the next keystroke instead of discarding every one.
    // Opening is the only release boundary available here: a generation that
    // died with its daemon took its lease with it, and one that died still
    // holding a LIVE lease refuses the open and stays dead for close() to
    // converge — the retained release obligation remains teardown's job.
    const reviveDeadSession = async (doc: Y.Doc): Promise<void> => {
      if (closed || current !== null) return;
      await adoptGeneration(doc, await openGeneration(false));
    };

    const closedError = (cause?: unknown): Error =>
      new Error(
        `Y.Doc session for ${input.path} is closed.`,
        cause === undefined ? {} : { cause },
      );

    const executeWithReconnect = async <T>(
      operation: (session: EngineYdocProviderSessionRust) => Promise<T>,
    ): Promise<T> => {
      if (closed) throw closedError();
      // Settling and closing are the paths that PERSIST. A dead session still
      // holds the user's text in the canonical doc, so rebuild a generation for
      // it to land in rather than reporting closed and dropping it.
      if (current === null) {
        if (canonicalDoc === null) throw closedError();
        try {
          await reviveDeadSession(canonicalDoc);
        } catch (error) {
          throw closedError(error);
        }
        if (current === null) throw closedError();
      }
      const generation = current;
      try {
        return await operation(generation);
      } catch (error) {
        if (!isEngineSessionReconnectError(error)) throw error;
        await rebind(generation);
        if (current === null) throw error;
        return await operation(current);
      }
    };

    current = await openGeneration(true);
    canonicalDoc = current.doc;
    const initialOpening = openingRemoteUpdates.get(current);
    if (initialOpening) {
      initialOpening.installed = true;
      openingRemoteUpdates.delete(current);
      for (const update of initialOpening.updates) {
        input.onRemoteUpdate(update);
      }
    }
    // A daemon update can arrive after the provider has encoded its initial
    // state but before this generation is installed. The provider has already
    // applied it to `doc`; encode the installed canonical state so the
    // renderer cannot initialize from the stale pre-update snapshot.
    const initialUpdate = Y.encodeStateAsUpdate(canonicalDoc);
    const contentKind = current.contentKind;
    const sessionPath = current.path;

    return {
      doc: canonicalDoc,
      initialUpdate,
      contentKind,
      path: sessionPath,
      applyLocalUpdate(update) {
        void append(async () => {
          if (canonicalDoc === null || closed) throw closedError();
          const doc = canonicalDoc;
          // The renderer has already accepted this update, so the canonical doc
          // — the renderer's truth — records it before anything else may fail.
          // A daemon generation is rebuilt AROUND that text, never instead of
          // it: dropping the update here is exactly how visible typing vanished
          // once a generation died.
          if (current === null) {
            Y.applyUpdate(doc, update);
            await reviveDeadSession(doc);
            return;
          }
          const generation = current;
          try {
            await generation.applyLocalUpdate(update);
            Y.applyUpdate(doc, update);
          } catch (error) {
            // A live refusal still owns its lease and must close first; a
            // transport restart opens first because the old daemon is gone.
            Y.applyUpdate(doc, update);
            await rebind(generation, {
              releaseBeforeOpen: !isEngineSessionReconnectError(error),
            });
          }
        }).catch((error: unknown) => {
          onError(`Y.Doc local update of ${input.path}`, error);
        });
      },
      settleNow(settleOptions) {
        return append(async () =>
          await executeWithReconnect(async (session) =>
            await session.settleNow(settleOptions),
          ),
        );
      },
      applyExternalMarkdownEdit(markdown) {
        return append(async () => {
          const result = await executeWithReconnect(async (session) =>
            await session.applyExternalMarkdownEdit(markdown),
          );
          return { supported: result.kind === "merged" };
        });
      },
      close(closeOptions) {
        return append(async () => {
          if (closed) return;
          // The quit path closes with a settle and nobody types again, so this
          // is the last chance to persist text the canonical doc has been
          // holding since the daemon died.
          if (
            current === null &&
            canonicalDoc !== null &&
            closeOptions?.settle !== false
          ) {
            try {
              await reviveDeadSession(canonicalDoc);
            } catch (error) {
              onError(`Y.Doc close recovery of ${input.path}`, error);
            }
          }
          if (current === null) {
            if (releaseObligation !== null) {
              await releaseGeneration(releaseObligation);
              releaseObligation = null;
            }
            closed = true;
            clearDeadYDocSession(deadSessionToken);
            return;
          }
          try {
            await executeWithReconnect(async (session) => {
              await session.close(closeOptions);
            });
          } catch (error) {
            // A settle failure whose RELEASE still succeeded tore the daemon
            // session down — record the teardown before rethrowing, or every
            // layer above would treat the path as still-reserved forever.
            if (error instanceof YdocReleasedWithSettleFailureError) {
              closed = true;
              current = null;
              clearDeadYDocSession(deadSessionToken);
            }
            throw error;
          }
          closed = true;
          current = null;
          clearDeadYDocSession(deadSessionToken);
        });
      },
    };
  }

  // Flush (settle) + release every live Y.Doc session whose path matches, so a
  // destructive/rewriting op can never collide with a later stale settle.
  // Propagates the first teardown failure: the op fails and the entry is
  // retained as failing-close for a retry. Callers already inside enqueueResult
  // (version ops, beginFileRename) call this directly; external callers go
  // through the enqueued settleAndCloseLiveSessionsForPath method.
  async function settleAndCloseLiveYDocSessions(
    match: (path: string) => boolean,
    summary: string,
  ): Promise<void> {
    for (const entry of [...liveYDocSessions.values()]) {
      if (!match(entry.path)) continue;
      // A healthy session flushes the CRDT to disk + projection first; a
      // failing-close entry already attempted its flush, so just retry release.
      if (entry.status === "live") {
        await entry.session.settleNow({ summary });
      }
      await entry.close({ settle: false });
    }
  }

  // The encrypted secret store (PR 08) shares engine.db; opened lazily so
  // workspaces without secret files never touch the key path.
  function secretStoreFor(): SecretFileStore {
    secretStore ??= useRustEngine
      ? daemonStores().secretStore
      : createSecretFileStore(rootPath);
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
      const { files, failedPaths } = validateKernelScanFiles(result);
      workspaceKernelConsecutiveFailures = 0;
      return { files, failedPaths };
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
  function engineStore(): Promise<CaptureVersionedTextStore> {
    if (!initialized) {
      const attempt = (async () => {
        store ??= useRustEngine
          ? daemonStores().store
          : createVersionedTextStore(rootPath);
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

  async function listTextFileMetadata(
    engine: VersionedTextStore,
    versionId: string,
  ): Promise<CaptureTextFileMetadata[]> {
    const captureEngine = engine as CaptureVersionedTextStore;
    if (captureEngine.listTextFileMetadata) {
      return await captureEngine.listTextFileMetadata({ workspaceId, versionId });
    }
    const snapshots = await engine.listTextFiles({ workspaceId, versionId });
    return snapshots.map((snapshot) => ({
      path: snapshot.path,
      objectId: snapshot.objectId,
      contentKind: snapshot.contentKind ?? "text",
      byteLength: snapshot.byteLength ?? Buffer.byteLength(snapshot.text, "utf8"),
      sha256:
        snapshot.sha256 ??
        (snapshot.contentKind === "binary"
          ? null
          : sha256Utf8(snapshot.text)),
      updatedAtMs: snapshot.updatedAtMs,
      latestMomentId: snapshot.latestMomentId,
    }));
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
    // WS-G2-C-2 watcher coexistence (gate fix 1). The settle's OWN .md self-write
    // is suppressed PRECISELY below by consumeExpectedEvent (onSettled registers
    // the settled sha BEFORE the disk write): a matching sha is our own write and
    // never re-journals. A watcher event on a live path whose sha does NOT match
    // an expected settle self-write is a GENUINE external edit (agent/other
    // editor) and MUST NOT be dropped — it is captured normally below (it becomes
    // a moment; on a shared workspace that surfaces as a real conflict, which is
    // correct, NOT silent loss). Folding an external edit into the live doc as
    // CRDT deltas is G2-C-3; here the bar is simply not-dropping.
    //
    // The blanket defer covers any session that is not healthy: a FAILING
    // teardown may still hold the reservation with the on-disk state
    // indeterminate, and a dead generation still owns the path through its
    // canonical doc. Neither may have a partial write journaled under it.
    const liveSessionStatus = liveYDocSessions.get(event.path)?.status;
    if (liveSessionStatus !== undefined && liveSessionStatus !== "live") return;
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
    const tracked = await listTextFileMetadata(engine, versionId);
    for (const file of tracked) {
      if (diskPaths.has(file.path)) continue;
      if (isUnderScanFailedPath(file.path, failedPaths)) continue;
      // TS-confirm the absence before retiring: the scan (kernel or TS) is
      // trusted for adds/updates but never to authorize a delete on its own.
      if (!(await pathConfirmedAbsentOnDisk(rootPath, file.path))) continue;
      await deleteIfTracked(engine, versionId, file.path, metadata);
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
      correlationId: `reconcile-${createId()}`,
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
    const targetFiles = await listTextFileMetadata(engine, targetVersionId);
    const targetPaths = new Set(targetFiles.map((file) => file.path));
    const targetTextSnapshots = new Map(
      (
        await Promise.all(
          targetFiles
            .filter(
              (file) =>
                file.contentKind === "text" &&
                policyTracksPath(file.path, policy),
            )
            .map(async (file) => {
              const snapshot = await engine.readTextFile({
                workspaceId,
                versionId: targetVersionId,
                path: file.path,
              });
              if (!snapshot || snapshot.contentKind === "binary") {
                throw new Error(
                  `Text content for ${file.path} is no longer available.`,
                );
              }
              return [file.path, snapshot] as const;
            }),
        )
      ),
    );
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
      const snapshot = targetTextSnapshots.get(file.path);
      if (!snapshot) {
        throw new Error(`Text content for ${file.path} is no longer available.`);
      }
      if (
        disk.kind === "text" &&
        (file.sha256 !== null
          ? disk.sha256 === file.sha256
          : disk.sha256 === sha256Utf8(snapshot.text))
      ) {
        continue;
      }
      operations.push({ kind: "write", path: file.path, text: snapshot.text });
    }
    // Only paths the PREVIOUS version tracked are deletable: the pre-switch
    // reconcile captured every engine-ownable text file into it, so this set
    // is exactly "text files the engine owns on disk right now".
    const previousFiles = await listTextFileMetadata(
      engine,
      previousVersionId,
    );
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
      emitCaptureOutcome(ok);
    }
  }

  function pollDaemonCaptureHealth(): void {
    if (stopped || daemonCaptureHealthTimer !== null) return;
    enqueue("daemon capture health", () =>
      reportCaptureOutcome(async () => {
        const engine = await engineStore();
        const status = await engine.watcherStatus?.();
        return status === undefined
          ? true
          : status.running && !status.degraded && !status.terminal;
      }),
    );
    const timer = setTimeout(() => {
      if (daemonCaptureHealthTimer === timer) daemonCaptureHealthTimer = null;
      pollDaemonCaptureHealth();
    }, DAEMON_CAPTURE_HEALTH_POLL_MS);
    daemonCaptureHealthTimer = timer;
    daemonCaptureHealthTimer.unref?.();
  }

  return {
    start() {
      if (options.daemonOwnsCapture) {
        pollDaemonCaptureHealth();
        return;
      }
      enqueue("startup reconciliation", () =>
        // reconcile() reports false when the tolerant scan skipped paths:
        // everything readable seeded, but the pass is degraded, so the
        // capture-failure notice raises instead of a silent partial pass.
        reportCaptureOutcome(() => reconcile()),
      );
    },

    captureBatch(events) {
      if (events.length === 0) return;
      if (options.daemonOwnsCapture) return;
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

    setActiveAgentRun(run) {
      return enqueueResult("daemon capture authorship", async () => {
        if (!options.daemonOwnsCapture) return;
        const engine = await engineStore();
        if (run === null) await engine.flushCapture?.();
        await engine.setCaptureAuthor?.(
          run === null
            ? null
            : {
                kind: "agent",
                agentId: run.agentId,
                onBehalfOf: run.onBehalfOf,
                agentRunId: run.agentRunId,
              },
        );
      });
    },

    registerExpectedEngineEvents,

    async openYDocSession(input) {
      // Reuse THIS capture's store (single-writer safety): the driver writes
      // only through store.runInEngineWriteLane / store.writeProjectedTextFile,
      // so it shares the store's one write connection + serialized lane. A
      // second createVersionedTextStore on the same engine.db would be a second
      // write connection and node:sqlite deadlocks.
      const engine = await engineStore();
      const versionId = await activeVersionIdOf(engine);
      const onSettled = async (result: {
        sha256: string;
        markdown: string;
      }) => {
        // Register the settle's self-write (sha of the projected markdown) so
        // even a watcher event that lands after the live-path guard lifts on
        // close is recognized as our own; then write the on-disk .md the
        // user/agent sees, through the contained disk writer.
        const cancel = registerExpectedEngineEvents([
          { path: input.path, operation: "write", sha256: result.sha256 },
        ]);
        try {
          await diskWriter.writeTextFile(
            join(rootPath, input.path),
            result.markdown,
          );
        } catch (error) {
          cancel();
          onError(`ydoc settle disk write of ${input.path}`, error);
        }
      };
      let entry: LiveYDocSession | null = null;
      const session = useRustEngine
        ? await openRestartSafeRustYDocSession({
            versionId,
            path: input.path,
            ...(input.contentKind
              ? { contentKind: input.contentKind }
              : {}),
            onDead: () => {
              if (
                entry !== null &&
                liveYDocSessions.get(input.path) === entry &&
                entry.status === "live"
              ) {
                entry.status = "dead-generation";
              }
            },
            onAlive: () => {
              if (
                entry !== null &&
                liveYDocSessions.get(input.path) === entry &&
                entry.status === "dead-generation"
              ) {
                entry.status = "live";
              }
            },
            onRemoteUpdate: input.onRemoteUpdate,
            onSettled,
          })
        : await openEngineYDocProviderSession({
            store: engine,
            rootDir: rootPath,
            workspaceId,
            versionId,
            path: input.path,
            ...(input.contentKind ? { contentKind: input.contentKind } : {}),
            onRemoteUpdate: input.onRemoteUpdate,
            onSettled,
          });
      // Register the live session only after the open succeeds (a secret/
      // not-found/already-live rejection propagates to the caller and never
      // guards a path that has no session). The close below drops the entry
      // ONLY when teardown succeeds (gate fix 5): a failing close retains a
      // failing-close entry so the reservation/retry are not lost and capture
      // stays deferred for the path.
      const closeEntry = async (opts?: {
        settle?: boolean;
        summary?: string;
      }): Promise<void> => {
        try {
          await session.close(opts);
        } catch (error) {
          if (error instanceof YdocReleasedWithSettleFailureError) {
            // The daemon session and its lease ARE gone — only the settle
            // failed. Lift the guard like a clean teardown (capture of the
            // path must resume; nothing holds the reservation) and rethrow so
            // the settle failure still surfaces to the caller.
            if (liveYDocSessions.get(input.path) === entry) {
              liveYDocSessions.delete(input.path);
            }
            throw error;
          }
          // The reservation may still be held and the on-disk state is
          // indeterminate — retain a failing-close guard so a retry/force-close
          // can complete the teardown, and DO NOT swallow (data-integrity
          // teardown). captureOnePath keeps deferring this path meanwhile.
          if (liveYDocSessions.get(input.path) === entry) {
            entry.status = "failing-close";
          }
          throw error;
        }
        // Lift the guard exactly when the session tears down (releasing the
        // single-canonical reservation), so ordinary capture of this path
        // resumes for the next opener / external editor.
        if (liveYDocSessions.get(input.path) === entry) {
          liveYDocSessions.delete(input.path);
        }
      };
      entry = {
        path: input.path,
        versionId,
        session,
        status: "live",
        close: closeEntry,
      };
      liveYDocSessions.set(input.path, entry);
      return {
        doc: session.doc,
        initialUpdate: session.initialUpdate,
        contentKind: session.contentKind,
        path: session.path,
        applyLocalUpdate: (update) => session.applyLocalUpdate(update),
        settleNow: (opts) => session.settleNow(opts),
        applyExternalMarkdownEdit: (markdown) =>
          session.applyExternalMarkdownEdit(markdown),
        close: closeEntry,
      };
    },

    settleAndCloseLiveSessionsForPath(pathOrPrefix) {
      // Public seam for destructive ops that DON'T run through the capture chain
      // themselves (the delete IPC deletes on disk directly). Enqueued so it is
      // ordered against pending capture batches and version ops. Flushes +
      // releases every live session at OR under the path so no stale settle can
      // resurrect a deleted file / orphan the object afterward.
      return enqueueResult("close live session for destructive op", async () => {
        await settleAndCloseLiveYDocSessions(
          (p) => p === pathOrPrefix || p.startsWith(`${pathOrPrefix}/`),
          "Saved latest edits before removing the file",
        );
      });
    },

    async listVersions() {
      const engine = await engineStore();
      return versionsSnapshot(engine);
    },

    createVersion(name) {
      return enqueueResult("create version", async () => {
        const policy = await readPolicyForTask();
        const engine = await engineStore();
        const fromVersionId = await activeVersionIdOf(engine);
        // WS-G2-C-2 (gate fix 2): create-and-switch makes the new fork active,
        // so a session still live on the old version would settle a stale
        // projection into a version it no longer owns. Vacate live sessions
        // first, exactly as switchVersion does.
        await settleAndCloseLiveYDocSessions(
          () => true,
          "Saved latest edits before creating a version",
        );
        // Fork from exactly what's on disk right now — capture the latest
        // edits first so the new version starts as a faithful copy.
        if (options.daemonOwnsCapture) {
          await engine.flushCapture?.();
        } else {
          await reconcileDiskIntoVersion(
            engine,
            fromVersionId,
            policy,
            {
              origin: "local-file",
              summary: "Saved latest edits",
              correlationId: `version-create-${createId()}`,
            },
          );
        }
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
        await listTextFileMetadata(engine, versionId);
        // WS-G2-C-2 (gate fix 2): a live Y.Doc session pins its OLD versionId+
        // path. Materializing another version into the same folder while it
        // stays live would let a later settle write a STALE projection into the
        // now-active version (two-canonical / two-lineage corruption). Flush +
        // release EVERY live session first so the switch starts from a quiesced,
        // single-canonical folder. A teardown failure fails the switch.
        await settleAndCloseLiveYDocSessions(
          () => true,
          "Saved latest edits before switching versions",
        );
        if (options.daemonOwnsCapture) {
          // The daemon watcher owns the source version. Force it to settle
          // before comparing heads, otherwise both the changed-file count and
          // the version being left can be based on pre-save state.
          await engine.flushCapture?.();
          const [before, after, secretOperations] = await Promise.all([
            listTextFileMetadata(engine, fromVersionId),
            listTextFileMetadata(engine, versionId),
            // The daemon performs the actual materialization after setActive;
            // this plan is used only to include protected paths in the result.
            planSecretMaterialization(versionId, fromVersionId),
          ]);
          const beforeByPath = new Map(
            before.map((file) => [file.path, `${file.contentKind}:${file.sha256 ?? ""}`]),
          );
          const afterByPath = new Map(
            after.map((file) => [file.path, `${file.contentKind}:${file.sha256 ?? ""}`]),
          );
          const changedPaths = new Set([...beforeByPath.keys(), ...afterByPath.keys()]);
          let changedFileCount = secretOperations.length;
          for (const path of changedPaths) {
            if (beforeByPath.get(path) !== afterByPath.get(path)) changedFileCount += 1;
          }
          await engine.setActiveVersion({ workspaceId, versionId });
          return { activeVersionId: versionId, changedFileCount };
        }
        // Nothing is ever lost: the current disk state (including edits still
        // inside the watcher settle window) is captured into the version the
        // user is leaving.
        const correlationId = `version-switch-${createId()}`;
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
        if (options.daemonOwnsCapture) {
          await engine.flushCapture?.();
        } else {
          await reconcileDiskIntoVersion(
            engine,
            activeVersionId,
            policy,
            {
              origin: "local-file",
              summary: "Saved latest edits",
              correlationId: `version-compare-${createId()}`,
            },
          );
        }
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
        const correlationId = `version-merge-${createId()}`;
        // WS-G2-C-2 (gate fix 2): a merge materializes results into the active
        // folder. Vacate live sessions first so a later settle can't overwrite
        // the merged result / reopen a stale lineage.
        await settleAndCloseLiveYDocSessions(
          () => true,
          "Saved latest edits before merging",
        );
        // Capture the latest disk edits so the merge sees them (whichever
        // side is active).
        if (options.daemonOwnsCapture) {
          await engine.flushCapture?.();
        } else {
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
        }
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
          if (!options.daemonOwnsCapture) {
            if (result.operation === "write") {
              materializations.push(
                await materializeWriteForSnapshot(engine, result.write.snapshot),
              );
            } else {
              materializations.push({ kind: "delete", path: change.path });
            }
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
        if (options.daemonOwnsCapture) {
          await engine.flushCapture?.();
        }
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
      if (options.daemonOwnsCapture) {
        await engine.flushCapture?.();
      }
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
      if (options.daemonOwnsCapture) {
        await engine.flushCapture?.();
      }
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
        if (options.daemonOwnsCapture) {
          await engine.flushCapture?.();
        }
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
          const secretCorrelationId = `restore-${createId()}`;
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
        const correlationId = `restore-${createId()}`;
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
      if (options.daemonOwnsCapture) {
        await engine.flushCapture?.();
      }
      const activeVersionId = await activeVersionIdOf(engine);
      const snapshot = await engine.readTextFile({
        workspaceId,
        versionId: activeVersionId,
        path,
      });
      return snapshot?.objectId ?? null;
    },

    async filePathForObjectId(objectId) {
      await chain;
      const engine = await engineStore();
      const activeVersionId = await activeVersionIdOf(engine);
      const files = await engine.listTextFiles({
        workspaceId,
        versionId: activeVersionId,
      });
      return files.find((file) => file.objectId === objectId)?.path ?? null;
    },

    writeGeneratedTextFile(input) {
      return enqueueResult("write generated text", async () => {
        const path = assertGeneratedMarkdownPath(input.path);
        if (Buffer.byteLength(input.text, "utf8") > MAX_ENGINE_CAPTURE_TEXT_BYTES) {
          throw new Error(`Generated Markdown is too large to track: ${path}`);
        }
        if (input.recoverExistingText) {
          // Recovery may only replace an owned projection with another text
          // carrying the same durable identity; otherwise the next crash
          // retry would lose its proof of ownership.
          assertGeneratedTextRecoveryIdentity(path, input.text, input.recoverExistingText);
        }
        await settleAndCloseLiveYDocSessions(
          (candidate) => candidate === path,
          "Saved latest edits before refreshing generated content",
        );
        const policy = await readPolicyForTask();
        assertEngineWritablePath(path, policy);
        const engine = await engineStore();
        const versionId = await activeVersionIdOf(engine);
        let current = await engine.readTextFile({ workspaceId, versionId, path });
        if (current?.contentKind === "binary") {
          throw new Error(`Generated Markdown cannot replace a binary file: ${path}`);
        }
        if (
          (input.createOnly && (input.expectedObjectId || input.recoverExistingText)) ||
          (input.expectedObjectId && input.recoverExistingText)
        ) {
          throw new Error("Generated Markdown write authority is ambiguous.");
        }
        if (input.createOnly && current) {
          throw new Error(`Generated Markdown destination already exists: ${path}`);
        }
        if (input.expectedObjectId) {
          if (!current || current.objectId !== input.expectedObjectId) {
            throw new Error(`Generated Markdown identity no longer matches: ${path}`);
          }
        } else if (input.recoverExistingText && current) {
          assertGeneratedTextRecoveryIdentity(path, current.text, input.recoverExistingText);
        } else if (current && current.text !== input.text) {
          // First creation may be retried after a crash, but it may not adopt
          // and overwrite an unrelated tracked file merely because the path
          // happens to collide.
          throw new Error(`Generated Markdown destination already exists: ${path}`);
        }

        const disk = await readDiskTextState(rootPath, path);
        if (input.createOnly && disk.kind !== "absent") {
          throw new Error(`Generated Markdown destination already exists on disk: ${path}`);
        }
        if (
          disk.kind === "binary" ||
          disk.kind === "untracked-content" ||
          disk.kind === "unreadable"
        ) {
          throw new Error(`Generated Markdown cannot safely replace the file on disk: ${path}`);
        }
        if (input.recoverExistingText && disk.kind === "text") {
          assertGeneratedTextRecoveryIdentity(path, disk.text, input.recoverExistingText);
        }
        if (
          !current &&
          !input.recoverExistingText &&
          disk.kind === "text" &&
          disk.text !== input.text
        ) {
          throw new Error(`Generated Markdown destination already exists on disk: ${path}`);
        }

        const metadata: ActorNeutralWriteMetadata = input.metadata ?? {
          origin: "api",
          summary: `Updated generated ${pathBasename(path)}`,
          correlationId: `generated-write-${createId()}`,
        };
        // Preserve a manually edited disk preimage in history before the
        // canonical generated copy replaces it. This never grants that edit
        // authority over the chat source; it only keeps recovery honest.
        if (
          disk.kind === "text" &&
          disk.text !== current?.text &&
          (Boolean(current) || Boolean(input.recoverExistingText))
        ) {
          await writeIfChanged(engine, versionId, path, disk, {
            origin: "local-file",
            summary: `Saved edits before refreshing ${pathBasename(path)}`,
            correlationId: metadata.correlationId,
          });
          current = await engine.readTextFile({ workspaceId, versionId, path });
        }

        let changed = false;
        if (!current || current.text !== input.text) {
          const written = await engine.writeTextFile({
            workspaceId,
            versionId,
            path,
            text: input.text,
            metadata,
          });
          current = written.snapshot;
          changed = true;
        }
        if (disk.kind !== "text" || disk.text !== input.text) {
          await materialize([{ kind: "write", path, text: input.text }], policy);
          changed = true;
        }
        if (!current) throw new Error(`Generated Markdown did not materialize: ${path}`);
        return { path, objectId: current.objectId, changed };
      });
    },

    archiveGeneratedTextFile(input) {
      return enqueueResult("archive generated text", async () => {
        const fromPath = assertGeneratedMarkdownPath(input.fromPath);
        const toPath = assertGeneratedMarkdownPath(input.toPath);
        if (fromPath === toPath) {
          throw new Error("Generated Markdown archive destination must be different.");
        }
        if (Boolean(input.expectedObjectId) === Boolean(input.recoverExistingText)) {
          throw new Error(
            "Generated Markdown archive requires exactly one ownership authority.",
          );
        }
        await settleAndCloseLiveYDocSessions(
          (candidate) => candidate === fromPath || candidate === toPath,
          "Saved latest edits before archiving generated content",
        );
        const policy = await readPolicyForTask();
        assertEngineWritablePath(fromPath, policy);
        assertEngineWritablePath(toPath, policy);
        const engine = await engineStore();
        const versionId = await activeVersionIdOf(engine);
        let source = await engine.readTextFile({ workspaceId, versionId, path: fromPath });
        let destination = await engine.readTextFile({ workspaceId, versionId, path: toPath });

        if (!source && !destination && input.recoverExistingText) {
          // A pre-delta projection may exist only on disk because no engine
          // object had been created yet. Capture exactly one marker-validated
          // side before continuing through the normal identity-preserving
          // archive path. Two present paths are ambiguous and fail below.
          const sourceDisk = await readDiskTextState(rootPath, fromPath);
          const destinationDisk = await readDiskTextState(rootPath, toPath);
          const recoverPath =
            sourceDisk.kind === "text" && destinationDisk.kind === "absent"
              ? fromPath
              : sourceDisk.kind === "absent" && destinationDisk.kind === "text"
                ? toPath
                : undefined;
          const recoverDisk = recoverPath === fromPath ? sourceDisk : destinationDisk;
          if (recoverPath && recoverDisk.kind === "text") {
            assertGeneratedTextRecoveryIdentity(
              recoverPath,
              recoverDisk.text,
              input.recoverExistingText,
            );
            await writeIfChanged(engine, versionId, recoverPath, recoverDisk, {
              origin: "local-file",
              summary: `Recovered generated ${pathBasename(recoverPath)}`,
              correlationId: `generated-recovery-${createId()}`,
            });
            source = await engine.readTextFile({ workspaceId, versionId, path: fromPath });
            destination = await engine.readTextFile({ workspaceId, versionId, path: toPath });
          }
        }

        if (!source) {
          // Crash-retry/idempotency: the engine rename already completed.
          if (!destination) {
            throw new Error(`Generated Markdown archive source is unavailable: ${fromPath}`);
          }
          if (destination.contentKind === "binary") {
            throw new Error(`Generated Markdown archive is unexpectedly binary: ${toPath}`);
          }
          if (
            input.expectedObjectId &&
            destination.objectId !== input.expectedObjectId
          ) {
            throw new Error(`Generated Markdown archive source is unavailable: ${fromPath}`);
          }
          if (input.recoverExistingText) {
            assertGeneratedTextRecoveryIdentity(
              toPath,
              destination.text,
              input.recoverExistingText,
            );
          }
          const sourceDisk = await readDiskTextState(rootPath, fromPath);
          const destinationDisk = await readDiskTextState(rootPath, toPath);
          if (input.recoverExistingText && sourceDisk.kind === "text") {
            assertGeneratedTextRecoveryIdentity(
              fromPath,
              sourceDisk.text,
              input.recoverExistingText,
            );
          }
          if (input.recoverExistingText && destinationDisk.kind === "text") {
            assertGeneratedTextRecoveryIdentity(
              toPath,
              destinationDisk.text,
              input.recoverExistingText,
            );
          }
          if (
            sourceDisk.kind === "binary" ||
            sourceDisk.kind === "untracked-content" ||
            sourceDisk.kind === "unreadable" ||
            (!input.recoverExistingText &&
              sourceDisk.kind === "text" &&
              sourceDisk.text !== destination.text)
          ) {
            throw new Error(
              `Generated Markdown archive source changed before recovery: ${fromPath}`,
            );
          }
          if (
            destinationDisk.kind === "binary" ||
            destinationDisk.kind === "untracked-content" ||
            destinationDisk.kind === "unreadable"
          ) {
            throw new Error(`Generated Markdown archive cannot repair its disk copy: ${toPath}`);
          }
          if (destinationDisk.kind === "text" && destinationDisk.text !== destination.text) {
            const canonical = destination.text;
            await writeIfChanged(engine, versionId, toPath, destinationDisk, {
              origin: "local-file",
              summary: `Saved edits before repairing ${pathBasename(toPath)}`,
            });
            const repaired = await engine.writeTextFile({
              workspaceId,
              versionId,
              path: toPath,
              text: canonical,
              metadata: input.metadata ?? {
                origin: "api",
                summary: `Repaired archived ${pathBasename(toPath)}`,
              },
            });
            destination = repaired.snapshot;
          }
          await materialize(
            [
              { kind: "write", path: toPath, text: destination.text },
              { kind: "delete", path: fromPath },
            ],
            policy,
          );
          return {
            fromPath,
            path: toPath,
            objectId: destination.objectId,
            changed: false,
          };
        }

        if (
          source.contentKind === "binary" ||
          (input.expectedObjectId && source.objectId !== input.expectedObjectId)
        ) {
          throw new Error(`Generated Markdown identity no longer matches: ${fromPath}`);
        }
        if (input.recoverExistingText) {
          assertGeneratedTextRecoveryIdentity(
            fromPath,
            source.text,
            input.recoverExistingText,
          );
        }
        if (destination) {
          throw new Error(`Generated Markdown archive destination already exists: ${toPath}`);
        }
        const sourceDisk = await readDiskTextState(rootPath, fromPath);
        const destinationDisk = await readDiskTextState(rootPath, toPath);
        if (input.recoverExistingText && sourceDisk.kind === "text") {
          assertGeneratedTextRecoveryIdentity(
            fromPath,
            sourceDisk.text,
            input.recoverExistingText,
          );
        }
        if (
          sourceDisk.kind === "binary" ||
          sourceDisk.kind === "untracked-content" ||
          sourceDisk.kind === "unreadable" ||
          destinationDisk.kind !== "absent"
        ) {
          throw new Error("Generated Markdown archive paths are not safe to replace.");
        }

        const metadata: ActorNeutralWriteMetadata = input.metadata ?? {
          origin: "api",
          summary: `Archived ${pathBasename(fromPath)}`,
          correlationId: `generated-archive-${createId()}`,
        };
        const canonical = source.text;
        if (sourceDisk.kind === "text" && sourceDisk.text !== canonical) {
          await writeIfChanged(engine, versionId, fromPath, sourceDisk, {
            origin: "local-file",
            summary: `Saved edits before archiving ${pathBasename(fromPath)}`,
            correlationId: metadata.correlationId,
          });
          await engine.writeTextFile({
            workspaceId,
            versionId,
            path: fromPath,
            text: canonical,
            metadata: {
              ...metadata,
              summary: `Restored generated ${pathBasename(fromPath)} before archive`,
            },
          });
          source = await engine.readTextFile({ workspaceId, versionId, path: fromPath });
          if (!source) throw new Error(`Generated Markdown disappeared: ${fromPath}`);
        }
        const renamed = await engine.renameTextFile({
          workspaceId,
          versionId,
          fromPath,
          toPath,
          metadata,
        });
        // Destination-first ensures a partial failure never leaves the user
        // with no readable copy. A retry recognizes the completed engine
        // rename above and repairs/removes the remaining disk path.
        await materialize(
          [
            { kind: "write", path: toPath, text: renamed.after.text },
            { kind: "delete", path: fromPath },
          ],
          policy,
        );
        return {
          fromPath,
          path: toPath,
          objectId: renamed.object.id,
          changed: true,
        };
      });
    },

    beginFileRename(fromPath, toPath) {
      return enqueueResult("prepare rename", async () => {
        // WS-G2-C-2 (gate fix 3): a live Y.Doc session over either endpoint must
        // be flushed + released before the file moves, or a later settle would
        // write the OLD path — resurrecting the moved-from file / orphaning the
        // object. Vacate first (a teardown failure fails the rename).
        await settleAndCloseLiveYDocSessions(
          (p) => p === fromPath || p === toPath,
          "Saved latest edits before renaming",
        );
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

    async flush() {
      await chain;
      if (options.daemonOwnsCapture) {
        await (await engineStore()).flushCapture?.();
      }
    },

    async stop() {
      // Everything already enqueued (including the watcher's final settled
      // batch) still runs; only NEW work is refused.
      stopped = true;
      if (daemonCaptureHealthTimer !== null) {
        clearTimeout(daemonCaptureHealthTimer);
        daemonCaptureHealthTimer = null;
      }
      await chain;
      try {
        if (options.daemonOwnsCapture && store) {
          await store.flushCapture?.();
        }
      } finally {
        // App quit may abandon a dead generation's retained release obligation:
        // the daemon process exits immediately afterward and releases every
        // workspace/session lease. Interactive lifecycle operations never use
        // this force-drop path; they must converge through closeEntry first.
        // Release the SQLite handles for the stores THIS capture created, so
        // repeated workspace switches never accumulate handles/WAL locks. An
        // injected store belongs to its creator and is left open. A degraded
        // daemon flush must not strand either close.
        if (!options.store && store) {
          await store.close().catch(() => undefined);
        }
        if (!options.secretStore && secretStore) {
          await secretStore.close().catch(() => undefined);
        }
      }
    },
  };
}
