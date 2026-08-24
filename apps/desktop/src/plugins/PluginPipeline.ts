import type { WatcherEvent } from "@dohc/workspace-core";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  PLUGIN_PIPELINE_ERROR_STAGES,
  PLUGIN_PIPELINE_STATUSES,
} from "../ipc/channels";
import type { PluginHost, PluginHostStartEvidence } from "./PluginHost";
import {
  discoverInstalledPlugins,
  type InstalledPluginRecord,
} from "./pluginDiscovery";
import { buildPluginBundle } from "./pluginBuildRunner";
import {
  foldForCompare,
  recoverOnDiskSegments,
} from "./pluginCaseRecovery";
import { HOST_CHANGE_REFUSED_ERROR_CODE } from "./pluginCommandInvocation";
import {
  isPluginHostCommandAuthority,
  PluginHostOwnershipClosedError,
  type PluginHostChangeAuthority,
  type PluginHostChangeReservation,
  type PluginHostChangeScope,
  type PluginHostOwnership,
  type PluginHostStartResult,
} from "./pluginHostOwnership";
import { verifyPluginIcon } from "./pluginIcon";
import { installPluginDependencies } from "./pluginInstallRunner";
import { scanPluginLifecycleScripts } from "./pluginLifecycleScan";
import {
  mutatePluginRecord,
  pluginDataDir,
  readPluginLocalState,
  type PluginLocalState,
  type PluginRecordShape,
} from "./pluginLocalState";
import { readPluginManifestFile } from "./pluginManifest";
import {
  DohcPluginManifest as DohcPluginManifestSchema,
  type DohcPluginManifest,
  type PluginSettingDeclaration,
  type PluginSettingValue,
} from "./pluginManifestSchema";
import {
  readPluginSettingsFile,
  renamePluginSettingsEntry,
  resolvePluginSettings,
  savePluginSettings,
} from "./pluginSettingsFile";
import type { PluginRuntimeStatus } from "./pluginHostProtocol";
import {
  canonicalPluginSourceHash,
  hashPluginSourceFiles,
  isExcludedSourceName,
  isPluginRootArtifact,
  pluginIdToSafePath,
  pluginStateRoot,
  snapshotPluginSource,
  type PluginSourceFileDigest,
  type PluginSourceSnapshotResult,
} from "./pluginSourceSnapshot";
import {
  measurePluginDirectory,
  pluginUninstallPreflight,
  readPluginBaselineManifest,
  summarizeUninstallPreflight,
  writePluginBaselineManifest,
  type PluginUninstallPreflightSummary,
} from "./pluginUninstallPreflight";
import { isInside } from "../security/pathContainment";
import {
  PLUGIN_HOST_DRAIN_DEADLINE_MS,
  errorMessage,
} from "./pluginShared";

export { PLUGIN_PIPELINE_ERROR_STAGES, PLUGIN_PIPELINE_STATUSES };

export type PluginPipelineStatus = typeof PLUGIN_PIPELINE_STATUSES[number];

export type PluginPipelineErrorStage =
  typeof PLUGIN_PIPELINE_ERROR_STAGES[number];

export interface PluginPipelineError {
  stage: PluginPipelineErrorStage;
  code: string;
  message: string;
}

/**
 * What the manifest says a plugin is, for the list row and the details header.
 * Every field is optional in the manifest, so every field can be null and each
 * surface falls back on its own: the id names an unnamed plugin, and the
 * glyph tile stands in for a missing icon.
 */
export interface PluginMetadata {
  displayName: string | null;
  description: string | null;
  publisher: string | null;
  /** Plugin-root-relative, already checked by discovery. */
  icon: string | null;
  /** What the plugin calls this build. Display only — never compared. */
  pluginVersion: string | null;
  repository: string | null;
  issues: string | null;
  license: string | null;
}

/**
 * Bytes on this machine, measured rather than recorded. Null means the
 * directory holds no files, which is the honest answer for a plugin that was
 * never installed or never wrote any data.
 */
export interface PluginPipelineSizes {
  installedBytes: number | null;
  dataBytes: number | null;
}

/** One declared panel, and where the workbench shows it. */
export interface PluginPanelContribution {
  id: string;
  title: string;
  placement: "editor" | "view";
  /** The rail button's icon, plugin-root-relative, or null to fall back to
   * the plugin's own icon. */
  icon: string | null;
}

export interface PluginCommandContribution {
  id: string;
  title: string;
}

export interface PluginPipelinePluginStatus extends PluginMetadata {
  id: string;
  directoryName: string;
  rootPath: string;
  valid: boolean;
  status: PluginPipelineStatus;
  disabledReason: "user" | "crash-loop" | "approval" | "repair" | null;
  runtimeStatus: PluginRuntimeStatus | null;
  sourceHash: string | null;
  approvedHash: string | null;
  installedBaselineHash: string | null;
  /** The manifest's declared web apps, so the settings surface can offer an
   * Open control without a second manifest read. */
  webApps: { id: string; title: string; instanced: boolean }[];
  /** The manifest's declared panels, so the workbench can put the ones placed
   * in the view rail there without a second manifest read. */
  panels: PluginPanelContribution[];
  /** The manifest's declared commands, so the workbench can list them
   * without a second manifest read. */
  commands: PluginCommandContribution[];
  /** The manifest's declared settings, so the details page can render the
   * controls without a second manifest read. Values live per workspace and
   * travel separately. */
  settings: PluginSettingDeclaration[];
  /**
   * True from the moment a build fails while an old runtime keeps serving,
   * until a replacement build succeeds — independent of runtimeStatus, so a
   * crash-loop respawn between the failure and the fix can never make the
   * still-owed replacement disappear from status. Mirrors recoveryState's
   * own has() (round-8 finding 3), cleared the moment a replacement
   * publishes or the plugin stops.
   */
  hasFailedReplacement: boolean;
  diagnostics: string[];
  warnings: string[];
  error: PluginPipelineError | null;
}

export type PluginPipelineStatusEvent =
  | { kind: "changed"; plugin: PluginPipelinePluginStatus }
  // directoryName is the departed row's own — never re-derived from
  // whatever this id currently names, which a collision can leave
  // pointing at an entirely different, still-installed row. Consumers
  // that key their own state by id alone (main's panel/web app
  // registrations) need it to apply the same trace-to-directory rule
  // cleanup itself already does.
  | { kind: "removed"; pluginId: string; directoryName: string }
  // An invalid, never-installed candidate (a broken manifest, or none at
  // all) never gets a status entry of its own — seeding only fires for one
  // that was already installed — so its arrival or departure names no
  // pluginId either "changed" or "removed" could carry.
  // list() still shows it directly from discovery either way, and an
  // offer still has to hide behind or return to it, so this names the
  // one honest fact available: discovery itself changed, not which
  // plugin.
  | { kind: "discovery-changed" }
  // Emitted only where the pipeline itself has PROVEN a rename — the same
  // id reappearing at a new directory within one watcher batch
  // (processWatcherBatch's own renamedDirectory), or an offline rename
  // startup resolves by matching content hash. Consumers that would
  // otherwise have to guess a rename from directoryName drift on a
  // "changed" event (a renderer tab tracking one open row) can retarget
  // on this fact directly instead.
  | { kind: "renamed"; pluginId: string; from: string; to: string };

export type PluginPipelineActionResult =
  | { ok: true; plugin: PluginPipelinePluginStatus }
  | {
    ok: false;
    error: PluginPipelineError;
    plugin: PluginPipelinePluginStatus | null;
  };

export type PluginPipelineUninstallPreflightResult =
  | {
    ok: true;
    confirmationToken: string;
    preflight: PluginUninstallPreflightSummary;
  }
  | { ok: false; error: PluginPipelineError };

export interface PluginPipelineRuntimeStopHooks {
  /** Revokes authority immediately before this pipeline stops a proven runtime. */
  onWillStopRuntime?: (pluginId: string) => void;
}

interface PluginPipelineOperations {
  discover: typeof discoverInstalledPlugins;
  snapshot: typeof snapshotPluginSource;
  install: typeof installPluginDependencies;
  scan: typeof scanPluginLifecycleScripts;
  build: typeof buildPluginBundle;
  readLocalState: typeof readPluginLocalState;
  mutateRecord: typeof mutatePluginRecord;
  writeBaseline: typeof writePluginBaselineManifest;
  uninstallPreflight: typeof pluginUninstallPreflight;
  hashSource: typeof hashPluginSourceFiles;
  removePath: typeof rm;
  inspectPath: typeof lstat;
  readFile: typeof readFile;
}

export interface PluginPipelineOptions {
  workspaceRoot: string;
  stateDir: string;
  hostOwnership: PluginHostOwnership<PluginHost>;
  resourcesBasePath?: string;
  /** See pluginInstallRunner's InstallPluginDependenciesInput.pnpmRunnerEntry. */
  pnpmRunnerEntry: string;
  onStatusChange?: (event: PluginPipelineStatusEvent) => void;
  /** Awaits external cleanup after a terminal runtime stop. A rejection is
   * logged and does not undo the completed stop. */
  onRuntimeStopped?: (pluginId: string) => void | Promise<void>;
  /** Whether this workspace's engine capture is running right now — used
   * only to keep uninstall preflight's recovery promises honest (a file
   * under the capture size cap is not actually recoverable if capture
   * wasn't running to record it). Defaults to true so existing callers and
   * tests that don't care about this keep their current behavior. */
  isEngineCaptureAvailable?: () => boolean;
  platform?: NodeJS.Platform;
  operations?: Partial<PluginPipelineOperations>;
}


interface QueuedJob {
  sourceRefresh: boolean;
  run: () => Promise<void>;
}

interface PluginJobQueue {
  jobs: QueuedJob[];
  sourceRefreshQueued: boolean;
  draining: Promise<void> | null;
}

interface UninstallRecordFingerprint {
  approvedHash: string | null;
  installedBaselineHash: string | null;
  approvedBundleHash: string | null;
  directoryName: string | null;
}

type UninstallSourceState =
  | { kind: "present"; hash: string | null }
  | { kind: "absent" };

interface UninstallTargetSnapshot {
  pluginId: string;
  directoryName: string;
  rootPath: string;
  candidate: {
    id: string;
    directoryName: string;
    rootPath: string;
  } | null;
  source: UninstallSourceState;
  cleanupIds: string[];
  records: Array<{
    pluginId: string;
    record: UninstallRecordFingerprint | null;
  }>;
}

interface ResolvedUninstallTarget {
  snapshot: UninstallTargetSnapshot;
  record: PluginRecordShape | undefined;
  preflight: Awaited<ReturnType<typeof pluginUninstallPreflight>>;
}

interface ResolvedUninstallIdentity {
  record: PluginRecordShape | undefined;
  rootPath: string;
  sourcePresent: boolean;
  preflightInput: Parameters<typeof pluginUninstallPreflight>[0];
  snapshot(liveHash: string | null): UninstallTargetSnapshot;
}

interface UninstallConfirmation {
  token: string;
  target: UninstallTargetSnapshot;
}

type UninstallCleanupDecision = "stop" | "cancel";

interface UninstallQueueClaim {
  readonly ready: Promise<void>;
  decide(decision: UninstallCleanupDecision): void;
  release(): void;
  readonly stopOutcome: Promise<
    | { ok: true }
    | { ok: false; error: unknown }
  >;
  readonly outcome: Promise<
    | { ok: true }
    | { ok: false; error: unknown }
  >;
}

interface FullBuildOptions {
  candidate: InstalledPluginRecord;
  startRuntime: boolean;
  disabledReasonAfterBuild: PluginPipelinePluginStatus["disabledReason"];
  resetCrashAccounting: boolean;
  freshInstall: boolean;
  /**
   * The source hash this build is allowed to approve. A caller that already
   * decided this content is approvable — the door-write predicate
   * (doorApprovedHash: the approved baseline plus the recorded door deltas)
   * or a verify pass that confirmed the tree still matches its approved
   * hash — passes what it verified. The build takes its own fresh snapshot,
   * so without this an out-of-band change landing between that verification
   * and the snapshot rode the caller's decision straight to auto-approval,
   * on both the door path and the reconcile/start paths. Only install and
   * approve — whose entire point is a user gesture
   * approving whatever is on disk right now — leave it unset and approve
   * what they snapshot.
   */
  expectedHash?: string;
  /** A second hash an explicit earlier approval already authorized in this run. */
  alsoAcceptHash?: string;
  /** Records this fresh snapshot as the bytes an explicit approve action authorized. */
  rememberAsApprovedAttempt?: boolean;
  /** Runs after the previous runtime has fully stopped and before publication. */
  onOldRuntimeStopped?: () => void;
}

class PipelineFailure extends Error {
  constructor(readonly detail: PluginPipelineError) {
    super(detail.message);
    this.name = "PipelineFailure";
  }
}

class PluginPipelineClosedError extends Error {
  readonly code = "plugin-pipeline-closed";

  constructor() {
    super("Plugin pipeline is closed.");
    this.name = "PluginPipelineClosedError";
  }
}

function existingHostResult<T>(value: T): PluginHostStartResult<T> {
  return { kind: "existing", value };
}

function startedHostResult<T>(
  value: T,
  evidence: PluginHostStartEvidence,
): PluginHostStartResult<T> {
  return { kind: "started", value, evidence };
}

function mapHostResult<T, U>(
  result: PluginHostStartResult<T>,
  map: (value: T) => U,
): PluginHostStartResult<U> {
  const value = map(result.value);
  return result.kind === "started"
    ? startedHostResult(value, result.evidence)
    : existingHostResult(value);
}

const DEFAULT_OPERATIONS: PluginPipelineOperations = {
  discover: discoverInstalledPlugins,
  snapshot: snapshotPluginSource,
  install: installPluginDependencies,
  scan: scanPluginLifecycleScripts,
  build: buildPluginBundle,
  readLocalState: readPluginLocalState,
  mutateRecord: mutatePluginRecord,
  writeBaseline: writePluginBaselineManifest,
  uninstallPreflight: pluginUninstallPreflight,
  hashSource: hashPluginSourceFiles,
  removePath: rm,
  inspectPath: lstat,
  readFile,
};

/**
 * The bridge contract caps PluginPipelineError.message at 10,000 characters
 * (min 1), and several producers join unbounded diagnostic lists — a noisy
 * directory's discovery diagnostics, a drifted snapshot manifest's parse
 * issues, a failed build's output. One
 * over-cap message made the whole plugin list and every status event for
 * the candidate fail schema parsing, so every message is bounded here, in
 * the one place all pipeline errors are built.
 */
const PIPELINE_ERROR_MESSAGE_MAX_CHARS = 8_000;

function boundedErrorMessage(message: string): string {
  if (message.length === 0) return "(no error detail)";
  if (message.length <= PIPELINE_ERROR_MESSAGE_MAX_CHARS) return message;
  const note = (shown: number): string =>
    ` [${message.length - shown} of ${message.length} characters elided; ` +
    `this message is capped at ${PIPELINE_ERROR_MESSAGE_MAX_CHARS} characters.]`;
  // The note's own width shrinks (never grows) once the real shown count —
  // no larger than the total — replaces the estimate, so the result stays
  // inside the cap.
  const shown = PIPELINE_ERROR_MESSAGE_MAX_CHARS - note(0).length;
  return `${message.slice(0, shown)}${note(shown)}`;
}

function pipelineError(
  stage: PluginPipelineErrorStage,
  code: string,
  message: string,
): PluginPipelineError {
  return { stage, code, message: boundedErrorMessage(message) };
}

/**
 * The same cap for the diagnostics and warnings a status record carries. Their
 * producers are as unbounded as the error producers above: a hostile
 * dohc-plugin.json puts a whole unrecognized key name into one strict-object
 * diagnostic, and a lifecycle warning line embeds a package's own version
 * string. One over-cap entry failed the entire list's schema parse, denying
 * every other plugin's Disable and Uninstall too.
 */
function boundedStatusLines(lines: readonly string[]): string[] {
  return lines.map(boundedErrorMessage);
}

function failureFromUnknown(
  stage: PluginPipelineErrorStage,
  code: string,
  error: unknown,
): PipelineFailure {
  return new PipelineFailure(pipelineError(stage, code, errorMessage(error)));
}

function cloneError(error: PluginPipelineError | null): PluginPipelineError | null {
  return error ? { ...error } : null;
}

function cloneStatus(status: PluginPipelinePluginStatus): PluginPipelinePluginStatus {
  return {
    ...status,
    settings: status.settings.map((setting) => ({ ...setting })),
    webApps: status.webApps.map((webApp) => ({ ...webApp })),
    panels: status.panels.map((panel) => ({ ...panel })),
    commands: status.commands.map((command) => ({ ...command })),
    diagnostics: [...status.diagnostics],
    warnings: [...status.warnings],
    error: cloneError(status.error),
  };
}

function manifestWebApps(
  manifest: {
    webApps?: { id: string; title: string; instanced: boolean }[];
  } | null,
): { id: string; title: string; instanced: boolean }[] {
  return (manifest?.webApps ?? []).map((webApp) => ({
    id: webApp.id,
    title: webApp.title,
    instanced: webApp.instanced,
  }));
}

/**
 * The panels a plugin declares, with where each one shows. The entry path
 * stays behind in main: the renderer never loads a panel by path — it asks
 * for one by id, and main re-reads the manifest to answer.
 */
function manifestPanels(
  manifest: {
    panels?: {
      id: string;
      title: string;
      placement: "editor" | "view";
      icon?: string;
    }[];
  } | null,
): PluginPanelContribution[] {
  return (manifest?.panels ?? []).map((panel) => ({
    id: panel.id,
    title: panel.title,
    placement: panel.placement,
    icon: panel.icon ?? null,
  }));
}

function manifestCommands(
  manifest: {
    commands?: { id: string; title: string }[];
  } | null,
): PluginCommandContribution[] {
  return (manifest?.commands ?? []).map((command) => ({
    id: command.id,
    title: command.title,
  }));
}

/**
 * What a plugin says about itself, for the surfaces that show a plugin before
 * anyone installs it. Derived from the candidate on every status change for
 * the same reason webApps is: an approved manifest edit that renames a plugin
 * or rewrites its description must reach the list, not stay frozen at first
 * discovery. The icon comes from the candidate rather than the manifest —
 * discovery is what checked the file behind it.
 */
function manifestSettings(
  manifest: { settings?: PluginSettingDeclaration[] } | null,
): PluginSettingDeclaration[] {
  return (manifest?.settings ?? []).map((setting) => ({ ...setting }));
}

function manifestMetadata(candidate: InstalledPluginRecord): PluginMetadata {
  return {
    displayName: candidate.manifest?.displayName ?? null,
    description: candidate.manifest?.description ?? null,
    publisher: candidate.manifest?.publisher ?? null,
    icon: candidate.iconPath,
    pluginVersion: candidate.manifest?.pluginVersion ?? null,
    repository: candidate.manifest?.repository ?? null,
    issues: candidate.manifest?.issues ?? null,
    license: candidate.manifest?.license ?? null,
  };
}

