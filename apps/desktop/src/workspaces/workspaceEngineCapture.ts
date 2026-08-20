import type { WatcherEvent } from "@dohc/workspace-core";
import {
  validateUserMaterializePath,
  validateUserWritePath,
} from "@dohc/workspace-core";
import {
  compareEnginePaths,
  compareVersionFilesPage,
  type VersionFileChange,
} from "@dohc/workspace-core/versionCompare";
import { resolveEffectivePolicy } from "@dohc/security-contract/effective-policy";
// The path floor is a cross-process security contract with a Rust twin, not
// engine state — the same reason workspaceFiles/workspaceGraph/workspaceSearch
// and the relay's shareFilter already read it from here.
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import {
  MAX_VERSIONED_BINARY_FILE_BYTES,
  type ActorNeutralWriteMetadata,
  type MomentAuthor,
  type SecretFileComparePage,
  type SecretFileMoment,
  type SecretFileStore,
  type VersionRecord,
  type VersionedTextConflictRecord,
  type VersionedTextMoment,
  type VersionedTextMomentSummary,
  type VersionedTextStore,
} from "@dohc/workspace-contracts/engine";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import type {
  MaterializeRelayPullPage,
  RelayMaterializedPath,
} from "@dohc/workspace-contracts/relay";
import {
  openEngineYdocProviderSession,
  DaemonRefusalError,
  isConflictStaleTargetRefusal,
  isEngineStoreBusyRefusal,
  isFileLockedRefusal,
  isTransientEngineRefusal,
  isYdocRemoteUpdatesPendingRefusal,
  isYdocUnsettledCloseRefusal,
  YdocReleasedWithSettleFailureError,
  YdocAdapterError,
  type EngineYdocProviderSession,
  type EngineYdocProviderSessionOptions,
  type EngineTransport,
  type ArtifactAssetDescriptor,
  type YdocContentKind,
} from "@dohc/workspace-engine-client";
import { MAX_DESKTOP_CAPTURE_TEXT_BYTES } from "@dohc/workspace-engine-client/limits";
import * as Y from "yjs";
import {
  isTextMediaType,
  mediaTypeForPath,
  scanWorkspaceFilesTolerant,
} from "@dohc/workspace-fs";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";
import {
  type ActiveAgentRun,
} from "./workspaceWatcher";
import {
  readWorkspaceEnginePolicy,
  type WorkspaceEnginePolicySnapshot,
} from "./workspaceEnginePolicyFile";
import {
  isEngineSessionReconnectError,
  isEngineWorkspaceOpenRefusedError,
  TRANSPORT_REBIND_MAX_BACKOFF_MS,
  WORKSPACE_OPEN_DEADLINE_MS,
  type EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import {
  createCaptureLiveStores,
  type CaptureTextFileMetadata,
  type CaptureVersionedTextStore,
} from "./workspaceEngineCaptureLiveStore";

export const DAEMON_CAPTURE_HEALTH_POLL_MS = 5_000;

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
//   - resolveEffectivePolicy (@dohc/security-contract) decides engine
//     ownership: the classifyEngineFilePath hard floor (ignored segments, `.env`-style
//     secret paths — the SAME floor engine search uses) that .dohc policy
//     files can NEVER override, plus workspace policy from .dohc/files.toml
//     which can only narrow (tracked = false), never widen.
//   - Only UTF-8 text files up to the engine's MAX_TEXT_BYTES are
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

// #564: how long ONE document-open TASK may keep retrying transport errors
// while it holds the capture chain. The task is more than the provider open —
// it reads the active version first, and that read has its own six-attempt
// ladder — so this is spent by the whole task through `withRetryBudget`,
// never per call. Derived from the session constants it bounds: two full
// open attempts plus two worst-case backoffs, so it always admits the
// single-recovery path (daemon died, relaunched, second attempt bound:
// ~2.1 s) and refuses the ladders that starved listMoments, readMoment, and
// capture.stop(). A healthy open never consults it: the budget gates retries
// only. Measured healthy opens on a busy chain are in ydocOpenDeadline.test.ts.
//
// It does not bound one in-flight `ydoc.open` either, and does not have to:
// that request carries its own measured YDOC_OPEN_DEADLINE_MS (#616), so a
// daemon that accepts the open and then hangs frees the chain at that bound.
// The two limits answer different questions — this one bounds RETRY WAITING,
// which a daemon that never fails never enters.
export const YDOC_OPEN_RETRY_DEADLINE_MS =
  2 * (WORKSPACE_OPEN_DEADLINE_MS + TRANSPORT_REBIND_MAX_BACKOFF_MS);
export const MAX_ENGINE_CAPTURE_TEXT_BYTES = 10 * 1024 * 1024;
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

// One page of the compare surface's rows: hydrated text changes and
// protected (secret) rows merged in path order, with a path continuation.
export interface WorkspaceVersionComparePage {
  files: VersionFileChange[];
  nextAfterPath: string | null;
}

export interface WorkspaceVersionMergeResult {
  mergedFileCount: number;
  unchangedFileCount: number;
  // How many files this merge left in conflict (new and re-surfaced). The
  // rows themselves are open conflicts in the engine; readers page them
  // through listOpenConflictsPage instead of carrying them here (#562).
  conflictCount: number;
}

// One page of open conflicts, the engine's own `conflicts.list` page passed
// through (#562): the daemon bounds a page by byte budget, and nothing on the
// desktop side re-drains it into one array.
export interface WorkspaceVersionConflictPage {
  conflicts: VersionedTextConflictRecord[];
  nextAfterConflictId: string | null;
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
  // The first page of the conflicts still open after this resolution.
  remaining: WorkspaceVersionConflictPage;
}

// The save state of a live engine Y.Doc, derived from REAL settle outcomes.
// "saved" means the projection committed and the .md landed — nothing else may
// claim it. "changed-on-disk" means the settle committed but the FILE holds an
// edit made outside dohc, which the settle must not overwrite (#338); the
// advice "error" carries (try another edit) is wrong there, so it gets its own
// state, exactly like "read-only".
// "file-locked" is transient by contract: another program holds the file's
// handle, the settle committed, and the provider retries with backoff until
// the handle releases (#554) — distinct from "error" so the surface can say
// what blocks the disk and that no user action is needed.
export type EngineYDocSaveState =
  | "settling"
  | "saved"
  | "error"
  | "file-locked"
  | "changed-on-disk";

export interface WorkspaceEngineYDocCloseOptions {
  settle?: boolean;
  summary?: string;
  // `settle: false` is a preference, not a promise: a release the daemon
  // refuses as unsettled escalates to a SETTLING close so pending edits survive
  // a transient failure. Set this to false when materializing the file would be
  // wrong whatever happens — the absent-head refusal is the case, because the
  // daemon refuses that release precisely BECAUSE content arrived, and settling
  // it writes the file the refusal is about to call missing.
  settleOnRefusal?: boolean;
  // Set ONLY by the app-quit teardown. `will-quit` races the whole shutdown
  // chain against one 3s timer, so a close there must not wait for a daemon to
  // come back: the budget cannot cover a relaunch anyway, and the wait starves
  // the store closes and the daemon stop chained behind it. Every other close
  // keeps the full transport ladder, because outside quit a daemon that
  // relaunches in a second is a session worth recovering.
  shuttingDown?: boolean;
}

// The desktop adds restart recovery and adapts external-edit outcomes around
// the Rust client session. Keep that small delta local instead of importing
// the retired in-process provider's public type into production.
export type WorkspaceEngineYDocProviderSession = Omit<
  EngineYdocProviderSession,
  | "head"
  | "lineage"
  | "applyLocalUpdate"
  | "applyExternalMarkdownEdit"
  | "close"
  // Deliberately NOT handed out. An evict takes a daemon session away without
  // settling it, which is right for an orphan nobody holds and wrong for a
  // document a caller is editing. Only this layer's own teardown may reach it
  // (#665) — see `RestartSafeYDocSession`.
  | "evict"
> & {
  readArtifactAsset(descriptor: ArtifactAssetDescriptor): Promise<{
    descriptor: ArtifactAssetDescriptor;
    bytes: Uint8Array;
  }>;
  // `onArmed` fires when THIS update has reached the provider — journaled onto
  // the session's journal chain and counted by the settle it arms. The call is
  // queued, so that moment is later than the caller handing the update over,
  // and a save-state bookkeeper that counts at hand-over instead vouches for
  // edits still sitting in the queue (#514).
  applyLocalUpdate(update: Uint8Array, onArmed?: () => void): void;
  applyExternalMarkdownEdit(markdown: string): Promise<{ supported: boolean }>;
  close(options?: WorkspaceEngineYDocCloseOptions): Promise<void>;
};

// The session THIS layer holds, which keeps the evict the public one drops.
type RestartSafeYDocSession = WorkspaceEngineYDocProviderSession & {
  evict(): Promise<void>;
};

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
  // Writes one SDK-originated text file with an explicit per-operation
  // author. This never reads or changes the workspace's ambient agent slot.
  writeAuthoredTextFile(
    absolutePath: string,
    text: string,
    author: MomentAuthor,
    options?: { createOnly?: boolean; signal?: AbortSignal },
  ): Promise<void>;
  // WS-G2-C-2 editor binding: open a live engine Y.Doc session for one rich
  // file through this capture's Rust workspace sessions. The session journals
  // editor edits as ydoc.update ops and, on each debounced settle, projects the
  // Markdown in the daemon and mirrors the on-disk .md through this capture's
  // disk writer. While the session is live its path is marked live-ydoc-driven, so
  // the watcher's observation of the settle's own .md write is DEFERRED (never
  // re-captured as an ordinary moment.append — which on a shared workspace
  // would double-replicate and collide (P0D) with the ydoc.update stream). The
  // returned session's close() lifts the guard. Rejects (secret path,
  // already-live, path-not-in-version) propagate to the caller, which uses the
  // plain editor — except path-not-in-version, which the caller must surface as
  // a refusal rather than a writable fallback.
  // Runs on the capture chain, so the session's version binding is decided in
  // the same serialized step that registers it as live: a version operation
  // either vacates this session or runs after it, never around it (#493).
  //
  // ABSENT-HEAD CONTRACT (canonical; the daemon and the client both point
  // here). The daemon does NOT refuse an open for a path the entered version
  // has no snapshot for — it derives an object id and binds an EMPTY doc, and
  // that branch is what makes a just-created file editable before capture
  // ingests it. So this layer, which knows why the open was asked for, owns
  // the decision.
  //
  // The bind is EMPTY only when the daemon has neither a snapshot nor durable
  // CRDT state: `head "absent"` AND `lineage "absent"`. A head-absent open
  // with a lineage is the crash-orphaned draft the daemon deliberately
  // resurrects, whose CRDT rows are the only copy of those edits — it binds.
  //
  // For a genuinely empty bind, the on-disk artifact decides:
  //
  //   empty file on disk -> creation. Bind it. `createFile` writes "" with
  //                         `wx` and opens straight after, so an EMPTY file
  //                         admits creation exactly.
  //   nothing on disk    -> the path is not in this version. REFUSE, and the
  //                         caller must NOT downgrade to the plain editor.
  //   file with content  -> an uncaptured artifact. The empty bind carries no
  //                         seed (actor.rs seeds from the head), so settling
  //                         it would erase the file. Refuse the SESSION only;
  //                         the plain editor shows and writes the real bytes.
  //
  // Size, not mere existence: on Windows `lstat` matches case-insensitively,
  // so an open of `notes/CASEONLY.md` finds `notes/caseOnly.md` while the
  // daemon's head lookup (case-sensitive) does not. Existence alone would call
  // that creation and settle an empty doc over the real file.
  //
  // Without the refusal, clicking a file that a version switch removed while
  // the click was queued behind it opens an empty writable editor over a path
  // the switch just deleted, and the first keystroke settles a phantom file
  // into the entered version (#534). The disk check runs on the capture chain
  // with the version binding, so a switch cannot land between them.
  openYDocSession(input: {
    path: string;
    onRemoteUpdate: (update: Uint8Array) => void;
    onLineageReplaced?: (update: Uint8Array, recoveredPaths: string[]) => void;
    contentKind?: YdocContentKind;
    // The HONEST save state for this document, reported on every settle:
    // "settling" when one starts, "saved" only when the projection AND the
    // .md actually landed, "error" when the settle failed and the file on
    // disk is therefore behind the editor. A failed settle used to reach
    // nothing at all — the doc kept reading "Saved" over a stale (or empty)
    // file, which is silent data loss.
    onSaveState?: (state: EngineYDocSaveState, token: number) => void;
  }): Promise<WorkspaceEngineYDocProviderSession>;
  // WS-G2-C-2 (gate fix 3): flush + release any live Y.Doc session at OR under a
  // path before a destructive op that does NOT run through the capture chain
  // itself (the delete IPC deletes on disk directly). Without this, a later
  // settle would resurrect the deleted file / orphan the object. No-op when
  // nothing is live at the path.
  // Answers a finisher the caller MUST call with the removal's outcome:
  // `true` when the path is gone, `false` when the removal failed. Only the
  // outcome decides whether a pending locked-write debt for that path is
  // cancelled or restored (#595).
  settleAndCloseLiveSessionsForPath(
    pathOrPrefix: string,
  ): Promise<(removed: boolean) => void>;
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
  // One page of changed files between a version and a target (default Main),
  // with text sides hydrated for diffing. The first page (no afterPath)
  // captures the latest disk edits first so the answer is never stale; later
  // pages continue that same comparison.
  compareVersions(
    sourceVersionId: string,
    options?: { targetVersionId?: string; afterPath?: string },
  ): Promise<WorkspaceVersionComparePage>;
  // How many files differ between a version and Main (text and protected),
  // computed from the metadata listing without hydrating any text.
  compareVersionsChangedCount(sourceVersionId: string): Promise<number>;
  // Merges a named version into Main through the engine merge API. When Main
  // is the active version, merged results are materialized to disk.
  mergeVersionIntoMain(sourceVersionId: string): Promise<WorkspaceVersionMergeResult>;
  // One page of open conflicts; pass the previous page's nextAfterConflictId
  // to continue.
  listOpenConflictsPage(
    afterConflictId?: string,
  ): Promise<WorkspaceVersionConflictPage>;
  countOpenConflicts(): Promise<number>;
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
  // Data-safety contract: the task must give every pull page to the supplied
  // materializer before it commits that page's relay cursor. A failed page
  // remains available to the next pass instead of being skipped forever.
  runRelaySync<T>(
    task: (materializePage: MaterializeRelayPullPage) => Promise<T>,
  ): Promise<T>;
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
  // Injectable for tests; production uses the required Rust workspace sessions.
  store?: VersionedTextStore;
  // Injectable for tests; production uses the daemon's encrypted secret store.
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
  // and Y.Doc paths. Production cannot construct a capture without it.
  // Injectable stores still take precedence in focused tests.
  rustEngineSessions: EngineWorkspaceSessions;
  // The real Rust daemon owns filesystem observation and version
  // materialization. Tests backed by the in-process loopback omit this because
  // that transport has no autonomous watcher or disk writer.
  daemonOwnsCapture?: boolean;
  // Injectable only to simulate daemon generations in focused restart tests.
  openRustYDocProviderSession?: (
    options: EngineYdocProviderSessionOptions,
  ) => Promise<
    Omit<EngineYdocProviderSession, "artifactAssets"> & {
      artifactAssets?: EngineYdocProviderSession["artifactAssets"];
    }
  >;
}

export interface EngineDiskWriter {
  writeTextFile(absolutePath: string, text: string): Promise<void>;
  writeBinaryFile(absolutePath: string, bytes: Uint8Array): Promise<void>;
  deletePath(absolutePath: string): Promise<void>;
}

const ENGINE_MAIN_VERSION_ID = "main";

// The capture layer's schedule for retrying a teardown blocked by something
// that clears on its own (#595, #658). Mirrors the provider's settle-retry
// posture: the delay doubles up to the cap, which bounds how long the pending
// write stays disk-stale after the blocker lets go. Both teardown ladders —
// the close retry and the detached debt's payment — start from it.
const TEARDOWN_RETRY_INITIAL_MS = 1_000;
const TEARDOWN_RETRY_CAP_MS = 10_000;