/**
 * Why a confirmed uninstall must not delete, or null when the live tree still
 * hashes to what the confirmation covered. A null hash means preflight could
 * not fingerprint the tree, so nothing proves the warning the user approved
 * still describes what the recursive delete would remove.
 */
function uninstallVerificationFailure(
  currentHash: string | null,
  confirmedHash: string | null,
  changed: string,
): string | null {
  if (currentHash === null || confirmedHash === null) {
    return "source could not be read to confirm what uninstall would delete";
  }
  return currentHash === confirmedHash ? null : changed;
}

function uninstallRecordFingerprint(
  record: PluginRecordShape | undefined,
): UninstallRecordFingerprint | null {
  if (!record) return null;
  return {
    approvedHash: record.approvedHash ?? null,
    installedBaselineHash: record.installedBaselineHash ?? null,
    approvedBundleHash: record.approvedBundleHash ?? null,
    directoryName: record.directoryName ?? null,
  };
}

function uninstallTargetVerificationFailure(
  current: UninstallTargetSnapshot,
  confirmed: UninstallTargetSnapshot,
  changed: string,
): string | null {
  if (current.source.kind !== confirmed.source.kind) return changed;
  if (current.source.kind === "present" && confirmed.source.kind === "present") {
    const sourceFailure = uninstallVerificationFailure(
      current.source.hash,
      confirmed.source.hash,
      changed,
    );
    if (sourceFailure) return sourceFailure;
  }
  const withoutSource = ({ source: _source, ...snapshot }: UninstallTargetSnapshot) =>
    snapshot;
  return JSON.stringify(withoutSource(current)) ===
      JSON.stringify(withoutSource(confirmed))
    ? null
    : changed;
}

function notDiscoveredError(pluginId: string): PluginPipelineError {
  return pipelineError(
    "discovery",
    "plugin-not-found",
    `Plugin "${pluginId}" is not a valid discovered plugin.`,
  );
}

function invalidPluginError(
  candidate: InstalledPluginRecord,
): PluginPipelineError | null {
  if (candidate.diagnostics.length === 0) return null;
  // pipelineError bounds the joined message.
  return pipelineError(
    "discovery",
    "invalid-plugin",
    candidate.diagnostics.join(" "),
  );
}

function generatedManifest(manifest: DohcPluginManifest): DohcPluginManifest {
  return { ...manifest, entry: "bundle.mjs" };
}

function relativeSourceRoot(workspaceRoot: string, rootPath: string): string {
  return relative(workspaceRoot, rootPath).replaceAll("\\", "/");
}

function eventTouchesRoot(event: WatcherEvent, root: string): boolean {
  const path = event.path.replaceAll("\\", "/");
  return path === root || path.startsWith(`${root}/`);
}

function pluginTreeEvent(event: WatcherEvent): boolean {
  const path = event.path.replaceAll("\\", "/");
  return path === "plugins" || path.startsWith("plugins/");
}

function candidateKey(candidate: InstalledPluginRecord): string {
  return `${candidate.id}\0${resolve(candidate.rootPath)}`;
}

// Two rows can share an id (a broken manifest's directory-derived fallback
// colliding with some other, unrelated plugin's real id), each with its
// own open uninstall confirmation dialog. Keying uninstallConfirmations by
// pluginId alone let a SECOND row's preflight silently overwrite the
// FIRST's still-open confirmation — confirming the first dialog would
// either fail on a token that no longer matches, or worse, go on to
// resolve and delete whatever row the SECOND preflight actually named.
function uninstallConfirmationKey(pluginId: string, directoryName: string): string {
  return `${pluginId}\0${directoryName}`;
}

export interface DoorWrittenDelta {
  sha256: string;
  seq: number;
  provisional?: boolean;
  /**
   * The write's original, caller-spelled absolute path. Set only when
   * landing attributed this delta through sourceRelPath's case-insensitive
   * fold, not an exact root match — an exact landing already proved
   * ownership, so it has nothing left to re-confirm. retryProvisionalDeltaRecovery
   * walks this path from the workspace root to confirm or disprove that
   * guess; a rekeyed or landing-exact delta carries no origin because it
   * needs none.
   */
  provisionalOrigin?: string;
}

export function overlayDoorWrittenSourceDeltas(
  baselineFiles: readonly PluginSourceFileDigest[],
  deltas: Iterable<readonly [string, DoorWrittenDelta]>,
  platform: NodeJS.Platform = process.platform,
): PluginSourceFileDigest[] {
  const files = new Map(
    baselineFiles.map((file) => [file.relPath, file.sha256]),
  );
  const baselineKeys = new Set(files.keys());
  const byLowerCase = platform === "win32" || platform === "darwin"
    ? new Map([...files.keys()].map((relPath) => [foldForCompare(relPath), relPath]))
    : undefined;
  for (
    const [relPath, delta] of [...deltas].sort((a, b) => a[1].seq - b[1].seq)
  ) {
    const target = delta.provisional && byLowerCase && !baselineKeys.has(relPath)
      ? byLowerCase.get(foldForCompare(relPath)) ?? relPath
      : relPath;
    files.set(target, delta.sha256);
  }
  return [...files].map(([relPath, sha256]) => ({ relPath, sha256 }));
}

export class PluginPipeline {
  private readonly workspaceRoot: string;
  private readonly dohcDir: string;
  private readonly operations: PluginPipelineOperations;
  private readonly platform: NodeJS.Platform;
  private readonly statuses = new Map<string, PluginPipelinePluginStatus>();
  // A key's presence is the fact a build failed with an old runtime still
  // standing in for it — set whenever captureRecoveredManifest runs, keyed
  // by has(). The value is the generated manifest it also tries to cache,
  // or null when that read wasn't readable; hasRecoverableFailure only
  // needs the key, the palette needs the value too (#779 round 21 finding
  // 5, merged #779 round 26 simplification 8).
  private readonly recoveryState = new Map<string, DohcPluginManifest | null>();
  private readonly lastApprovedAttemptHash = new Map<string, string>();
  private readonly queues = new Map<string, PluginJobQueue>();
  private readonly uninstallConfirmations = new Map<string, UninstallConfirmation>();
  /**
   * Every door-written file since the approved baseline, per plugin:
   * relPath (POSIX, root-relative) to the sha256 of the written bytes and
   * the write's order in doorWriteSeq. See handleDoorWrittenSourceChange
   * and doorApprovedHash — this overlay, applied to the persisted baseline
   * manifest, is the only tree the door path may auto-approve. Overlay
   * A landing-time key is provisional until pluginAuthoredWrite's async case
   * recovery moves it to the spelling read from disk.
   */
  private readonly doorWrittenDeltas = new Map<
    string,
    Map<string, DoorWrittenDelta>
  >();
  /** Orders door writes against each build's snapshot; see runFullBuild. */
  private doorWriteSeq = 0;
  /**
   * The plugins whose first install is running right now, and the ones whose
   * source changed while that install ran. A fresh install hashes the tree,
   * then spends the whole dependency install and build on those bytes; a
   * write landing in that window leaves the recorded approval describing a
   * tree that is already gone. The queued refresh then holds for approval,
   * which is right — nothing may auto-approve a hash nobody approved — but
   * the user edited nothing, so the hold has to name what moved (#803).
   */
  private readonly freshInstallsInFlight = new Set<string>();
  private readonly sourceChangedDuringInstall = new Set<string>();
  private discovery: InstalledPluginRecord[] = [];
  private discoveryTail: Promise<void> = Promise.resolve();
  private startPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private readonly abortController = new AbortController();
  private disposed = false;

  constructor(private readonly options: PluginPipelineOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.dohcDir = pluginDataDir(options.stateDir, this.workspaceRoot);
    this.operations = { ...DEFAULT_OPERATIONS, ...options.operations };
    this.platform = options.platform ?? process.platform;
  }

  /**
   * The single PluginHost this pipeline owns for its workspace. #777's panel
   * surface shares this instance (rather than creating its own host) so a
   * panel and the install/build pipeline can never race two independent
   * hosts over the same plugin id.
   */
  get hostOwnership(): PluginHostOwnership<PluginHost> {
    return this.options.hostOwnership;
  }

  get host(): PluginHost {
    return this.hostOwnership.host;
  }

  /**
   * What this plugin declares the user may set. Refusing an unknown
   * directory is what keeps one plugin's settings out of another's reach:
   * every settings call names a directory, and only one this workspace
   * discovered has declarations to answer with. Resolved by directoryName,
   * never id — an id is only ever a broken manifest's directory-derived
   * fallback, which can coincide with some OTHER, unrelated plugin's real
   * id, and one directory is always exactly one discovery entry.
   *
   * The running build's own status, not the freshest on-disk manifest, is
   * authoritative whenever one exists for this exact directory: an edit
   * that failed to publish (a pre-stop write failure, a hold for approval)
   * leaves a newer, unapproved manifest sitting on disk while the plugin
   * users and other plugins actually interact with keeps declaring the
   * settings it was built and approved with. Only once there is no status
   * to trace to this directory yet (never installed) does the fresh
   * manifest answer instead — status.directoryName, not merely a status
   * keyed under this candidate's id, guards against a stale or colliding
   * status entry a shared id can still hold under a DIFFERENT directory.
   */
  private declaredSettings(directoryName: string): PluginSettingDeclaration[] {
    const candidate = this.discovery.find(
      (entry) => entry.directoryName === directoryName,
    );
    if (!candidate) throw new Error(`Unknown plugin directory: ${directoryName}`);
    const status = this.statuses.get(candidate.id);
    if (status && status.directoryName === directoryName) return status.settings;
    return manifestSettings(candidate.manifest);
  }

  /**
   * What this plugin takes up on this machine, in two numbers the details
   * rail shows separately because uninstall treats them differently: the
   * installed tree dohc built under its own userData (snapshot source, its
   * node_modules, the bundle), and the state root the plugin itself wrote.
   * A directory that holds no files answers null, and the rail then shows no
   * row — a plugin that was never installed has no installed size, and
   * printing a "0 bytes" would state something dohc does not know.
   *
   * Not queued behind the action lock: this only reads, and a reader opening
   * the page while an install runs should not have to wait for it.
   */
  async sizes(directoryName: string, pluginId: string): Promise<PluginPipelineSizes> {
    // liveRoot and the state root below are dohc's own build and runtime
    // storage, keyed by pluginId — the identity dohc actually built and ran
    // under. Presence alone is not enough to measure them for a caller's
    // chosen directory: two directories can share an id (a broken
    // manifest's directory-derived fallback colliding with some other,
    // unrelated plugin's real id), and pluginId's own persisted record is
    // what proves which directory it actually belongs to. A record that
    // positively names a DIFFERENT directory means this id's real bytes are
    // the OTHER row's, not this one's, to report.
    const state = await this.localState();
    const record = state.plugins[pluginId];
    if (record?.directoryName !== undefined && record.directoryName !== directoryName) {
      return { installedBytes: null, dataBytes: null };
    }
    const [installed, data] = await Promise.all([
      measurePluginDirectory(this.liveRoot(pluginId)),
      measurePluginDirectory(pluginStateRoot(this.dohcDir, pluginId)),
    ]);
    return {
      installedBytes: installed?.totalBytes ?? null,
      dataBytes: data?.totalBytes ?? null,
    };
  }

  /** This plugin's settings: its declared defaults under the stored answers,
   * for the exact directory a caller selected — never id alone, which two
   * rows can share. */
  async getPluginSettings(
    directoryName: string,
  ): Promise<Record<string, PluginSettingValue>> {
    const declared = this.declaredSettings(directoryName);
    const stored = await readPluginSettingsFile(this.workspaceRoot);
    return resolvePluginSettings(declared, stored[directoryName]);
  }

  /** Records the user's answers, for the exact directory a caller selected,
   * and tells the plugin, if it is running. `pluginId` names the process to
   * notify — pluginHost tracks running instances by id, never directoryName
   * — and appears in an error message; the stored answers themselves are
   * always read and written under directoryName. directoryName also gates
   * the notification itself: two directories can share an id, and
   * pluginHost only ever runs one of them under it at a time — telling it
   * about a save meant for the OTHER one would hand a running process
   * values it never asked for. */
  async setPluginSettings(
    directoryName: string,
    pluginId: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, PluginSettingValue>> {
    const declared = this.declaredSettings(directoryName);
    const values = await savePluginSettings(
      this.workspaceRoot,
      directoryName,
      pluginId,
      declared,
      patch,
    );
    // Not awaited: the value is already saved, and a plugin that is slow to
    // take the change must not make the user wait for a save that landed.
    void this.host
      .notifySettingsChanged(pluginId, directoryName, values)
      .catch((error: unknown) => {
        console.warn(
          `[desktop] plugin "${pluginId}" did not take a settings change: ${errorMessage(error)}`,
        );
      });
    return values;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  list(): PluginPipelinePluginStatus[] {
    const listed: PluginPipelinePluginStatus[] = [];
    const included = new Set<string>();
    for (const candidate of this.discovery) {
      if (!candidate.valid || !candidate.manifest) {
        // A seeded status for this same root means the plugin was installed
        // before its manifest broke. Report that installation identity so
        // Settings still offers Uninstall.
        const installed = this.statusForCandidate(candidate);
        if (
          installed && !installed.valid &&
          resolve(installed.rootPath) === resolve(candidate.rootPath)
        ) {
          listed.push(cloneStatus(installed));
          included.add(installed.id);
          continue;
        }
        listed.push({
          id: candidate.id,
          directoryName: candidate.directoryName,
          rootPath: candidate.rootPath,
          valid: false,
          status: "invalid",
          disabledReason: null,
          runtimeStatus: null,
          sourceHash: null,
          approvedHash: null,
          installedBaselineHash: null,
          ...manifestMetadata(candidate),
          settings: manifestSettings(candidate.manifest),
          webApps: manifestWebApps(candidate.manifest),
          panels: manifestPanels(candidate.manifest),
          commands: manifestCommands(candidate.manifest),
          hasFailedReplacement: this.recoveryState.has(candidate.id),
          diagnostics: boundedStatusLines(candidate.diagnostics),
          warnings: [],
          error: invalidPluginError(candidate),
        });
        continue;
      }
      const status = this.statuses.get(candidate.id);
      if (!status) continue;
      listed.push(cloneStatus(status));
      included.add(candidate.id);
    }
    for (const [pluginId, status] of this.statuses) {
      if (!included.has(pluginId)) listed.push(cloneStatus(status));
    }
    return listed.sort((left, right) =>
      left.directoryName.localeCompare(right.directoryName) ||
      left.id.localeCompare(right.id)
    );
  }

  /**
   * The directory (if any) whose discovery entry just lost a duplicate-id
   * collision to `pluginId` — read from discovery's own structured
   * supersededPluginId marker, never from list()'s wire-shaped status
   * (that crosses ListPluginsResult's strict IPC schema, which has no room
   * for an internal-only field) and never by scanning diagnostic text
   * (bounded and re-worded for display, not a stable machine-checked
   * signal). addOfferedPlugin's own handler uses this to detect its copy
   * having WON a collision another directory already held the id under.
   */
  findDirectorySupersededBy(pluginId: string): string | null {
    return this.discovery.find(
      (entry) => entry.supersededPluginId === pluginId,
    )?.directoryName ?? null;
  }

  /**
   * The root and manifest of a discovered plugin, in the shape main serves
   * panels from.
   *
   * main also keeps a registration map, but that map is filled only when a
   * tab opens a panel or a web app. A view in the activity bar opens no tab,
   * so nothing fills it for a view-only plugin, and the panel it declares
   * could never start. This is where the manifest actually lives.
   */
  pluginRegistration(
    pluginId: string,
  ): { pluginRoot: string; manifest: DohcPluginManifest; directoryName: string } | null {
    // A failed replacement with nothing recoverable from the live root must
    // not fall through to the freshly discovered candidate's own manifest
    // either — that candidate was never approved and may not even be
    // compatible with what is still running. Callers already treat a null
    // registration as "nothing new to serve" and fall back to their own
    // last-known-good record.
    if (this.recoveryState.has(pluginId)) {
      const recovered = this.recoveryState.get(pluginId);
      // recoveryState carries no directoryName of its own — setStatus
      // always writes the current candidate's directoryName into
      // this.statuses right before a failure path can ever populate
      // recoveryState, so it is reliably there by the time this reads it.
      // Missing anyway is nothing this call can vouch for; refuse the same
      // way an unrecovered manifest already does.
      const directoryName = this.statuses.get(pluginId)?.directoryName;
      return recovered && directoryName
        ? { pluginRoot: this.liveRoot(pluginId), manifest: recovered, directoryName }
        : null;
    }
    for (const candidate of this.discovery) {
      if (candidate.id !== pluginId || !candidate.manifest) continue;
      return {
        pluginRoot: candidate.rootPath,
        manifest: candidate.manifest,
        directoryName: candidate.directoryName,
      };
    }
    return null;
  }

  /**
   * True exactly when pluginRegistration() above just refused to serve this
   * plugin because its replacement failed with nothing recoverable — not
   * when the plugin is simply unknown to this pipeline. A caller reading a
   * null registration back needs this distinction: falling back to its own
   * last-known-good record is right for "unknown," but reading the failed
   * candidate's own raw manifest straight off disk instead is exactly what
   * pluginRegistration()'s own refusal was for (#779 round 23 finding 1).
   */
  hasUnrecoverableFailedReplacement(pluginId: string): boolean {
    return this.recoveryState.get(pluginId) === null;
  }

  /**
   * Resolves an absolute workspace path to the id of the discovered plugin
   * whose root contains it, or null when no plugin owns that path. Lets a
   * door-attributed write (main.ts's writeAuthoredText) tell this pipeline
   * which plugin's source just changed, so it can route the change through
   * handleDoorWrittenSourceChange instead of waiting for the watcher.
   */
  pluginIdForPath(absolutePath: string): string | null {
    const target = resolve(absolutePath);
    for (const candidate of this.discovery) {
      if (isInside(resolve(candidate.rootPath), target)) return candidate.id;
    }
    if (this.platform === "win32" || this.platform === "darwin") {
      const foldedTarget = foldForCompare(target);
      for (const candidate of this.discovery) {
        if (isInside(foldForCompare(resolve(candidate.rootPath)), foldedTarget)) {
          return candidate.id;
        }
      }
    }
    return null;
  }

  private sourceRelPathExact(
    candidate: InstalledPluginRecord,
    absolutePath: string,
  ): string | null {
    const root = resolve(candidate.rootPath);
    const target = resolve(absolutePath);
    if (target === root) return null;
    if (!isInside(root, target)) return null;
    return relative(root, target).replaceAll("\\", "/");
  }

  private sourceRelPath(
    candidate: InstalledPluginRecord,
    absolutePath: string,
  ): string | null {
    const exact = this.sourceRelPathExact(candidate, absolutePath);
    if (exact !== null) return exact;
    if (this.platform !== "win32" && this.platform !== "darwin") return null;
    const root = resolve(candidate.rootPath);
    const target = resolve(absolutePath);
    const foldedRoot = foldForCompare(root);
    const foldedTarget = foldForCompare(target);
    if (foldedTarget === foldedRoot || !isInside(foldedRoot, foldedTarget)) return null;
    const rootSegments = root.split(/[\\/]+/).filter(Boolean);
    const targetSegments = target.split(/[\\/]+/).filter(Boolean);
    if (
      rootSegments.length >= targetSegments.length ||
      rootSegments.some((segment, index) => {
        const targetSegment = targetSegments[index];
        return targetSegment === undefined ||
          foldForCompare(segment) !== foldForCompare(targetSegment);
      })
    ) {
      return null;
    }
    return targetSegments.slice(rootSegments.length).join("/");
  }

  install(pluginId: string): Promise<PluginPipelineActionResult> {
    return this.enqueueAdoptedAction(pluginId, async (change) => {
      const candidate = this.requireValidCandidate(pluginId);
      return this.runFullBuild({
        candidate,
        startRuntime: true,
        disabledReasonAfterBuild: null,
        resetCrashAccounting: true,
        freshInstall: true,
      }, change);
    });
  }

  disable(
    pluginId: string,
    hooks: PluginPipelineRuntimeStopHooks = {},
  ): Promise<PluginPipelineActionResult> {
    return this.enqueueAdoptedAction(pluginId, async (change) => {
      let priorDisabled: boolean | undefined;
      try {
        const candidate = this.requireValidCandidate(pluginId);
        await this.operations.mutateRecord(
          this.options.stateDir,
          this.workspaceRoot,
          pluginId,
          (record) => {
            priorDisabled = record?.disabled;
            return { ...record, disabled: true };
          },
        );
        try {
          await this.stopTerminalRuntime(
            pluginId,
            change,
            () => hooks.onWillStopRuntime?.(pluginId),
          );
        } catch (stopError) {
          if (
            !this.disposed &&
            this.host.currentRecord(pluginId)
          ) {
            try {
              await this.operations.mutateRecord(
                this.options.stateDir,
                this.workspaceRoot,
                pluginId,
                (record) => record && { ...record, disabled: priorDisabled },
              );
            } catch (compensationError) {
              console.error(
                `[PluginPipeline] failed to restore the durable state after stop failed for "${pluginId}".`,
                compensationError,
              );
            }
          }
          throw stopError;
        }
        return existingHostResult(this.success(this.setStatus(candidate, {
          status: "disabled",
          disabledReason: "user",
          runtimeStatus: null,
          error: null,
        })));
      } catch (error) {
        const detail = error instanceof PipelineFailure
          ? error.detail
          : pipelineError("state", "disable-failed", errorMessage(error));
        return existingHostResult(this.failure(pluginId, detail));
      }
    });
  }

  enable(pluginId: string): Promise<PluginPipelineActionResult> {
    return this.enqueueAdoptedAction(pluginId, async (change) => {
      const candidate = this.requireValidCandidate(pluginId);
      const state = await this.localRecord(pluginId);
      if (!state?.approvedHash) {
        return existingHostResult(this.failure(
          pluginId,
          pipelineError(
            "state",
            "install-required",
            `Plugin "${pluginId}" must be installed before it can be enabled.`,
          ),
        ));
      }
      return this.startFromApprovedSource(
        candidate,
        state,
        state.approvedHash,
        {
          clearDisabled: true,
          resetCrashAccounting:
            this.statuses.get(pluginId)?.disabledReason === "crash-loop",
          runtimeErrorCode: "enable-failed",
        },
        change,
      );
    });
  }

  /**
   * Starts an already-approved, hash-verified plugin if it isn't already
   * running, refusing otherwise. This is the gate #777's panel surface calls
   * before it can execute a plugin's process: opening a panel must never run
   * code this pipeline hasn't verified and built. Unlike `enable()`, this
   * never clears a `disabled` flag — a user's explicit disable must not be
   * silently bypassed by opening a panel.
   *
   * A plugin discovered for the first time (no local record yet) runs the
   * same full install path `install()` uses: frozen pnpm install, the
   * lifecycle-hook scan, a real build, and only then a recorded approved
   * hash. This still verifies and builds every byte before it can execute —
   * "verify hash before execute" holds either way — it just doesn't require
   * a separate explicit Install click before the very first open, matching
   * the design doc's "no permission prompts" rule (design rule 3): a plugin
   * an agent or the user placed under plugins/ is trusted the same way any
   * local process is, the first time its panel opens as much as any other.
   */
  ensureStarted(
    pluginId: string,
    scope: PluginHostChangeScope,
  ): Promise<PluginHostStartResult<PluginPipelineActionResult>> {
    if (
      this.host.currentRecord(pluginId) &&
      !isPluginHostCommandAuthority(scope)
    ) {
      return scope.runChange(async (change) =>
        change.preserve(await this.enqueueStartedValue(
          pluginId,
          () => this.runEnsureStarted(pluginId, change),
        )))
        .then((value) => existingHostResult(value));
    }
    return this.enqueueStartedValue(
      pluginId,
      () => this.runEnsureStarted(pluginId),
    );
  }

  private async runEnsureStarted(
    pluginId: string,
    change?: PluginHostChangeAuthority,
  ): Promise<PluginHostStartResult<PluginPipelineActionResult>> {
    const candidate = this.requireValidCandidate(pluginId);
    const priorStatus = this.statuses.get(pluginId);
    const state = await this.localRecord(pluginId);
    if (state?.disabled === true) {
      return existingHostResult(this.failure(
        pluginId,
        pipelineError(
          "state",
          "plugin-disabled",
          `Plugin "${pluginId}" is disabled. Enable it before opening it.`,
        ),
      ));
    }
    if (!state?.approvedHash) {
      if (this.host.currentRecord(pluginId) && !change) {
        return this.restoreStatusAfterHostChangeRefusal(
          candidate,
          priorStatus,
          existingHostResult(this.failure(
            pluginId,
            this.hostChangeInProgressError(pluginId),
          )),
        );
      }
      return this.runFullBuild({
        candidate,
        startRuntime: true,
        disabledReasonAfterBuild: null,
        resetCrashAccounting: true,
        freshInstall: true,
      }, change);
    }
    return this.startFromApprovedSource(
      candidate,
      state,
      state.approvedHash,
      {
        clearDisabled: false,
        resetCrashAccounting: false,
        runtimeErrorCode: "start-failed",
      },
      change,
    );
  }

  private buildFromCurrentSource(
    pluginId: string,
    candidate: InstalledPluginRecord & { manifest: DohcPluginManifest },
    change: PluginHostChangeAuthority,
    options: Pick<
      FullBuildOptions,
      | "expectedHash"
      | "alsoAcceptHash"
      | "rememberAsApprovedAttempt"
      | "onOldRuntimeStopped"
    > = {},
  ): Promise<PluginHostStartResult<PluginPipelineActionResult>> {
    const staysDisabled =
      this.statuses.get(pluginId)?.disabledReason === "user";
    return this.runFullBuild({
      candidate,
      startRuntime: !staysDisabled,
      disabledReasonAfterBuild: staysDisabled ? "user" : null,
      resetCrashAccounting: true,
      freshInstall: false,
      ...options,
    }, change);
  }

  approve(pluginId: string): Promise<PluginPipelineActionResult> {
    return this.enqueueAdoptedAction(pluginId, async (change) => {
      const candidate = this.requireValidCandidate(pluginId);
      // The disabled bit is the user's own choice, orthogonal to approval.
      return this.buildFromCurrentSource(pluginId, candidate, change, {
        rememberAsApprovedAttempt: true,
      });
    });
  }

  rebuild(
    pluginId: string,
    options?: { onOldRuntimeStopped?: () => void },
  ): Promise<PluginPipelineActionResult> {
    return this.enqueueAdoptedAction(pluginId, async (change) => {
        const candidate = this.requireValidCandidate(pluginId);
        // A crash-loop respawn between the failure and this call flips
        // status back to whatever the still-running old build reports;
        // hasRecoverableFailure is the fact that survives it (round-8
        // finding 3, round-21 finding 1).
        if (!this.hasRecoverableFailure(pluginId)) {
          return existingHostResult(this.failure(
            pluginId,
            pipelineError(
              "state",
              "no-failed-build",
              `Plugin "${pluginId}" has no failed build to retry.`,
            ),
          ));
        }
        const record = await this.localRecord(pluginId);
        if (!record?.approvedHash) {
          return existingHostResult(this.failure(
            pluginId,
            pipelineError(
              "state",
              "no-failed-build",
              `Plugin "${pluginId}" has no failed build to retry.`,
            ),
          ));
        }
        return this.buildFromCurrentSource(
          pluginId,
          candidate,
          change,
          {
            expectedHash: record.approvedHash,
            alsoAcceptHash: this.lastApprovedAttemptHash.get(pluginId),
            onOldRuntimeStopped: options?.onOldRuntimeStopped,
          },
        );
    });
  }

  /**
   * Records one door-attributed write — per-operation authored bytes that
   * arrived through main.ts's writeAuthoredText — and queues a source
   * refresh. The write's own path and content are the only bytes this call
   * attributes: the design doc's auto-approve predicate is attribution
   * through the door, not topology, so the refresh auto-approves only when
   * the live tree equals the approved baseline plus every recorded door
   * delta (doorApprovedHash). Hashing the whole live tree here instead
   * folded ambient, watcher-class bytes already on disk — a git checkout, a
   * mirror delivery — into the door write's auto-approval. Deltas are
   * recorded synchronously and keyed per
   * plugin, so the dedup in enqueueSourceRefresh can drop this
   * notification's queue entry and the surviving refresh still sees every
   * write, newest content per path.
   */
  handleDoorWrittenSourceChange(
    pluginId: string,
    write: { absolutePath: string; text: string },
  ): void {
    const candidate = this.validCandidate(pluginId);
    if (!candidate) return;
    const exactRelPath = this.sourceRelPathExact(candidate, write.absolutePath);
    const relPath = exactRelPath ?? this.sourceRelPath(candidate, write.absolutePath);
    if (relPath === null) return;
    // node_modules and .dohc are excluded from every source digest, so a
    // write under them cannot change the hash this predicate compares.
    if (this.isExcludedRelPath(relPath)) return;
    const deltas = this.doorWrittenDeltas.get(pluginId) ??
      new Map<string, DoorWrittenDelta>();
    deltas.set(relPath, {
      sha256: createHash("sha256").update(write.text, "utf8").digest("hex"),
      seq: ++this.doorWriteSeq,
      provisional: true,
      provisionalOrigin: exactRelPath === null ? write.absolutePath : undefined,
    });
    this.doorWrittenDeltas.set(pluginId, deltas);
    this.enqueueSourceRefresh(pluginId, (change) =>
      this.reconcileApprovedCandidate(pluginId, true, change));
  }

  /**
   * Moves a door-written delta from its landing-time spelling to its recovered
   * on-disk spelling, preserving its sequence. This settles one write; it
   * does not create another. A missing source entry was already superseded.
   */
  rekeyDoorWrittenSourceChange(
    pluginId: string,
    from: { absolutePath: string },
    to: { absolutePath: string },
  ): void {
    const candidate = this.validCandidate(pluginId);
    if (!candidate) return;
    const fromRelPath = this.sourceRelPath(candidate, from.absolutePath);
    if (fromRelPath === null) return;
    const deltas = this.doorWrittenDeltas.get(pluginId);
    const delta = deltas?.get(fromRelPath);
    if (!deltas || !delta) return;

    const toRelPath = this.sourceRelPathExact(candidate, to.absolutePath);
    if (toRelPath === null) {
      // Recovery resolved the write's true on-disk path, and it is not
      // under the plugin's real root: the landing-time fold guessed
      // ownership from spelling alone, and a case-sensitive volume just
      // proved that guess wrong. Drop the provisional attribution — this
      // is an ordinary out-of-band change to a distinct, real directory,
      // not this plugin's own source.
      deltas.delete(fromRelPath);
      this.enqueueSourceRefresh(pluginId, (change) =>
        this.reconcileApprovedCandidate(pluginId, true, change));
      return;
    }

    if (this.isExcludedRelPath(toRelPath)) {
      deltas.delete(fromRelPath);
      this.enqueueSourceRefresh(pluginId, (change) =>
        this.reconcileApprovedCandidate(pluginId, true, change));
      return;
    }

    const destination = deltas.get(toRelPath);
    const pathChanged = fromRelPath !== toRelPath;
    if (pathChanged) deltas.delete(fromRelPath);
    if (!destination || destination.seq <= delta.seq) {
      deltas.set(toRelPath, { sha256: delta.sha256, seq: delta.seq });
    }
    if (pathChanged) {
      this.enqueueSourceRefresh(pluginId, (change) =>
        this.reconcileApprovedCandidate(pluginId, true, change));
    }
  }

  private isExcludedRelPath(relPath: string): boolean {
    return relPath.split("/").some((segment) => isExcludedSourceName(segment));
  }

  /**
   * Reconciles one watcher batch, behind every batch already in flight. The
   * returned promise settles once this batch has decided its refreshes and
   * queued them; it never rejects, so a caller that only forwards events can
   * ignore it.
   */
  handleWatcherEvents(events: readonly WatcherEvent[]): Promise<void> {
    if (this.disposed || !events.some(pluginTreeEvent)) return Promise.resolve();
    const batch = events.map((event) => ({ ...event }));
    this.discoveryTail = this.discoveryTail.then(
      () => this.processWatcherBatch(batch),
      () => this.processWatcherBatch(batch),
    ).catch((error) => {
      console.error(
        `[desktop] plugin discovery refresh failed for ${this.workspaceRoot}:`,
        error,
      );
    });
    return this.discoveryTail;
  }

  noteRuntimeStatus(pluginId: string, runtimeStatus: PluginRuntimeStatus): void {
    if (this.disposed) return;
    const candidate = this.validCandidate(pluginId);
    if (!candidate) return;
    if (runtimeStatus === "disabled") {
      // recoveryState staying set is what keeps hasFailedReplacement true
      // through this transition: a build that failed and was never
      // replaced is still owed one whether or not the old runtime that
      // outlived it just gave up crash-looping. Clearing it here hid Retry
      // build and routed Enable through an approval hold instead (round-9
      // finding 2) — the one path a build failure can leave with no running
      // host left to preserve the fact for later.
      this.setStatus(candidate, {
        status: "disabled",
        disabledReason: "crash-loop",
        runtimeStatus,
        error: null,
      });
      return;
    }
    this.setStatus(candidate, {
      status: runtimeStatus,
      runtimeStatus,
      disabledReason: null,
      error: runtimeStatus === "failed" || runtimeStatus === "crashed"
        ? pipelineError(
          "runtime",
          runtimeStatus,
          `Plugin "${pluginId}" ${runtimeStatus}.`,
        )
        : null,
    });
  }

  uninstallPreflight(
    pluginId: string,
    directoryName: string,
  ): Promise<PluginPipelineUninstallPreflightResult> {
    return this.enqueueActionValue(pluginId, async () => {
      try {
        const target = await this.resolveUninstallTarget(pluginId, directoryName);
        const confirmationToken = randomUUID();
        this.uninstallConfirmations.set(uninstallConfirmationKey(pluginId, directoryName), {
          token: confirmationToken,
          target: target.snapshot,
        });
        return {
          ok: true,
          confirmationToken,
          preflight: summarizeUninstallPreflight(target.preflight),
        };
      } catch (error) {
        return {
          ok: false,
          error: pipelineError(
            "uninstall",
            "preflight-failed",
            errorMessage(error),
          ),
        };
      }
    });
  }

  uninstall(
    pluginId: string,
    directoryName: string,
    confirmationToken: string,
    hooks: PluginPipelineRuntimeStopHooks = {},
  ): Promise<PluginPipelineActionResult> {
    if (this.disposed) {
      return Promise.resolve(this.pipelineClosedFailure(pluginId));
    }
    const confirmationKey = uninstallConfirmationKey(pluginId, directoryName);
    const pendingConfirmation = this.uninstallConfirmations.get(confirmationKey);
    const cleanupIds = pendingConfirmation?.token === confirmationToken
      ? pendingConfirmation.target.cleanupIds
      : [];
    const reservations = new Map<string, PluginHostChangeReservation>();
    for (const id of new Set([pluginId, ...cleanupIds])) {
      reservations.set(id, this.hostOwnership.reserveChange(id));
    }
    const cleanupQueueClaims = this.claimUninstallCleanupQueues(
      cleanupIds,
      pluginId,
      reservations,
      hooks,
    );
    const primaryReservation = reservations.get(pluginId);
    if (!primaryReservation) {
      throw new Error(`Plugin "${pluginId}" has no uninstall reservation.`);
    }
    const action = this.enqueueAdoptedAction(pluginId, async (change) => {
      const confirmation = this.uninstallConfirmations.get(confirmationKey);
      this.uninstallConfirmations.delete(confirmationKey);
      if (!confirmation || confirmation.token !== confirmationToken) {
        return existingHostResult(this.failure(
          pluginId,
          pipelineError(
            "uninstall",
            "confirmation-required",
            `Plugin "${pluginId}" requires a current uninstall preflight confirmation.`,
          ),
        ));
      }

      // A cleanup identity may already have accepted work ahead of this
      // uninstall. Wait until every claimed queue reaches this uninstall's
      // boundary before validating the exact target, while the synchronous
      // ownership reservations keep any later host change from starting.
      // No runtime is stopped until this validation succeeds.
      await Promise.all(cleanupQueueClaims.map((claim) => claim.ready));
      const validated = await this.revalidateUninstallTarget(
        confirmation.target,
        "changed after uninstall preflight",
      );
      if (!validated.ok) {
        return existingHostResult(this.failure(
          pluginId,
          pipelineError(
            "uninstall",
            "confirmation-stale",
            `Plugin "${pluginId}" ${validated.reason}. Review it again.`,
          ),
        ));
      }
      const { record } = validated;
      const cleanupIds = new Set(confirmation.target.cleanupIds);
      if (confirmation.target.source.kind === "absent") {
        return this.finishSourcelessUninstall(
          pluginId,
          cleanupIds,
          change,
          cleanupQueueClaims,
          confirmation.target,
          hooks,
        );
      }
      // Resolved from what THIS confirmation's own preflight named, never
      // a fresh lookup a caller could otherwise steer — the row an
      // uninstall deletes can never drift from the one its own preflight
      // reported on.
      const candidate = this.requireUninstallableCandidate(
        confirmation.target.directoryName,
        pluginId,
        record,
      );
      // State/artifacts might be filed under the id the record was
      // ORIGINALLY installed under, not pluginId: a broken manifest gives
      // discovery a directory-derived fallback id,
      // and installedRecord's own directoryName join is what already finds
      // the persisted record across that mismatch. Deleting only under
      // pluginId strands the other key's state and plugin data forever —
      // nothing else ever visits it again once the discovery entry for
      // this directory is gone.
      //
      // pluginId itself only joins cleanup when nothing PROVES it belongs
      // to a different directory — a persisted record's own directoryName
      // is that proof, for every piece of cleanup here, not only which
      // directory's SOURCE gets deleted: an invalid row's own fallback id can
      // coincide with some OTHER, unrelated, installed plugin's real id,
      // and that installation's record genuinely lives under this exact
      // key — disabling it, stopping its running process, and deleting its
      // build and state right along with the invalid row's source.
      // Cleanup is bound to the identities the confirmed preflight named.
      // Re-discovering identities here could stop or delete state the user
      // never reviewed, and those late identities would not have received a
      // synchronous ownership reservation when uninstall() was called.
      const pluginIdTracesHere = cleanupIds.has(pluginId);

      // Guarded: candidate.id can collide with an unrelated, installed
      // plugin's real id, and this.statuses is keyed by that id alone — an
      // unguarded write here would show THAT plugin as uninstalling and
      // then, on this action's own status transitions below, keep
      // overwriting an entry that was never this row's to begin with.
      // Skipping the write costs the invalid row nothing visible: list()
      // never reads this.statuses for
      // an invalid candidate that failed this same check to begin with.
      if (this.ownsStatusEntry(candidate)) {
        this.setStatus(candidate, {
          status: "uninstalling",
          disabledReason: "user",
          error: null,
        });
      }
      try {
        // Guarded the same way cleanupIds is: pluginId's own record here
        // can genuinely belong to a different, unrelated installation —
        // marking IT disabled would be exactly the harm this fix closes,
        // done a step earlier than the delete itself.
        if (pluginIdTracesHere && record) {
          await this.operations.mutateRecord(
            this.options.stateDir,
            this.workspaceRoot,
            pluginId,
            (existing) => ({ ...existing, disabled: true }),
          );
        }
        // Every cleanup identity's own runtime is stopped before its data
        // is deleted, not only pluginId's — cleanupIds is already scoped
        // to identities that trace to this exact directory, so stopping
        // every one of them can never reach a process an unrelated
        // installation owns. stopOldRuntime, not a bare pluginHost.stop:
        // it also drains this id's own in-flight work and clears
        // its recovery state, for every identity being torn down here, not
        // only the primary one.
        await this.stopCleanupRuntimes(
          cleanupIds,
          pluginId,
          change,
          cleanupQueueClaims,
          hooks,
        );

        // Re-verify immediately before the actual delete: pluginHost.stop()
        // can take real wall-clock time (a grace period, then signal
        // escalation), and the earlier check above is no longer "immediately
        // before delete" once that wait has happened — this must never
        // delete content different from what the confirmation actually
        // covered.
        const preDelete = await this.revalidateUninstallTarget(
          confirmation.target,
          "changed while its process was stopping",
        );
        if (!preDelete.ok) {
          const detail = pipelineError(
            "uninstall",
            "confirmation-stale",
            `Plugin "${pluginId}" ${preDelete.reason}. Review uninstall again.`,
          );
          // Nothing was deleted, the record still says disabled, and the host
          // is stopped — but the status set above still reads "uninstalling",
          // which disables every action for good.
          if (this.ownsStatusEntry(candidate)) {
            this.setStatus(candidate, {
              status: "disabled",
              disabledReason: "user",
              runtimeStatus: null,
              error: detail,
            });
          }
          return existingHostResult(this.failure(pluginId, detail));
        }

        // Every delete is attempted even if another rejects, for every
        // cleanup identity — skipping one because another failed would
        // silently leave it behind with no record that cleanup is still
        // owed.
        const [rootDeleted, ...dataDeleted] = await Promise.allSettled([
          this.operations.removePath(candidate.rootPath, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
          }),
          ...[...cleanupIds].map((id) => this.removePluginData(id)),
        ]);
        if (rootDeleted.status === "rejected") throw rootDeleted.reason;
        for (const result of dataDeleted) {
          if (result.status === "rejected") throw result.reason;
        }

        await Promise.all(
          [...cleanupIds].map((id) =>
            this.operations.mutateRecord(
              this.options.stateDir,
              this.workspaceRoot,
              id,
              () => undefined,
            )
          ),
        );
        this.clearUninstalledIdentityState(
          cleanupIds,
          confirmation.target.directoryName,
        );
        // One directory is one discovery entry, so the deleted root — not the
        // id, which an invalid candidate does not share with its record — is
        // what identifies the entry that just went away.
        this.discovery = this.discovery.filter((entry) =>
          resolve(entry.rootPath) !== resolve(candidate.rootPath)
        );
        this.emit({ kind: "removed", pluginId, directoryName: candidate.directoryName });
        return existingHostResult({
          ok: true,
          plugin: {
            ...this.baseStatus(candidate),
            status: "disabled",
            disabledReason: "user",
          },
        });
      } catch (error) {
        // A failed delete must never disappear as a stuck "uninstalling"
        // spinner with orphaned files left behind and no way back in. The
        // local record is left untouched (still disabled, still pointing at
        // whatever survived) so a retry's preflight has something real to
        // re-check, and the status becomes the same actionable
        // disabled-pending-repair state a failed fresh install already uses.
        const detail = error instanceof PipelineFailure
          ? error.detail
          : pipelineError("uninstall", "delete-failed", errorMessage(error));
        if (this.ownsStatusEntry(candidate)) {
          this.setStatus(candidate, {
            status: "disabled-pending-repair",
            disabledReason: "repair",
            runtimeStatus: null,
            error: detail,
          });
        }
        return existingHostResult(this.failure(pluginId, detail));
      }
    }, primaryReservation);
    return action.finally(async () => {
      for (const claim of cleanupQueueClaims) {
        claim.decide("cancel");
        claim.release();
      }
      await Promise.all(cleanupQueueClaims.map((claim) => claim.outcome));
    });
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.abortController.abort();
    const closingOwnership = this.hostOwnership.close();
    this.disposePromise = this.finishDispose(closingOwnership);
    return this.disposePromise;
  }

  private async finishDispose(closingOwnership: Promise<void>): Promise<void> {
    // Observe owner failure immediately even if a pipeline job takes longer
    // to drain. Waiting to attach a handler until after the queues settle can
    // surface a rejected stopAll() as an unhandled rejection in the interim.
    const ownershipOutcome = closingOwnership.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await this.discoveryTail.catch(() => undefined);
      await Promise.all(
        [...this.queues.values()]
          .map((queue) => queue.draining)
          .filter((draining): draining is Promise<void> => draining !== null),
      );
      const outcome = await ownershipOutcome;
      if (!outcome.ok) throw outcome.error;
    } finally {
      this.uninstallConfirmations.clear();
    }
  }