// The lock can sit at any depth of a teardown failure: the escalated
// settling close's own refusal, or the pre-close settle failure carried as
// `cause` (YdocReleasedWithSettleFailureError wraps it, and wrappers above
// may add another layer).
function hasRefusalInCauseChain(
  error: unknown,
  refusal: (candidate: unknown) => boolean,
): boolean {
  let candidate = error;
  for (let depth = 0; depth < 4 && candidate != null; depth += 1) {
    if (refusal(candidate)) return true;
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return false;
}

function isFileLockedCause(error: unknown): boolean {
  return hasRefusalInCauseChain(error, isFileLockedRefusal);
}

// Blocked by something that clears on its own — a program outside dohc
// holding the artifact, or dohc's own writers meeting inside SQLite. The same
// answer #679 gave for the capture ladder, and deliberately the same SET the
// provider's own settle ladder re-arms on (`isTransientEngineRefusal`): every
// reader of this predicate is deciding whether something ELSE is already
// retrying. Narrower than the provider's set and this cancels a live retry;
// wider and a failure nobody retries goes quiet.
//
// The two classes are still named apart wherever the answer differs: only the
// file lock leaves a durably pending write for the detached debt registry.
function isTransientEngineCause(error: unknown): boolean {
  return hasRefusalInCauseChain(error, isTransientEngineRefusal);
}

function isLineageChangedCause(error: unknown): boolean {
  return hasRefusalInCauseChain(
    error,
    (candidate) =>
      candidate instanceof YdocAdapterError &&
      candidate.code === "lineage-changed",
  );
}

/**
 * What the document may claim after a settle failed.
 *
 * `file-locked`: the settle COMMITTED and the write job is durably pending,
 * so the write outlives this attempt — the provider retries it while the
 * session lives and the detached debt registry pays it after close. Name the
 * blocker; the user's own file is held and no user action helps.
 *
 * `engine-store-busy`: dohc's own database was busy. Nothing of the user's is
 * held, nobody can act, and the provider's ladder retries — so the document is
 * still SETTLING, and any other word would report a failure that has not
 * happened. This is #658's deliberate decision to stay quiet: store
 * contention gets no state of its own and no copy of its own, because there
 * is nothing to tell the user.
 *
 * A close used to be the exception, because it released the session and left
 * nothing behind to retry. It no longer can: a teardown that meets a
 * transient blocker either keeps the session and is retried by the close
 * ladder, or releases only once the engine HAS the text and hands the
 * artifact to the detached debt. Either way a retry is coming, so the answer
 * no longer depends on where the failure was raised.
 */
function settleFailureSaveState(error: unknown): EngineYDocSaveState {
  if (isFileLockedRefusal(error)) return "file-locked";
  if (isEngineStoreBusyRefusal(error)) return "settling";
  return "error";
}

// The engine refuses a pending write whose preimage no longer matches the
// file: the external program EDITED it before releasing its lock. No amount
// of waiting changes that, so a retry ladder aimed at the lock has nothing
// left to wait for.
function isConflictStaleTargetCause(error: unknown): boolean {
  return hasRefusalInCauseChain(error, isConflictStaleTargetRefusal);
}

// Peers outran this settle: remote edits drained under the session's lease, so
// the engine refuses rather than materializing a projection this session never
// saw. The adapter already resynced and settled once (`YdocLiveAdapter.settle`);
// a second refusal means the race is still on, and the answer to a race is to
// wait and try again. It rides the same INVALID_PARAMS/`retry: "no"` shape as a
// terminal refusal, so only this discriminator keeps the ladder from cancelling
// a write that would have landed (#650).
function isRemoteUpdatesPendingCause(error: unknown): boolean {
  return hasRefusalInCauseChain(error, isYdocRemoteUpdatesPendingRefusal);
}

// The wire's own "do not try again" (`retry: no`). Read from a SETTLE, that is
// a definite answer that this write cannot land — a preimage that no longer
// matches, a target turned read-only, an ACL that denies the replace. It is
// the opposite of a busy engine or a dropped transport, which answer nothing
// about the write and must keep retrying.
//
// Read from a CLOSE it would mean something else entirely (a refused release
// is terminal on the wire and still has to be retried), so every caller must
// know which call raised it.
function isTerminalRefusal(error: unknown): boolean {
  return error instanceof DaemonRefusalError && error.disposition === "terminal";
}

interface RegisteredExpectedEngineEvent extends ExpectedEngineEvent {
  expiresAtMs: number;
}

/**
 * Wraps a callback so it runs at most once, and tolerates it being absent.
 *
 * Used for the save-state edit count: several recovery paths can each be the
 * first to arm a settle carrying one update, so they all get the same wrapped
 * callback and the first one there wins.
 */
function announceOnce(announce: (() => void) | undefined): () => void {
  let announced = false;
  return () => {
    if (announced) return;
    announced = true;
    announce?.();
  };
}

function isExactYDocClaimPromotion(doc: Y.Doc, claimId: string): boolean {
  // Promotion claims the SHA-256 of this lineage's full-state base.
  // Shared client clocks prove ancestry only: two peers can clone a base and
  // then fork. The exact base hash proves that this unclaimed document is the
  // lineage that received the claim.
  return sha256Bytes(Y.encodeStateAsUpdate(doc)) === claimId;
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// A settled projection is capped at MAX_PROJECTION_BYTES
// (crates/dohc-engine-collab/src/limits.rs), so a file bigger than that cannot
// be the settled artifact whatever its bytes are — the size alone answers the
// question. Hashing it anyway would hold a close open over a read as long as
// the file.
export const MAX_SETTLED_FILE_BYTES = 16 * 1024 * 1024;

type SettledFileDigest =
  // The file's bytes, hashed. Compare it with the settle's sha.
  | { kind: "sha256"; sha256: string }
  // The file cannot BE the settled artifact: gone, not a regular file, or
  // past the largest projection the engine can produce.
  | { kind: "changed" }
  // dohc could not check. This says nothing about the file's content, so the
  // caller must not report either a save or a change from it.
  | { kind: "unverifiable"; reason: string };

// Hash the workspace file a settle claims to have written. Streamed and
// bounded, and it refuses to read through a path that leaves the workspace.
async function digestSettledFile(
  rootPath: string,
  path: string,
): Promise<SettledFileDigest> {
  const absolute = join(rootPath, path);
  // Containment first, the same check the disk writer runs before it writes
  // (createDefaultDiskWriter's assertContainedDir): a parent directory
  // replaced by a symlink redirects this read outside the workspace, and a
  // file out there that happened to match would report a save for an artifact
  // that is not in the workspace at all.
  let realRoot: string;
  let realParent: string;
  try {
    [realRoot, realParent] = await Promise.all([
      realpath(resolve(rootPath)),
      realpath(dirname(absolute)),
    ]);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "changed" };
    return { kind: "unverifiable", reason: `the folder could not be read (${code ?? "unknown"})` };
  }
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
    return {
      kind: "unverifiable",
      reason: "the folder now resolves outside the workspace",
    };
  }
  try {
    const info = await lstat(absolute);
    // A symlink leaf is never an engine artifact — the disk writer refuses to
    // write through one — so the artifact is not here.
    if (info.isSymbolicLink() || !info.isFile()) return { kind: "changed" };
    if (info.size > MAX_SETTLED_FILE_BYTES) return { kind: "changed" };
    const hash = createHash("sha256");
    let read = 0;
    for await (const chunk of createReadStream(absolute)) {
      const bytes = chunk as Uint8Array;
      read += bytes.byteLength;
      // The file grew past the bound after its size was taken. Same answer,
      // and the read stops here rather than following it.
      if (read > MAX_SETTLED_FILE_BYTES) return { kind: "changed" };
      hash.update(bytes);
    }
    return { kind: "sha256", sha256: hash.digest("hex") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "changed" };
    return { kind: "unverifiable", reason: `the file could not be read (${code ?? "unknown"})` };
  }
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

// The refusal half of the absent-head contract stated on
// `WorkspaceEngineCapture.openYDocSession`: the entered version has no snapshot
// for this path AND no artifact on disk, so the path is not in this version.
// Distinct from every other open refusal because the caller must NOT fall back
// to a writable plain editor — that editor would write the same phantom file
// the engine refusal just prevented.
export class YDocPathNotInVersionError extends Error {
  readonly code = "path-not-in-version" as const;
  constructor(
    readonly workspacePath: string,
    readonly versionId: string,
  ) {
    super(
      `${workspacePath} is not in version ${versionId}, so it cannot open for editing.`,
    );
    this.name = "YDocPathNotInVersionError";
  }
}

export function isYDocPathNotInVersionError(
  error: unknown,
): error is YDocPathNotInVersionError {
  return error instanceof YDocPathNotInVersionError;
}

// The other half of the absent-head contract: the artifact IS on disk and
// holds content, but the entered version has no snapshot for it yet. The
// daemon seeds an absent-head bind from the head (actor.rs), so the doc would
// come up EMPTY and the first settle would erase the file. Unlike
// YDocPathNotInVersionError this is an ORDINARY refusal: the file is really
// there, so the plain editor shows and writes its real bytes, and telling the
// user it is not in this version would be false.
export class YDocUncapturedArtifactError extends Error {
  readonly code = "uncaptured-artifact" as const;
  constructor(readonly workspacePath: string) {
    super(
      `${workspacePath} is on disk but not yet recorded in this version, so it cannot open a live session.`,
    );
    this.name = "YDocUncapturedArtifactError";
  }
}

// The absent-head decision raced a writer and its answer is already stale. Two
// ways in: content arrived while the release was in flight, leaving a session
// that can be neither handed back (the provider closed itself and dropped its
// subscriptions before the daemon refused) nor reopened (the refusal reinserts
// the daemon entry with its lease held); or the artifact appeared on disk while
// the release ran. Deliberately NOT a YDocPathNotInVersionError in either case:
// something is writing this path, so telling the user their version does not
// have it would be false.
export class YDocOpenRacedError extends Error {
  readonly code = "open-raced" as const;
  constructor(readonly workspacePath: string) {
    super(
      `${workspacePath} changed while it was opening, so this open's answer is already stale. Open it again.`,
    );
    this.name = "YDocOpenRacedError";
  }
}

// The open refused, and its session was NOT released. The daemon reinserts a
// refused close's entry with its lease held (ydoc_close_inner), so it may
// still own this document — which makes every refusal that describes the DISK
// false, whatever the disk says. `main` answers this with `engineMayHoldDocument`: the
// document stays read-only with a retry, and the next open discharges the
// orphan this left behind (#564, codex r14/r17).
export class YDocSessionUnreleasedError extends Error {
  readonly code = "session-unreleased" as const;
  constructor(
    readonly workspacePath: string,
    cause: unknown,
  ) {
    super(
      `${workspacePath} could not be released after the engine refused to open it, so the engine may still hold the document. It is read-only until a retry releases it.`,
      { cause },
    );
    this.name = "YDocSessionUnreleasedError";
  }
}

export function isYDocSessionUnreleasedError(
  error: unknown,
): error is YDocSessionUnreleasedError {
  return error instanceof YDocSessionUnreleasedError;
}

export class YDocRemovalInProgressError extends Error {
  readonly code = "removal-in-progress" as const;
  constructor(
    readonly workspacePath: string,
    readonly inProgress: string,
    readonly operation: "open" | "settle",
    readonly removalOperation: "delete" | "move",
  ) {
    super(
      operation === "open"
        ? `dohc could not open ${workspacePath}. ${inProgress}`
        : `dohc could not save ${workspacePath}. ${inProgress} Wait for that to finish. Then save again.`,
    );
    this.name = "YDocRemovalInProgressError";
  }
}

export function isYDocRemovalInProgressError(
  error: unknown,
): error is YDocRemovalInProgressError {
  return error instanceof YDocRemovalInProgressError;
}

// A detached locked-write payment that was cancelled after it started. The
// payment runs on the capture chain; the edges that cancel it do not, so a
// delete or move finisher can land while the payment sits in an awaited RPC.
// Internal to the retry ladder — it never reaches a caller.
class DetachedPaymentCancelledError extends Error {
  constructor(readonly workspacePath: string) {
    super(
      `locked-write payment for ${workspacePath} was cancelled before its settle could land`,
    );
    this.name = "DetachedPaymentCancelledError";
  }
}

// What the on-disk artifact says about an otherwise-empty bind. "missing" is
// the only state that proves the path is not in this version; every other
// answer, including an unreadable one, refuses the session without making that
// claim.
type AbsentHeadDiskState = "missing" | "empty" | "content";

async function absentHeadDiskState(
  rootPath: string,
  path: string,
): Promise<AbsentHeadDiskState> {
  // lstat, never stat: a symlink LEAF resolves outside the workspace, and the
  // rest of capture already refuses those. It reports as content so the engine
  // session is refused without claiming the path is gone.
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(join(rootPath, path));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    // Unreadable is not gone. Refuse the session, but never tell the user the
    // version does not have a file we simply could not read.
    return "content";
  }
  if (info.isSymbolicLink() || !info.isFile()) return "content";
  return info.size === 0 ? "empty" : "content";
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

export type DiskTextState =
  // Confirmed absent (ENOENT/ENOTDIR): the engine file, if any, was deleted.
  | { kind: "absent" }
  // Engine-ownable UTF-8 text within the size cap.
  | { kind: "text"; text: string; sha256: string }
  // Engine-ownable binary content within the binary cap.
  | { kind: "binary"; bytes: Buffer; sha256: string; byteLength: number }
  // Present but not engine-ownable (binary, oversized, or non-UTF-8 text).
  // `sha256` is carried ONLY for genuine UTF-8 text that is merely over the
  // text cap: a Y.Doc settle is not bounded by that cap, so its own
  // materialization can land here, and the self-write check needs the same
  // sha-precise identity every other branch uses.
  | { kind: "untracked-content"; sha256?: string }
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

// Confirmed-absent delete gate: the reconcile scan drives adds/updates, but a
// scan is NOT trusted to authorize a DELETE. Before retiring ANY
// previously-tracked path absent from the scan, this confirms the absence with a
// direct lstat: only a genuinely gone path (ENOENT/ENOTDIR) is retired. A path
// that still exists in any form — even transiently unreadable — is left tracked,
// so an incomplete listing can never drive a false delete on any platform. lstat
// (never stat) so a symlink leaf is treated as present, matching
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

/**
 * What the engine can own of a file the caller names ABSOLUTELY, for an
 * import into a share view's store.
 *
 * The rule is the capture's, not a second copy of it: the same media-type
 * test, the same UTF-8 round trip, the same caps. An import that classified
 * content its own way would disagree with the capture about the same bytes.
 * A symlink source reads as `untracked-content` here, so a share view refuses
 * to propose content reached through a link.
 */
export function readDiskContent(absolutePath: string): Promise<DiskTextState> {
  return readDiskTextState(dirname(absolutePath), basename(absolutePath));
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
    if (info.size > MAX_ENGINE_CAPTURE_TEXT_BYTES) return { kind: "untracked-content" };
    const bytes = await readFile(absolute);
    if (bytes.length > MAX_ENGINE_CAPTURE_TEXT_BYTES) {
      // Bytes in hand: carry the sha so a settle's own oversized
      // materialization is recognizable as our write. The size-only early-out
      // above cannot because it deliberately refuses to load the file.
      return { kind: "untracked-content", sha256: sha256Bytes(bytes) };
    }
    const text = bytes.toString("utf8");
    // The engine only stores text that round-trips through UTF-8; anything
    // else is binary in disguise, not engine-ownable as text.
    if (!Buffer.from(text, "utf8").equals(bytes)) {
      if (
        liveDocumentKindForPath(path) === "scene" ||
        bytes.length > MAX_ENGINE_CAPTURE_BINARY_BYTES
      ) {
        return { kind: "untracked-content", sha256: sha256Bytes(bytes) };
      }
      return { kind: "binary", bytes, sha256: sha256Bytes(bytes), byteLength: bytes.byteLength };
    }
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
  //   4. the path's REAL location must not be an area dohc reserves. Steps 1-3
  //      prove the write stays INSIDE the root; they cannot prove it stays OUT
  //      of `.dohc`. A symlinked ancestor (`notes -> .dohc`) resolves inside
  //      the root and passes all three, so engine-owned text would land on the
  //      workspace's own control plane. `assertEngineWritablePath` refuses that
  //      spelling; this refuses it wherever the path leads.
  //      Resolved as an ENTRY in every case: this writer never follows a leaf
  //      link — step 3 refuses one, and rm removes one as a link — so only the
  //      parent chain decides. It runs BEFORE mkdir, so a reserved ancestor
  //      cannot have directories created through it either.
  //      It answers with the resolution it judged, and every step after it
  //      works on THAT path. Re-walking the spelling would let an ancestor
  //      alias swapped after the check redirect the mkdir, the checks, and the
  //      write to somewhere no rule was applied.
  async function assertResolvedArea(absolutePath: string, label: string): Promise<string> {
    const { resolvedAbsolute } = await assertResolvedWorkspacePath({
      rootPath,
      absolutePath,
      spelled: absolutePath,
      label,
      access: "entry",
    });
    return resolvedAbsolute;
  }
  // Text and bytes take the SAME four checks in the same order, so they take
  // one path through them. writeFile defaults a string to UTF-8 and ignores
  // the encoding for a Uint8Array, so one call serves both. Two copies of a
  // security sequence can drift; one cannot.
  async function writeEngineFile(
    absolutePath: string,
    data: string | Uint8Array,
  ): Promise<void> {
    await assertContainedNearestAncestor(dirname(absolutePath));
    // Entry mode, so this is the resolved parent chain plus the held-back
    // name: the directories are canonical and only the leaf is still spelling.
    const target = await assertResolvedArea(absolutePath, "Engine write path");
    const dir = dirname(target);
    await mkdir(dir, { recursive: true });
    await assertContainedDir(dir);
    await assertLeafNotSymlink(target);
    await writeFile(target, data);
  }
  return {
    writeTextFile: writeEngineFile,
    writeBinaryFile: writeEngineFile,
    async deletePath(absolutePath) {
      await assertContainedDir(dirname(absolutePath));
      const target = await assertResolvedArea(absolutePath, "Engine delete path");
      // rm on a symlink removes the link itself, never the target, so a
      // symlink leaf needs no extra handling here.
      await rm(target, { force: true });
    },
  };
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

  let liveStores: ReturnType<typeof createCaptureLiveStores> | null = null;
  function daemonStores() {
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
    session: RestartSafeYDocSession;
    // "live": healthy; sha-precise suppression, external edits captured.
    // "dead-generation": the daemon generation died; the canonical doc still
    // holds the user's text and a later op can rebuild a generation around it.
    // "failing-close": close/settle threw during TEARDOWN; the reservation may
    // still be held and the on-disk state is indeterminate. Only teardown
    // clears this — a recovering generation must never lift it.
    status: "live" | "dead-generation" | "failing-close";
    // No caller ever received this session: it exists because a REFUSED open
    // could not release it, so nothing else will ever close it and the next
    // open of this path must discharge it before binding. A handed-out
    // session is the opposite case — its holder and the version ops converge
    // its teardown, and a second open must still refuse (ydoc-session-busy).
    orphaned: boolean;
    // Flush + tear down, releasing the reservation, then drop the registry
    // entry — ONLY on success. On failure the entry is retained as
    // failing-close and the error propagates (never swallowed on this
    // data-integrity-critical teardown). Reused by the returned session's
    // close(), the renderer close IPC, and every lifecycle op below.
    close: (opts?: WorkspaceEngineYDocCloseOptions) => Promise<void>;
    // This session's own way to apply a delete directly (codex P1-C
    // follow-up on #746), read only while `status` is "failing-close":
    // `captureBatch`'s synchronous delete pass calls it at
    // watcher-delivery time instead of relying solely on the TTL-bounded
    // no-debt tombstone map. A close-retry ladder's own doubling delay
    // caps at the same 10s as that TTL, so a delete landing right after
    // one retry can otherwise expire before the next retry arrives to ask.
    armRemovalSuppression: (expected: boolean, deletedAtMs: number) => void;
  }
  const liveYDocSessions = new Map<string, LiveYDocSession>();
  // The detached locked-write debts, by path: each entry is the payment
  // routine its arming session left behind, plus the way to re-arm it. The
  // registry is what lets OTHER lifecycle edges find a debt whose session is
  // gone, and it is the single owner record — the debt's own timer stands down
  // when the registry no longer names its routine.
  //
  // A debt leaves the registry only on PROOF, and the proof must be that THIS
  // write landed — never that some adjacent operation returned Ok. An
  // operation merely ATTEMPTING proves nothing: a payment that met the lock
  // again, a delete that failed, a release that failed all keep the debt. Nor
  // does a neighbour's success: a settle handed to another session, a close
  // that raced a newer update, a delete that removed the path each say
  // something true about themselves and nothing about the write this debt
  // owes.
  //
  // A STAND-DOWN is the one other exit: the engine answered that this write
  // can never land, so the ladder reports it and gives up. Absence therefore
  // reads "landed or abandoned", never "landed" alone.
  interface DetachedLockedDebt {
    pay: () => Promise<void>;
    arm: () => void;
    // Cancel the WRITE this debt owes. A retained retry session is a DAEMON
    // LEASE and is not cancellable: dropping the reference leaves it with no
    // owner, and every later open of that path is refused ydoc-session-busy
    // until the daemon restarts. So discard releases the lease, and a
    // refused release puts the debt back — release-only — rather than
    // letting go of it. Rejects when the lease is still held.
    discard: () => Promise<void>;
    // Set once the write is abandoned for good. A stood-down debt used to
    // DELETE this entry, and `beginFileRename` read that absence as proof
    // the write landed — recording the stale pre-lock artifact as if it had
    // (#681). Keeping the entry with this flag set is what lets the rename
    // seam tell "abandoned" from "landed" instead of reading both as
    // silence; `onError` already carries the stand-down's message, so
    // nothing here needs to repeat it.
    //
    // Not immortal, and cleared only by PROOF, never by attempt: a
    // materialized settle of this exact path (`onSettled`) is the moment
    // "its last edit reached disk" becomes true, so that is what clears it —
    // an open alone proves only that no lease is held, not that anything
    // landed. The delete/move seams and the watcher's own external-delete
    // capture all cancel a debt outright (never restore a cancelled one), so
    // a removed path drops its marker the same way.
    stoodDown: boolean;
  }
  const detachedLockedDebts = new Map<string, DetachedLockedDebt>();

  // A delete-shaped watcher event that named a path with no debt to clean
  // up YET (#681 round 7, codex P1): `cleanupDetachedDebtForEvent`'s own
  // `has(path)` gate correctly does nothing there, but a close's transient
  // retry ladder runs OFF the capture chain for as long as
  // TEARDOWN_RETRY_CAP_MS allows — seconds wide in production — and can
  // still register a FRESH debt for that same path afterward. Recording
  // the deletion here (not a raw disk stat, which cannot tell "deleted"
  // from "never written yet" — the same absence either way) lets the
  // registration door (`scheduleDetachedLockedSettle`) ask "did the
  // watcher JUST tell me this exact path is gone" instead.
  //
  // NOT invalidated by a later recreation (#681 round 8, codex P1 —
  // reverted a same-round attempt at that shape once the certifier's S2(b)
  // named the corruption it opens: a session that opened BEFORE the
  // delete can still be mid-retry-ladder when a DIFFERENT session
  // recreates the path; invalidating the tombstone on recreation would
  // let the OLD session's late debt arm and settle its stale canonical
  // doc over the NEW file). The memory discriminates by WHICH session is
  // registering instead: `deletedAtMs` is compared against that session's
  // own open time at the consuming door, so a session that opened before
  // the delete (the stale one) still cancels, and a session that opened
  // after it (the recreation's own) arms normally — see
  // `consumeRecentExternalDeleteWithNoDebt`.
  const recentExternalDeletesWithNoDebt = new Map<
    string,
    { deletedAtMs: number; expiresAtMs: number; expected: boolean }
  >();
  // Swept in place, at most once per PRUNE window (#681 round 9, codex
  // P2 — round 8's version rebuilt the whole map, via a spread + filter +
  // new Map, on EVERY insert. A bulk deletion of a large tree calls
  // `noteExternalDeleteWithNoDebt` once per path, and every one of those
  // paths is fresh — nothing has crossed its own 10s TTL yet within the
  // same burst — so that rebuild was quadratic busywork that found nothing
  // to prune. Throttling to once per window turns a burst of N inserts
  // into one O(map size) sweep instead of N of them; a sweep this throws
  // away is still safe because `consumeRecentExternalDeleteWithNoDebt`
  // checks its own entry's expiry directly, so a throttled sweep can never
  // let an expired tombstone match.
  const RECENT_EXTERNAL_DELETE_PRUNE_INTERVAL_MS = 1_000;
  let recentExternalDeletesPrunedAtMs = -Infinity;
  function pruneRecentExternalDeletesWithNoDebt(): void {
    const nowMs = now();
    if (nowMs - recentExternalDeletesPrunedAtMs < RECENT_EXTERNAL_DELETE_PRUNE_INTERVAL_MS) {
      return;
    }
    recentExternalDeletesPrunedAtMs = nowMs;
    for (const [path, entry] of recentExternalDeletesWithNoDebt) {
      if (entry.expiresAtMs <= nowMs) recentExternalDeletesWithNoDebt.delete(path);
    }
  }
  function noteExternalDeleteWithNoDebt(path: string, expected: boolean): void {
    pruneRecentExternalDeletesWithNoDebt();
    const deletedAtMs = now();
    recentExternalDeletesWithNoDebt.set(path, {
      deletedAtMs,
      expiresAtMs: deletedAtMs + EXPECTED_ENGINE_EVENT_EXPIRY_MS,
      expected,
    });
  }
  // Consumes the memory only for a session whose OWN open predates the
  // recorded delete — the stale incarnation this delete actually orphaned.
  // A session opened AFTER the delete (the path's later recreation, or any
  // fresh open past that point) reads no match and arms normally: its
  // content is not what the deletion removed. Returns the reason the
  // recorder itself observed (`expected`: dohc's own removal, e.g. a
  // version switch's materialization; or external), so the cancellation
  // trace can name which — the recorder is the only place that verdict is
  // still known once the debt itself would otherwise treat it as generic.
  // Checks the entry's OWN expiry here too, not only via the throttled
  // sweep above: this is the door correctness actually depends on, so it
  // must never trust a sweep that may have been skipped this window.
  function consumeRecentExternalDeleteWithNoDebt(
    path: string,
    sessionOpenedAtMs: number,
  ): { expected: boolean } | null {
    pruneRecentExternalDeletesWithNoDebt();
    const entry = recentExternalDeletesWithNoDebt.get(path);
    if (
      entry === undefined ||
      entry.expiresAtMs <= now() ||
      sessionOpenedAtMs >= entry.deletedAtMs
    ) {
      return null;
    }
    recentExternalDeletesWithNoDebt.delete(path);
    return { expected: entry.expected };
  }

  // Take matching debts OUT of the registry without deciding their fate: the
  // caller is about to attempt a removal, and only its OUTCOME says whether
  // they are cancelled or restored. Suspended debts have no timer (the
  // registry no longer names their routine), so nothing fires meanwhile.
  function suspendDetachedDebts(
    match: (path: string) => boolean,
  ): Array<[string, DetachedLockedDebt]> {
    const suspended: Array<[string, DetachedLockedDebt]> = [];
    for (const [path, debt] of [...detachedLockedDebts.entries()]) {
      if (!match(path)) continue;
      detachedLockedDebts.delete(path);
      suspended.push([path, debt]);
    }
    return suspended;
  }

  // The removal happened: cancel with a trace. A delayed payment would reopen
  // the old path and RECREATE a deleted file or a moved-from tree — the
  // clobber inverted. Nothing durable is lost: the edits stay in the object's
  // lineage, which is where a deleted document's text lives anyway.
  function cancelSuspendedDebts(
    suspended: Array<[string, DetachedLockedDebt]>,
    reason: string,
  ): void {
    for (const [path, debt] of suspended) {
      // The debt may hold a retry session whose release the daemon
      // REFUSED — the only session that can free that path's lease
      // Discarding the debt without closing it strands
      // the lease, and restoring or recreating the path then answers
      // ydoc-session-busy until the daemon restarts.
      void debt.discard().catch((error: unknown) => {
        onError(`ydoc close retry of ${path}`, error);
      });
      onError(
        `ydoc close retry of ${path}`,
        new Error(
          `locked-write retry cancelled: ${reason} removed the path while a pending write waited; the edits remain in the document lineage`,
        ),
      );
    }
  }

  // The removal did NOT happen (the same lock can block a trash/move too), so
  // the path still exists and still owes its write: put the debts back and
  // re-arm them.
  function restoreSuspendedDebts(
    suspended: Array<[string, DetachedLockedDebt]>,
  ): void {
    for (const [path, debt] of suspended) {
      if (detachedLockedDebts.has(path)) continue;
      detachedLockedDebts.set(path, debt);
      debt.arm();
    }
  }

  // A destructive operation is an INTERVAL, not an instant. The seam vacates
  // sessions and suspends debts on the capture chain, main does the disk work
  // OFF the chain, and only then does the finisher decide the debts' fate. The
  // suspend/cancel pair covers the debts that exist at each end of that
  // interval; a REMOVAL WINDOW covers the interval itself.
  //
  // It is what the cancel alone cannot do (#663). A payment that starts inside
  // the window passes its ownership check, reaches its settle, and parks in the
  // RPC; the finisher's cancel then lands at the client while the daemon is
  // already writing. A settle cannot be recalled, so the path the user just
  // deleted or moved away comes back. Refusing the payment while the window is
  // open is the only point where the answer still stops a write.
  //
  // A window opens on the capture chain and a payment runs on the capture
  // chain, so no payment can be in flight when one opens. That is why the
  // window needs no drain: refusing the STARTS is the whole fence.
  interface RemovalWindow {
    match: (path: string) => boolean;
    operation: "delete" | "move";
    // What another operation tells the user when it has to wait for this one.
    inProgress: string;
  }
  const removalWindows = new Set<RemovalWindow>();
  function openRemovalWindow(window: RemovalWindow): () => void {
    removalWindows.add(window);
    return () => {
      removalWindows.delete(window);
    };
  }
  function removalWindowFor(path: string): RemovalWindow | null {
    for (const window of removalWindows) {
      if (window.match(path)) return window;
    }
    return null;
  }

  async function openRestartSafeRustYDocSession(input: {
    versionId: string;
    path: string;
    contentKind?: YdocContentKind;
    onDead: () => void;
    onAlive: () => void;
    onRemoteUpdate: (update: Uint8Array) => void;
    onLineageReplaced: (update: Uint8Array, recoveredPaths: string[]) => void;
    onSettled: (
      result: {
        sha256: string;
        content: string | null;
        materialized: boolean;
      },
      token: number,
      generation: number,
    ) => void | Promise<void>;
    onSettleStart: (token: number, generation: number) => void;
    onSettleError: (error: unknown, token: number, generation: number) => void;
    // The FIRST generation's answers to "does the entered version have a
    // snapshot for this path" and "did the daemon resume durable CRDT state".
    // Reported out because the absent-head contract (see
    // `WorkspaceEngineCapture.openYDocSession`) is decided by the caller, not
    // here: later generations reopen an already-admitted document.
  }): Promise<{
    session: RestartSafeYDocSession;
    head: "present" | "absent";
    lineage: "existing" | "absent";
  }> {
    const sessions = options.rustEngineSessions;
    const openProvider =
      options.openRustYDocProviderSession ??
      openEngineYdocProviderSession;
    const workspace = { workspaceId, rootPath };
    let canonicalDoc: Y.Doc | null = null;
    let canonicalLineageClaimId: string | null = null;
    let current: EngineYdocProviderSession | null = null;
    let releaseObligation: EngineYdocProviderSession | null = null;
    let closed = false;
    let dead = false;
    const deadSessionToken = {};
    let operationChain: Promise<void> = Promise.resolve();
    const openingRemoteUpdates = new WeakMap<
      EngineYdocProviderSession,
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
      unreleased: EngineYdocProviderSession | null,
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

    // #710. `generation` is always the `openEngineYdocProviderSession` ladder
    // (production never overrides the DI seam), whose raw adapter layer
    // already swallows `ydoc-session-not-found` before it can reach here
    // (`YdocAdapterSession.close`, packages/workspace-engine-client/src/ydoc/
    // ydocLiveAdapter.ts) — and neither call below passes
    // `settleOnRefusal: false`, the ladder's only rethrow path, so the error
    // that DOES escape is by construction never that refusal. A settle:false
    // release retries once, settling, before giving up.
    const releaseGeneration = async (
      generation: EngineYdocProviderSession,
    ): Promise<void> => {
      try {
        await generation.close({ settle: false });
      } catch {
        await generation.close({ settle: true });
      }
    };

    // `seedAbsentLineage: false` for every generation after the first. A hard
    // daemon kill can lose the object's durable lineage, and a reopen would
    // then seed a fresh doc from the .md — a new client id whose state does not
    // overlap the canonical doc, so merging it would append a SECOND copy of
    // the file. The canonical doc is the renderer's truth; the replacement
    // starts empty and the replay re-establishes it.
    // Settle tokens are minted PER GENERATION and every generation starts at 1,
    // so a token alone does not identify a settle across a daemon restart. The
    // generation is stamped here, where it is known, and travels with every
    // settle callback.
    let generations = 0;
    // A file-locked settle failure means the engine holds a durably pending
    // write and the GENERATION's own backoff timer is retrying it. That timer
    // dies with the generation, so the fact it existed must outlive it (#595):
    // set on a file-locked refusal, cleared by the next settle that reaches
    // disk, and read at adoption to re-arm the retry on the replacement.
    let lockedSettlePending = false;
    const openGeneration = async (
      seedAbsentLineage: boolean,
      openOptions?: { retryTransportErrors?: boolean },
    ): Promise<EngineYdocProviderSession> =>
      await sessions.run(
        workspace,
        async (binding) => {
          const generation = ++generations;
          if (typeof binding.client.onEvent !== "function") {
            throw new Error(
              "Rust engine client does not expose Y.Doc event delivery.",
            );
          }
          let opened: EngineYdocProviderSession | null = null;
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
          const providerOpened = await openProvider({
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
            onLineageReplaced: (replacement, recoveredPaths) => {
              if (current !== opened || canonicalDoc === null) return;
              const retired = canonicalDoc;
              canonicalDoc = replacement;
              canonicalLineageClaimId = opened?.lineageClaimId ?? null;
              input.onLineageReplaced?.(
                Y.encodeStateAsUpdate(replacement),
                recoveredPaths,
              );
              retired.destroy();
            },
            onLocalEditError: requestReconnect,
            // requestReconnect returns early for anything that is not a
            // reconnect error, so it is NOT an error sink: every settle
            // failure also goes to onSettleError, which reports it.
            onSessionError: requestReconnect,
            onSettleStart: (token) => input.onSettleStart(token, generation),
            onSettleError: (error, token) => {
              if (isFileLockedRefusal(error)) lockedSettlePending = true;
              input.onSettleError(error, token, generation);
            },
            onSettled: (result, token) => {
              lockedSettlePending = false;
              return input.onSettled(result, token, generation);
            },
          });
          opened = providerOpened;
          openingRemoteUpdates.set(opened, opening);
          return opened;
        },
        {
          retryTransportErrors: openOptions?.retryTransportErrors ?? true,
        },
      );

    // Reconcile a freshly opened generation against the canonical doc and
    // install it: daemon-side edits land in the canonical doc first, then every
    // renderer edit the replacement is missing is replayed into it. The exposed
    // Y.Doc never changes identity across daemon generations.
    const adoptGeneration = async (
      doc: Y.Doc,
      replacement: EngineYdocProviderSession,
      // Announced when the REPLAY is armed on the replacement — the moment the
      // settle that will carry it exists. Anything later is too late: that
      // settle can start while the replay's journal RPC is still in flight, and
      // an edit counted after the RPC returns is missing from the seq that
      // settle reports. The settle then succeeds carrying the edit while
      // vouching for a seq below it, and with nothing left to arm another
      // settle the document sits on "Saving…" for good (#514, codex P2).
      onReplayArmed?: () => void,
    ): Promise<void> => {
      try {
        let replacementClaimId = replacement.lineageClaimId ?? null;
        const claimChanged = replacementClaimId !== canonicalLineageClaimId;
        const promotedSameLineage =
          canonicalLineageClaimId === null &&
          replacementClaimId !== null &&
          isExactYDocClaimPromotion(doc, replacementClaimId);
        if (claimChanged && !promotedSameLineage) {
          openingRemoteUpdates.delete(replacement);
          canonicalDoc = replacement.doc;
          canonicalLineageClaimId = replacementClaimId;
          current = replacement;
          input.onLineageReplaced?.(
            Y.encodeStateAsUpdate(replacement.doc),
            [],
          );
          doc.destroy();
          markAlive();
          return;
        }
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
          const journaled = replacement.applyLocalUpdate(replay);
          onReplayArmed?.();
          await journaled;
          replacementClaimId =
            replacement.lineageClaimId ?? replacementClaimId;
        } else {
          // Nothing to replay: the replacement already holds this text, so
          // every settle it runs carries it.
          onReplayArmed?.();
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
        canonicalLineageClaimId = replacementClaimId;
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
      // A pending locked settle survives the rebind (#595): the failed
      // generation's retry timer died with it, and when the replacement
      // needed no replay (the daemon's CRDT already holds the edit) nothing
      // above armed a settle — releasing the lock later would leave the
      // artifact stale until an unrelated edit. Ask the replacement to
      // settle: unchanged content routes through the engine's idempotent
      // branch, which replays the pending write, and a still-held lock
      // re-enters the provider's own retry ladder. Failures are reported
      // through the settle channel like any other, so nothing extra to do
      // with the rejection here.
      if (lockedSettlePending) {
        void replacement.settleNow().catch(() => undefined);
      }
    };

    const rebind = async (
      failed: EngineYdocProviderSession,
      options?: {
        releaseBeforeOpen?: boolean;
        retryTransportErrors?: boolean;
        // The recovery replay is an arm point like any other: when the failed
        // generation never armed anything (a SYNCHRONOUS refusal throws before
        // its settle exists), this replay is the first settle that will carry
        // the edit, and the only one that will.
        onReplayArmed?: () => void;
      },
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
      let replacement: EngineYdocProviderSession;
      try {
        replacement = await openGeneration(false, {
          retryTransportErrors: options?.retryTransportErrors,
        });
      } catch (error) {
        markDead(failed);
        throw error;
      }
      await adoptGeneration(doc, replacement, options?.onReplayArmed);
      // A reconnect-class failure means the prior daemon/workspace binding is
      // gone. Opening the replacement first is the release boundary; sending a
      // close through the broken transport can only fail and must not turn a
      // recoverable daemon restart into a dead session.
    };

    // A session whose generation died leaves the canonical doc as the only
    // holder of the renderer's text. Rebuild a generation around it so a dead
    // session heals instead of discarding every keystroke.
    //
    // The open does NOT retry the transport ladder. This runs on the settle and
    // close paths, and `will-quit` races the entire shutdown chain — engine
    // stores, relay workspaces, the daemon stop — against one 3s timer with
    // these closes first in line. A revive that needs seconds to wait a daemon
    // back up cannot help at quit anyway, and must not starve the cleanup that
    // still can. A daemon that is already back answers on the first attempt.
    //
    // Opening is the only release boundary available here: a generation that
    // died with its daemon took its lease with it, and one that died still
    // holding a LIVE lease refuses the open and stays dead for close() to
    // converge — the retained release obligation remains teardown's job.
    const reviveDeadSession = async (
      doc: Y.Doc,
      onReplayArmed?: () => void,
    ): Promise<void> => {
      if (closed || current !== null) return;
      await adoptGeneration(
        doc,
        await openGeneration(false, { retryTransportErrors: false }),
        onReplayArmed,
      );
    };

    const closedError = (cause?: unknown): Error =>
      new Error(
        `Y.Doc session for ${input.path} is closed.`,
        cause === undefined ? {} : { cause },
      );

    const executeWithReconnect = async <T>(
      operation: (session: EngineYdocProviderSession) => Promise<T>,
      options?: { retryTransportErrors?: boolean },
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
        await rebind(generation, {
          retryTransportErrors: options?.retryTransportErrors,
        });
        if (current === null) throw error;
        return await operation(current);
      }
    };

    // The FIRST generation opens on the capture chain (#493). Its retry
    // window is bounded by the TASK's budget (#564), which the open runs
    // inside — no per-run deadline here, or the task would carry two.
    // Rebinds after a daemon death run on the session's own operation chain,
    // outside that budget, and keep the full ladder.
    current = await openGeneration(true);
    canonicalDoc = current.doc;
    canonicalLineageClaimId = current.lineageClaimId ?? null;
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
    const objectId = current.objectId;
    const sessionVersionId = current.versionId;
    const contentKind = current.contentKind;
    const sessionPath = current.path;
    const openedHead = current.head;
    const openedLineage = current.lineage;

    const restartSafeSession: RestartSafeYDocSession = {
      get doc() {
        if (canonicalDoc === null) throw closedError();
        return canonicalDoc;
      },
      initialUpdate,
      ...(objectId ? { objectId } : {}),
      ...(sessionVersionId ? { versionId: sessionVersionId } : {}),
      get lineageClaimId() {
        return canonicalLineageClaimId;
      },
      contentKind,
      get artifactAssets() {
        return current?.artifactAssets ?? [];
      },
      path: sessionPath,
      readArtifactAsset(descriptor) {
        return Promise.reject(
          new Error(
            `Artifact asset ${descriptor.id} must load through its version-bound capture session.`,
          ),
        );
      },
      applyLocalUpdate(update, onArmed) {
        // ONE announcement per update, at the FIRST provider call that arms a
        // settle carrying it. Three calls can be that first one — the live
        // generation's own, a dead session's revive replay, and a failed
        // generation's recovery replay — and which one gets there depends on
        // how the generation failed. Handing the same once-guarded function to
        // all three is what stops that from mattering: the count can neither
        // lead the armed settle (a "Saved" over content it never carried) nor
        // lag it (a settle that saves the edit while vouching for a seq below
        // it, leaving the document on "Saving…" with nothing left to arm
        // another settle). #514, and its two review rounds.
        const armed = announceOnce(onArmed);
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
            // The revive replays the canonical doc — this update included —
            // into the new generation. It announces the update when that
            // replay is ARMED, not when its journal RPC returns.
            await reviveDeadSession(doc, armed);
            return;
          }
          const generation = current;
          try {
            // The provider journals and arms its settle SYNCHRONOUSLY inside
            // this call, so the update is covered from here. Announce it before
            // awaiting the journal round trip: the settle it just armed may
            // start before that round trip returns.
            const journaled = generation.applyLocalUpdate(update);
            armed();
            await journaled;
            Y.applyUpdate(doc, update);
            // A successful record can promote a local-only lineage. Retain
            // the durable claim now; later deltas change the full-state hash.
            if (
              canonicalLineageClaimId === null &&
              generation.lineageClaimId != null
            ) {
              canonicalLineageClaimId = generation.lineageClaimId;
            }
          } catch (error) {
            // A live refusal still owns its lease and must close first; a
            // transport restart opens first because the old daemon is gone.
            //
            // A SYNCHRONOUS refusal threw before the line above, so nothing was
            // armed and nothing announced. The recovery replay below is then
            // the first and only settle that will carry this edit, and the
            // once-guard makes announcing there a no-op when the failure was
            // asynchronous and the count already rose.
            Y.applyUpdate(doc, update);
            // This is an invariant breach, not a reconnect. Rebinding would
            // replace this still-visible editor with the winner and silently
            // discard the refused keystroke. Keep the old document visible
            // and report the failure; the server's live-session drain rule
            // makes this branch unreachable in an ordinary arbitration.
            if (isLineageChangedCause(error)) throw error;
            // A transient refusal is not a broken generation, and rebinding
            // for one is worse than doing nothing. The provider holds what the
            // engine refused and has already re-armed its own ladder to resend
            // it; closing that provider CANCELS the retry, and if the
            // replacement's replay meets the same busy store the session is
            // marked dead with no timer behind it — canonical text in memory
            // only, the .md stale until some unrelated edit (#658).
            //
            // Absorbed, therefore, rather than recovered from: the retry
            // already exists one layer down. Every other class here really
            // does need a new generation — a dropped transport, a quarantined
            // session, a session the daemon no longer knows — so this stays
            // narrow and everything else still rebinds.
            if (isTransientEngineCause(error)) {
              armed();
              return;
            }
            await rebind(generation, {
              releaseBeforeOpen: !isEngineSessionReconnectError(error),
              onReplayArmed: armed,
            });
          }
        }).catch((error: unknown) => {
          onError(`Y.Doc local update of ${input.path}`, error);
        });
      },
      settleNow(settleOptions) {
        return append(async () => {
          // The delete seam's own vacate settles on this capture chain before
          // it opens its removal window. That ordering prevents its settle
          // from racing its delete. This fence backs every other caller that
          // can reach the same settle door while another operation already
          // owns the path.
          const removal = removalWindowFor(input.path);
          if (removal) {
            throw new YDocRemovalInProgressError(
              input.path,
              removal.inProgress,
              "settle",
              removal.operation,
            );
          }
          return await executeWithReconnect(async (session) =>
            await session.settleNow(settleOptions),
          );
        });
      },
      applyExternalMarkdownEdit(markdown) {
        return append(async () => {
          const result = await executeWithReconnect(async (session) =>
            await session.applyExternalMarkdownEdit(markdown),
          );
          return { supported: result.kind === "merged" };
        });
      },
      evict() {
        return append(async () => {
          if (closed) return;
          // No revive, no settle, no release ladder. Evict whichever
          // generation still holds the lease, including a dead wrapper's
          // retained release obligation.
          if (current !== null) {
            await current.evict();
          } else if (releaseObligation !== null) {
            await releaseObligation.evict();
            releaseObligation = null;
          }
          closed = true;
          current = null;
          clearDeadYDocSession(deadSessionToken);
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
            // A session still LIVE when the daemon died reaches its rebind
            // from HERE. At quit that rebind cannot succeed: the 3s budget
            // does not cover a daemon relaunch, and waiting it out starves the
            // store closes and the daemon stop. Nothing is dropped by giving
            // up — a live `current` means no edit has failed since the daemon
            // died, so every update is already in its journal and only the .md
            // projection is deferred to the next launch. The path that DOES
            // still hold unjournaled text is the dead-session revive above.
            await executeWithReconnect(
              async (session) => {
                await session.close(closeOptions);
              },
              { retryTransportErrors: closeOptions?.shuttingDown !== true },
            );
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
    return {
      session: restartSafeSession,
      head: openedHead,
      lineage: openedLineage,
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
      // A healthy session flushes the CRDT to disk + projection first. A
      // failing-close entry skips only the SETTLE — its flush was attempted
      // and may have been refused — because the release below hands over
      // anything the engine is still missing whatever `settle` says, and
      // refuses to release while it is behind (ydocProviderSession `close`).
      if (entry.status === "live") {
        await entry.session.settleNow({ summary });
      }
      await entry.close({ settle: false });
    }
    // Detached locked-write debts are NOT touched here. This
    // vacate runs for version operations and content refreshes that remove
    // nothing, and its callers have only ATTEMPTED their operation at this
    // point — neither is proof. Each edge decides for itself, above:
    // `beginFileRename` pays and fails while the payment stays locked;
    // `settleAndCloseLiveSessionsForPath` suspends and lets the delete's
    // outcome cancel or restore; version switches leave the debt to its own
    // version fence.
  }

  // The encrypted secret store (PR 08) shares engine.db; opened lazily so
  // workspaces without secret files never touch the key path.
  function secretStoreFor(): SecretFileStore {
    secretStore ??= daemonStores().secretStore;
    return secretStore;
  }

  // One page of protected-file changes, with the same guarantee as the text
  // pager (#562): a returned page is empty only when the comparison is
  // exhausted — an all-identical window is walked through, never returned as
  // an empty page a surface would misread.
  async function secretComparePage(
    targetVersionId: string,
    sourceVersionId: string,
    afterPath: string | undefined,
  ): Promise<SecretFileComparePage> {
    const secrets = secretStoreFor();
    let cursor = afterPath;
    for (;;) {
      const page = await secrets.compareSecretFileVersions({
        workspaceId,
        targetVersionId,
        sourceVersionId,
        ...(cursor !== undefined ? { afterPath: cursor } : {}),
      });
      if (page.entries.length > 0 || page.nextAfterPath === null) return page;
      cursor = page.nextAfterPath;
    }
  }

  // Reconciliation-tolerant listing (WS-H1 gate fix): an unreadable or racy
  // path is skipped and reported as a failed path instead of aborting the
  // whole scan, so one bad directory can never stop every OTHER existing
  // file from seeding the engine on a cold adoption.
  async function scanWorkspaceFilesForReconcile(): Promise<ReconcileScan> {
    const scan = await scanWorkspaceFilesTolerant(rootPath);
    return { files: scan.files, failedPaths: scan.failures.map((failure) => failure.path) };
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
        store ??= daemonStores().store;
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

  // "Which paths does the Y.Doc editor own?", memoized for one task. Only a
  // RETIREMENT decision needs it, so a task that retires nothing never builds
  // it; a task that retires many pays for one listing, not one per path.
  function makeYdocOwnedPathsLookup(
    engine: VersionedTextStore,
    versionId: string,
  ): () => Promise<Set<string>> {
    let cache: Set<string> | null = null;
    return async () => {
      cache ??= new Set(
        (await listTextFileMetadata(engine, versionId))
          .filter((file) => file.hasYdocMarker)
          .map((file) => file.path),
      );
      return cache;
    };
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
    // The in-process store has no metadata listing, so the Y.Doc marker is
    // read straight from engine.db through the write lane it owns. An engine
    // without the lane answers "no marker", which only costs the oversized
    // Y.Doc protection the daemon path gets — it never retires anything the
    // old code would have kept.
    const ydocObjectIds = await ydocMarkedObjectIds(engine, versionId);
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
      hasYdocMarker: ydocObjectIds.has(snapshot.objectId),
    }));
  }

  // Object ids carrying a ydoc_docs marker in this version. MARKER-EXISTS,
  // not durable-state: a default local close prunes updates and snapshots but
  // KEEPS the marker, and such a file is still Y.Doc-owned.
  async function ydocMarkedObjectIds(
    engine: VersionedTextStore,
    versionId: string,
  ): Promise<Set<string>> {
    const runInLane = engine.runInEngineWriteLane?.bind(engine);
    if (!runInLane) return new Set();
    try {
      const ids = await runInLane((connection) => {
        const rows = connection
          .prepare(
            "SELECT object_id AS objectId FROM ydoc_docs WHERE workspace_id = ? AND version_id = ?",
          )
          .all(workspaceId, versionId) as Array<{ objectId: string }>;
        return rows.map((row) => row.objectId);
      });
      return new Set(ids);
    } catch (error) {
      // A store without the table (or a read failure) must not take the
      // reconcile pass down; fall back to "no markers".
      onError("ydoc marker lookup", error);
      return new Set();
    }
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

  // Same verdict as `consumeExpectedEvent`, without spending the token: a
  // caller that only needs to KNOW whether an event is expected — not to be
  // the one downstream gate that acts on it — must not steal the answer
  // from whichever gate consumes it for real (#681 round 5, CodeRabbit
  // Major). The single consumption stays at each branch's original site.
  function peekExpectedEvent(
    operation: "write" | "delete",
    path: string,
    sha256?: string,
  ): boolean {
    const nowMs = now();
    return expectedEvents.some(
      (event) =>
        event.expiresAtMs > nowMs &&
        event.path === path &&
        event.operation === operation &&
        (operation === "delete" || event.sha256 === sha256),
    );
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

  // A detached-debt marker's cleanup on removal must not depend on whether
  // policy tracks the path, or on any other capture-side gate: a debt can
  // exist for a path policy later excludes (or one that was tracked when
  // the session opened it and is not now), and running this after such a
  // gate left an external delete of an excluded path unable to ever clear
  // the marker it left behind (#681 round 3, codex P2). Cleanup runs
  // whether the delete is EXTERNAL or EXPECTED (#681 round 4, codex P2):
  // an engine-materialized removal — a version switch whose target omits
  // the file, a relay fast-forward delete — is registered as an expected
  // event so it never re-journals as a new moment, but it is exactly as
  // terminal for an abandoned write as an external delete. The path is
  // gone either way; only the REASON differs, and only the trace needs to
  // say which.
  //
  // A SEPARATE function from `captureOnePath`, called for every batched
  // event regardless of `daemonOwnsCapture` (#681 round 6, codex P2-B):
  // registry maintenance is not capture. Production sets
  // `daemonOwnsCapture: true` (engineCaptureGate.ts), under which
  // `captureBatch` never calls `captureOnePath` at all — the daemon
  // performs the disk-to-engine write itself — but a detached debt is
  // purely JS-side bookkeeping about a Y.Doc session's own close failure,
  // unrelated to which side captures disk content, and the watcher
  // reports the same events either way. Living inside `captureOnePath`
  // left this entire mechanism (rounds 3-5) dead in the shipped
  // configuration; every prior test exercised the JS-capture harness.
  //
  // GATED ON A DEBT EXISTING (#681 round 5, CodeRabbit Major + security).
  // Only a path with a registered debt needs this early answer at all —
  // every OTHER path, secrets included, must see the capture-side gates
  // (secret floor, then live-session, then policy) completely untouched.
  // Consuming the expected-event token here for a path with no debt stole
  // it from whichever gate owns that path's own verdict — a secret path's
  // removal read as external and recorded a spurious protected "Deleted"
  // moment, because `captureSecretPath` never got the chance to consume
  // its own token. Reading disk here unconditionally also meant reading
  // secret plaintext through the plaintext reader before the secret
  // floor, and charging a disk read to every excluded/deferred path on
  // every event. PEEK decides the trace and whether to cancel; the single
  // real consumption stays at `captureOnePath`'s own original site (or
  // inside `captureSecretPath`, for the — believed unreachable — case of
  // a secret path somehow carrying a debt: peeking rather than consuming
  // leaves that path's own verdict intact either way).
  async function cleanupDetachedDebtForEvent(event: WatcherEvent): Promise<void> {
    if (!detachedLockedDebts.has(event.path)) {
      // `captureBatch`'s own synchronous pass, at watcher-delivery time,
      // already recorded a delete's no-debt tombstone (codex P1-C on
      // #746) — nothing is left to do for a path with no debt by the time
      // this enqueued task runs.
      return;
    }
    if (event.operation === "delete") {
      const isExternalDelete = !peekExpectedEvent("delete", event.path);
      cancelSuspendedDebts(
        suspendDetachedDebts((path) => path === event.path),
        isExternalDelete
          ? `an external delete of ${event.path}`
          : `dohc's own removal of ${event.path}`,
      );
      return;
    }
    const peeked = await readDiskTextState(rootPath, event.path);
    if (peeked.kind !== "absent") return;
    const isExternalAbsence = !peekExpectedEvent("delete", event.path);
    cancelSuspendedDebts(
      suspendDetachedDebts((path) => path === event.path),
      isExternalAbsence
        ? `an external delete of ${event.path}`
        : `dohc's own removal of ${event.path}`,
    );
  }

  async function captureOnePath(
    engine: VersionedTextStore,
    versionId: string,
    event: WatcherEvent,
    policy: WorkspaceEnginePolicySnapshot,
    metadata: ActorNeutralWriteMetadata,
    ydocOwnedPaths: () => Promise<Set<string>>,
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
    //
    // An ORPHAN is the exception, and it has to be, or the discharge above
    // promises a recovery it cannot reach. That entry exists because a
    // refused open could not release its session, and the retry that
    // discharges it converges only once the file is captured — so deferring
    // capture for the entry waiting on that capture is a deadlock, and the
    // document stays read-only for the rest of the run (#564, codex r21).
    // It is also the SAFE exception: the doc was never handed out and holds
    // nothing the user typed, so there is no partial write to journal under
    // it, and the file is the only truth this path has.
    const liveSession = liveYDocSessions.get(event.path);
    if (
      liveSession !== undefined &&
      liveSession.status !== "live" &&
      !liveSession.orphaned
    ) {
      return;
    }
    if (!policyTracksPath(event.path, policy)) return;
    // Deletes trust the watcher's confirmed-absent check; updates re-read the
    // CURRENT disk state so rapid successive writes coalesce to the final
    // content instead of replaying stale event snapshots. This is the ONE
    // real consumption of the expected-event token for this event — the
    // debt cleanup above only ever peeked.
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
      // OUR OWN settle materialization can land here. A Y.Doc is not bounded
      // by the engine's MAX_TEXT_BYTES, so a document grown past
      // it materializes a file this reader classifies as un-ownable — and
      // retiring the record would DELETE the document's engine history while
      // the editor reports "Saved". (The dogfood journey's repro was 131,442
      // bytes, right into this trap.) Every other branch here checks the
      // expected-event registry first; this one must too, with the same
      // sha-precise identity so a genuine external oversized write still
      // retires the path as designed.
      if (
        disk.sha256 !== undefined &&
        consumeExpectedEvent("write", event.path, disk.sha256)
      ) {
        return;
      }
      // OWNERSHIP decides, exactly as the startup reconcile decides. A Y.Doc
      // is bounded by nothing, so its settled artifact routinely reads as
      // un-ownable here — and that is true whoever wrote the bytes and
      // whether or not the doc is open. An agent writing the .md directly is
      // a first-class dohc flow, so keying this on a LIVE session would
      // retire records the reconcile keeps. This is not the blanket
      // live-path skip gate fix 1 removed: ordinary capture of a live path is
      // untouched; only the retirement decision defers to ownership.
      // Two checks, and BOTH are load-bearing. The marker lookup answers
      // "has this document ever settled", so a session opened on a path with
      // no marker yet is absent from it. The live-session check covers exactly
      // that document; deleting it would retire the record of a doc the user
      // just opened and has not saved.
      if (liveYDocSessions.has(event.path)) return;
      if ((await ydocOwnedPaths()).has(event.path)) return;
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
    const ydocOwnedPaths = makeYdocOwnedPathsLookup(engine, versionId);
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
      } else if (
        disk.kind === "untracked-content" &&
        (await ydocOwnedPaths()).has(file.path)
      ) {
        // A path the Y.Doc EDITOR owns. Its content is whatever the CRDT
        // projects — a settle is bounded by nothing, so it routinely exceeds
        // the caps ordinary captured text is held to, and the reader then
        // reports it as un-ownable. Retiring here would journal a "Stopped
        // tracking" delete for a document the user is actively editing, on
        // every single launch, and drop it back to the plain editor.
        //
        // The expected-event registry cannot help at this layer: those
        // entries expire in seconds and reconciliation runs at startup, long
        // after the write. Ownership is the durable fact, so ownership is
        // what this asks.
        continue;
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
      // Confirm the absence before retiring: the scan is trusted for
      // adds/updates but never to authorize a delete on its own.
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
      // Same confirmed-absent delete gate for protected files: an incomplete
      // scan must never retire a secret whose file is still on disk.
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
      const batch = events.map((event) => ({ ...event }));
      // The no-debt tombstone (codex P1-C on #746), recorded HERE at
      // watcher-delivery time rather than inside the enqueued cleanup
      // below. A close-retry's own removal check runs OFF the capture
      // chain, on its own timer, and a chain busy with reconciliation or a
      // version op can leave the cleanup task queued behind that work for
      // as long as it runs. A retry firing inside that window used to find
      // no tombstone at all — nothing had recorded it yet — and resurrect
      // the file. `detachedLockedDebts` and `expectedEvents` are plain
      // maps a synchronous read sees exactly as fresh as the enqueued
      // read would, so recording immediately only narrows the window.
      //
      // A retrying entry ALSO gets armed directly (codex P1-C follow-up):
      // the tombstone's own TTL (`EXPECTED_ENGINE_EVENT_EXPIRY_MS`) caps at
      // the same 10s the close-retry ladder's doubling delay eventually
      // reaches, so a delete landing right after one retry can otherwise
      // expire before the next one arrives to consume it. Calling the
      // session's own door bypasses the TTL for that session entirely —
      // nothing here can expire, because nothing here is a map entry.
      for (const event of batch) {
        if (event.operation !== "delete") continue;
        const expected = peekExpectedEvent("delete", event.path);
        if (!detachedLockedDebts.has(event.path)) {
          noteExternalDeleteWithNoDebt(event.path, expected);
        }
        const live = liveYDocSessions.get(event.path);
        if (live?.status === "failing-close") {
          live.armRemovalSuppression(expected, now());
        }
      }
      // Registry maintenance, not capture (#681 round 6, codex P2-B): runs
      // for every batch regardless of `daemonOwnsCapture`, ahead of the
      // early return below. See `cleanupDetachedDebtForEvent`'s own
      // comment for why a debt's cleanup cannot be skipped just because
      // the daemon owns the disk-to-engine write.
      enqueue("detached-debt cleanup", async () => {
        for (const event of batch) {
          try {
            await cleanupDetachedDebtForEvent(event);
          } catch (error) {
            onError(`detached-debt cleanup of ${event.path}`, error);
          }
        }
      });
      if (options.daemonOwnsCapture) return;
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
          const ydocOwnedPaths = makeYdocOwnedPathsLookup(engine, versionId);
          let pathFailures = 0;
          for (const event of batch) {
            try {
              await captureOnePath(
                engine,
                versionId,
                event,
                policy,
                metadata,
                ydocOwnedPaths,
                author,
              );
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

    writeAuthoredTextFile(absolutePath, text, author, writeOptions = {}) {
      return enqueueResult("write authored text", async () => {
        if (writeOptions.signal?.aborted) {
          throw new Error("Plugin panel is no longer active.");
        }
        const observedBytes = Buffer.byteLength(text, "utf8");
        if (observedBytes > MAX_DESKTOP_CAPTURE_TEXT_BYTES) {
          throw new Error(
            `Authored text exceeds the in-band write limit: limit ${MAX_DESKTOP_CAPTURE_TEXT_BYTES} bytes, observed ${observedBytes} bytes.`,
          );
        }
        const { relative: resolvedRelative, resolvedAbsolute } =
          await assertResolvedWorkspacePath({
            rootPath,
            absolutePath: resolve(absolutePath),
            spelled: absolutePath,
            label: "Authored text path",
            access: "write",
          });
        const path = resolvedRelative.replaceAll("\\", "/");
        if (
          path.length === 0 ||
          isAbsolute(path) ||
          path === ".." ||
          path.startsWith("../")
        ) {
          throw new Error(`Authored text path escapes the workspace: ${absolutePath}.`);
        }
        if (writeOptions.createOnly && existsSync(resolvedAbsolute)) {
          throw new Error(`File already exists: ${path}`);
        }
        const policy = await readPolicyForTask();
        assertEngineWritablePath(path, policy);
        if (writeOptions.signal?.aborted) {
          throw new Error("Plugin panel is no longer active.");
        }
        const engine = await engineStore();
        const versionId = await activeVersionIdOf(engine);
        const metadata: ActorNeutralWriteMetadata = {
          origin: "api",
          summary: `Updated ${pathBasename(path)}`,
          correlationId: `authored-write-${createId()}`,
        };
        await engine.writeTextFile({
          workspaceId,
          versionId,
          path,
          text,
          metadata,
          author,
        });
        await materialize([{ kind: "write", path, text }], policy);
      });
    },

    openYDocSession(input) {
      // ON THE CAPTURE CHAIN, deliberately (#493). The version this session
      // binds to is read here and the registry entry is written at the end,
      // with a daemon round trip in between. Off the chain, a switch/merge/
      // create running in that gap swept a registry the session had not
      // reached yet: the sweep vacated nothing, and the session went live
      // against the version the user just LEFT. Everything typed into it
      // settled into that version's lineage and materialized its
      // projection over the folder the switch had just written. Running the
      // open as a chain task makes "which version is active" and "this path
      // has a live session" one indivisible step against every version op.
      // ONE budget for the whole task (#564). Bounding only the provider open
      // left the task unbounded: the version read below runs first, through
      // the store's own six-attempt transport ladder, so a daemon-down open
      // failed THERE — holding the chain for that ladder and rejecting with a
      // rebind error the surface reads as an ordinary fallback, which is the
      // writable plain editor this bound exists to prevent.
      return enqueueResult("open ydoc session", () =>
        options.rustEngineSessions.withRetryBudget(
          YDOC_OPEN_RETRY_DEADLINE_MS,
          openYDocSessionTask,
        ),
      );

      async function openYDocSessionTask(): Promise<WorkspaceEngineYDocProviderSession> {
        // This session's own place in time, captured before anything else
        // runs (#681 round 8, codex P1): the registration door
        // (`scheduleDetachedLockedSettle`, far below) compares this against
        // a delete tombstone's own timestamp to tell a STALE incarnation
        // (opened before the delete — its content is what the deletion
        // orphaned) from this path's later recreation (opened after it —
        // arms normally, since a tombstone recorded before this session
        // began says nothing about what THIS session holds).
        const sessionOpenedAtMs = now();
        const removal = removalWindowFor(input.path);
        if (removal) {
          throw new YDocRemovalInProgressError(
            input.path,
            removal.inProgress,
            "open",
            removal.operation,
          );
        }
        // An ORPHANED session — one a refused open could not release — still
        // belongs to the daemon, which answers ydoc-session-busy for as long
        // as it stands, so the user's "Try again" would refuse forever.
        // Discharge it first, on the SAME terms the release that orphaned it
        // used: `settleOnRefusal: false`.
        //
        // That flag is the whole point, and an earlier round of this PR had
        // the reasoning wrong. It said the discharge could settle because "the
        // refusal proved content exists" — conflating content existing in the
        // DOC with the disk being captured. The danger was never calling the
        // path missing. It is rule 1 above: this doc was seeded from neither a
        // head nor a snapshot, so settling it writes whatever replication
        // delivered OVER bytes the watcher has not ingested yet. Without the
        // flag the provider escalates a repeated UnsettledClose to a SETTLING
        // close (ydocProviderSession), and a quick retry on a dirty orphan
        // materializes the Y.Doc over the user's uncaptured file (#564, codex
        // r20).
        //
        // A terminal refusal on an orphan now EVICTS, so the next open binds
        // the preserved lineage (#665). A transient or workspace-open refusal
        // retains the orphan and waits it out through the existing ladders.
        //
        // Only an orphan. A failing-close session someone still HOLDS is
        // converged by its holder and by the version ops, and a second open
        // of it must keep refusing.
        const retained = liveYDocSessions.get(input.path);
        if (retained?.status === "failing-close" && retained.orphaned) {
          try {
            await retained.close({ settle: false });
          } catch (dischargeError) {
            if (isEngineWorkspaceOpenRefusedError(dischargeError)) {
              throw dischargeError;
            }
            throw new YDocSessionUnreleasedError(input.path, dischargeError);
          }
        }
        // Resolve the active version through this capture's store, then open the
        // provider through the same Rust workspace-session owner. Capture,
        // version work, and Y.Doc work therefore share one daemon workspace lease.
        const engine = await engineStore();
        const versionId = await activeVersionIdOf(engine);
        const reportSaveState = (
          state: EngineYDocSaveState,
          token: number,
        ): void => {
          try {
            input.onSaveState?.(state, token);
          } catch {
            // Observer boundary: a renderer-facing status hook must never
            // re-enter the session or wedge the settle chain.
          }
        };
        // How many updates entered this document, and how many of them a
        // COMMITTED settle carried. The close downgrade below needs proof that
        // the text settled, and a successful RELEASE is not that proof:
        // `close_session` checks `last_settled_sha` only before a local-only
        // PRUNE, while a replicated lineage — a synced workspace, promoted by
        // `claim_base` on the first pulled `ydoc.update` — compacts instead and
        // never prunes, so its release succeeds over unsettled text
        // (crates/dohc-engine-collab/src/durable.rs). The desktop therefore
        // evidences its own claim rather than inferring it from a release whose
        // meaning depends on the regime.
        //
        // Settles OVERLAP, and they do not finish in the order they start:
        // runSettle announces a start before it queues, and a settle that
        // aborts on the journal reports its failure WITHOUT ever reaching the
        // settle chain, so it can finish ahead of one queued before it. Order
        // is therefore not a sound pairing, and neither a shared slot nor a
        // queue can be right. Each settle's claim is keyed by the settle
        // itself: its token, and the generation that minted the token — every
        // daemon generation runs its own settle chain and starts counting at 1
        // again, so the token alone repeats across a restart.
        //
        // Counting is coarse for the same reason: an update that leaves the
        // projection unchanged still marks the document unsettled, because
        // over-counting only costs loudness while under-counting would report a
        // save that never happened.
        let updatesSeen = 0;
        let updatesSettled = 0;
        const settleClaims = new Map<string, number>();
        const settleId = (token: number, generation: number): string =>
          `${generation}:${token}`;
        // WHEN this settle started (codex P1 on #746's synchronous
        // tombstone): the no-debt tombstone clear below must not erase a
        // delete newer than the write it certifies. A settle's own
        // completion callback can run late — behind an occupied capture
        // chain, or simple scheduling — so an external delete landing
        // AFTER the write already materialized, but BEFORE this callback
        // runs, must survive the clear. Keyed on start, not completion:
        // the write could have landed any time from here on, so a
        // tombstone recorded at or after this moment might be exactly
        // that delete.
        const settleStartedAtMs = new Map<string, number>();
        const noteUpdate = (): void => {
          updatesSeen += 1;
        };
        // The sha of the last settle that committed — what the file must NOT
        // hold for `changed-on-disk` to be true of it. An unverifiable read
        // says nothing about the bytes, so it is not drift either.
        let lastSettledSha: string | null = null;
        const fileDriftedFromSettled = async (settled: string): Promise<boolean> => {
          const digest = await digestSettledFile(rootPath, input.path);
          if (digest.kind === "unverifiable") return false;
          return digest.kind === "changed" || digest.sha256 !== settled;
        };
        const onSettled = async (
          result: {
            sha256: string;
            content: string | null;
            // The daemon reports whether the settled document reached the workspace
            // file. Only an explicit success may continue to the save notification.
            materialized: boolean;
          },
          token: number,
          generation: number,
        ) => {
          // The settle COMMITTED — every branch below is about the FILE, not
          // the lineage — so the updates THIS settle carried are a moment in
          // History now. Updates that arrived after its start are not: they
          // belong to a later settle's claim, which only that settle can
          // redeem.
          const claim = settleClaims.get(settleId(token, generation));
          settleClaims.delete(settleId(token, generation));
          const startedAtMs = settleStartedAtMs.get(settleId(token, generation));
          settleStartedAtMs.delete(settleId(token, generation));
          if (claim !== undefined && claim > updatesSettled) updatesSettled = claim;
          lastSettledSha = result.sha256;
          // The settle committed, but the engine says the FILE did not move
          // (materialization blocked by containment — a symlinked target — with
          // the write pending a retry). Say so rather than report a save the
          // disk never received.
          if (result.materialized === false) {
            onError(
              `ydoc settle of ${input.path}`,
              new Error(
                "the engine committed the settle but could not write the file (blocked target); the write is pending a retry",
              ),
            );
            reportSaveState("error", token);
            return;
          }
          // The engine just wrote this path's settled content to disk — the
          // proof a stand-down marker denies (#681). This fires for every
          // settle on this session, including the pre-close one a rename's
          // vacate runs, so a mid-session rename over a recovered path is
          // covered too. An open alone is not this proof: it shows no
          // conflicting lease, not that anything reached disk.
          //
          // The same proof also retires this path's no-debt tombstone (#681
          // round 9, codex P1): a session is classified once, at open,
          // against a delete it predates, and stays classified that way
          // forever otherwise — even after landing THIS settle proves the
          // deletion's premise (the path is gone) no longer holds. Without
          // this, a still-later transient close failure for the SAME
          // session, over edits made AFTER this recovery, would read as
          // belonging to the deleted incarnation and get wrongly cancelled.
          //
          // ONLY a tombstone that PREDATES this settle's own start (codex
          // P1 follow-up on #746's synchronous recording): this callback
          // can run late, behind an occupied capture chain, and a delete
          // landing after the write already materialized but before this
          // callback runs must survive — clearing it here would erase the
          // one place that evidence is recorded, purely because an OLDER
          // settle's completion happened to run after it.
          const staleTombstone = recentExternalDeletesWithNoDebt.get(input.path);
          if (
            staleTombstone !== undefined &&
            startedAtMs !== undefined &&
            staleTombstone.deletedAtMs <= startedAtMs
          ) {
            recentExternalDeletesWithNoDebt.delete(input.path);
          }
          //
          // Clear the ABANDONMENT, not the debt (CodeRabbit): this entry may
          // belong to an OLDER generation whose own release is still being
          // refused (L). That entry is L's only owner — deleting it here
          // strands the lease at ydoc-session-busy until the daemon
          // restarts, exactly what the surrounding comments guard against.
          const clearedStandDown = detachedLockedDebts.get(input.path);
          if (clearedStandDown?.stoodDown) {
            clearedStandDown.stoodDown = false;
            // The flag alone does not say whether L is still owed — only
            // that OLDER generation's own closure knows that (#681 round 6,
            // codex P2-A). Ask it, on the chain (this settle's completion
            // runs off it): with nothing owed, paying now just retires the
            // entry — the `writeCancelled` branch below already does that
            // for a non-stood-down debt, and skipping this left a fully
            // discharged debt lingering forever (a later delete then traced
            // a cancellation for a write that was never pending, and the
            // closure graph stayed retained past workspace stop). With a
            // release still refused, the same call re-arms that retry
            // exactly as it would have on its own schedule — the O3 case
            // this settle must never strand. Fire-and-forget: a stalled
            // release here must never fail THIS settle's own success.
            enqueue(`ydoc close retry of ${input.path}`, () =>
              clearedStandDown.pay().catch((error: unknown) => {
                onError(`ydoc close retry of ${input.path}`, error);
              }),
            );
          }
          // #338. The ENGINE owns the artifact: a settle it reports as
          // materialized either wrote the file or found those bytes already
          // there. The desktop used to write them AGAIN ("the mirror of the same
          // bytes"), which was redundant every time it agreed with the engine
          // and destructive the one time it did not — an unchanged projection is
          // answered from the lineage without touching the file, so the mirror
          // replaced whatever an outside writer had put there. The desktop now
          // writes NOTHING here. It reads the file to decide what to REPORT.
          //
          // The digest comes from a bounded streaming hash, not from
          // readDiskTextState: that reader answers "can capture own this?" and
          // returns no sha at all past its 5 MiB cap, which would have read as
          // "no proof of drift" for the largest files — the worst case to guess
          // wrong about.
          const digest = await digestSettledFile(rootPath, input.path);
          if (digest.kind === "unverifiable") {
            // dohc could not check the file, which is not the same as knowing it
            // changed: a transient lock (a scanner holding it open) must not
            // send the user to History for a file that probably holds exactly
            // this document. It is the retryable failure — the next settle
            // checks again.
            onError(
              `ydoc settle of ${input.path}`,
              new Error(
                `the engine settled the document but dohc could not check the file: ${digest.reason}`,
              ),
            );
            reportSaveState("error", token);
            return;
          }
          if (digest.kind === "changed" || digest.sha256 !== result.sha256) {
            // Gone, too big to be this document, or simply different: in none of
            // those does the file hold what the editor holds. A delete counts as
            // changed — it is an intent, and recreating the file would be the
            // same overwrite in reverse. The text stays in the CRDT and in
            // History either way.
            reportSaveState("changed-on-disk", token);
            return;
          }
          // The file holds the settled bytes, so the ENGINE's write of them is
          // ours: register it, and a watcher event that lands after the
          // live-path guard lifts on close is recognized instead of re-journaled
          // as an external edit. Registering on the drift path instead would arm
          // a suppression for bytes nobody wrote, which could swallow a later
          // genuine event carrying that same sha.
          registerExpectedEngineEvents([
            { path: input.path, operation: "write", sha256: result.sha256 },
          ]);
          reportSaveState("saved", token);
        };
        // Claim exactly what this settle can carry. The daemon serves one
        // session's commands in order, so an update already sent is in the
        // settle that follows it; one sent after this point is not.
        const onSettleStart = (token: number, generation: number) => {
          settleClaims.set(settleId(token, generation), updatesSeen);
          settleStartedAtMs.set(settleId(token, generation), now());
          reportSaveState("settling", token);
        };
        // The one place a background settle failure is observable. Log it with
        // the path and the wire error, and tell the editor the file on disk is
        // behind — a settle that never lands is the user's content going
        // nowhere.
        //
        // #496 corrects this report from the close path below, and only ever
        // DOWNWARDS in loudness. Reporting the failure first and withdrawing it
        // once the release proves it benign is deliberate: a report deferred
        // until the outcome is known can be dropped, and a dropped settle
        // failure is the silent loss this callback exists to prevent. An extra
        // `error` that gets corrected cannot lose anything.
        //
        // Remembered per FAILURE, not as one latest-failure slot. This session
        // outlives the daemon generation under it, each generation runs its own
        // settle chain, and their tokens both start at 1 — so a slot could be
        // overwritten by an unrelated generation's failure between the close's
        // settle and its release, and the close would then withdraw nothing.
        // Keying on the error itself is what the close already matches on, and
        // a WeakMap keeps the record exactly as long as the error exists.
        const settleFailureTokens = new WeakMap<object, number>();
        const onSettleError = (
          error: unknown,
          token: number,
          generation: number,
        ) => {
          // This settle carried nothing to History, so its claim is dropped
          // unredeemed — and only ITS claim, whichever settle finishes first.
          settleClaims.delete(settleId(token, generation));
          settleStartedAtMs.delete(settleId(token, generation));
          if (typeof error === "object" && error !== null) {
            settleFailureTokens.set(error, token);
          }
          onError(`ydoc settle of ${input.path}`, error);
          reportSaveState(settleFailureSaveState(error), token);
        };
        let entry: LiveYDocSession | null = null;
        const { session, head, lineage } = await openRestartSafeRustYDocSession({
          versionId,
          path: input.path,
          ...(input.contentKind ? { contentKind: input.contentKind } : {}),
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
          onRemoteUpdate: (update) => {
            noteUpdate();
            input.onRemoteUpdate(update);
          },
          onLineageReplaced: (update, recoveredPaths) => {
            noteUpdate();
            input.onLineageReplaced?.(update, recoveredPaths);
          },
          onSettled,
          onSettleStart,
          onSettleError,
        });
        // Register the live session only after the open succeeds (a secret/
        // already-live/path-not-in-version rejection propagates to the caller
        // and never guards a path that has no session). The close below drops the entry
        // ONLY when teardown succeeds (gate fix 5): a failing close retains a
        // failing-close entry so the reservation/retry are not lost and capture
        // stays deferred for the path.
        // THE DETACHED LOCKED-WRITE DEBT.
        //
        // A replicated lineage compacts on release without the local-only
        // pending-job guard (durable.rs), so a close can RELEASE successfully
        // over a locked settle: the provider throws
        // YdocReleasedWithSettleFailureError, and the session and its entry
        // are both gone. The per-entry ladder below cannot pay that debt, so
        // this one does — it reopens enough state to settle, and an unchanged
        // projection routes through the engine's idempotent settle, which
        // replays the pending write.
        //
        // It pays ON the capture chain, the serialization point every version
        // operation runs through, and re-checks the world at fire time. That
        // is what gives the debt exactly one owner and keeps it behind the
        // version fence:
        //
        // - A live entry for the path TAKES the debt. Opening a document
        //   settles nothing by itself, so the live session's settle is asked
        //   for explicitly. An open cannot interleave with a chain task, which
        //   is what makes the check authoritative.
        // - A workspace on ANOTHER version drops it with a trace. Reopening
        //   the captured version here would run outside the fence and could
        //   write the old version's projection over the active one. Nothing
        //   durable is lost: the fence replays pending materializations before
        //   any switch scans the filesystem (lib.rs,
        //   materialize_replay_pending_for_fence — fatal on failure), so a
        //   SUCCEEDED switch already paid or carried it.
        //
        // The payment is callable from the debt's own timer (wrapped in
        // `enqueue`) and inline by another chain task that must drain the debt
        // before touching the path — a rename, most of all.
        let detachedRetryMs = TEARDOWN_RETRY_INITIAL_MS;
        // One debt, one timer.
        let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;

        // ── A debt owes TWO things ──────────────────────────────────────
        //
        //   W  the newest Y.Doc state must reach the Markdown artifact
        //   L  a retry session whose RELEASE the daemon refused must still
        //      be released: ydoc_close_inner reinserts that session and it
        //      keeps its lease, so every later open of the path answers
        //      ydoc-session-busy until the daemon restarts
        //
        // The registry entry lives until both are discharged, and cancelling W
        // never cancels L.

        // W's proof is ASKED, never stored. Every remote update bumps the
        // sequence; a settle records the value it is known to carry,
        // snapshotted before it is issued because the projection is taken
        // inside that call. The write is proven only while the two still
        // agree, so an update arriving after a settle succeeds withdraws the
        // proof by itself.
        //
        // Only a MATERIALIZED settle records anything. A settle resolving is
        // the adjacent operation, not the write: the engine commits the
        // lineage and answers `materialized: false` for a target it declines
        // to write — a symlinked path or ancestor — so the artifact is still
        // stale when the call comes back clean. That field is part of what
        // proof MEANS; a guard beside the call would only move the hole to the
        // next discharge path.
        let updateSeq = 0;
        let settleCovers = -1;
        const writeIsProven = (): boolean => settleCovers === updateSeq;

        // L's holder: a session the daemon refused to release. Assigned only
        // where a close fails, cleared only where a close succeeds.
        let pendingRelease: WorkspaceEngineYDocProviderSession | null = null;

        // W is cancelled: the path is gone, or the engine will refuse this
        // write however long anyone waits. L can still be outstanding.
        let writeCancelled = false;

        // THE ONLY way this debt lets go of a lease. Release first, forget
        // second: a refused release keeps the session, because dropping the
        // reference leaves the lease with no owner at all.
        const releaseRetainedSession = async (): Promise<void> => {
          const held = pendingRelease;
          if (held === null) return;
          // `settle: false` is a preference, not a promise: the provider
          // ESCALATES a refused release to a SETTLING close so pending edits
          // survive a transient failure. That is right while this debt still
          // owes a write. It is wrong the moment W is cancelled — the path is
          // gone, or the engine refuses this write for good, and the
          // escalation would materialize the canonical Y.Doc back onto the
          // path the user just deleted. `settleOnRefusal: false` hands the
          // refusal back instead, which is what keeps the lease retryable
          // without ever writing.
          await held.close(
            writeCancelled
              ? { settle: false, settleOnRefusal: false }
              : { settle: false },
          );
          pendingRelease = null;
        };

        // Give up on W and say why — the user is the last one who can act on
        // this. L is untouched: the debt survives whenever a lease is still
        // held, so the ladder keeps retrying the release alone.
        //
        // The entry stays, marked stood-down, instead of being deleted
        // (#681): a stood-down debt refuses the rename instead of reading
        // as paid.
        const standDownFromWrite = (message: string): void => {
          writeCancelled = true;
          onError(`ydoc close retry of ${input.path}`, new Error(message));
          const debt = detachedLockedDebts.get(input.path);
          if (debt) debt.stoodDown = true;
          if (pendingRelease === null) return;
          armDetachedLockedRetry();
        };

        // The one stand-down a clean settle can earn. Named separately because
        // both discharge paths reach it and the user's next step is the same
        // from either.
        //
        // WHICH component is the symlink, the wire does not say: the engine
        // checks the ancestors AND the target file itself
        // (prepare_target_parent_symlink_free) and answers the same
        // `materialized: false` either way. So the instruction covers both.
        // Naming only the folder sent a user whose note.md IS the symlink to
        // replace it with a directory, which can never materialize.
        const standDownFromBlockedTarget = (): void =>
          standDownFromWrite(
            `locked-write retry stopped: the engine committed the settle but did not write ${input.path}. dohc does not write through symlinks, and either the file or a folder above it is one. The edits stay in the document's history. Replace the linked file with a real file, or the linked folder with a real folder. Then open ${input.path} to write it again.`,
          );

        // The one stand-down message both the registration door
        // (`scheduleDetachedLockedSettle`, below) and a retry's own consult
        // (`suppressSettleForRemoval`, next) report on the same tombstone
        // match — kept as one string so the two doors can never drift apart.
        const removalStandDownMessage = (tombstone: { expected: boolean }): string =>
          tombstone.expected
            ? `locked-write retry cancelled: dohc's own removal of ${input.path} removed the path while a pending write waited; the edits remain in the document lineage`
            : `locked-write retry cancelled: an external delete of ${input.path} removed the path while a pending write waited; the edits remain in the document lineage`;

        // `captureBatch`'s direct-arm door (codex P1-C follow-up, #746):
        // called at watcher-delivery time, bypassing the TTL-bounded
        // no-debt tombstone map entirely, so nothing here can expire before
        // a later-stage retry arrives to ask. The same age discrimination
        // `consumeRecentExternalDeleteWithNoDebt` applies still holds — a
        // session opened AFTER the delete is this path's later recreation,
        // not the incarnation the delete orphaned.
        const armRemovalSuppression = (expected: boolean, deletedAtMs: number): void => {
          if (writeCancelled || sessionOpenedAtMs >= deletedAtMs) return;
          standDownFromWrite(removalStandDownMessage({ expected }));
        };

        // A RETRY's own removal check (#746). `scheduleDetachedLockedSettle`
        // (below) is the debt-REGISTRATION door and asks this once, but two
        // ladders re-run a settle without ever passing back through it: this
        // debt's own payment retry (`settleForProof`) once armed, and the
        // separate close-retry ladder (`scheduleTransientCloseRetry`) that
        // owns the unreplicated shape and never registers a debt at all. A
        // delete landing after registration but before one of those retries
        // used to reach neither fence. Both ask HERE, at the last point
        // before their own write. `writeCancelled` makes the stand-down
        // sticky: once one retry stands down, every later retry short-circuits
        // without re-consuming or re-announcing the same tombstone.
        const suppressSettleForRemoval = (): boolean => {
          if (writeCancelled) return true;
          const tombstone = consumeRecentExternalDeleteWithNoDebt(
            input.path,
            sessionOpenedAtMs,
          );
          if (tombstone === null) return false;
          standDownFromWrite(removalStandDownMessage(tombstone));
          return true;
        };

        const payDetachedLockedDebt = async (): Promise<void> => {
          // Another edge may have paid, transferred, or CANCELLED this debt
          // after the timer's own check — a destructive vacate cancels
          // registry entries while a fired payment can already sit queued
          // behind it on the chain. The registry is the single owner record:
          // no longer named there means nothing left to do.
          if (detachedLockedDebts.get(input.path)?.pay !== payDetachedLockedDebt) {
            return;
          }
          if (stopped) {
            // A retained lease needs no release here: stop() closes the
            // store it belongs to, which drops every session lease with it.
            detachedLockedDebts.delete(input.path);
            return;
          }
          // A destructive operation is under way over this path and its disk
          // work has not reported yet (#663). Starting here settles a path
          // that is about to stop existing, and no later cancel can recall
          // the RPC. DEFER, do not stand down: the removal can still fail,
          // and the finisher is what decides between cancelling this debt and
          // restoring it.
          if (removalWindowFor(input.path) !== null) {
            armDetachedLockedRetry();
            return;
          }
          // WHERE a failure came from decides which obligation it answers: a
          // settle refusal answers W, a close refusal answers L. They share
          // one catch, and "terminal" means opposite things for the two — a
          // refused write must stop, a refused release must keep retrying —
          // so the settle's own failure is tagged here rather than guessed
          // at from the wire code alone.
          let settleFailure: unknown = null;
          // Answers whether the artifact MOVED. `materialized: false` has one
          // producer: the materialization job was BLOCKED because the target
          // file or one of its ancestors is a symlink (`JobOutcome::Blocked`
          // <- `MaterializeError::SymlinkTarget`). Waiting restores no
          // containment, so that answer belongs with the terminal settle
          // refusals rather than the transient ones this ladder exists to
          // outlast (#651).
          const settleForProof = async (
            session: WorkspaceEngineYDocProviderSession,
          ): Promise<boolean> => {
            // Snapshot BEFORE issuing: the projection is taken inside the
            // call, so an update delivered while it is in flight is already
            // outside what it carries. Erring wide costs one extra settle;
            // erring narrow loses the update entirely.
            const covers = updateSeq;
            // ASK AGAIN, at the last point where the answer still stops a
            // write. The check at the top of this payment is stale by now: a
            // payment runs on the capture chain, but the edges that CANCEL it
            // do not. A delete or move finisher runs OFF the chain, after its
            // disk work, so it can cancel while this payment is parked in an
            // awaited RPC — the version read, the open, the reconnect ladder.
            // Settling on that stale yes writes the path the user just removed
            // or moved away, which is the recreation every fence above exists
            // to prevent. `suppressSettleForRemoval` covers the same window
            // for a delete that landed AFTER registration passed with no
            // tombstone yet on record (#746). `suppressSettleForRemoval`
            // already opens with `if (writeCancelled) return true;`, side-
            // effect-free, so a separate `writeCancelled ||` guard here
            // would only duplicate that check.
            if (
              detachedLockedDebts.get(input.path)?.pay !== payDetachedLockedDebt ||
              suppressSettleForRemoval()
            ) {
              throw new DetachedPaymentCancelledError(input.path);
            }
            let result;
            try {
              result = await session.settleNow({ summary: "session close" });
            } catch (error) {
              settleFailure = error;
              throw error;
            }
            if (result.materialized) settleCovers = covers;
            return result.materialized;
          };
          try {
            if (writeCancelled) {
              // Only L is left. Never open a session here: the path this
              // debt names is gone, or its write is refused for good, and
              // reopening it would recreate what the user removed.
              await releaseRetainedSession();
              // This release proves the lease, not the write. A stood-down
              // debt's marker survives it (#681) — but a debt cancelled by
              // the delete/move seam (`discardDetachedLockedDebt`, no
              // marker) had only its lease left to finish: drop the entry
              // now, or it sits forever and a later rename onto this freed
              // path would read it as still locked.
              const debt = detachedLockedDebts.get(input.path);
              if (debt && !debt.stoodDown) {
                detachedLockedDebts.delete(input.path);
              }
              return;
            }
            const live = liveYDocSessions.get(input.path);
            if (live) {
              // A HANDOFF, not a hand-wave. Firing this
              // settle and dropping the debt took "a live session exists"
              // as proof the write would land: that settle can exhaust its
              // own reconnect retry, and the receiving generation never saw
              // the original lock refusal, so nothing there re-arms. Await
              // it — success IS this write landing, and a failure keeps the
              // debt (a still-held lock re-arms; anything else reports and
              // re-arms like every other unproven attempt).
              const materialized = await settleForProof(live.session);
              // Asked BEFORE the proof: a blocked target is a definite answer
              // about this write, and `settleCovers` can still hold an earlier
              // settle's yes.
              if (!materialized) {
                standDownFromBlockedTarget();
                return;
              }
              if (writeIsProven()) {
                detachedLockedDebts.delete(input.path);
                return;
              }
              // The handoff settled, but over a projection it did not carry.
              // Nothing is discharged; the next attempt settles the newer
              // state.
              armDetachedLockedRetry();
              return;
            }
            // The active-version read lives INSIDE the guarded block (#595
            // it can reject (the reconnect ladder exhausted, the
            // engine refusing the read), and rejecting outside left the debt
            // in the registry with no timer scheduled — stranded until an
            // unrelated lifecycle action or a restart. A failure here
            // re-arms like any other.
            const activeVersionId = await activeVersionIdOf(engine);
            if (activeVersionId !== versionId) {
              standDownFromWrite(
                `locked-write retry dropped: the workspace moved to version ${activeVersionId} while a pending write for version ${versionId} waited; the version fence replay owns pending writes across switches`,
              );
              return;
            }
            // A session whose release was REFUSED is still alive in the
            // daemon: ydoc_close_inner reinserts it and it
            // keeps its lease, so opening a FRESH session for this path is
            // answered ydoc-session-busy forever. Only that session can
            // finish its own release — retry its close before anything else.
            if (pendingRelease !== null) {
              await releaseRetainedSession();
              // L is discharged. W is NOT, and asking `writeIsProven()` here
              // would be a stored yes wearing a comparison's clothes:
              // `close()` unsubscribes from remote updates
              // BEFORE it asks the daemon to release, so a retained session
              // has been deaf since its first close. Its `updateSeq` is
              // frozen, so the comparison keeps answering yes over updates
              // the artifact never received. A retained settle is never
              // proof — re-arm, and let a fresh session settle what the
              // document holds now. One extra settle; never a lost update.
              armDetachedLockedRetry();
              return;
            }
            const { session: retrySession } =
              await openRestartSafeRustYDocSession({
                versionId,
                path: input.path,
                ...(input.contentKind
                  ? { contentKind: input.contentKind }
                  : {}),
                onDead: () => undefined,
                onAlive: () => undefined,
                onRemoteUpdate: () => {
                  // An update the settle did not carry is not covered by
                  // it. The close below cancels this update's debounce and
                  // sends settle: false, and a REPLICATED lineage compacts
                  // and releases without the local-only unsettled guard
                  // (durable.rs) — so the close succeeds over a projection
                  // that never reached Markdown. Bumping the sequence is
                  // the whole record: whether it outran a settle is
                  // decided by comparing it to what that settle covers.
                  updateSeq += 1;
                },
                onLineageReplaced: () => {
                  updateSeq += 1;
                },
                onSettleStart: () => undefined,
                onSettleError: () => undefined,
                onSettled: () => undefined,
              });
            let materialized: boolean;
            try {
              materialized = await settleForProof(retrySession);
            } finally {
              // The release is NOT suppressed: a replicated
              // update arriving between the settle and this release makes
              // `settle: false` escalate to a settling close, and that can
              // fail. Swallowing it dropped the debt while the daemon
              // session could stay reserved and the newest update had no
              // retry. The session is RETAINED for its own close retry
              // rather than discarded, because the daemon keeps
              // its lease when it refuses a release.
              try {
                await retrySession.close({ settle: false });
              } catch (closeError) {
                pendingRelease = retrySession;
                throw closeError;
              }
            }
            if (!materialized) {
              // Same order as the handoff above: a blocked target answers this
              // write before any proof is consulted.
              standDownFromBlockedTarget();
              return;
            }
            if (!writeIsProven()) {
              // The close returned Ok, but about a projection this settle
              // never carried. That is proof of the RELEASE, not of the
              // write — the debt stands and the next attempt settles the
              // newer state.
              armDetachedLockedRetry();
              return;
            }
            // PROOF: the write landed and the session released.
            detachedLockedDebts.delete(input.path);
          } catch (retryError) {
            if (retryError instanceof DetachedPaymentCancelledError) {
              // A destructive edge cancelled this debt mid-payment. It owns the
              // trace and the lease handback; this payment simply stops, and
              // must NOT re-arm — the registry no longer names it, and arming
              // would only schedule a timer that stands down.
              return;
            }
            if (
              isFileLockedCause(retryError) ||
              isRemoteUpdatesPendingCause(retryError)
            ) {
              armDetachedLockedRetry();
              return;
            }
            if (retryError === settleFailure && isTerminalRefusal(retryError)) {
              // TERMINAL, not transient — and it came from the SETTLE, so it
              // answers the write. The preimage no longer matches (the
              // external program EDITED the file before releasing its lock),
              // or materialization failed for good (the target turned
              // read-only, an ACL denies the replace). Polling that every 10
              // seconds reopened a session and logged the same error until
              // the workspace closed, and never told the user the one thing
              // they could act on. Give up on the write, keep the lease.
              //
              // The identity check is what keeps this narrow: a refused
              // RELEASE is terminal on the wire too, says nothing about the
              // write, and must keep retrying.
              standDownFromWrite(
                isConflictStaleTargetCause(retryError)
                  ? `locked-write retry stopped: ${input.path} changed outside dohc while another program held it, so the pending write no longer matches the file. The edits stay in the document's history — open ${input.path} to write them again.`
                  : `locked-write retry stopped: the engine cannot write ${input.path} (${String((retryError as Error).message)}). Retrying cannot change that. The edits stay in the document's history — open ${input.path} to write them again.`,
              );
              return;
            }
            // No proof either way — a failed release leaves the session
            // possibly reserved and the write possibly unlanded. Retain and
            // re-arm; the throw reports this attempt through the caller's
            // context without releasing the debt.
            armDetachedLockedRetry();
            throw retryError;
          }
        };
        const armDetachedLockedRetry = (): void => {
          if (stopped) return;
          // ONE debt, ONE timer. Every arming path can run
          // while a timer is already pending — a refused rename reaches
          // this through pay() while the original ladder still sleeps — and
          // stacking them gave each attempt its own independent ladder,
          // every one of which opens and settles a temporary session once
          // it reaches the cap. Replacing the pending timer keeps the work
          // proportional to the DEBT, not to how often something touched it.
          if (pendingRetryTimer !== null) clearTimeout(pendingRetryTimer);
          const delay = detachedRetryMs;
          detachedRetryMs = Math.min(detachedRetryMs * 2, TEARDOWN_RETRY_CAP_MS);
          pendingRetryTimer = setTimeout(() => {
            pendingRetryTimer = null;
            // Paid, transferred, or dropped by another edge while the timer
            // slept: the registry no longer names this routine — stand down.
            if (detachedLockedDebts.get(input.path)?.pay !== payDetachedLockedDebt) {
              return;
            }
            enqueue(`ydoc close retry of ${input.path}`, payDetachedLockedDebt);
          }, delay);
        };
        // Discarding a debt cancels W. It does NOT cancel L: a retained
        // retry session is a live daemon lease on this path, and the caller
        // that discards knows only that the path went away.
        const discardDetachedLockedDebt = async (): Promise<void> => {
          writeCancelled = true;
          if (pendingRetryTimer !== null) {
            clearTimeout(pendingRetryTimer);
            pendingRetryTimer = null;
          }
          if (pendingRelease === null) return;
          try {
            await releaseRetainedSession();
          } catch (error) {
            // The daemon refused the release again, and the discarding
            // caller only logs. Hand the lease BACK to the registry —
            // cancelled for the write, alive for the release — so the one
            // ladder keeps trying it. Dropping it here is exactly what
            // leaves the path at ydoc-session-busy until a daemon restart.
            scheduleDetachedLockedSettle();
            throw error;
          }
        };
        // The registration door (#681 round 7, codex P1). A close can reach
        // here two ways: directly, when a release SUCCEEDS over a failed
        // settle (this debt is fresh — `writeCancelled` is still false);
        // or off the chain, after a transient close retry ladder that runs
        // for as long as TEARDOWN_RETRY_CAP_MS allows — seconds wide in
        // production, unlike the delete/move seams #697 already fences on
        // the chain. `discardDetachedLockedDebt`'s own re-registration
        // (`writeCancelled` already true) is release-only by then — no
        // write is left to resurrect anything, so it always registers.
        //
        // A FRESH debt is different: its ladder can reopen the canonical
        // Y.Doc and settle it back to disk, recreating a file an external
        // delete removed anywhere in that window. `cleanupDetachedDebtForEvent`
        // cannot have cleaned up a debt that did not exist yet when the
        // delete's watcher event ran, but it DOES remember the path
        // (`noteExternalDeleteWithNoDebt`) — consuming that memory here,
        // at the door, is what cancels this write with the same trace the
        // watcher's own cleanup uses, instead of arming a ladder that
        // would resurrect the file (or, if it later stood down instead,
        // strand a marker blocking an unrelated file recreated at this
        // path). A raw disk stat cannot stand in for this: an absent path
        // means "deleted" and "never written yet" identically, and most
        // pending writes ARE their document's first materialization.
        //
        // THIS session's own age is what keeps that memory from also
        // cancelling a path's later RECREATION (#681 round 8, codex P1 —
        // a same-round attempt to invalidate the memory on any recreation
        // was reverted once the certifier's S2(b) named the corruption it
        // opened: an OLD session can still be mid-retry-ladder when a
        // DIFFERENT session recreates the path, and invalidating on the
        // recreation event alone would let the OLD session's late debt
        // arm and settle its stale canonical doc OVER the new file).
        // `consumeRecentExternalDeleteWithNoDebt` only matches a session
        // that opened BEFORE the recorded delete — the incarnation that
        // deletion actually orphaned. A session opened AFTER it (this
        // path's recreation, or any fresh open past that point) reads no
        // match here and registers normally: its content is not what the
        // deletion removed.
        //
        // BEST-EFFORT, not a fence: the watcher's own memory expires
        // (`EXPECTED_ENGINE_EVENT_EXPIRY_MS`), and a delete landing after
        // that window, or after this door already registered, is not
        // caught here — `cleanupDetachedDebtForEvent` remains the
        // authoritative door for those.
        const scheduleDetachedLockedSettle = (): void => {
          if (stopped) return;
          const tombstone = writeCancelled
            ? null
            : consumeRecentExternalDeleteWithNoDebt(input.path, sessionOpenedAtMs);
          if (tombstone !== null) {
            onError(
              `ydoc close retry of ${input.path}`,
              new Error(removalStandDownMessage(tombstone)),
            );
            return;
          }
          detachedLockedDebts.set(input.path, {
            pay: payDetachedLockedDebt,
            arm: armDetachedLockedRetry,
            discard: discardDetachedLockedDebt,
            stoodDown: false,
          });
          armDetachedLockedRetry();
        };
        // A close whose settle met the transient lock keeps a debt nobody
        // else will pay (#595): the renderer forgets the session on a failed
        // close, and the durably pending write would sit until restart. The
        // ENTRY outlives the renderer, so the capture layer retries the
        // teardown on a doubling delay until the lock releases — each retry
        // re-runs the pre-close settle — or a non-lock failure says retrying
        // cannot help. A paid debt removes the entry, which disarms this.
        let transientCloseRetryMs = TEARDOWN_RETRY_INITIAL_MS;
        let transientCloseRetryTimer: ReturnType<typeof setTimeout> | null = null;
        const scheduleTransientCloseRetry = (
          error: unknown,
          opts?: WorkspaceEngineYDocCloseOptions,
        ): void => {
          if (!isTransientEngineCause(error) || transientCloseRetryTimer !== null)
            return;
          if (stopped || liveYDocSessions.get(input.path) !== entry) return;
          const delay = transientCloseRetryMs;
          transientCloseRetryMs = Math.min(
            transientCloseRetryMs * 2,
            TEARDOWN_RETRY_CAP_MS,
          );
          transientCloseRetryTimer = setTimeout(() => {
            transientCloseRetryTimer = null;
            if (stopped || liveYDocSessions.get(input.path) !== entry) return;
            // THIS retry's own removal check (#746). No debt is ever
            // registered for this ladder, so nothing else asks whether the
            // file this retry is about to write was deleted since the last
            // attempt. Ask here, at the last point before the retry's own
            // settle — the FIRST attempt (above, not this timer) keeps
            // asking nothing, exactly as before, so a settle refusal it
            // meets still produces the same failure the registration door
            // downstream depends on.
            //
            // ALWAYS asked, even when this retry's own opts already carry
            // `settle: false` (codex P1-A): that option is a preference, not
            // a promise — a release the daemon refuses still ESCALATES to a
            // settling close unless `settleOnRefusal: false` comes with it
            // (ydocProviderSession.ts) — so a caller's own settle:false does
            // not retire the resurrection risk this check exists to catch.
            const retryOpts: WorkspaceEngineYDocCloseOptions | undefined =
              suppressSettleForRemoval()
                ? { ...opts, settle: false, settleOnRefusal: false }
                : opts;
            void closeEntry(retryOpts).catch((retryError: unknown) => {
              if (isTransientEngineCause(retryError)) {
                // `retryOpts`, not the outer `opts`: a suppressed retry's
                // forced `settle: false, settleOnRefusal: false` must carry
                // into whichever call ends up arming the next attempt.
                scheduleTransientCloseRetry(retryError, retryOpts);
                return;
              }
              // A non-lock failure is new information: the debt cannot be
              // paid by waiting, and nobody upstream is listening anymore.
              onError(`ydoc close retry of ${input.path}`, retryError);
            });
          }, delay);
        };
        // The close was REFUSED and an evict discharged it instead. Only the
        // absent-head refusals below read it, and what it tells them is that
        // the lineage holds content: the daemon refuses a prune-close for no
        // other reason (#665).
        let dischargedByEvict = false;
        const closeEntry = async (
          opts?: WorkspaceEngineYDocCloseOptions,
        ): Promise<void> => {
          // THE ORPHAN'S POLICY, and it belongs to the ORPHAN rather than to
          // each caller. An orphan is a session no caller ever received: its
          // doc was seeded from neither a head nor a snapshot, so it holds
          // nothing of the user's, and settling it writes what replication
          // delivered OVER disk bytes the watcher has not captured yet.
          //
          // Two rounds fixed that at two call sites — the first release, then
          // the discharge — and a third was still escalating: the lifecycle
          // sweep a version switch, merge, rename or delete reaches. Three
          // sites is a class, so the rule moved here. Every present and
          // future caller inherits it, and a caller asking to settle an
          // orphan is asking for the one write that is never correct
          // (#564, codex r21).
          const effective: WorkspaceEngineYDocCloseOptions | undefined =
            liveEntry.orphaned
              ? { ...opts, settle: false, settleOnRefusal: false }
              : opts;
          try {
            await session.close(effective);
          } catch (error) {
            // THE ORPHAN'S THIRD EXIT (#665). It may not settle — the rule
            // above — and its prune-close refuses while no artifact holds its
            // CRDT's bytes. On a policy-excluded path, or a file over the
            // MAX_TEXT_BYTES capture limit, no capture will ever mint that artifact,
            // so the refused close's reinserted lease answered every later
            // open with `ydoc-session-busy` until the daemon restarted.
            //
            // An evict writes nothing and discards nothing: the daemon lets go
            // of the session and keeps the lineage, so the next open
            // resurrects this document's edits.
            //
            // An orphan, OR a write this session already cancelled for good
            // (codex P1-B on #746): a suppressed close-retry forces the same
            // `settleOnRefusal: false` an orphan's release uses, and can meet
            // the same dirty-session refusal — but `writeCancelled` means no
            // caller is ever getting a materialized write from this session
            // again, so leaving it to strand the lease busy until restart is
            // strictly worse than discharging it the orphan's way. A session
            // someone still HOLDS with an OPEN write is converged by its
            // holder instead. And only a TERMINAL refusal either way: a busy
            // store or a spent budget is waited out by the ladders that
            // already exist.
            if (
              (liveEntry.orphaned || writeCancelled) &&
              isYdocUnsettledCloseRefusal(error)
            ) {
              try {
                await session.evict();
                dischargedByEvict = true;
                if (liveYDocSessions.get(input.path) === liveEntry) {
                  liveYDocSessions.delete(input.path);
                }
                return;
              } catch (evictError) {
                // The daemon kept the session, so the retain below is still
                // the honest outcome. Report the eviction failure, because it
                // is the reason this path stays reserved.
                onError(`ydoc evict of ${input.path}`, evictError);
              }
            }
            if (error instanceof YdocReleasedWithSettleFailureError) {
              // A transient settle failure under a SUCCEEDED release is the
              // replicated shape: this error is the last time anyone hears
              // about the unsettled document, so arm the detached debt BEFORE
              // the entry goes away.
              //
              // Either blocker qualifies, because the debt is paid by
              // SETTLING and by the time this error exists the engine holds
              // the text either way: a file lock leaves the write durably
              // pending, and a busy store that had left text UNSENT refuses
              // the release rather than reaching here (ydocProviderSession
              // `close`). So the settle a payment runs can only be missing the
              // artifact, never the content.
              if (isTransientEngineCause(error.cause)) {
                scheduleDetachedLockedSettle();
              }
              // The daemon session and its lease ARE gone — only the settle
              // failed. Lift the guard like a clean teardown (capture of the
              // path must resume; nothing holds the reservation).
              if (liveYDocSessions.get(input.path) === liveEntry) {
                liveYDocSessions.delete(input.path);
              }
              // #496: the settle met a head the daemon's capture had already
              // moved — an edit made outside dohc, ingested before this close.
              //
              // THIS error, not the refusal, is what makes that benign. The
              // refusal alone proves nothing: the release that follows it can
              // refuse too (`UnsettledClose`, when the CRDT projection no
              // longer matches `last_settled_sha` —
              // crates/dohc-engine-collab/src/durable.rs), and the daemon then
              // REINSERTS the session entry (crates/dohc-workspace-engine/
              // src/lib.rs, ydoc_close_inner) — the doc stays reserved, live,
              // and unsaved. The provider throws this error only after the
              // release completed, so it is the one signal that the session is
              // gone and the settle was the only casualty.
              //
              // Being a close is structural — the provider constructs this
              // error nowhere else — and the token is looked up from the exact
              // failure this close carries, so the correction can never
              // withdraw a DIFFERENT failure's `error`.
              //
              // The refusal itself is not enough to name the outcome, because
              // it does not mean what the state would claim. `changed-on-disk`
              // makes two assertions to the user, and each needs its own proof:
              //
              //  1. "your text is safe in History" — every update this document
              //     received is in a committed settle. A release cannot stand
              //     in for this: it proves settlement only for a local-only
              //     PRUNE, while a replicated lineage compacts and releases
              //     cleanly over unsettled text.
              //  2. "the file changed outside dohc" — the file does NOT hold
              //     this document's last settled bytes. The engine raises
              //     ConflictStaleTarget for any divergence of the HEAD, which
              //     includes a path rebound to another object and a settle
              //     whose materialization was blocked or superseded
              //     (crates/dohc-engine-runtime/src/actor.rs) — cases where the
              //     durable head moved while the disk still holds our own
              //     bytes. So read the file, exactly as the ordinary settled
              //     path does.
              //
              // Fail either proof and the close stays loud, which is where this
              // correction started.
              const failedToken =
                typeof error.cause === "object" && error.cause !== null
                  ? settleFailureTokens.get(error.cause)
                  : undefined;
              if (
                failedToken !== undefined &&
                isConflictStaleTargetRefusal(error.cause) &&
                updatesSeen === updatesSettled &&
                lastSettledSha !== null &&
                (await fileDriftedFromSettled(lastSettledSha))
              ) {
                reportSaveState("changed-on-disk", failedToken);
                return;
              }
              throw error;
            }
            // The reservation may still be held and the on-disk state is
            // indeterminate — retain a failing-close guard so a retry/force-close
            // can complete the teardown, and DO NOT swallow (data-integrity
            // teardown). captureOnePath keeps deferring this path meanwhile.
            if (liveYDocSessions.get(input.path) === liveEntry) {
              liveEntry.status = "failing-close";
              scheduleTransientCloseRetry(error, opts);
            }
            throw error;
          }
          // Lift the guard exactly when the session tears down (releasing the
          // single-canonical reservation), so ordinary capture of this path
          // resumes for the next opener / external editor.
          if (liveYDocSessions.get(input.path) === liveEntry) {
            liveYDocSessions.delete(input.path);
          }
        };
        const liveEntry: LiveYDocSession = {
          path: input.path,
          versionId,
          session,
          status: "live",
          orphaned: false,
          close: closeEntry,
          armRemovalSuppression,
        };
        entry = liveEntry;
        // A session whose release FAILED is still the daemon's: a refused
        // close reinserts its entry with the lease held (ydoc_close_inner).
        // Retaining it here is what makes it reachable — by a version op,
        // by the path-scoped settle-and-close, and by the next open of this
        // path, which discharges it before binding.
        const retainUnreleased = (): void => {
          const registered = liveYDocSessions.get(input.path);
          if (registered === liveEntry) {
            liveEntry.status = "failing-close";
            return;
          }
          // Registered under nothing: this entry was never handed out, so it
          // exists only to keep the unreleased session reachable. A path some
          // LATER open owns is left alone — its entry is what teardown must
          // find — and a released session is not resurrected.
          if (registered === undefined && liveEntry.orphaned) {
            liveEntry.status = "failing-close";
            liveYDocSessions.set(input.path, liveEntry);
          }
        };
        // ABSENT-HEAD CONTRACT (stated on WorkspaceEngineCapture.openYDocSession).
        // Both absent means the daemon bound an EMPTY doc over nothing. A
        // lineage without a head is the crash-orphaned draft the daemon
        // resurrects: it holds the user's only copy of those edits, and a
        // settle:false close of that dirty lineage would be refused and strand
        // the lease. Read here, on the capture chain, so no version op can land
        // between the version binding above and this check.
        if (head === "absent") {
          const disk = await absentHeadDiskState(rootPath, input.path);
          // THREE RULES, IN THIS ORDER. They used to be tangled into one
          // condition, and the order is the whole correctness argument:
          //
          //  1. Content on disk always refuses a fresh bind. A resurrected
          //     lineage refuses only where capture can eventually reach it.
          //  2. An update that reached the session means the document exists
          //     here: a peer is replicating it into this version, so refusing
          //     "not in this version" would be false. Bind it.
          //  3. Nothing on disk, nothing replicated: the path is not in this
          //     version. Refuse — and release without ever settling.
          //
          // The ADMIT paths (1's inverse, and 2) deliberately do not recheck
          // the artifact after deciding to admit. Rule 2's admit is
          // straight-line to the registration below — no window there. Rule
          // 1's inverse is not: `captureWillReachPath` below reads the
          // policy and the disk again, so a writer can land inside that
          // read. That window, and the open-ended one after admission (a
          // writer that fills the file once this call has already
          // returned), are both bounded the same way: the settle refuses to
          // materialize over a file that drifted from what it settled
          // (digestSettledFile here, the materialized-sha comparison in
          // actor.rs). Before this change the open admitted every
          // absent-head bind unconditionally, so these rules only ever
          // narrow that surface.
          // Both rules below release the session and then describe the DISK.
          // A release the BUDGET refused describes neither: nothing was
          // released, the daemon still holds the restart-safe session, and a
          // disk verdict is one main answers with a plain `available:false` —
          // the writable plain editor, over a live session (#533/#567's
          // double writer). The deadline keeps its own classification, which
          // main answers with `engineMayHoldDocument` (#564, codex r13).
          const releaseOrRefuse = async (): Promise<void> => {
            // Marked BEFORE the release, not after: no caller receives this
            // wrapper either way, and marking first is what puts this close
            // under the orphan's own never-settle policy instead of spelling
            // it out here (#564, codex r21).
            liveEntry.orphaned = true;
            try {
              await liveEntry.close({ settle: false });
            } catch (releaseError) {
              // Whatever refused it, this session is still the daemon's, and
              // the refusal below is the LAST reference to it. Retain it, or
              // the session keeps its lease and every later open of this path
              // answers ydoc-session-busy with nothing left to close it
              // (#564, codex r14).
              retainUnreleased();
              // The BUDGET's own refusals keep their identity — an agent
              // reading the message needs the limit that fired. Everything
              // else becomes the one refusal that is true of all of them:
              // this session is still the daemon's.
              if (isEngineWorkspaceOpenRefusedError(releaseError)) {
                throw releaseError;
              }
              throw new YDocSessionUnreleasedError(input.path, releaseError);
            }
          };
          if (disk === "content") {
            const captureWillReachPath =
              lineage === "existing" &&
              policyTracksPath(input.path, await readPolicyForTask()) &&
              (await readDiskTextState(rootPath, input.path)).kind !== "untracked-content";
            if (lineage === "absent" || captureWillReachPath) {
              await releaseOrRefuse();
              throw new YDocUncapturedArtifactError(input.path);
            }
          }
          if (lineage === "absent" && disk === "missing" && updatesSeen === 0) {
            // The count cannot be read atomically with the release: the close
            // defers through the operation chain, so its provider has not
            // unsubscribed at this line and an update can still arrive before
            // the close reaches the daemon. `settleOnRefusal: false` is what
            // makes that survivable — without it the daemon's UnsettledClose,
            // which means exactly "content arrived after all", escalates to a
            // SETTLING close and materializes the path this code is about to
            // call missing.
            // A refused release means an update won the gap — the daemon is
            // saying the lineage is dirty — and `releaseOrRefuse` has already
            // turned that into the unreleased refusal, which is the honest
            // one: nothing here may claim the path is missing while something
            // is writing it.
            await releaseOrRefuse();
            // A discharge that needed an EVICT was refused first, and the
            // prune-close refuses for one reason: the lineage holds content.
            // The eviction released the lease, so this is no longer the
            // unreleased refusal — but the path is still one something is
            // writing, and calling it missing would be as false as before
            // (#665).
            if (dischargedByEvict) {
              throw new YDocOpenRacedError(input.path);
            }
            // RECHECKED immediately before the claim. The release above
            // awaited a daemon round trip, and this chain serializes engine
            // work, not the filesystem — an agent or an external editor can
            // create the path inside that window, and the queued watcher then
            // captures a file we just told the user does not exist.
            //
            // This NARROWS, it does not close: a writer can always land one
            // tick after any recheck. It is here because this is the one
            // terminal decision that makes a user-facing STATEMENT, and a
            // false one is worth a second syscall. The admit paths take no
            // recheck deliberately — see the note below.
            if ((await absentHeadDiskState(rootPath, input.path)) === "missing") {
              throw new YDocPathNotInVersionError(input.path, versionId);
            }
            throw new YDocOpenRacedError(input.path);
          }
        }
        // Registered only after the open succeeds: a secret, already-live or
        // path-not-in-version rejection propagates to the caller and never
        // guards a path that has no session. The absent-head refusals above
        // register it themselves when their release FAILS, because the daemon
        // keeps that session and something must still be able to close it.
        liveYDocSessions.set(input.path, liveEntry);
        return {
          get doc() {
            return session.doc;
          },
          initialUpdate: session.initialUpdate,
          ...(session.objectId ? { objectId: session.objectId } : {}),
          ...(session.versionId ? { versionId: session.versionId } : {}),
          get lineageClaimId() {
            return session.lineageClaimId;
          },
          contentKind: session.contentKind,
          get artifactAssets() {
            return session.artifactAssets ?? [];
          },
          path: session.path,
          async readArtifactAsset(descriptor) {
            const bytes = await engine.readBinaryBlob({
              workspaceId,
              sha256: descriptor.sha256,
            });
            if (!bytes) {
              throw new Error(
                `Artifact asset ${descriptor.id} is missing from version ${versionId}. Open the file again after sync finishes.`,
              );
            }
            const actualSha256 = sha256Bytes(bytes);
            if (actualSha256 !== descriptor.sha256) {
              throw new Error(
                `Artifact asset ${descriptor.id} failed its SHA-256 check. Open the file again after sync finishes.`,
              );
            }
            return { descriptor, bytes };
          },
          // TWO counters ride this call, and they are not the same count.
          // `noteUpdate` is the CLOSE counter (#496): it asks whether every
          // update is covered by a settle, counts here at hand-over, and
          // over-counts on purpose — over-counting only costs loudness.
          // `onArmed` is the SAVE counter (#514): it asks which edits a
          // settle may vouch for, so it must fire at the moment a settle
          // carrying this update is ARMED, deeper in and later. Merging them
          // would break one or the other.
          applyLocalUpdate: (update, onArmed) => {
            noteUpdate();
            return session.applyLocalUpdate(update, onArmed);
          },
          settleNow: (opts) => session.settleNow(opts),
          applyExternalMarkdownEdit: (markdown) => {
            noteUpdate();
            return session.applyExternalMarkdownEdit(markdown);
          },
          close: closeEntry,
        };
      }
    },

    settleAndCloseLiveSessionsForPath(pathOrPrefix) {
      // Public seam for destructive ops that DON'T run through the capture chain
      // themselves (the delete IPC deletes on disk directly). Enqueued so it is
      // ordered against pending capture batches and version ops. Flushes +
      // releases every live session at OR under the path so no stale settle can
      // resurrect a deleted file / orphan the object afterward.
      //
      // Detached locked-write debts under the path are SUSPENDED, not
      // cancelled: the caller has only attempted the removal
      // yet, and the same handle that blocks the write can block the OS
      // trash and the workspace-trash fallback too. The returned finisher
      // takes the outcome — `true` cancels with a trace (the path is gone;
      // a later payment would recreate it), `false` restores and re-arms
      // (the path is still there and still owes its write).
      const match = (p: string) =>
        p === pathOrPrefix || p.startsWith(`${pathOrPrefix}/`);
      return enqueueResult("close live session for destructive op", async () => {
        await settleAndCloseLiveYDocSessions(
          match,
          "Saved latest edits before removing the file",
        );
        const suspended = suspendDetachedDebts(match);
        // Held from here until the finisher reports the outcome, so a debt
        // registered inside the window cannot settle the path mid-delete
        // (#663). Nothing after this line can throw, so the finisher is the
        // only closer this seam needs.
        const closeRemovalWindow = openRemovalWindow({
          match,
          operation: "delete",
          inProgress: `dohc is still deleting ${pathOrPrefix}.`,
        });
        // Closed LAST. Both branches below are synchronous and append nothing
        // to the chain, so no task can observe a half-decided outcome — but
        // the rule is the same one the move seam needs, and stating it once is
        // cheaper than re-deriving it per seam.
        return (removed: boolean) => {
          if (removed) {
            // RESCAN — the snapshot is not the whole set. The disk delete
            // runs OFF the capture chain, so an open of this path can land on
            // the chain while it is in flight, meet the lock, and register a
            // NEW debt. Cancelling only what was suspended leaves that one
            // armed, and its ladder reopens the path the user just deleted.
            cancelSuspendedDebts(
              [...suspended, ...suspendDetachedDebts(match)],
              `a delete of ${pathOrPrefix}`,
            );
          } else {
            restoreSuspendedDebts(suspended);
          }
          closeRemovalWindow();
        };
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

    compareVersions(sourceVersionId, compareOptions) {
      const targetVersionId =
        compareOptions?.targetVersionId ?? ENGINE_MAIN_VERSION_ID;
      const afterPath = compareOptions?.afterPath;
      return enqueueResult("compare versions", async () => {
        const policy = await readPolicyForTask();
        const engine = await engineStore();
        // Capture the latest disk edits first so the comparison reflects what
        // the user actually sees in the folder. Only the FIRST page captures:
        // a later page continues the same comparison, and re-capturing under
        // it could move the cursor's ground truth mid-walk.
        if (afterPath === undefined) {
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
        }
        const textPage = await compareVersionFilesPage(engine, {
          workspaceId,
          sourceVersionId,
          targetVersionId,
          ...(afterPath !== undefined ? { afterPath } : {}),
        });
        // Protected rows (PR 08): secret files report path + status ONLY —
        // "Protected file changed", never contents, never diffs. ONE engine
        // page of them (#562): both sources page by path, and the merged page
        // ends at the SMALLER of the two continuations, so one cursor resumes
        // both. Rows past that boundary are re-fetched by the next page —
        // dropped here, never lost.
        const secretPage = await secretComparePage(
          targetVersionId,
          sourceVersionId,
          afterPath,
        );
        const textNext = textPage.nextAfterPath;
        const secretNext = secretPage.nextAfterPath;
        const boundary =
          textNext !== null && secretNext !== null
            ? compareEnginePaths(textNext, secretNext) <= 0
              ? textNext
              : secretNext
            : (textNext ?? secretNext);
        // Every boundary comparison is in the ENGINE's path order (UTF-8
        // bytes = code points). A UTF-16 `<` here can drop a non-BMP path at
        // the boundary — or emit it twice, once per page.
        const inWindow = (path: string): boolean =>
          boundary === null || compareEnginePaths(path, boundary) <= 0;
        const files = [
          ...textPage.files.filter((change) => inWindow(change.path)),
          ...secretPage.entries
            .filter((change) => inWindow(change.path))
            .map(
              (change): VersionFileChange => ({
                path: change.path,
                status: change.status,
                protected: true,
              }),
            ),
        ].sort((a, b) => compareEnginePaths(a.path, b.path));
        return { files, nextAfterPath: boundary };
      });
    },

    compareVersionsChangedCount(sourceVersionId) {
      return enqueueResult("count changed files", async () => {
        const engine = await engineStore();
        if (options.daemonOwnsCapture) {
          await engine.flushCapture?.();
        }
        let count = 0;
        let afterPath: string | undefined;
        do {
          const page = await engine.compareVersionFilesPage({
            workspaceId,
            sourceVersionId,
            targetVersionId: ENGINE_MAIN_VERSION_ID,
            ...(afterPath !== undefined ? { afterPath } : {}),
          });
          count += page.entries.length;
          afterPath = page.nextAfterPath ?? undefined;
        } while (afterPath !== undefined);
        let secretAfterPath: string | undefined;
        do {
          const page = await secretStoreFor().compareSecretFileVersions({
            workspaceId,
            targetVersionId: ENGINE_MAIN_VERSION_ID,
            sourceVersionId,
            ...(secretAfterPath !== undefined
              ? { afterPath: secretAfterPath }
              : {}),
          });
          count += page.entries.length;
          secretAfterPath = page.nextAfterPath ?? undefined;
        } while (secretAfterPath !== undefined);
        return count;
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
        // base/current/incoming when it conflicts). The differing paths come
        // from the engine's metadata listing, one page at a time — the walk
        // needs paths, never text bodies (#562).
        const changedPaths: string[] = [];
        {
          let afterPath: string | undefined;
          do {
            const page = await engine.compareVersionFilesPage({
              workspaceId,
              sourceVersionId,
              targetVersionId: ENGINE_MAIN_VERSION_ID,
              ...(afterPath !== undefined ? { afterPath } : {}),
            });
            changedPaths.push(...page.entries.map((entry) => entry.path));
            afterPath = page.nextAfterPath ?? undefined;
          } while (afterPath !== undefined);
        }
        // Re-running the merge RESUMES: a path that already has an open
        // conflict for this version pair re-surfaces that conflict instead of
        // recording a duplicate. Only the paths are retained from the walk.
        const openConflictPaths = new Set<string>();
        {
          let afterConflictId: string | undefined;
          do {
            const page = await engine.listTextConflicts({
              workspaceId,
              status: "open",
              // Paths only, like the compare walk above. Hydrating here would
              // fetch every withheld body of every open conflict and keep none.
              bodies: "withheld",
              ...(afterConflictId !== undefined ? { afterConflictId } : {}),
            });
            for (const conflict of page.conflicts) {
              if (
                conflict.sourceVersionId === sourceVersionId &&
                conflict.targetVersionId === ENGINE_MAIN_VERSION_ID
              ) {
                openConflictPaths.add(conflict.path);
              }
            }
            afterConflictId = page.nextAfterConflictId ?? undefined;
          } while (afterConflictId !== undefined);
        }
        const materializations: MaterializeOperation[] = [];
        let conflictCount = 0;
        let mergedFileCount = 0;
        let unchangedFileCount = 0;
        for (const path of changedPaths) {
          if (openConflictPaths.has(path)) {
            conflictCount += 1;
            continue;
          }
          const result = await engine.mergeTextFileFromVersion({
            workspaceId,
            targetVersionId: ENGINE_MAIN_VERSION_ID,
            sourceVersionId,
            path,
            metadata,
          });
          if (result.kind === "unchanged") {
            unchangedFileCount += 1;
            continue;
          }
          if (result.kind === "conflict") {
            conflictCount += 1;
            continue;
          }
          mergedFileCount += 1;
          if (!options.daemonOwnsCapture) {
            if (result.operation === "write") {
              materializations.push(
                await materializeWriteForSnapshot(engine, result.write.snapshot),
              );
            } else {
              materializations.push({ kind: "delete", path });
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
        const secretChanges: SecretFileComparePage["entries"] = [];
        {
          let secretAfterPath: string | undefined;
          do {
            const page = await secrets.compareSecretFileVersions({
              workspaceId,
              targetVersionId: ENGINE_MAIN_VERSION_ID,
              sourceVersionId,
              ...(secretAfterPath !== undefined
                ? { afterPath: secretAfterPath }
                : {}),
            });
            secretChanges.push(...page.entries);
            secretAfterPath = page.nextAfterPath ?? undefined;
          } while (secretAfterPath !== undefined);
        }
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
        return { mergedFileCount, unchangedFileCount, conflictCount };
      });
    },

    async listOpenConflictsPage(afterConflictId) {
      const engine = await engineStore();
      return engine.listTextConflicts({
        workspaceId,
        status: "open",
        ...(afterConflictId !== undefined ? { afterConflictId } : {}),
      });
    },

    async countOpenConflicts() {
      const engine = await engineStore();
      let count = 0;
      let afterConflictId: string | undefined;
      do {
        const page = await engine.listTextConflicts({
          workspaceId,
          status: "open",
          // Count only. Do not fetch conflict bodies that the caller will not use.
          bodies: "withheld",
          ...(afterConflictId !== undefined ? { afterConflictId } : {}),
        });
        count += page.conflicts.length;
        afterConflictId = page.nextAfterConflictId ?? undefined;
      } while (afterConflictId !== undefined);
      return count;
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
          } else if (
            result.conflict.chosenFrom === "incoming" &&
            result.conflict.incoming.contentKind === "binary"
          ) {
            // Binary bytes never ride in a resolve result, so the engine
            // reports no write. Read back the head the resolution wrote and
            // mirror it, or the folder keeps the losing side's bytes.
            const head = await engine.readTextFile({
              workspaceId,
              versionId: result.conflict.targetVersionId,
              path: result.conflict.path,
            });
            if (!head) {
              // Going quiet here would leave the folder on the LOSING bytes
              // while the engine reports the conflict resolved. This message
              // reaches the conflict panel, so it stays in the user's nouns;
              // the precise state goes on the cause, for the log.
              throw new Error(
                `dohc could not keep the copy you chose for ${result.conflict.path}. The folder still has the other copy. Open the merge again and choose once more.`,
                {
                  cause: new Error(
                    `resolved conflict ${result.conflict.id} has no head at ${result.conflict.path} in ${result.conflict.targetVersionId}`,
                  ),
                },
              );
            }
            await materialize(
              [await materializeWriteForSnapshot(engine, head)],
              policy,
            );
          }
        }
        const remaining = await engine.listTextConflicts({
          workspaceId,
          status: "open",
        });
        return {
          conflict: result.conflict,
          remaining: {
            conflicts: remaining.conflicts,
            nextAfterConflictId: remaining.nextAfterConflictId,
          },
        };
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
      // (oldest-text-moment, previous-page-cursor-moment] so pages never
      // duplicate or drop a protected row. The secret timeline is short by
      // nature (.env edits are rare), so it is read whole per page.
      //
      // The OPEN end is the older one, because a tie can outlast a page: one
      // reconcile pass can stamp more text moments with a millisecond than a
      // page holds, and the shell appends each later page. Holding a tied
      // protected moment back until the page where the tie group ends keeps
      // text before protected across the assembled timeline, not just inside
      // one page. The last page's lower bound is -Infinity, so nothing is
      // held back forever.
      let upperMs = Number.POSITIVE_INFINITY;
      if (input.beforeMomentOrder !== undefined) {
        // The cursor is the previous page's oldest text moment; its
        // timestamp bounds this page's window from above (inclusive).
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
          (moment) => moment.recordedAtMs > lowerMs && moment.recordedAtMs <= upperMs,
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
      // Merge newest-first on a stated total order, because ties are the
      // daemon's normal regime: one reconcile pass stamps every moment it
      // produces with the same wall clock, and the two timelines' orders come
      // from independent counters, so time alone cannot rank them. The rule:
      // newer recordedAtMs first, then text before protected, then higher
      // momentOrder (a counter each store keeps for itself, so it ranks only
      // moments of the same kind), then lower id. The renderer shows this
      // order as given, so it is what the user reads.
      const merged = [...textMoments, ...protectedInWindow].sort((a, b) => {
        if (a.recordedAtMs !== b.recordedAtMs) {
          return b.recordedAtMs - a.recordedAtMs;
        }
        if (a.protected !== b.protected) return a.protected ? 1 : -1;
        if (a.momentOrder !== b.momentOrder) return b.momentOrder - a.momentOrder;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
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
        const observedBytes = Buffer.byteLength(input.text, "utf8");
        if (observedBytes > MAX_DESKTOP_CAPTURE_TEXT_BYTES) {
          throw new Error(
            `Generated Markdown exceeds the in-band write limit: limit ${MAX_DESKTOP_CAPTURE_TEXT_BYTES} bytes, observed ${observedBytes} bytes: ${path}.`,
          );
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
      // Held from the vacate until the finisher reports the outcome, so a debt
      // registered inside the window cannot settle an endpoint mid-move
      // (#663). Opened after the drain below, never before: the drain's own
      // payment is the one payment this move NEEDS to land.
      let closeRemovalWindow: () => void = () => undefined;
      return enqueueResult("prepare rename", async () => {
        // PREFIX, not just exact endpoint: this method also serves directory
        // moves, so a live session or a detached debt for `dir/note.md`
        // rides a move of `dir`. Left unvacated/undrained, either can
        // materialize or reopen the moved-away child path mid-move — #738,
        // the same prefix rule the delete seam already applies to its own
        // path. Both the vacate right below and the debt drain further down
        // share this one match.
        const isSourceSide = (candidate: string): boolean =>
          candidate === fromPath || candidate.startsWith(`${fromPath}/`);
        const endpointMatch = (candidate: string): boolean =>
          isSourceSide(candidate) ||
          candidate === toPath ||
          candidate.startsWith(`${toPath}/`);
        // A live Y.Doc session over either endpoint (or child) is vacated
        // FIRST, ahead of the detached-debt drain below (#681 round 2). A
        // session recovering a stood-down path (reopened, per every
        // stand-down's own instruction) proves nothing by merely existing —
        // only a real settle does — so it needs its chance to settle here,
        // on the chain, before the drain reads whatever marker it left
        // behind. Without this order, reopening and immediately renaming
        // would refuse on a marker the session was about to clear itself.
        //
        // WS-G2-C-2 (gate fix 3): required regardless — a live session over
        // either endpoint must be flushed + released before the file moves,
        // or a later settle would write the OLD path, resurrecting the
        // moved-from file / orphaning the object. Vacate first (a teardown
        // failure fails the rename).
        await settleAndCloseLiveYDocSessions(
          endpointMatch,
          "Saved latest edits before renaming",
        );
        // A DETACHED locked-write debt is another live thing a
        // rename must vacate — its session is gone, so the vacate above
        // cannot see it, and without this drain the rename would read the
        // STALE pre-lock artifact, record old bytes, and leave the retry
        // targeting the moved-from path. We are on the chain, so nothing
        // interleaves with the payment.
        //
        // The payment must PROVE it landed: it RESOLVES when
        // it merely re-armed against a still-held lock, and proceeding there
        // would read the stale pre-lock artifact and commit it through
        // writeIfChanged — replacing the canonical Y.Doc head with pre-lock
        // text, which the finisher's path rollback cannot undo. The registry
        // is the proof: still named after the payment means it did not land,
        // so the rename REFUSES and the debt survives for the retry ladder.
        //
        // Read it in that direction ONLY. Absence still means paid — a
        // stood-down debt on the SOURCE refuses the rename instead (#681),
        // below. One on the DESTINATION is left ALONE: `movePath` never
        // overwrites an existing destination (workspaceFiles.ts, `destExists`)
        // — a move onto a path that is still there fails on its own with the
        // standard, followable "Destination already exists" refusal, before
        // this debt is ever relevant. Cancelling it here at PREPARE time
        // (before the disk move even runs) destroyed the marker for a move
        // that could then FAIL, leaving the abandoned write undefended
        // (#681 round 3, codex P1) — the two scenarios that actually need
        // covering are handled elsewhere: an externally removed destination
        // clears through the watcher's own delete-cancel, and an existing
        // one is `movePath`'s refusal, not this one's.
        for (const endpoint of [...detachedLockedDebts.keys()]) {
          if (!endpointMatch(endpoint)) continue;
          const debt = detachedLockedDebts.get(endpoint);
          if (!debt) continue;
          await debt.pay();
          const after = detachedLockedDebts.get(endpoint);
          if (!after) continue;
          if (after.stoodDown) {
            // Destination-side: leave it. See the comment above.
            if (!isSourceSide(endpoint)) continue;
            // Explorer renders this verbatim (the dohc-interface skill): what
            // happened, why, then one instruction per sentence.
            throw new Error(
              `dohc could not rename ${fromPath}. dohc gave up on writing ${endpoint} earlier, so its last edits never reached disk. The edits stay in the document's history. Open ${endpoint} to write them again. Then rename ${fromPath} again.`,
            );
          }
          // WHY the payment did not land decides what the user is told. A
          // removal window over the endpoint holds every payment for it, so
          // the lock may be long gone and "close that program" would send
          // the user after nothing.
          const removal = removalWindowFor(endpoint);
          throw new Error(
            // Explorer renders this verbatim, so it follows
            // the dohc-interface skill: what happened, why, then ONE instruction
            // per sentence.
            removal
              ? `dohc could not rename ${fromPath}. ${removal.inProgress} Wait for that to finish. Then rename again.`
              : `dohc could not rename ${fromPath}. Another program still has ${endpoint} open, so the last edits are not on disk yet. Close that program. Then rename again.`,
          );
        }
        // The drain above sees only the debts that exist NOW. The filesystem
        // move runs off this chain, after the finisher is handed back, so an
        // open of the source can land on the chain inside that window, meet
        // the lock, and register a debt the drain never saw. Left armed, its
        // ladder reopens the moved-from path and recreates the file the user
        // just moved away — the same hole the delete seam had.
        //
        // CANCEL, not retarget. Retargeting is tempting: the write belongs to
        // the object, and the object now lives at `toPath`. But it is only
        // sound when the ENGINE rename ran, and this seam also serves folder
        // moves, binary files and untracked paths, where the destination is
        // not this debt's object at all — writing this lineage's text there
        // would be the clobber inverted. Cancelling is safe in every case and
        // loses nothing durable: the edits stay in the object's lineage, which
        // is where a moved document's text lives anyway.
        //
        // The residual, stated rather than hidden: the artifact at the
        // destination can stay stale until the document is reopened. Making
        // the pending write follow the file is a retarget feature, not this
        // fence.
        const cancelDebtsRegisteredDuringTheMove = (): void => {
          cancelSuspendedDebts(
            suspendDetachedDebts(endpointMatch),
            `a move of ${fromPath}`,
          );
        };
        // Cancelling those entries is not the same as stopping the write they
        // authorise: it runs off the chain, after the disk move, and a payment
        // already parked in its settle RPC sails past it (#663). The window
        // stops them from starting for as long as the move is unfinished.
        closeRemovalWindow = openRemovalWindow({
          match: endpointMatch,
          operation: "move",
          inProgress: `dohc is still moving ${fromPath}.`,
        });
        const policy = await readPolicyForTask();
        // THE OUTCOME, then the window — the one rule every finisher here
        // follows. It serves both moves that leave nothing to undo: the ones
        // the engine rename declined (folders, binary, untracked — the disk
        // move still happens, so they still need the fence) and the ones that
        // succeeded.
        const finishWithoutRollback: WorkspaceEngineRenameFinisher = async (
          ok: boolean,
        ) => {
          if (ok) cancelDebtsRegisteredDuringTheMove();
          closeRemovalWindow();
        };
        // Only a clean single-file rename between two engine-owned text paths
        // goes through the engine rename (preserving the stable object id);
        // everything else falls back to the watcher's delete+write capture.
        if (
          !policyTracksPath(fromPath, policy) ||
          !policyTracksPath(toPath, policy)
        ) {
          return finishWithoutRollback;
        }
        const toCheck = validateUserWritePath(toPath);
        if (!toCheck.ok || toCheck.normalized !== toPath) {
          return finishWithoutRollback;
        }
        const engine = await engineStore();
        const versionId = await activeVersionIdOf(engine);
        const disk = await readDiskTextState(rootPath, fromPath);
        if (disk.kind !== "text") return finishWithoutRollback;
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
          return finishWithoutRollback;
        }
        const cancel = registerExpectedEngineEvents([
          { path: fromPath, operation: "delete" },
          { path: toPath, operation: "write", sha256: disk.sha256 },
        ]);
        return async (ok: boolean) => {
          // A move that landed has nothing to undo, so it ends exactly like
          // one the engine never recorded.
          if (ok) return finishWithoutRollback(true);
          cancel();
          // The disk move failed after the engine recorded the rename: rename
          // back so engine state keeps mirroring the folder. Forward history —
          // both rename moments stay visible.
          //
          // THE WINDOW SPANS THE ROLLBACK. Closing it here only APPENDS the
          // rollback to the chain, and whatever is already queued runs first —
          // against an engine whose object sits at toPath while the file is
          // still at fromPath. A payment released into that gap settles
          // fromPath against an identity that is about to stop existing. The
          // move is not over until its engine state is back, so neither is the
          // window (codex, #696).
          try {
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
            });
          } catch (error) {
            onError("rename rollback", error);
          } finally {
            // A rollback that failed leaves the engine mid-move, but holding
            // the window past that would silence these paths' debts for good.
            // Close it either way; the trace above is what says the engine and
            // the folder disagree.
            closeRemovalWindow();
          }
        };
      }).catch((error: unknown) => {
        // Unlike the delete seam, this one still reads policy, opens the
        // engine and touches disk after the window opens. A throw there hands
        // the caller no finisher, and a leaked window silences these
        // endpoints' debts for the workspace's lifetime.
        closeRemovalWindow();
        throw error;
      });
    },

    runRelaySync(task) {
      return enqueueResult("relay sync", async () => {
        // A joined daemon can pull before any capture task has opened the
        // versioned store. The incoming moments target `main`, so create that
        // version before the relay applies them.
        const engine = await engineStore();
        const materializePage: MaterializeRelayPullPage = async (changed) => {
          if (changed.length === 0) return;
          // Policy and active-version reads only when there is disk work: a
          // quiescent relay tick does not need either one.
          const policy = await readPolicyForTask();
          const activeVersionId = await activeVersionIdOf(engine);
          const materializations: MaterializeOperation[] = [];
          for (const change of changed) {
            // A failed disk materialization leaves the relay cursor behind.
            // If the user switches versions before the retry, the redelivered
            // path still belongs to the version that produced it. Never read
            // from or delete the newly active version's disk projection.
            if (change.versionId !== activeVersionId) continue;
            if (change.operation === "delete") {
              materializations.push({
                kind: "delete",
                path: change.path,
                ...(change.contentKind === "secret" ? { protected: true } : {}),
              });
              continue;
            }
            if (change.contentKind === "secret") {
              const materialized = await secretStoreFor().materializeSecretFile({
                workspaceId,
                versionId: change.versionId,
                path: change.path,
              });
              if (!materialized.present) {
                throw new Error(
                  `Protected content for ${change.path} is no longer available.`,
                );
              }
              materializations.push({
                kind: "write",
                path: change.path,
                text: materialized.text,
                protected: true,
              });
              continue;
            }
            if (change.contentKind === "binary") {
              const bytes = await engine.readBinaryFile({
                workspaceId,
                versionId: activeVersionId,
                path: change.path,
              });
              if (!bytes) {
                throw new Error(`Binary content for ${change.path} is no longer available.`);
              }
              materializations.push({ kind: "write-binary", path: change.path, bytes });
              continue;
            }
            const snapshot = await engine.readTextFile({
              workspaceId,
              versionId: change.versionId,
              path: change.path,
            });
            if (!snapshot) continue;
            materializations.push(await materializeWriteForSnapshot(engine, snapshot));
          }
          await materialize(materializations, policy);
          // The daemon watcher must manifest the pulled disk state before the
          // caller can make its next edit. Otherwise a fast local edit can
          // coalesce with this materialization as the path's first sight, and
          // capture correctly refuses to claim the foreign sync head.
          if (options.daemonOwnsCapture) {
            await engine.reconcileCapture?.();
          }
        };
        return await task(materializePage);
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
        // Release every store this capture owns, so repeated workspace
        // switches never accumulate session leases or SQLite handles. An
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