  private async startInternal(): Promise<void> {
    try {
      this.discovery = await this.discoverCandidates();
      await this.seedStatuses();
      for (const candidate of this.discovery) {
        if (!candidate.valid || !candidate.manifest) continue;
        const record = await this.localRecord(candidate.id);
        if (!record?.approvedHash) continue;
        // Startup just associated this persisted install with candidate by
        // id alone — the ordinary join, and the only one an offline rename
        // (the directory moved while dohc was closed, nothing to watch it
        // happen) ever reaches. The record's own directoryName is still
        // whatever it was before the move; left uncorrected,
        // pluginIdTracesDirectory reads that stale value as proof this
        // plugin's own data belongs to someone else, and cleanup disowns
        // all of it. The record follows the plugin, not the other way
        // around — migrate its settings through the same boundary an
        // online rename already uses.
        if (
          record.directoryName !== undefined &&
          record.directoryName !== candidate.directoryName
        ) {
          // Startup has no discovery history to prove this — unlike
          // processWatcherBatch, which can tell a genuine rename apart from
          // a coexisting duplicate promoted into a vacated id by checking
          // whether the new directory is new to discovery this batch. A
          // duplicate that coexisted
          // the whole time dohc was closed, now the only remaining
          // declarer of this manifest name because the original directory
          // is simply gone, looks identical here: same id, a directoryName
          // mismatch. Content is what a rename actually preserves and a
          // coincidentally-same-named duplicate does not — adopt only when
          // this candidate's own live source hashes to exactly what was
          // approved under this id.
          const liveDigest = await hashPluginSourceFiles(candidate.rootPath);
          if (liveDigest.sourceHash === record.approvedHash) {
            const fromDirectoryName = record.directoryName;
            const toDirectoryName = candidate.directoryName;
            await this.operations.mutateRecord(
              this.options.stateDir,
              this.workspaceRoot,
              candidate.id,
              (existing) =>
                existing ? { ...existing, directoryName: toDirectoryName } : existing,
            );
            await renamePluginSettingsEntry(
              this.workspaceRoot,
              fromDirectoryName,
              toDirectoryName,
            );
            this.emit({
              kind: "renamed",
              pluginId: candidate.id,
              from: fromDirectoryName,
              to: toDirectoryName,
            });
          }
          // On mismatch: do not retarget or migrate. The record still
          // names the missing original directory, and install's own
          // recoverable/cleanup path already handles that; this candidate
          // — a fresh, unrelated one from the record's point of view —
          // still gets the reconciliation below, which verifies its own
          // hash against this SAME approvedHash and correctly holds for
          // approval on the mismatch rather than auto-trusting it.
        }
        this.enqueueSourceRefresh(candidate.id, (change) =>
          this.reconcileApprovedCandidate(candidate.id, true, change));
      }
    } catch (error) {
      throw failureFromUnknown("discovery", "discovery-failed", error);
    }
  }

  private async seedStatuses(): Promise<void> {
    const state = await this.localState();
    for (const candidate of this.discovery) {
      this.seedCandidateStatus(state, candidate);
    }
  }

  /**
   * The persisted installation a discovered candidate belongs to. A valid
   * candidate is named by its manifest, which is the key its record was
   * written under. An invalid one has no manifest to name it, so discovery
   * falls back to the directory name — "foo" against a record keyed
   * "@scope/bar" — and the id lookup misses. Every path uninstall deletes is
   * derived from that key, so the join has to survive the manifest: the
   * record carries the directory it was installed from.
   */
  private installedRecord(
    state: PluginLocalState,
    candidate: InstalledPluginRecord,
  ): { pluginId: string; record: PluginRecordShape } | null {
    const byId = state.plugins[candidate.id];
    if (byId) return { pluginId: candidate.id, record: byId };
    if (candidate.valid && candidate.manifest) return null;
    for (const [pluginId, record] of Object.entries(state.plugins)) {
      if (record.directoryName === candidate.directoryName) {
        return { pluginId, record };
      }
    }
    return null;
  }

  /**
   * Every id whose OWN persisted record traces to this candidate's
   * directory — including candidate.id itself, when a record happens to be
   * filed under exactly that key. Deliberately its own scan, not
   * installedRecord's: installedRecord returns the FIRST match by
   * id-then-directory, correct for seeding one status from one
   * installation, but uninstall()'s own "mark disabled before delete" step
   * (a crash-safety marker, run at the very start of every attempt) writes
   * a bare record under the candidate's OWN id with no directoryName at
   * all — installedRecord's byId branch would match that marker on a RETRY
   * and stop there, never reaching the real record a partially-failed
   * first attempt left behind under the ORIGINAL id.
   *
   * candidate.id is deliberately NOT excluded here: a broken manifest's
   * discovery id (candidate.id) and the caller's pluginId can differ (a
   * row installed under one id, later discovered by its directory-derived
   * fallback), and a genuine record filed under candidate.id's own key —
   * distinct from both pluginId and every other match — must still be
   * found, not silently skipped because it happens to equal candidate.id.
   * The Set the caller builds from this already
   * dedupes any overlap with pluginId, so including it here is never
   * redundant work, only ever a correctness gap when omitted.
   */
  private additionalCleanupIds(
    candidate: InstalledPluginRecord,
    state: PluginLocalState,
  ): string[] {
    const ids: string[] = [];
    for (const [id, record] of Object.entries(state.plugins)) {
      if (record.directoryName === candidate.directoryName) ids.push(id);
    }
    return ids;
  }

  /**
   * Whether pluginId's own persisted record — if any — genuinely belongs
   * to candidate's directory, rather than to some OTHER, unrelated
   * installation whose real id happens to collide with candidate's own
   * fallback id. Nothing recorded there yet is not evidence of a
   * collision, so this reads true by default; only a record that
   * positively names a DIFFERENT directory excludes pluginId. Shared by
   * uninstallPreflight (what the confirmation warns about and compares
   * against) and uninstall (what cleanup actually touches), so both agree.
   */
  private pluginIdTracesDirectory(
    record: PluginRecordShape | undefined,
    candidate: InstalledPluginRecord,
  ): boolean {
    return record?.directoryName === undefined ||
      record.directoryName === candidate.directoryName;
  }

  /**
   * Whether a caller-supplied (pluginId, directoryName) pair names a
   * genuine relationship, checked BEFORE any side effect runs — stricter
   * than pluginIdTracesDirectory, which defaults to true on no evidence
   * (right for deciding whether an ALREADY-accepted pluginId also gets
   * touched by cleanup, wrong for deciding whether to accept the pair at
   * all). A pair is valid when pluginId is exactly the row's own current
   * id (candidate.id, resolved by directory — the ordinary case), or
   * pluginId's own persisted record positively names this exact directory
   * (a broken manifest's ORIGINAL id — still valid even though it differs
   * from candidate.id). Anything else — an arbitrary or
   * stale combination naming two unrelated rows — is rejected outright,
   * before uninstallRootPath or any cleanup identity is resolved from it.
   */
  private pluginIdIsProvenForDirectory(
    pluginId: string,
    record: PluginRecordShape | undefined,
    candidate: InstalledPluginRecord,
  ): boolean {
    return pluginId === candidate.id || record?.directoryName === candidate.directoryName;
  }

  /**
   * Whether this.statuses' entry at candidate.id — if any — genuinely
   * belongs to candidate's own directory, rather than to some OTHER,
   * unrelated installation whose real id happens to collide with this
   * candidate's own fallback id. setStatus(candidate, ...) writes THAT
   * key; calling it when this is false would overwrite an entry that
   * belongs entirely to someone else's plugin — exactly the harm
   * cleanupIds's own pluginIdTracesHere guard closes for disk state, kept
   * as its own check here because it reads this.statuses rather than the
   * persisted record.
   */
  private ownsStatusEntry(candidate: InstalledPluginRecord): boolean {
    const existing = this.statuses.get(candidate.id);
    return !existing || existing.directoryName === candidate.directoryName;
  }

  /**
   * The seeded status that belongs to a discovered candidate. An invalid
   * candidate's status is keyed by its installed plugin id, which its
   * fallback id does not match, so the root path — the one identity both
   * always agree on — is what joins them.
   */
  private statusForCandidate(
    candidate: InstalledPluginRecord,
  ): PluginPipelinePluginStatus | undefined {
    const byId = this.statuses.get(candidate.id);
    if (byId) return byId;
    const root = resolve(candidate.rootPath);
    for (const status of this.statuses.values()) {
      if (!status.valid && resolve(status.rootPath) === root) return status;
    }
    return undefined;
  }

  /**
   * The status a candidate starts a session with. An invalid candidate that
   * still has a persisted installation keeps that installation identity
   * instead of reading as never installed: its live root, plugin data, and
   * state record are all still on disk, and uninstall — which derives every
   * path it deletes from the plugin id, never from the manifest — stays the
   * visible way back. Without this the user has to delete the source folder
   * and the app's own plugin data by hand.
   */
  private seedCandidateStatus(
    state: PluginLocalState,
    candidate: InstalledPluginRecord,
  ): void {
    const installed = this.installedRecord(state, candidate);
    if (!candidate.valid || !candidate.manifest) {
      if (!installed?.record.approvedHash) return;
      const { record } = installed;
      // Seeded under the installed plugin id, not the manifest-less fallback
      // id, so the record, the live root, and the plugin data this status
      // acts on are the ones this installation actually owns.
      this.setStatus({ ...candidate, id: installed.pluginId }, {
        status: "invalid",
        disabledReason: null,
        runtimeStatus: null,
        sourceHash: null,
        approvedHash: record.approvedHash,
        installedBaselineHash: record.installedBaselineHash ?? null,
        diagnostics: [...candidate.diagnostics],
        error: invalidPluginError(candidate),
      });
      return;
    }
    const record = installed?.record;
    this.setStatus(candidate, {
      status: record?.approvedHash
        ? record.disabled === true
          ? "disabled"
          : "queued"
        : "discovered",
      disabledReason: record?.disabled === true ? "user" : null,
      approvedHash: record?.approvedHash ?? null,
      installedBaselineHash: record?.installedBaselineHash ?? null,
      diagnostics: [...candidate.diagnostics],
    });
  }

  private async processWatcherBatch(events: readonly WatcherEvent[]): Promise<void> {
    if (this.disposed) return;
    const previous = this.discovery;
    const next = await this.discoverCandidates();
    this.discovery = next;
    await this.seedStatusesForNewCandidates(next);

    const previousValid = previous.filter(
      (candidate): candidate is InstalledPluginRecord & { manifest: DohcPluginManifest } =>
        candidate.valid && candidate.manifest !== null,
    );
    const nextValid = next.filter(
      (candidate): candidate is InstalledPluginRecord & { manifest: DohcPluginManifest } =>
        candidate.valid && candidate.manifest !== null,
    );
    const nextById = new Map(nextValid.map((candidate) => [candidate.id, candidate]));
    const nextByRoot = new Map(
      nextValid.map((candidate) => [resolve(candidate.rootPath), candidate]),
    );
    const nextRoots = new Set(next.map((candidate) => resolve(candidate.rootPath)));
    const replaced = new Set<string>();
    const departing: InstalledPluginRecord[] = [];
    const replacements: InstalledPluginRecord[] = [];
    // The new directoryName a departing id's OWN settings entry should
    // move to — set only when this exact id reappears, within this same
    // batch, under a different directory: the one case the pipeline can
    // prove is a rename rather than an unrelated departure and a
    // coincidental later arrival.
    const renamedDirectory = new Map<string, string>();

    for (const oldCandidate of previousValid) {
      const sameId = nextById.get(oldCandidate.id);
      const sameRoot = nextByRoot.get(resolve(oldCandidate.rootPath));
      const identityChanged =
        !sameId ||
        resolve(sameId.rootPath) !== resolve(oldCandidate.rootPath) ||
        !sameRoot ||
        sameRoot.id !== oldCandidate.id;
      if (!identityChanged) continue;
      // A root still on disk whose manifest is momentarily invalid — the
      // ordinary state while a user's agent edits a plugin — has not
      // departed. Deleting its record, its approval, and its plugin data
      // here uninstalled a plugin that only needed its manifest finished;
      // the invalid state has its own handling, which keeps the
      // installation and still offers Uninstall. It is a departure only
      // when the root is gone, when a valid manifest
      // gave this root a different id, or when another valid root took this
      // id — and that last one must still clean up before its replacement
      // is reconciled.
      if (!sameId && !sameRoot && nextRoots.has(resolve(oldCandidate.rootPath))) {
        continue;
      }

      departing.push(oldCandidate);
      // Not a rename when sameId's directory already existed as SOME
      // candidate before this batch (valid or not) — that is a duplicate
      // this id was already sharing, now promoted into the vacancy
      // oldCandidate's own departure just opened, never oldCandidate's own
      // content arriving there. A genuine rename's target directory is
      // brand new to discovery this batch.
      if (
        sameId &&
        sameId.directoryName !== oldCandidate.directoryName &&
        !previous.some((entry) => entry.directoryName === sameId.directoryName)
      ) {
        renamedDirectory.set(oldCandidate.id, sameId.directoryName);
      }
      const replacement = sameRoot ?? sameId;
      if (
        replacement?.valid &&
        replacement.manifest &&
        !replaced.has(candidateKey(replacement))
      ) {
        replaced.add(candidateKey(replacement));
        replacements.push(replacement);
      }
    }

    // Every departing identity is fully removed — including its local
    // state record — before any replacement is reconciled. A replacement
    // can land on the exact id a departing identity is vacating (a rename
    // colliding with an already-installed id, or a literal two-way swap);
    // reconciling it first can still observe that departing identity's
    // still-live host status and its about-to-be-deleted approvedHash —
    // both let byte-identical relocated content carry the old identity's
    // approval and running state across without ever holding for approval.
    for (const oldCandidate of departing) {
      await this.enqueuePreservedBackground(oldCandidate.id, async (change) => {
        await this.removeOldIdentity(
          oldCandidate,
          change,
          renamedDirectory.get(oldCandidate.id),
        );
        return existingHostResult(undefined);
      });
    }
    // The old identity's approval never carries to the replacement:
    // a manifest-name change or root swap is a new identity,
    // and reconcileApprovedCandidate keys approval strictly by this
    // identity's own (id, content hash) record — matching a mismatch or
    // a never-approved id the same way any other unapproved discovery
    // does, and continuing seamlessly only when this identity's own
    // approval already matches its current content.
    for (const replacement of replacements) {
      this.enqueueSourceRefresh(replacement.id, (change) =>
        this.reconcileApprovedCandidate(replacement.id, true, change));
    }

    for (const candidate of nextValid) {
      if (replaced.has(candidateKey(candidate))) continue;
      const sourceRoot = relativeSourceRoot(this.workspaceRoot, candidate.rootPath);
      if (!events.some((event) => eventTouchesRoot(event, sourceRoot))) continue;
      // Joined by root, not by id alone: a root whose manifest was invalid a
      // moment ago carries discovery's fallback id, and restoring the
      // manifest has to reconcile the installation whose record survived
      // that invalid window back to running.
      const old = previous.find((entry) =>
        resolve(entry.rootPath) === resolve(candidate.rootPath) &&
        (entry.valid && entry.manifest !== null ? entry.id === candidate.id : true)
      );
      if (!old) continue;
      this.enqueueSourceRefresh(candidate.id, (change) =>
        this.reconcileApprovedCandidate(candidate.id, false, change));
    }

    // An invalid candidate (a broken manifest, or none at all) that was
    // never installed gets no status entry and so no "changed"/"removed"
    // event of its own above — the only signal left honest enough to name
    // is that discovery's invalid set itself moved. Fingerprinted by
    // directoryName AND its diagnostics, not directoryName alone: one
    // malformed manifest replaced by another, differently malformed one
    // leaves the directory NAME set unchanged while the row's own
    // diagnostics — what the Plugins view actually shows for it — did
    // change.
    const invalidFingerprints = (candidates: readonly InstalledPluginRecord[]) =>
      new Set(
        candidates
          .filter((candidate) => !candidate.valid || candidate.manifest === null)
          .map((candidate) => `${candidate.directoryName}\0${candidate.diagnostics.join("\0")}`),
      );
    const previousInvalid = invalidFingerprints(previous);
    const nextInvalid = invalidFingerprints(next);
    const invalidSetChanged =
      previousInvalid.size !== nextInvalid.size ||
      [...previousInvalid].some((fingerprint) => !nextInvalid.has(fingerprint));
    if (invalidSetChanged) this.emit({ kind: "discovery-changed" });
  }

  private async seedStatusesForNewCandidates(
    candidates: readonly InstalledPluginRecord[],
  ): Promise<void> {
    const state = await this.localState();
    for (const candidate of candidates) {
      const status = this.statusForCandidate(candidate);
      // A candidate whose manifest just broke still carries the status of the
      // valid plugin it was a moment ago, and a candidate whose manifest was
      // just restored still carries the invalid one. Reseeding either gives
      // it the status a fresh launch would.
      if (
        status &&
        status.valid === (candidate.valid && candidate.manifest !== null)
      ) {
        continue;
      }
      this.seedCandidateStatus(state, candidate);
    }
  }

  /**
   * The one source-refresh ladder behind startup reconciliation, watcher
   * batches, and door writes. Verify the live tree against the approved
   * hash; when it changed, auto-approve iff the live tree equals the
   * approved baseline plus the accumulated door-written deltas
   * (doorApprovedHash) — the design doc's predicate — and hold for approval
   * otherwise. A queued watcher reconcile can be the only refresh that
   * survives enqueueSourceRefresh's dedup after a door write, so it must
   * consult the same predicate rather than holding a pure door-write
   * sequence for approval.
   */
  private async reconcileApprovedCandidate(
    pluginId: string,
    startRuntime: boolean,
    change: PluginHostChangeAuthority,
  ): Promise<PluginHostStartResult<void>> {
    // Consumed first, before any early return: this is the refresh the racing
    // write queued, and a mark left behind by an install that never recorded
    // an approval would explain a later, unrelated hold (#803).
    const racedInstall = this.sourceChangedDuringInstall.delete(pluginId);
    const candidate = this.validCandidate(pluginId);
    if (!candidate) return existingHostResult(undefined);
    const record = await this.localRecord(pluginId);
    if (!record?.approvedHash) {
      this.setStatus(candidate, { status: "discovered" });
      return existingHostResult(undefined);
    }
    // The disabled bit is the user's own choice only when the user chose
    // it: the approval path's hold also writes disabled: true, and a tree
    // whose deviation from baseline is all door-written satisfies that
    // hold — an out-of-band change on an explicitly disabled plugin must
    // still never silently re-enable it.
    const priorDisabledReason = record.disabled === true
      ? this.statuses.get(pluginId)?.disabledReason ?? "user"
      : undefined;
    // Captured before verifyApprovedSource's own snapshotOrThrow clears it
    // to a busy "snapshotting" status — restored below if this reconcile
    // turns out to be a no-op (#779 round 20 finding 3).
    const priorStatus = this.statuses.get(pluginId);
    const verified = await this.verifyApprovedSource(candidate, record.approvedHash);
    if (verified.kind === "failed") return existingHostResult(undefined);
    if (verified.kind === "changed") {
      // The plugin's own last approved attempt, not a fresh out-of-band
      // change — buildFromCurrentSource's own retry path accepts this
      // exact hash too (alsoAcceptHash), one shared rule. Gated on
      // hasRecoverableFailure, the same fact Retry itself requires: once a
      // later hold genuinely ends this recovery, a stale attempt hash must
      // not resurrect it for content that only happens to match again
      // (#779 round 21 finding 3).
      if (
        priorStatus &&
        this.hasRecoverableFailure(pluginId) &&
        verified.sourceHash === this.lastApprovedAttemptHash.get(pluginId)
      ) {
        this.setStatus(candidate, priorStatus);
        return existingHostResult(undefined);
      }
      const doorHash = await this.doorApprovedHash(pluginId, record.approvedHash);
      if (doorHash === null || verified.sourceHash !== doorHash) {
        return mapHostResult(await this.holdForApproval(
          candidate,
          verified.sourceHash,
          priorDisabledReason,
          racedInstall ? "changed-during-install" : "changed-after-install",
          undefined,
          change,
        ), () => undefined);
      }
      const disabled = priorDisabledReason === "user";
      return mapHostResult(await this.runFullBuild({
        candidate,
        startRuntime: !disabled,
        disabledReasonAfterBuild: disabled ? "user" : null,
        resetCrashAccounting: !disabled,
        freshInstall: false,
        // The build snapshots the tree again, and this comparison is
        // already stale by then. Binding the build to the hash this check
        // passed on is what stops a change landing in that window from
        // riding the door write to approval.
        expectedHash: doorHash,
      }, change), () => undefined);
    }
    this.setStatus(candidate, {
      sourceHash: verified.snapshot.sourceHash,
      approvedHash: record.approvedHash,
      installedBaselineHash: record.installedBaselineHash ?? null,
    });
    if (record.disabled === true) {
      // An approval hold is satisfied when the live tree — here equal to the
      // approved hash — also equals baseline plus door deltas: the door
      // restored every interloped byte, so the plugin comes back instead of
      // idling under a hold whose cause is gone.
      // Only that hold waits on content. A user disable, a crash loop, and a
      // failed repair are all decisions about the plugin, so releasing them
      // here restarted a plugin the app had turned off — and reset the crash
      // accounting that turned it off.
      const doorHash = priorDisabledReason === "approval"
        ? await this.doorApprovedHash(pluginId, record.approvedHash)
        : null;
      if (doorHash !== record.approvedHash) {
        this.setStatus(candidate, {
          status: "disabled",
          disabledReason: priorDisabledReason ?? "user",
          runtimeStatus: null,
        });
        return existingHostResult(undefined);
      }
      return mapHostResult(await this.runFullBuild({
        candidate,
        startRuntime: true,
        disabledReasonAfterBuild: null,
        resetCrashAccounting: true,
        freshInstall: false,
        expectedHash: record.approvedHash,
      }, change), () => undefined);
    }
    if (!startRuntime || this.host.getStatus(pluginId)) {
      // A no-op reconcile (nothing to rebuild, nothing to start) must
      // restore the status this function's own snapshotOrThrow set to
      // "snapshotting" at the top — otherwise a watcher event for an
      // already-running, unchanged plugin left it permanently stuck
      // reading "Checking source" (fixround Section B item 12).
      const runtimeStatus = this.host.getStatus(pluginId);
      this.setStatus(candidate, {
        status: runtimeStatus ?? "queued",
        runtimeStatus: runtimeStatus ?? null,
        error: null,
      });
      return existingHostResult(undefined);
    }
    return mapHostResult(await this.runFullBuild({
      candidate,
      startRuntime: true,
      disabledReasonAfterBuild: null,
      resetCrashAccounting: true,
      freshInstall: false,
      // Bound to the hash verifyApprovedSource just confirmed: the build's
      // own snapshot is two full tree copies later, and an out-of-band write
      // landing in between must hold for approval, not ride this reconcile
      // to auto-approval.
      expectedHash: record.approvedHash,
    }, change), () => undefined);
  }

  private async removeOldIdentity(
    candidate: InstalledPluginRecord,
    change: PluginHostChangeAuthority,
    renamedToDirectoryName?: string,
  ): Promise<void> {
    try {
      await this.stopTerminalRuntime(candidate.id, change);
      await this.operations.mutateRecord(
        this.options.stateDir,
        this.workspaceRoot,
        candidate.id,
        () => undefined,
      );
      // Only ever set for the one case processWatcherBatch can itself
      // prove is a rename — this exact id reappearing, in this same
      // batch, under a different directory — not a guess this method
      // makes on its own.
      if (renamedToDirectoryName !== undefined) {
        await renamePluginSettingsEntry(
          this.workspaceRoot,
          candidate.directoryName,
          renamedToDirectoryName,
        );
      }
      await this.removePluginData(candidate.id);
      this.statuses.delete(candidate.id);
      this.doorWrittenDeltas.delete(candidate.id);
      this.lastApprovedAttemptHash.delete(candidate.id);
      this.sourceChangedDuringInstall.delete(candidate.id);
      this.uninstallConfirmations.delete(
        uninstallConfirmationKey(candidate.id, candidate.directoryName),
      );
      // A proven rename reports the fact directly — never "removed", which
      // would read as a genuine departure to a consumer tracking one open
      // row for this id.
      this.emit(
        renamedToDirectoryName !== undefined
          ? {
            kind: "renamed",
            pluginId: candidate.id,
            from: candidate.directoryName,
            to: renamedToDirectoryName,
          }
          : { kind: "removed", pluginId: candidate.id, directoryName: candidate.directoryName },
      );
    } catch (error) {
      const detail = pipelineError(
        "uninstall",
        "identity-cleanup-failed",
        errorMessage(error),
      );
      this.failure(candidate.id, detail);
      throw new PipelineFailure(detail);
    }
  }

  private async stopOldRuntime(
    pluginId: string,
    change: PluginHostChangeAuthority,
    callbacks: {
      onWillStop?: () => void;
      onRuntimeStopped?: () => void | Promise<void>;
      onStopped?: () => void;
      markStopped?: () => void;
    } = {},
  ): Promise<void> {
    const stopped = await change.stop({ onWillStop: callbacks.onWillStop });
    if (stopped.kind === "refused" || stopped.kind === "superseded") {
      throw new PipelineFailure(this.hostChangeInProgressError(pluginId));
    }
    if (!stopped.drained) {
      console.warn(
        `[desktop] Plugin "${pluginId}" still has work in flight ` +
          `after ${PLUGIN_HOST_DRAIN_DEADLINE_MS} ms. Stopping its host anyway.`,
      );
    }
    if (stopped.stopError !== undefined) {
      console.error(
        `[PluginPipeline] stop for "${pluginId}" rejected after its record was already gone.`,
        stopped.stopError,
      );
    }
    // The old runtime a recovery would have preserved is genuinely gone
    // now, whatever reason stopped it — the recovery this key stood for
    // ends here too, or a stale attempt hash could resurrect it later for
    // content that only happens to match again (#779 round 21 finding 3).
    this.recoveryState.delete(pluginId);
    this.lastApprovedAttemptHash.delete(pluginId);
    // The stop already happened — mark it before running its consequences,
    // so a throwing notification can never look like the stop never occurred.
    callbacks.markStopped?.();
    try {
      await callbacks.onRuntimeStopped?.();
    } catch (error) {
      // Best-effort: the host is already gone, so cleanup failure cannot
      // restore it or turn this completed stop back into a failed stop.
      console.error(
        `[PluginPipeline] runtime-stopped cleanup failed for "${pluginId}".`,
        error,
      );
    }
    try {
      callbacks.onStopped?.();
    } catch (error) {
      // Best-effort: a notification failure must never corrupt build state.
      console.error(`[PluginPipeline] old-runtime-stopped notification failed for "${pluginId}".`, error);
    }
  }

  private stopTerminalRuntime(
    pluginId: string,
    change: PluginHostChangeAuthority,
    onWillStop?: () => void,
  ): Promise<void> {
    return this.stopOldRuntime(pluginId, change, {
      onWillStop,
      onRuntimeStopped: () => this.options.onRuntimeStopped?.(pluginId),
    });
  }

  private startHost(
    pluginRoot: string,
    directoryName: string,
    manifest: DohcPluginManifest,
  ): Promise<PluginHostStartEvidence> {
    // PluginHost.start returns as soon as the exact record exists. Activation
    // continues under the host's own bounded promise and is not a pipeline
    // admission condition.
    return this.host.start(pluginRoot, directoryName, manifest);
  }

  private hostChangeInProgressError(pluginId: string): PluginPipelineError {
    return pipelineError(
      "runtime",
      HOST_CHANGE_REFUSED_ERROR_CODE,
      `dohc is still working on plugin "${pluginId}". Try the command again in a moment.`,
    );
  }

  private restoreStatusAfterHostChangeRefusal(
    candidate: InstalledPluginRecord & { manifest: DohcPluginManifest },
    priorStatus: PluginPipelinePluginStatus | undefined,
    result: PluginHostStartResult<PluginPipelineActionResult>,
  ): PluginHostStartResult<PluginPipelineActionResult> {
    if (
      !priorStatus ||
      result.value.ok ||
      result.value.error.code !== HOST_CHANGE_REFUSED_ERROR_CODE
    ) {
      return result;
    }
    const restored = this.setStatus(candidate, priorStatus);
    return mapHostResult(result, (value) => ({
      ...value,
      plugin: cloneStatus(restored),
    }));
  }

  /**
   * Retries case recovery for every still-provisional delta before
   * doorApprovedHash hashes them: confirms a landing-time fold's guessed
   * ownership, or recovers a leaf's on-disk spelling.
   */
  private async retryProvisionalDeltaRecovery(pluginId: string): Promise<void> {
    if (this.platform !== "win32" && this.platform !== "darwin") return;
    const deltas = this.doorWrittenDeltas.get(pluginId);
    if (!deltas) return;
    const candidate = this.validCandidate(pluginId);
    if (!candidate) return;
    const root = resolve(candidate.rootPath);
    for (const [relPath, delta] of [...deltas]) {
      if (!delta.provisional) continue;
      const origin = delta.provisionalOrigin;
      const { segments, fullyRecovered } = await recoverOnDiskSegments(
        origin !== undefined ? this.workspaceRoot : root,
        origin !== undefined
          ? relative(this.workspaceRoot, origin).replaceAll("\\", "/")
          : relPath,
        undefined,
      );
      const current = deltas.get(relPath);
      if (!current || current.seq !== delta.seq) continue;
      if (!fullyRecovered) continue;
      const recoveredRelPath = origin !== undefined
        ? this.sourceRelPathExact(candidate, join(this.workspaceRoot, ...segments))
        : segments.join("/");
      if (recoveredRelPath === null) {
        // Recovery resolved the write's true on-disk path, and it is not
        // under this plugin's real root: the landing-time fold guessed
        // ownership from spelling alone, and a case-sensitive volume just
        // proved that guess wrong. Drop it — the same confirmation
        // rekeyDoorWrittenSourceChange applies to a delta the writer's own
        // recovery rekeys.
        deltas.delete(relPath);
        continue;
      }
      if (this.isExcludedRelPath(recoveredRelPath)) {
        deltas.delete(relPath);
        continue;
      }
      if (recoveredRelPath === relPath) {
        deltas.set(relPath, { sha256: delta.sha256, seq: delta.seq });
        continue;
      }
      deltas.delete(relPath);
      const destination = deltas.get(recoveredRelPath);
      if (!destination || destination.seq <= delta.seq) {
        deltas.set(recoveredRelPath, { sha256: delta.sha256, seq: delta.seq });
      }
    }
  }

  /**
   * The one tree the door path may auto-approve: the approved per-file
   * baseline overlaid with every door-written delta recorded since. Null
   * when no baseline verifies against the approved hash — a fresh
   * install's first approval is user-driven, and a baseline that cannot be
   * read or does not describe the approved content proves nothing, so
   * nothing auto-approves. Only handleDoorWrittenSourceChange writes
   * deltas, so any other byte on disk — an interloper file, a
   * watcher-class edit, an out-of-band delete — makes the live tree miss
   * this hash and hold for approval. The SDK write surface has no delete,
   * so a delta only ever adds or replaces one file. The retry also confirms
   * ownership for a delta attributed through the landing-time path fold.
   */
  private async doorApprovedHash(
    pluginId: string,
    approvedHash: string,
  ): Promise<string | null> {
    const baseline = await readPluginBaselineManifest(this.dohcDir, pluginId);
    if (!baseline || baseline.sourceHash !== approvedHash) return null;
    await this.retryProvisionalDeltaRecovery(pluginId);
    return canonicalPluginSourceHash(
      overlayDoorWrittenSourceDeltas(
        baseline.files,
        this.doorWrittenDeltas.get(pluginId) ?? [],
        this.platform,
      ),
    );
  }

  private async runFullBuild(
    input: FullBuildOptions,
    change?: PluginHostChangeAuthority,
  ): Promise<PluginHostStartResult<PluginPipelineActionResult>> {
    const { candidate } = input;
    const oldRuntime = this.host.getStatus(candidate.id) ?? null;
    if (!candidate.manifest) {
      return existingHostResult(this.failure(
        candidate.id,
        pipelineError("discovery", "invalid-plugin", "Plugin manifest is invalid."),
      ));
    }
    const validCandidate = { ...candidate, manifest: candidate.manifest };
    // Every setStatus call this attempt makes below — "snapshotting",
    // "installing", "scanning", "building" — optimistically re-derives
    // commands/webApps/panels/settings from this candidate's own manifest,
    // since recoveryState has no key for it yet. If the attempt then fails
    // with nothing recoverable from the live root, the catch below needs
    // what those fields held before this attempt touched them, not
    // whatever they drifted to along the way (#779 round 22 finding 5).
    const priorStatus = this.statuses.get(candidate.id) ?? null;
    let oldRuntimeStopped = false;
    let startEvidence: PluginHostStartEvidence | null = null;
    let sourceHash: string | null = null;
    // The staged source tree, until it is published or discarded. Anything
    // that throws below leaves it staged, so the catch has to drop it.
    let unpublishedSource: { discard: () => Promise<void> } | null = null;
    // Sampled before the snapshot reads the tree: a delta at or below this
    // mark is settled by this build's success (its bytes are in the new
    // baseline, or a user gesture approved whatever superseded them); a
    // delta above it landed after the snapshot and must survive for its own
    // queued refresh.
    const doorSeqAtSnapshot = this.doorWriteSeq;
    if (input.freshInstall) this.freshInstallsInFlight.add(candidate.id);
    try {
      const snapshot = await this.snapshotOrThrow(validCandidate);
      unpublishedSource = snapshot;
      sourceHash = snapshot.sourceHash;
      if (input.rememberAsApprovedAttempt) {
        this.lastApprovedAttemptHash.set(candidate.id, snapshot.sourceHash);
      }
      if (
        input.expectedHash !== undefined &&
        snapshot.sourceHash !== input.expectedHash &&
        snapshot.sourceHash !== input.alsoAcceptHash
      ) {
        // Ownership passes back only once the tree is actually gone: a
        // discard that rejects here has to reach the catch's own cleanup
        // instead of leaving staged bytes beside the live root.
        await snapshot.discard();
        unpublishedSource = null;
        const priorDisabledReason = input.disabledReasonAfterBuild === "user"
          ? this.statuses.get(candidate.id)?.disabledReason ?? "user"
          : undefined;
        return await this.holdForApproval(
          validCandidate,
          snapshot.sourceHash,
          priorDisabledReason,
          "changed-after-install",
          input.onOldRuntimeStopped,
          change,
        );
      }
      // snapshotOrThrow's own digest is reused for the install baseline
      // manifest below instead of re-hashing the whole tree a second time
      // (fixround Section C F1) — writePluginBaselineManifest already
      // enforces canonicalPluginSourceHash(digest.files) === digest.sourceHash
      // and digest.sourceHash === installedBaselineHash, which is the same
      // invariant a second hash pass would have re-verified.
      const baselineDigest = snapshot.digest;

      // candidate.manifest was parsed from the live root at an earlier
      // discovery pass and can have drifted from what this snapshot just
      // hash-verified. Everything from here on — the lifecycle scan, the
      // build's entry point, and the capabilities handed to the running
      // process — must read the manifest as it exists in the snapshot
      // itself, never that stale copy.
      const manifestRead = await readPluginManifestFile(snapshot.snapshotRoot);
      if (!manifestRead.ok) {
        throw new PipelineFailure(pipelineError(
          "scan",
          "invalid-manifest",
          `Plugin manifest in the approved snapshot is invalid: ` +
            manifestRead.diagnostics.join("; "),
        ));
      }
      const manifest = manifestRead.manifest;
      if (manifest.name !== candidate.id) {
        throw new PipelineFailure(pipelineError(
          "scan",
          "invalid-manifest",
          `Plugin manifest in the approved snapshot is named "${manifest.name}", ` +
            `not "${candidate.id}".`,
        ));
      }

      this.setStatus(candidate, { status: "installing", error: null });
      const installResult = await this.operations.install({
        workspaceRoot: this.workspaceRoot,
        pluginId: candidate.id,
        snapshotRoot: snapshot.snapshotRoot,
        pnpmPaths: snapshot.pnpmPaths,
        resourcesBasePath: this.options.resourcesBasePath,
        pnpmRunnerEntry: this.options.pnpmRunnerEntry,
        signal: this.abortController.signal,
      });
      this.unwrap("install", installResult);

      this.setStatus(candidate, { status: "scanning" });
      const scan = this.unwrap("scan", await this.operations.scan({
        snapshotRoot: snapshot.snapshotRoot,
        manifest,
      }));
      this.setStatus(candidate, { warnings: [...scan.warningLines] });

      this.setStatus(candidate, { status: "building" });
      const built = this.unwrap("build", await this.operations.build({
        dohcDir: this.dohcDir,
        pluginId: candidate.id,
        snapshotRoot: snapshot.snapshotRoot,
        manifest,
        resourcesBasePath: this.options.resourcesBasePath,
        signal: this.abortController.signal,
      }));
      // The build stages its output; it does not replace the live root. The
      // record that approves these exact bytes is written first, so a failed
      // write leaves the old, already-approved bundle serving instead of
      // publishing bytes whose approval was never recorded.
      try {
        await this.operations.mutateRecord(
          this.options.stateDir,
          this.workspaceRoot,
          candidate.id,
          () => ({
            disabled: !input.startRuntime,
            approvedHash: snapshot.sourceHash,
            installedBaselineHash: snapshot.sourceHash,
            approvedBundleHash: built.bundleHash,
            directoryName: candidate.directoryName,
          }),
        );
      } catch (error) {
        // The next install re-stages the snapshot, so a discard that also
        // fails cannot make the recorded state wrong — only the staged tree
        // is lost.
        await built.discard().catch(() => undefined);
        throw failureFromUnknown("state", "state-write-failed", error);
      }
      this.lastApprovedAttemptHash.delete(candidate.id);

      // The old process stops before either publish. It is full-trust code
      // that knows its own live root, so leaving it running while the live
      // root is replaced let it overwrite the published bundle in the window
      // before the new process starts — unapproved bytes running under the
      // approvedBundleHash just recorded for them.
      if (oldRuntime) {
        if (!change) {
          throw new Error(
            `Plugin "${candidate.id}" cannot replace a running host without change authority.`,
          );
        }
        await this.stopOldRuntime(
          candidate.id,
          change,
          {
            onStopped: input.onOldRuntimeStopped,
            markStopped: () => { oldRuntimeStopped = true; },
          },
        );
      }

      // Both publishes happen only now, with the record that approves these
      // exact bytes already durable. The source goes first because the
      // bundle's own publish carries the live snapshot into the tree it swaps
      // in; between the two the live root holds the new, approved source and
      // the previous bundle, which the recorded approvedBundleHash no longer
      // matches, so the next start rebuilds rather than trusting it.
      unpublishedSource = null;
      try {
        await snapshot.publish();
      } catch (error) {
        await built.discard().catch(() => undefined);
        throw failureFromUnknown("snapshot", "publish-failed", error);
      }

      let published: { cleanupWarning: string | null };
      try {
        published = await built.publish();
      } catch (error) {
        throw failureFromUnknown("build", "publish-failed", error);
      }
      // The baseline manifest lives inside the live root that publish just
      // replaced, so it can only be written now. It is uninstall's evidence
      // of the installed source, not an approval gate: a failure here cannot
      // let unapproved bytes run.
      try {
        await this.operations.writeBaseline({
          dohcDir: this.dohcDir,
          pluginId: candidate.id,
          baselineDigest,
          installedBaselineHash: snapshot.sourceHash,
        });
      } catch (error) {
        throw failureFromUnknown("state", "state-write-failed", error);
      }
      const settledDeltas = this.doorWrittenDeltas.get(candidate.id);
      if (settledDeltas) {
        for (const [relPath, delta] of settledDeltas) {
          if (delta.seq <= doorSeqAtSnapshot) settledDeltas.delete(relPath);
        }
        if (settledDeltas.size === 0) {
          this.doorWrittenDeltas.delete(candidate.id);
        }
      }
      const warnings = [
        ...scan.warningLines,
        ...(published.cleanupWarning ? [published.cleanupWarning] : []),
      ];

      if (input.startRuntime) {
        this.setStatus(candidate, { status: "starting", warnings });
        if (input.resetCrashAccounting) {
          this.host.resetCrashAccounting(candidate.id);
        }
        // The published bundle is re-read here, not trusted from the build:
        // approval binds the bytes that execute, and anything that reached
        // the live root between publication and this start is not what the
        // record approves.
        if (!await this.verifiedLiveBundle(built.liveRoot, built.bundleHash)) {
          throw new PipelineFailure(pipelineError(
            "build",
            "bundle-changed",
            `Plugin "${candidate.id}" bundle at ${built.liveRoot} changed after ` +
              "it was published, so it no longer matches the approval recorded " +
              "for it. Install the plugin again.",
          ));
        }
        startEvidence = await this.startHost(
          built.liveRoot,
          candidate.directoryName,
          generatedManifest(manifest),
        );
      }

      this.recoveryState.delete(candidate.id);
      // Discovery's own cached candidate for this id can be stale by now —
      // a source edit made again right after discovery's last scan (but
      // before this exact snapshot was taken) still lands in the snapshot,
      // just not in that cache. Refreshed here so pluginRegistration()
      // (and anything else that reads this.discovery) is accurate right
      // away instead of only after the next watcher rescan happens to run.
      // A later rescan still wins normally, the same as any other edit
      // (#779 round 23 finding 5). iconPath is manifest-derived the same
      // way discovery's own scan computes it — left at its stale value, a
      // build that added, removed or changed a plugin's icon would keep
      // showing whatever discovery's last scan found instead (#779 round
      // 25 finding 2).
      const builtIcon = manifest.icon
        ? (await verifyPluginIcon(candidate.rootPath, manifest.icon)).icon
        : null;
      this.discovery = this.discovery.map((entry) =>
        candidateKey(entry) === candidateKey(candidate)
          ? { ...entry, manifest, iconPath: builtIcon }
          : entry
      );
      const result = this.success(this.setStatus(candidate, {
        status: input.startRuntime ? "starting" : "disabled",
        disabledReason: input.disabledReasonAfterBuild,
        runtimeStatus: input.startRuntime ? "starting" : null,
        sourceHash: snapshot.sourceHash,
        approvedHash: snapshot.sourceHash,
        installedBaselineHash: snapshot.sourceHash,
        warnings,
        error: null,
      }, { manifest, iconPath: builtIcon }));
      return startEvidence
        ? startedHostResult(result, startEvidence)
        : existingHostResult(result);
    } catch (error) {
      await unpublishedSource?.discard().catch(() => undefined);
      const detail = error instanceof PipelineFailure
        ? error.detail
        : pipelineError("runtime", "pipeline-failed", errorMessage(error));
      // oldRuntime was read before this attempt touched anything. When
      // oldRuntimeStopped is also true, this attempt genuinely stopped it
      // before publish or start then failed — oldRuntime's own pre-build
      // status would otherwise claim a runtime that is now gone. Reading
      // the host directly reports what is actually running at the moment
      // of failure instead (#779 round 24 finding 2).
      const currentRuntimeStatus =
        this.host.getStatus(candidate.id) ?? null;
      if (input.freshInstall && oldRuntime === null) {
        await this.operations.mutateRecord(
          this.options.stateDir,
          this.workspaceRoot,
          candidate.id,
          (record) => ({ ...record, disabled: true }),
        ).catch(() => undefined);
        this.setStatus(candidate, {
          status: "disabled-pending-repair",
          disabledReason: "repair",
          runtimeStatus: null,
          sourceHash,
          error: detail,
        });
      } else {
        // Recorded whether or not a runtime was ever running to preserve:
        // a stopped plugin's own failed approve needs the same durable
        // fact a running one does, or a later watcher-triggered reseed can
        // still wipe status "failed" out from under it with nothing left
        // to prove Retry is still owed (#779 round 22 finding 4).
        let recovered = false;
        if (!oldRuntimeStopped) {
          await this.captureRecoveredManifest(candidate.id);
          recovered = Boolean(this.recoveryState.get(candidate.id));
        }
        this.setStatus(candidate, {
          status: "failed",
          runtimeStatus: currentRuntimeStatus,
          sourceHash,
          error: detail,
          // priorStatus: see its own definition above (#779 round 22
          // finding 5).
          ...(!recovered && priorStatus
            ? {
              settings: priorStatus.settings,
              webApps: priorStatus.webApps,
              panels: priorStatus.panels,
              commands: priorStatus.commands,
            }
            : {}),
        });
      }
      const result = this.failure(candidate.id, detail);
      return startEvidence
        ? startedHostResult(result, startEvidence)
        : existingHostResult(result);
    } finally {
      this.freshInstallsInFlight.delete(candidate.id);
    }
  }

  /**
   * Turns a plugin off until the user approves the source now on disk, and
   * says which change did it. `cause` separates the two ways a tree can stop
   * matching its approval: an edit after the install finished, or a write
   * that raced the install itself. Both hold — the approval gate never bends
   * — but only one of them is something the user did, so a hold with no
   * message left a plugin that switched itself off seconds after Install
   * with nothing on screen to explain it (#803).
   */
  private async holdForApproval(
    candidate: InstalledPluginRecord & { manifest: DohcPluginManifest },
    sourceHash: string,
    priorDisabledReason?: PluginPipelinePluginStatus["disabledReason"],
    cause: "changed-after-install" | "changed-during-install" =
      "changed-after-install",
    onOldRuntimeStopped?: () => void,
    change?: PluginHostChangeAuthority,
  ): Promise<PluginHostStartResult<PluginPipelineActionResult>> {
    const error = cause === "changed-during-install"
      ? pipelineError(
        "snapshot",
        "source-changed-during-install",
        `The source of "${candidate.id}" changed while dohc was installing ` +
          "it. Approve the new source to install it.",
      )
      : pipelineError(
        "snapshot",
        "source-changed-after-install",
        `The source of "${candidate.id}" changed after dohc installed it. ` +
          "Approve the new source to install it.",
      );
    try {
      if (this.host.currentRecord(candidate.id)) {
        if (!change) {
          throw new Error(
            `Plugin "${candidate.id}" cannot stop a running host without change authority.`,
          );
        }
        await this.stopOldRuntime(candidate.id, change, {
          onStopped: onOldRuntimeStopped,
        });
      }
      await this.operations.mutateRecord(
        this.options.stateDir,
        this.workspaceRoot,
        candidate.id,
        (record) => ({ ...record, disabled: true }),
      );
      const record = await this.localRecord(candidate.id);
      return existingHostResult(this.success(this.setStatus(candidate, {
        status: "disabled-pending-approval",
        disabledReason: priorDisabledReason ?? "approval",
        runtimeStatus: null,
        sourceHash,
        approvedHash: record?.approvedHash ?? null,
        installedBaselineHash: record?.installedBaselineHash ?? null,
        error,
      })));
    } catch (holdError) {
      const detail = holdError instanceof PipelineFailure
        ? holdError.detail
        : pipelineError("state", "approval-hold-failed", errorMessage(holdError));
      return existingHostResult(this.failure(candidate.id, detail));
    }
  }

  /**
   * The source check for every caller that only verifies an already-approved
   * hash: enable, ensureStarted, and reconcile. The snapshot is staged, never
   * published on sight. A tree that no longer hashes to the approved value is
   * discarded, so the live snapshot keeps serving the approved bytes while
   * the change waits for approval — it is the tree a panel's static preview
   * and a brokered `snapshot/server.mjs` child both read, and publishing it
   * eagerly let a running host execute source nobody had approved. A tree
   * that still matches is published, which costs nothing
   * when the existing snapshot was preserved and repairs it when it was
   * missing or corrupt.
   */
  private async verifyApprovedSource(
    candidate: InstalledPluginRecord & { manifest: DohcPluginManifest },
    approvedHash: string,
  ): Promise<
    | { kind: "verified"; snapshot: Extract<PluginSourceSnapshotResult, { ok: true }> }
    | { kind: "changed"; sourceHash: string }
    | { kind: "failed"; result: PluginPipelineActionResult }
  > {
    // The staged tree, until it is published or discarded. A cleanup that
    // rejects must reach the catch below and be retried there, or its bytes
    // stay beside the live root with nothing left to remove them.
    let unpublishedSource: { discard: () => Promise<void> } | null = null;
    try {
      const snapshot = await this.snapshotOrThrow(candidate, approvedHash);
      unpublishedSource = snapshot;
      if (snapshot.sourceHash !== approvedHash) {
        await snapshot.discard();
        unpublishedSource = null;
        return { kind: "changed", sourceHash: snapshot.sourceHash };
      }
      await snapshot.publish();
      unpublishedSource = null;
      return { kind: "verified", snapshot };
    } catch (error) {
      await unpublishedSource?.discard().catch(() => undefined);
      const detail = error instanceof PipelineFailure
        ? error.detail
        : pipelineError("snapshot", "snapshot-failed", errorMessage(error));
      const runtimeStatus = this.host.getStatus(candidate.id) ?? null;
      // This verify pass never touched the live root, so whatever it was
      // running is still running — the same "old runtime still serving a
      // failed candidate" case runFullBuild's own catch recovers from, and
      // it needs the same recovery cache write, or the not-yet-trusted
      // candidate this pass just rejected becomes authoritative everywhere
      // setStatus derives from it (round-8 finding 1).
      if (runtimeStatus !== null) {
        await this.captureRecoveredManifest(candidate.id);
      }
      // snapshotOrThrow set "snapshotting" on its way in. That is a busy
      // status: it disables every Settings action for this plugin, and
      // nothing else restores it, so a failed source check left the plugin
      // unrecoverable short of reopening the workspace.
      // Land where runFullBuild's own failure path lands instead.
      this.setStatus(candidate, {
        status: "failed",
        runtimeStatus,
        error: detail,
      });
      return { kind: "failed", result: this.failure(candidate.id, detail) };
    }
  }

  /**
   * Populates the recovery cache from the live root's own generated
   * manifest, so setStatus keeps deriving commands/panels/webApps/settings
   * from the build actually running rather than a candidate manifest a
   * failure just meant not to trust. Shared by every failure path that can
   * land with an old runtime still serving — one entry point missing this
   * call is how round-8 finding 1 escaped runFullBuild's own version of it.
   *
   * Marks recoveryState's own key (has(), value null) before attempting
   * the read: an unreadable or missing generated manifest must not cost
   * Retry its own availability, only the palette's manifest to show
   * (#779 round 21 finding 5).
   */
  private async captureRecoveredManifest(pluginId: string): Promise<void> {
    if (!this.recoveryState.has(pluginId)) this.recoveryState.set(pluginId, null);
    try {
      const manifestPath = join(
        this.liveRoot(pluginId),
        "dohc-plugin.generated.json",
      );
      const [manifestStats, manifestBody] = await Promise.all([
        this.operations.inspectPath(manifestPath),
        this.operations.readFile(manifestPath, "utf8"),
      ]);
      if (manifestStats.isFile()) {
        const parsed = DohcPluginManifestSchema.safeParse(
          JSON.parse(manifestBody),
        );
        if (parsed.success) {
          this.recoveryState.set(pluginId, parsed.data);
        }
      }
    } catch {
      // The existing candidate-manifest fallback remains the best available
      // answer when the live manifest cannot be read.
    }
  }

  /** Retry's own precondition: a failed build with an old runtime still
   * standing in for it, whether or not its manifest could be cached. */
  private hasRecoverableFailure(pluginId: string): boolean {
    return this.statuses.get(pluginId)?.status === "failed" ||
      this.recoveryState.has(pluginId);
  }

  private async snapshotOrThrow(
    candidate: InstalledPluginRecord & { manifest: DohcPluginManifest },
    preserveIfHashMatches?: string,
  ): Promise<Extract<PluginSourceSnapshotResult, { ok: true }>> {
    this.setStatus(candidate, { status: "snapshotting", error: null });
    const snapshot = await this.operations.snapshot({
      workspaceRoot: this.workspaceRoot,
      stateDir: this.options.stateDir,
      dohcDir: this.dohcDir,
      pluginId: candidate.id,
      pluginRoot: candidate.rootPath,
      manifest: candidate.manifest,
      preserveIfHashMatches,
    });
    if (!snapshot.ok) {
      throw new PipelineFailure(
        pipelineError("snapshot", snapshot.error.code, snapshot.error.message),
      );
    }
    this.setStatus(candidate, { sourceHash: snapshot.sourceHash });
    return snapshot;
  }

  // assertInstall/assertScan/assertBuild were the same body three times —
  // "if !result.ok, throw PipelineFailure(pipelineError(stage,
  // result.error.code, result.error.message))" — differing only in which
  // stage name they threw with (fixround Section C F4).
  private unwrap<T extends { ok: true }, E extends { code: string; message: string }>(
    stage: PluginPipelineErrorStage,
    result: T | { ok: false; error: E },
  ): T {
    if (!result.ok) {
      throw new PipelineFailure(pipelineError(stage, result.error.code, result.error.message));
    }
    return result;
  }

  private async localState(): Promise<PluginLocalState> {
    const result = await this.operations.readLocalState(
      this.options.stateDir,
      this.workspaceRoot,
    );
    if (!result.ok) {
      throw new PipelineFailure(
        pipelineError("state", "local-state-unreadable", result.warning),
      );
    }
    return result.state;
  }

  private async localRecord(pluginId: string): Promise<PluginRecordShape | undefined> {
    return (await this.localState()).plugins[pluginId];
  }

  /**
   * Discovery, told which directory each installed plugin id was installed
   * from. Without it, two roots declaring one id are resolved by lexical
   * order, and a new directory can take an installation's id — and with it
   * the approval and uninstall paths recorded for another root.
   */
  private async discoverCandidates(): Promise<InstalledPluginRecord[]> {
    const state = await this.localState();
    const installedDirectoryNames = new Map<string, string>();
    for (const [pluginId, record] of Object.entries(state.plugins)) {
      if (record.directoryName) {
        installedDirectoryNames.set(pluginId, record.directoryName);
      }
    }
    return this.operations.discover(this.workspaceRoot, installedDirectoryNames);
  }

  private validCandidate(
    pluginId: string,
  ): (InstalledPluginRecord & { manifest: DohcPluginManifest }) | null {
    const candidate = this.discovery.find((entry) =>
      entry.id === pluginId && entry.valid && entry.manifest !== null
    );
    return candidate
      ? candidate as InstalledPluginRecord & { manifest: DohcPluginManifest }
      : null;
  }

  private requireValidCandidate(
    pluginId: string,
  ): InstalledPluginRecord & { manifest: DohcPluginManifest } {
    const candidate = this.validCandidate(pluginId);
    if (!candidate) {
      throw new PipelineFailure(
        pipelineError(
          "discovery",
          "plugin-not-found",
          `Plugin "${pluginId}" is not a valid discovered plugin.`,
        ),
      );
    }
    return candidate;
  }

  /**
   * The candidate uninstall may act on: normally a valid discovered plugin,
   * and also an invalid one that still carries a persisted installation.
   * Uninstall reads nothing from the manifest — it deletes the discovered
   * root, the live root and plugin data keyed by plugin id, and the state
   * record — so a broken manifest must not remove the way back.
   *
   * Directory is checked FIRST, against every discovered candidate —
   * valid or not. pluginId alone is not a safe key to search discovery by:
   * a discovered (never-installed) row's own id is only ever a broken
   * manifest's directory-derived fallback, a plain string that can coincide
   * with some OTHER, unrelated plugin's real, valid manifest id. Matching
   * that id first — the id-then-fallback shape this method used to check
   * first — would then resolve the WRONG plugin whenever the two collide,
   * naming one row while deleting another.
   * Every discovered entry carries exactly one physical directory, so a
   * directory match can never be ambiguous the way an id match can.
   */
  private uninstallableCandidate(
    directoryName: string,
    pluginId: string,
    record: PluginRecordShape | undefined,
  ): InstalledPluginRecord | null {
    const byDirectory = this.discovery.find((entry) => entry.directoryName === directoryName);
    if (byDirectory) return byDirectory;

    const valid = this.validCandidate(pluginId);
    if (valid) return valid;
    // Never approved: there is no installation for the root-path fallback
    // below to find, but the discovered entry validCandidate() just
    // rejected for being invalid is still the one thing Remove has to
    // delete — an invalid manifest must not leave a never-installed copy
    // with no way back either. Id-matched the same way discovery already
    // identifies this exact directory.
    if (!record?.approvedHash) {
      const discovered = this.discovery.find((entry) => entry.id === pluginId);
      if (discovered) return discovered;
    }
    // Joined by root path, not by id: this plugin's discovery entry carries
    // the fallback id its broken manifest left it with, which is not the id
    // its installation is recorded under.
    const status = this.statuses.get(pluginId);
    const installed = record?.approvedHash && status
      ? this.discovery.find((entry) =>
        resolve(entry.rootPath) === resolve(status.rootPath)
      )
      : undefined;
    return installed ?? null;
  }

  private requireUninstallableCandidate(
    directoryName: string,
    pluginId: string,
    record: PluginRecordShape | undefined,
  ): InstalledPluginRecord {
    const candidate = this.uninstallableCandidate(directoryName, pluginId, record);
    if (candidate) return candidate;
    throw new PipelineFailure(notDiscoveredError(pluginId));
  }

  /**
   * The plugin root an uninstall acts on. Normally the discovered
   * candidate's. When an earlier uninstall deleted the root and then failed
   * on the plugin data or the record, discovery has no candidate left and
   * the installation's own status names the root that is gone — preflight
   * still has to report what is left, or the interrupted uninstall can never
   * be finished.
   */
  private uninstallRootPath(
    directoryName: string,
    pluginId: string,
    record: PluginRecordShape | undefined,
  ): string {
    const candidate = this.uninstallableCandidate(directoryName, pluginId, record);
    if (candidate) return candidate.rootPath;
    const status = this.statuses.get(pluginId);
    if (status) return status.rootPath;
    throw new PipelineFailure(notDiscoveredError(pluginId));
  }

  /** Resolves the identity and durable state one uninstall can touch. */
  private async resolveUninstallIdentity(
    pluginId: string,
    directoryName: string,
  ): Promise<ResolvedUninstallIdentity> {
    const state = await this.localState();
    const record = state.plugins[pluginId];
    const candidate = this.uninstallableCandidate(directoryName, pluginId, record)
      ?? this.sourcelessCandidate(pluginId);
    if (
      candidate &&
      (candidate.directoryName !== directoryName ||
        !this.pluginIdIsProvenForDirectory(pluginId, record, candidate))
    ) {
      throw new Error(
        `Plugin "${pluginId}" does not match directory "${directoryName}".`,
      );
    }

    const rootPath = resolve(this.uninstallRootPath(directoryName, pluginId, record));
    const sourcePresent = await this.sourceRootPresent(rootPath);
    const additionalCleanupIds = candidate
      ? this.additionalCleanupIds(candidate, state)
      : [];
    const pluginIdTracesHere = !candidate ||
      this.pluginIdTracesDirectory(record, candidate);
    const cleanupIds = [...new Set([
      ...(pluginIdTracesHere ? [pluginId] : []),
      ...additionalCleanupIds,
    ])].sort();
    const preflightInput: Parameters<typeof pluginUninstallPreflight>[0] = {
      dohcDir: this.dohcDir,
      pluginId,
      pluginRoot: rootPath,
      stateRoot: pluginIdTracesHere ? pluginStateRoot(this.dohcDir, pluginId) : null,
      additionalStateRoots: additionalCleanupIds.map((id) =>
        pluginStateRoot(this.dohcDir, id)
      ),
      installedBaselineHash: pluginIdTracesHere
        ? record?.installedBaselineHash
        : undefined,
      engineCaptureAvailable: this.engineCaptureAvailable(),
    };
    const snapshot = (liveHash: string | null): UninstallTargetSnapshot => ({
      pluginId,
      directoryName,
      rootPath,
      candidate: candidate
        ? {
            id: candidate.id,
            directoryName: candidate.directoryName,
            rootPath: resolve(candidate.rootPath),
          }
        : null,
      source: sourcePresent
        ? { kind: "present", hash: liveHash }
        : { kind: "absent" },
      cleanupIds,
      records: cleanupIds.map((id) => ({
        pluginId: id,
        record: uninstallRecordFingerprint(state.plugins[id]),
      })),
    });
    return { record, rootPath, sourcePresent, preflightInput, snapshot };
  }

  /**
   * Adds the irreversible-delete warning and inventory only for the dialog.
   * Execution revalidation reuses the same identity resolver and snapshot
   * constructor, but probes only the live source hash it actually compares.
   */
  private async resolveUninstallTarget(
    pluginId: string,
    directoryName: string,
  ): Promise<ResolvedUninstallTarget> {
    const identity = await this.resolveUninstallIdentity(pluginId, directoryName);
    const preflight = await this.operations.uninstallPreflight(identity.preflightInput);
    return {
      record: identity.record,
      preflight,
      snapshot: identity.snapshot(preflight.liveHash),
    };
  }

  private async revalidateUninstallTarget(
    confirmed: UninstallTargetSnapshot,
    changed: string,
  ): Promise<
    | { ok: true; record: PluginRecordShape | undefined }
    | { ok: false; reason: string }
  > {
    let identity: ResolvedUninstallIdentity;
    try {
      identity = await this.resolveUninstallIdentity(
        confirmed.pluginId,
        confirmed.directoryName,
      );
    } catch {
      return { ok: false, reason: changed };
    }
    let liveHash: string | null = null;
    if (identity.sourcePresent) {
      try {
        liveHash = (await this.operations.hashSource(identity.rootPath)).sourceHash;
      } catch {
        // The full preflight maps every hash failure, including an ENOENT
        // after the lstat above, to a present-but-unverifiable source. Keep
        // that exact fail-closed distinction from an already-absent root.
      }
    }
    const reason = uninstallTargetVerificationFailure(
      identity.snapshot(liveHash),
      confirmed,
      changed,
    );
    return reason === null
      ? { ok: true, record: identity.record }
      : { ok: false, reason };
  }

  /**
   * Only ENOENT means the source tree is gone. Any other inspection error —
   * a Windows EPERM or EBUSY on a locked root — used to read as "nothing
   * left to delete", and the confirmed uninstall then dropped the record and
   * plugin data while the source tree survived: a half-uninstall that
   * re-discovered as a fresh install. The preflight refuses instead.
   */
  private async sourceRootPresent(pluginRoot: string): Promise<boolean> {
    try {
      await this.operations.inspectPath(pluginRoot);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new PipelineFailure(pipelineError(
        "uninstall",
        "preflight-failed",
        `Plugin source at ${pluginRoot} could not be inspected, so uninstall ` +
          `cannot know what it would delete: ${errorMessage(error)}`,
      ));
    }
  }

  /**
   * The synthetic candidate a sourceless retry acts on — the discovered
   * candidate shape, but built from the persisted status once discovery has
   * nothing left there, so a partial earlier failure (source gone, state or
   * the record still owed) still has something to resolve additional
   * cleanup identities from. Shared by uninstallPreflight (so the
   * confirmation reports that data too, not only what discovery can still
   * find) and finishSourcelessUninstall (the actual delete), so both agree
   * on exactly the same candidate.
   */
  private sourcelessCandidate(pluginId: string): InstalledPluginRecord | null {
    const status = this.statuses.get(pluginId);
    if (!status) return null;
    return {
      id: pluginId,
      directoryName: status.directoryName,
      rootPath: status.rootPath,
      manifest: null,
      iconPath: null,
      diagnostics: status.diagnostics,
      valid: status.valid,
      supersededPluginId: null,
    };
  }

  /**
   * Finishes an uninstall that has no source tree left to delete. An earlier
   * attempt deleted the root and then failed on the plugin data or the
   * record, stranding both: discovery offers no candidate, and every live
   * hash the normal path re-checks describes a tree that is gone. What the
   * user confirmed was that irreversible source delete, and it already
   * happened; what remains is what dohc itself built and recorded.
   *
   * Cleanup still has to resolve every identity the record carried, the
   * same as uninstall()'s normal path: the earlier attempt could have
   * deleted the source and the record under pluginId while leaving state
   * and plugin data behind under the id the plugin was ORIGINALLY installed
   * under, if that differs — the synthetic candidate's directoryName is the
   * one identity survivable across that partial failure, since a record by
   * directory outlives the source delete that stranded it.
   */
  private async finishSourcelessUninstall(
    pluginId: string,
    cleanupIds: ReadonlySet<string>,
    change: PluginHostChangeAuthority,
    cleanupQueueClaims: ReadonlyArray<UninstallQueueClaim>,
    confirmed: UninstallTargetSnapshot,
    hooks: PluginPipelineRuntimeStopHooks,
  ): Promise<PluginHostStartResult<PluginPipelineActionResult>> {
    const status = this.statuses.get(pluginId);
    const candidate = this.sourcelessCandidate(pluginId);
    if (!status || !candidate) {
      return existingHostResult(this.failure(pluginId, notDiscoveredError(pluginId)));
    }
    this.setStatus(candidate, {
      status: "uninstalling",
      disabledReason: "user",
      valid: status.valid,
      error: null,
    });
    try {
      // Every cleanup identity gets stopOldRuntime, not only pluginId's own
      // — cleanupIds is already scoped to identities that trace here, the
      // same reasoning uninstall()'s own normal path applies.
      await this.stopCleanupRuntimes(
        cleanupIds,
        pluginId,
        change,
        cleanupQueueClaims,
        hooks,
      );
      const preDelete = await this.revalidateUninstallTarget(
        confirmed,
        "changed while its process was stopping",
      );
      if (!preDelete.ok) {
        const detail = pipelineError(
          "uninstall",
          "confirmation-stale",
          `Plugin "${pluginId}" ${preDelete.reason}. Review uninstall again.`,
        );
        this.setStatus(candidate, {
          status: "disabled",
          disabledReason: "user",
          runtimeStatus: null,
          valid: status.valid,
          error: detail,
        });
        return existingHostResult(this.failure(pluginId, detail));
      }
      await Promise.all([...cleanupIds].map((id) => this.removePluginData(id)));
      await Promise.all(
        [...cleanupIds].map((id) =>
          this.operations.mutateRecord(
            this.options.stateDir,
            this.workspaceRoot,
            id,
            () => undefined,
          )
        ),
      );
      this.clearUninstalledIdentityState(cleanupIds, confirmed.directoryName);
      this.emit({ kind: "removed", pluginId, directoryName: candidate.directoryName });
      return existingHostResult({
        ok: true,
        plugin: {
          ...cloneStatus(status),
          status: "disabled",
          disabledReason: "user",
        },
      });
    } catch (error) {
      const detail = error instanceof PipelineFailure
        ? error.detail
        : pipelineError(
          "uninstall",
          "delete-failed",
          errorMessage(error),
        );
      this.setStatus(candidate, {
        status: "disabled-pending-repair",
        disabledReason: "repair",
        runtimeStatus: null,
        valid: status.valid,
        error: detail,
      });
      return existingHostResult(this.failure(pluginId, detail));
    }
  }

  private clearUninstalledIdentityState(
    cleanupIds: ReadonlySet<string>,
    directoryName: string,
  ): void {
    for (const pluginId of cleanupIds) {
      this.statuses.delete(pluginId);
      this.doorWrittenDeltas.delete(pluginId);
      this.lastApprovedAttemptHash.delete(pluginId);
      this.uninstallConfirmations.delete(
        uninstallConfirmationKey(pluginId, directoryName),
      );
    }
  }

  private async stopCleanupRuntimes(
    cleanupIds: ReadonlySet<string>,
    primaryPluginId: string,
    primaryChange: PluginHostChangeAuthority,
    cleanupQueueClaims: ReadonlyArray<UninstallQueueClaim>,
    hooks: PluginPipelineRuntimeStopHooks,
  ): Promise<void> {
    const stops = cleanupQueueClaims.map(async (claim) => {
      claim.decide("stop");
      const outcome = await claim.stopOutcome;
      if (!outcome.ok) throw outcome.error;
    });
    if (cleanupIds.has(primaryPluginId)) {
      stops.push(this.stopTerminalRuntime(
        primaryPluginId,
        primaryChange,
        () => hooks.onWillStopRuntime?.(primaryPluginId),
      ));
    }
    const outcomes = await Promise.allSettled(stops);
    const failure = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    if (failure) throw failure.reason;
  }

  /**
   * Claims every secondary identity's pipeline queue at uninstall admission.
   * The ownership reservations already close runtime admission, while these
   * jobs order cleanup after work that the queue accepted earlier and before
   * work submitted after uninstall. They wait for the primary action's
   * decision, so a stale confirmation releases them without stopping a host.
   */
  private claimUninstallCleanupQueues(
    cleanupIds: ReadonlyArray<string>,
    primaryPluginId: string,
    reservations: ReadonlyMap<string, PluginHostChangeReservation>,
    hooks: PluginPipelineRuntimeStopHooks,
  ): UninstallQueueClaim[] {
    const claims: UninstallQueueClaim[] = [];
    const secondaryIds = [...new Set(cleanupIds)]
      .filter((pluginId) => pluginId !== primaryPluginId)
      .sort();
    for (const pluginId of secondaryIds) {
      const reservation = reservations.get(pluginId);
      if (!reservation) {
        throw new Error(
          `Plugin "${pluginId}" has no confirmed uninstall reservation.`,
        );
      }
      const { promise: decision, resolve: decide } =
        Promise.withResolvers<UninstallCleanupDecision>();
      const { promise: released, resolve: release } =
        Promise.withResolvers<void>();
      const { promise: stopOutcome, resolve: settleStop } = Promise.withResolvers<
        { ok: true } | { ok: false; error: unknown }
      >();
      const { promise: ready, resolve: markReady } =
        Promise.withResolvers<void>();
      const action = this.enqueueActionValue(pluginId, async () => {
        markReady();
        if (await decision === "cancel") {
          try {
            await reservation.cancel();
            settleStop({ ok: true });
          } catch (error) {
            settleStop({ ok: false, error });
            throw error;
          }
          return;
        }
        let stopFailure: unknown;
        try {
          await reservation.run(async (change) => {
            await this.stopTerminalRuntime(
              pluginId,
              change,
              () => hooks.onWillStopRuntime?.(pluginId),
            );
            return change.preserve(existingHostResult(undefined));
          });
          settleStop({ ok: true });
        } catch (error) {
          stopFailure = error;
          settleStop({ ok: false, error });
        }
        // The stop boundary and the queue boundary are separate: the primary
        // uninstall may delete only after stopOutcome settles, while work
        // admitted behind this claim stays parked until primary cleanup ends.
        await released;
        if (stopFailure !== undefined) throw stopFailure;
      });
      claims.push({
        ready,
        decide,
        release,
        stopOutcome,
        outcome: action.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      });
    }
    return claims;
  }

  private engineCaptureAvailable(): boolean {
    return this.options.isEngineCaptureAvailable?.() ?? true;
  }

  private liveRoot(pluginId: string): string {
    return join(this.dohcDir, "plugins", pluginIdToSafePath(pluginId));
  }

  /**
   * The live root and anything the pipeline left beside it. A build stages at
   * `<liveRoot>.staging-<uuid>` and swaps through `<liveRoot>.previous-<uuid>`,
   * and a source snapshot stages at
   * `<liveRoot>.snap-staging-<uuid>`, so a job that died mid-rename leaves
   * plugin bytes outside the live root that a recursive delete of the live
   * root alone would not reach. Only those exact families match: plugin ids
   * may contain dots, so any looser test deletes plugin `foo.bar`'s live root
   * while uninstalling `foo`.
   */
  private async pluginDataPaths(pluginId: string): Promise<string[]> {
    const liveRoot = this.liveRoot(pluginId);
    const parent = dirname(liveRoot);
    const liveRootName = basename(liveRoot);
    const siblings = await readdir(parent).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    return [
      liveRoot,
      // The plugin's durable data (a wrapper's sessions, logs, secrets) is
      // deleted with the plugin; the uninstall preflight warned about it.
      pluginStateRoot(this.dohcDir, pluginId),
      ...siblings
        .filter((name) => isPluginRootArtifact(liveRootName, name))
        .map((name) => join(parent, name)),
    ];
  }

  private async removePluginData(pluginId: string): Promise<void> {
    for (const path of await this.pluginDataPaths(pluginId)) {
      await this.operations.removePath(path, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    }
  }

  /**
   * A live bundle is trusted to start only when it is present AND its
   * content still hashes to what this pipeline itself built and recorded as
   * approvedBundleHash — a bundle tampered after the build, with its
   * source tree untouched, must never start because only file presence
   * was checked, never content.
   */
  private async verifiedLiveBundle(
    liveRoot: string,
    approvedBundleHash: string | undefined,
  ): Promise<boolean> {
    if (!approvedBundleHash) return false;
    try {
      const [manifest, bundleBytes] = await Promise.all([
        this.operations.inspectPath(join(liveRoot, "dohc-plugin.generated.json")),
        this.operations.readFile(join(liveRoot, "bundle.mjs")),
      ]);
      if (!manifest.isFile()) return false;
      const bundleHash = createHash("sha256").update(bundleBytes).digest("hex");
      return bundleHash === approvedBundleHash;
    } catch {
      return false;
    }
  }

  /**
   * The one verified-source ladder behind enable() and ensureStarted():
   * verify the live tree still hashes to the approved value, hold for
   * approval when it doesn't, then ask whether the already-built bundle.mjs
   * on disk can still be trusted to run as-is. When it can, this starts the
   * host directly; when it can't,
   * this rebuilds from the just-verified source rather than starting
   * whatever bytes are on disk.
   */
  private async startFromApprovedSource(
    candidate: InstalledPluginRecord & { manifest: DohcPluginManifest },
    state: PluginRecordShape,
    approvedHash: string,
    options: {
      clearDisabled: boolean;
      resetCrashAccounting: boolean;
      runtimeErrorCode: string;
    },
    change?: PluginHostChangeAuthority,
  ): Promise<PluginHostStartResult<PluginPipelineActionResult>> {
    const priorStatus = this.statuses.get(candidate.id);
    const verified = await this.verifyApprovedSource(candidate, approvedHash);
    if (verified.kind === "failed") return existingHostResult(verified.result);
    if (verified.kind === "changed") {
      if (this.host.currentRecord(candidate.id) && !change) {
        return this.restoreStatusAfterHostChangeRefusal(
          candidate,
          priorStatus,
          existingHostResult(this.failure(
            candidate.id,
            this.hostChangeInProgressError(candidate.id),
          )),
        );
      }
      return this.restoreStatusAfterHostChangeRefusal(
        candidate,
        priorStatus,
        await this.holdForApproval(
          candidate,
          verified.sourceHash,
          undefined,
          "changed-after-install",
          undefined,
          change,
        ),
      );
    }

    const pluginId = candidate.id;
    const liveRoot = this.liveRoot(pluginId);
    if (!await this.verifiedLiveBundle(liveRoot, state.approvedBundleHash)) {
      if (
        this.host.currentRecord(pluginId) &&
        (!change || change.checkStop().kind !== "ready")
      ) {
        return this.restoreStatusAfterHostChangeRefusal(
          candidate,
          priorStatus,
          existingHostResult(this.failure(
            pluginId,
            this.hostChangeInProgressError(pluginId),
          )),
        );
      }
      return this.runFullBuild({
        candidate,
        startRuntime: true,
        disabledReasonAfterBuild: null,
        resetCrashAccounting: options.resetCrashAccounting,
        freshInstall: false,
        // The build snapshots the tree again, two full tree copies after the
        // verify pass above. Binding it to the hash that pass verified is
        // what keeps an out-of-band write landing in that window from being
        // auto-approved — the same window closed on the door-write path.
        expectedHash: approvedHash,
      }, change);
    }

    let startEvidence: PluginHostStartEvidence | null = null;
    try {
      if (options.clearDisabled) {
        await this.operations.mutateRecord(
          this.options.stateDir,
          this.workspaceRoot,
          pluginId,
          (record) => ({ ...record, disabled: false }),
        );
      }
      if (options.resetCrashAccounting) {
        this.host.resetCrashAccounting(pluginId);
      }
      if (!this.host.getStatus(pluginId)) {
        startEvidence = await this.startHost(
          liveRoot,
          candidate.directoryName,
          generatedManifest(candidate.manifest),
        );
      }
      const runtimeStatus = this.host.getStatus(pluginId) === "ready"
        ? "ready"
        : "starting";
      const result = this.success(this.setStatus(candidate, {
        status: runtimeStatus,
        disabledReason: null,
        runtimeStatus,
        error: null,
      }));
      return startEvidence
        ? startedHostResult(result, startEvidence)
        : existingHostResult(result);
    } catch (error) {
      const result = this.failure(
        pluginId,
        pipelineError("runtime", options.runtimeErrorCode, errorMessage(error)),
      );
      return startEvidence
        ? startedHostResult(result, startEvidence)
        : existingHostResult(result);
    }
  }

  private baseStatus(candidate: InstalledPluginRecord): PluginPipelinePluginStatus {
    return {
      id: candidate.id,
      directoryName: candidate.directoryName,
      rootPath: candidate.rootPath,
      valid: candidate.valid && candidate.manifest !== null,
      status: candidate.valid ? "discovered" : "invalid",
      disabledReason: null,
      runtimeStatus: null,
      sourceHash: null,
      approvedHash: null,
      installedBaselineHash: null,
      ...manifestMetadata(candidate),
      settings: manifestSettings(candidate.manifest),
      webApps: manifestWebApps(candidate.manifest),
      panels: manifestPanels(candidate.manifest),
      commands: manifestCommands(candidate.manifest),
      hasFailedReplacement: this.recoveryState.has(candidate.id),
      diagnostics: boundedStatusLines(candidate.diagnostics),
      warnings: [],
      error: null,
    };
  }

  private setStatus(
    candidate: InstalledPluginRecord,
    patch: Partial<PluginPipelinePluginStatus>,
    // The manifest (and its own derived icon) a build actually installed,
    // scanned and built, when this call reports on one. Discovery's own
    // candidate.manifest/iconPath can be stale by then — a plugin's own
    // on-disk manifest (and the icon it declares) can change again after
    // discovery scanned it but before this exact snapshot was taken and
    // built, and only that snapshot is what is now running. Left
    // undefined, every derivation below falls back to candidate's own
    // fields exactly as it always has (#779 round 23 finding 5, round 25
    // finding 2).
    built?: { manifest: DohcPluginManifest; iconPath: string | null },
  ): PluginPipelinePluginStatus {
    const current = this.statuses.get(candidate.id) ?? this.baseStatus(candidate);
    // null (a failed replacement, nothing recovered) falls every
    // derivation below back to current's own contributions instead of
    // this candidate's own untrusted manifest (#779 round 22 finding 5).
    const authoritativeManifest = this.recoveryState.has(candidate.id)
      ? (this.recoveryState.get(candidate.id) ?? null)
      : (built?.manifest ?? candidate.manifest);
    // Only the manifest content and icon this call reports on should
    // prefer built — directoryName/rootPath/valid below stay tied to the
    // real discovery candidate, which is what identifies the plugin on
    // disk, not what it built.
    const metadataSource: InstalledPluginRecord = built
      ? { ...candidate, manifest: built.manifest, iconPath: built.iconPath }
      : candidate;
    const next: PluginPipelinePluginStatus = {
      ...current,
      ...patch,
      directoryName: candidate.directoryName,
      rootPath: candidate.rootPath,
      // A caller with no real discovery candidate left (failure()'s
      // synthetic fallback, below) explicitly states the validity it wants
      // preserved via patch.valid; every other caller passes a real
      // discovered candidate and gets the normal derived computation.
      // Without this, a failure recorded after a still-valid plugin's
      // discovery entry was replaced always read back as invalid.
      valid: patch.valid ?? (candidate.valid && candidate.manifest !== null),
      // Derived from the candidate like directoryName/rootPath: an approved
      // manifest edit that adds or renames a web app must become visible on
      // the next status change, not stay frozen at first discovery. The
      // manifest's own metadata is derived the same way — except from a
      // synthetic candidate (failure()'s fallback, a sourceless uninstall),
      // which has no manifest to read. The status keeps the name and icon it
      // already carried rather than losing them mid-action.
      ...(metadataSource.manifest ? manifestMetadata(metadataSource) : {}),
      settings: authoritativeManifest
        ? manifestSettings(authoritativeManifest)
        : current.settings,
      webApps: patch.webApps ?? (authoritativeManifest
        ? manifestWebApps(authoritativeManifest)
        : current.webApps),
      panels: patch.panels ?? (authoritativeManifest
        ? manifestPanels(authoritativeManifest)
        : current.panels),
      commands: patch.commands ?? (authoritativeManifest
        ? manifestCommands(authoritativeManifest)
        : current.commands),
      hasFailedReplacement: this.recoveryState.has(candidate.id),
      diagnostics: boundedStatusLines(patch.diagnostics ?? current.diagnostics),
      warnings: boundedStatusLines(patch.warnings ?? current.warnings),
      error: patch.error === undefined ? cloneError(current.error) : cloneError(patch.error),
    };
    this.statuses.set(candidate.id, next);
    this.emit({ kind: "changed", plugin: cloneStatus(next) });
    return next;
  }

  private success(plugin: PluginPipelinePluginStatus): PluginPipelineActionResult {
    return { ok: true, plugin: cloneStatus(plugin) };
  }

  private failure(
    pluginId: string,
    error: PluginPipelineError,
  ): PluginPipelineActionResult {
    const current = this.statuses.get(pluginId);
    if (current && current.error !== error) {
      this.setStatus(
        this.discovery.find((candidate) => candidate.id === pluginId) ?? {
          id: current.id,
          directoryName: current.directoryName,
          rootPath: current.rootPath,
          manifest: null,
          iconPath: null,
          diagnostics: current.diagnostics,
          valid: current.valid,
          supersededPluginId: null,
        },
        { error, valid: current.valid },
      );
    }
    return {
      ok: false,
      error: { ...error },
      plugin: current ? cloneStatus(this.statuses.get(pluginId) ?? current) : null,
    };
  }

  private emit(event: PluginPipelineStatusEvent): void {
    if (this.disposed) return;
    const listener = this.options.onStatusChange;
    if (!listener) return;
    queueMicrotask(() => {
      if (!this.disposed) listener(event);
    });
  }

  private enqueueSourceRefresh(
    pluginId: string,
    run: (
      change: PluginHostChangeAuthority,
    ) => Promise<PluginHostStartResult<void>>,
  ): void {
    if (this.disposed) return;
    // Marked before the dedup: the refresh already queued is the one that
    // will read this change, so dropping this entry must not drop the fact
    // that the change arrived mid-install.
    if (this.freshInstallsInFlight.has(pluginId)) {
      this.sourceChangedDuringInstall.add(pluginId);
    }
    const queue = this.queueFor(pluginId);
    if (queue.sourceRefreshQueued) return;
    queue.sourceRefreshQueued = true;
    const reservation = this.hostOwnership.reserveChange(pluginId);
    queue.jobs.push({
      sourceRefresh: true,
      run: async () => {
        queue.sourceRefreshQueued = false;
        await reservation.run(async (change) =>
          change.preserve(await run(change)));
      },
    });
    this.drain(pluginId, queue);
  }

  private enqueuePreservedBackground<T>(
    pluginId: string,
    run: (
      change: PluginHostChangeAuthority,
    ) => Promise<PluginHostStartResult<T>>,
  ): Promise<T> {
    const reservation = this.hostOwnership.reserveChange(pluginId);
    return this.enqueueActionValue(pluginId, () =>
      reservation.run(async (change) =>
        change.preserve(await run(change))));
  }

  private enqueueAdoptedAction(
    pluginId: string,
    run: (
      change: PluginHostChangeAuthority,
    ) => Promise<PluginHostStartResult<PluginPipelineActionResult>>,
    reservation?: PluginHostChangeReservation,
  ): Promise<PluginPipelineActionResult> {
    let changeReservation: PluginHostChangeReservation;
    try {
      changeReservation = reservation ?? this.hostOwnership.reserveChange(pluginId);
    } catch (error) {
      if (this.isCloseInvalidation(error)) {
        return Promise.resolve(this.pipelineClosedFailure(pluginId));
      }
      throw error;
    }
    const action = this.enqueueActionValue(pluginId, () =>
      changeReservation.run(async (change) => {
        let result: PluginHostStartResult<PluginPipelineActionResult>;
        try {
          result = await run(change);
        } catch (error) {
          const detail = error instanceof PipelineFailure
            ? error.detail
            : pipelineError("runtime", "action-failed", errorMessage(error));
          result = existingHostResult(this.failure(pluginId, detail));
        }
        return result.kind === "started"
          ? change.adopt(result)
          : change.preserve(result);
      }));
    return action.catch((error: unknown) => {
      if (this.isCloseInvalidation(error)) {
        return this.pipelineClosedFailure(pluginId);
      }
      throw error;
    });
  }

  private enqueueStartedValue(
    pluginId: string,
    run: () => Promise<PluginHostStartResult<PluginPipelineActionResult>>,
  ): Promise<PluginHostStartResult<PluginPipelineActionResult>> {
    return this.enqueueActionValue(pluginId, async () => {
      if (this.disposed) {
        return existingHostResult(this.pipelineClosedFailure(pluginId));
      }
      try {
        return await run();
      } catch (error) {
        const detail = error instanceof PipelineFailure
          ? error.detail
          : pipelineError("runtime", "action-failed", errorMessage(error));
        return existingHostResult(this.failure(pluginId, detail));
      }
    });
  }

  private isCloseInvalidation(error: unknown): boolean {
    return this.disposed && (
      error instanceof PluginHostOwnershipClosedError ||
      error instanceof PluginPipelineClosedError
    );
  }

  private pipelineClosedFailure(pluginId: string): PluginPipelineActionResult {
    return this.failure(
      pluginId,
      pipelineError("runtime", "pipeline-closed", "Plugin pipeline is closed."),
    );
  }

  private enqueueActionValue<T>(pluginId: string, run: () => Promise<T>): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new PluginPipelineClosedError());
    }
    return new Promise<T>((resolveResult, rejectResult) => {
      const queue = this.queueFor(pluginId);
      queue.jobs.push({
        sourceRefresh: false,
        run: async () => {
          try {
            resolveResult(await run());
          } catch (error) {
            rejectResult(error);
          }
        },
      });
      this.drain(pluginId, queue);
    });
  }

  private queueFor(pluginId: string): PluginJobQueue {
    const existing = this.queues.get(pluginId);
    if (existing) return existing;
    const queue: PluginJobQueue = {
      jobs: [],
      sourceRefreshQueued: false,
      draining: null,
    };
    this.queues.set(pluginId, queue);
    return queue;
  }

  private drain(pluginId: string, queue: PluginJobQueue): void {
    if (queue.draining) return;
    queue.draining = (async () => {
      while (queue.jobs.length > 0) {
        const job = queue.jobs.shift();
        if (!job) continue;
        try {
          await job.run();
        } catch (error) {
          if (job.sourceRefresh) {
            const candidate = this.validCandidate(pluginId);
            if (candidate) {
              this.failure(
                pluginId,
                pipelineError("runtime", "refresh-failed", errorMessage(error)),
              );
            }
          }
        }
      }
    })().finally(() => {
      queue.draining = null;
      if (queue.jobs.length > 0) {
        this.drain(pluginId, queue);
      } else if (this.queues.get(pluginId) === queue) {
        this.queues.delete(pluginId);
      }
    });
  }
}
