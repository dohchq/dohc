import type { WatcherEvent } from "@dohc/workspace-core";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  PLUGIN_PIPELINE_ERROR_STAGES,
  PLUGIN_PIPELINE_STATUSES,
} from "../ipc/channels";
import type { PluginHost } from "./PluginHost";
import {
  discoverInstalledPlugins,
  type InstalledPluginRecord,
} from "./pluginDiscovery";
import { buildPluginBundle } from "./pluginBuildRunner";
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
import type {
  DohcPluginManifest,
  PluginSettingDeclaration,
  PluginSettingValue,
} from "./pluginManifestSchema";
import {
  readPluginSettingsFile,
  resolvePluginSettings,
  savePluginSettings,
} from "./pluginSettingsFile";
import type { PluginRuntimeStatus } from "./pluginHostProtocol";
import {
  canonicalPluginSourceHash,
  EXCLUDED_SOURCE_NAMES,
  isPluginRootArtifact,
  pluginIdToSafePath,
  pluginStateRoot,
  snapshotPluginSource,
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
import { errorMessage, isInside } from "./pluginShared";

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
  webApps: { id: string; title: string }[];
  /** The manifest's declared settings, so the details page can render the
   * controls without a second manifest read. Values live per workspace and
   * travel separately. */
  settings: PluginSettingDeclaration[];
  diagnostics: string[];
  warnings: string[];
  error: PluginPipelineError | null;
}

export type PluginPipelineStatusEvent =
  | { kind: "changed"; plugin: PluginPipelinePluginStatus }
  | { kind: "removed"; pluginId: string };

export type PluginPipelineActionResult =
  | { ok: true; plugin: PluginPipelinePluginStatus }
  | {
    ok: false;
    error: PluginPipelineError;
    plugin: PluginPipelinePluginStatus | null;
  };

/**
 * `startedHost` is true only when this very call took the plugin's host from
 * not-running to running. A panel owns stopping a host only when its own
 * ensureStarted caused that transition, and jobs are serialized per plugin,
 * so a queued workspace reconciliation can win the race and start the host
 * first — the panel's call then succeeds on an already-running host and must
 * not claim it (#779 round 10 B3).
 */
export type PluginPipelineEnsureStartedResult =
  | { ok: true; plugin: PluginPipelinePluginStatus; startedHost: boolean }
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
  removePath: typeof rm;
  inspectPath: typeof lstat;
  readFile: typeof readFile;
}

export interface PluginPipelineOptions {
  workspaceRoot: string;
  stateDir: string;
  pluginHost: PluginHost;
  resourcesBasePath?: string;
  /** See pluginInstallRunner's InstallPluginDependenciesInput.pnpmRunnerEntry. */
  pnpmRunnerEntry: string;
  onStatusChange?: (event: PluginPipelineStatusEvent) => void;
  /** Whether this workspace's engine capture is running right now — used
   * only to keep uninstall preflight's recovery promises honest (a file
   * under the capture size cap is not actually recoverable if capture
   * wasn't running to record it). Defaults to true so existing callers and
   * tests that don't care about this keep their current behavior. */
  isEngineCaptureAvailable?: () => boolean;
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

interface UninstallConfirmation {
  token: string;
  /** Null when preflight found no source tree left to delete (#779 round 12 A2). */
  pluginRoot: string | null;
  liveHash: string | null;
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
   * and the snapshot rode the caller's decision straight to auto-approval
   * (#779 round 9 B2 on the door path, round 13 A1 on the reconcile/start
   * paths). Only install and approve — whose entire point is a user gesture
   * approving whatever is on disk right now — leave it unset and approve
   * what they snapshot.
   */
  expectedHash?: string;
}

class PipelineFailure extends Error {
  constructor(readonly detail: PluginPipelineError) {
    super(detail.message);
    this.name = "PipelineFailure";
  }
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
  removePath: rm,
  inspectPath: lstat,
  readFile,
};

/**
 * The bridge contract caps PluginPipelineError.message at 10,000 characters
 * (min 1), and several producers join unbounded diagnostic lists — a noisy
 * directory's discovery diagnostics (#779 round 13 A2), a drifted snapshot
 * manifest's parse issues, a failed build's output (round 14 C1). One
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
 * every other plugin's Disable and Uninstall too (#779 round 15 A2).
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
    diagnostics: [...status.diagnostics],
    warnings: [...status.warnings],
    error: cloneError(status.error),
  };
}

function manifestWebApps(
  manifest: { webApps?: { id: string; title: string }[] } | null,
): { id: string; title: string }[] {
  return (manifest?.webApps ?? []).map((webApp) => ({
    id: webApp.id,
    title: webApp.title,
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
 * still describes what the recursive delete would remove (#779 round 11 A2).
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
  // pipelineError bounds the joined message (#779 round 13 A2, round 14 C1).
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

export class PluginPipeline {
  private readonly workspaceRoot: string;
  private readonly dohcDir: string;
  private readonly operations: PluginPipelineOperations;
  private readonly statuses = new Map<string, PluginPipelinePluginStatus>();
  private readonly queues = new Map<string, PluginJobQueue>();
  private readonly uninstallConfirmations = new Map<string, UninstallConfirmation>();
  /**
   * Every door-written file since the approved baseline, per plugin:
   * relPath (POSIX, root-relative) to the sha256 of the written bytes and
   * the write's order in doorWriteSeq. See handleDoorWrittenSourceChange
   * and doorApprovedHash — this overlay, applied to the persisted baseline
   * manifest, is the only tree the door path may auto-approve.
   */
  private readonly doorWrittenDeltas = new Map<
    string,
    Map<string, { sha256: string; seq: number }>
  >();
  /** Orders door writes against each build's snapshot; see runFullBuild. */
  private doorWriteSeq = 0;
  private discovery: InstalledPluginRecord[] = [];
  private discoveryTail: Promise<void> = Promise.resolve();
  private startPromise: Promise<void> | null = null;
  private readonly abortController = new AbortController();
  private disposed = false;

  constructor(private readonly options: PluginPipelineOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.dohcDir = pluginDataDir(options.stateDir, this.workspaceRoot);
    this.operations = { ...DEFAULT_OPERATIONS, ...options.operations };
  }

  /**
   * The single PluginHost this pipeline owns for its workspace. #777's panel
   * surface shares this instance (rather than creating its own host) so a
   * panel and the install/build pipeline can never race two independent
   * hosts over the same plugin id.
   */
  get host(): PluginHost {
    return this.options.pluginHost;
  }

  /**
   * What this plugin declares the user may set. Refusing an unknown plugin is
   * what keeps one plugin's settings out of another's reach: every settings
   * call names a plugin, and only a plugin this workspace discovered has
   * declarations to answer with.
   */
  private declaredSettings(pluginId: string): PluginSettingDeclaration[] {
    const status = this.statuses.get(pluginId);
    if (status) return status.settings;
    const candidate = this.discovery.find((entry) => entry.id === pluginId);
    if (!candidate) throw new Error(`Unknown plugin: ${pluginId}`);
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
  async sizes(pluginId: string): Promise<PluginPipelineSizes> {
    const [installed, data] = await Promise.all([
      measurePluginDirectory(this.liveRoot(pluginId)),
      measurePluginDirectory(pluginStateRoot(this.dohcDir, pluginId)),
    ]);
    return {
      installedBytes: installed?.totalBytes ?? null,
      dataBytes: data?.totalBytes ?? null,
    };
  }

  /** This plugin's settings: its declared defaults under the stored answers. */
  async getPluginSettings(
    pluginId: string,
  ): Promise<Record<string, PluginSettingValue>> {
    const declared = this.declaredSettings(pluginId);
    const stored = await readPluginSettingsFile(this.workspaceRoot);
    return resolvePluginSettings(declared, stored[pluginId]);
  }

  /** Records the user's answers and tells the plugin, if it is running. */
  async setPluginSettings(
    pluginId: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, PluginSettingValue>> {
    const declared = this.declaredSettings(pluginId);
    const values = await savePluginSettings(
      this.workspaceRoot,
      pluginId,
      declared,
      patch,
    );
    // Not awaited: the value is already saved, and a plugin that is slow to
    // take the change must not make the user wait for a save that landed.
    void this.options.pluginHost.notifySettingsChanged(pluginId, values).catch(
      (error: unknown) => {
        console.warn(
          `[desktop] plugin "${pluginId}" did not take a settings change: ${errorMessage(error)}`,
        );
      },
    );
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
        // Settings still offers Uninstall (#779 round 8 D2).
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
    return null;
  }

  install(pluginId: string): Promise<PluginPipelineActionResult> {
    return this.enqueueAction(pluginId, async () => {
      const candidate = this.requireValidCandidate(pluginId);
      return this.runFullBuild({
        candidate,
        startRuntime: true,
        disabledReasonAfterBuild: null,
        resetCrashAccounting: true,
        freshInstall: true,
      });
    });
  }

  disable(pluginId: string): Promise<PluginPipelineActionResult> {
    return this.enqueueAction(pluginId, async () => {
      const candidate = this.requireValidCandidate(pluginId);
      try {
        await this.operations.mutateRecord(
          this.options.stateDir,
          this.workspaceRoot,
          pluginId,
          (record) => ({ ...record, disabled: true }),
        );
        await this.options.pluginHost.stop(pluginId);
        return this.success(this.setStatus(candidate, {
          status: "disabled",
          disabledReason: "user",
          runtimeStatus: null,
          error: null,
        }));
      } catch (error) {
        return this.failure(
          pluginId,
          pipelineError("state", "disable-failed", errorMessage(error)),
        );
      }
    });
  }

  enable(pluginId: string): Promise<PluginPipelineActionResult> {
    return this.enqueueAction(pluginId, async () => {
      const candidate = this.requireValidCandidate(pluginId);
      const state = await this.localRecord(pluginId);
      if (!state?.approvedHash) {
        return this.failure(
          pluginId,
          pipelineError(
            "state",
            "install-required",
            `Plugin "${pluginId}" must be installed before it can be enabled.`,
          ),
        );
      }
      return this.startFromApprovedSource(candidate, state, state.approvedHash, {
        clearDisabled: true,
        resetCrashAccounting:
          this.statuses.get(pluginId)?.disabledReason === "crash-loop",
        runtimeErrorCode: "enable-failed",
      });
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
  ensureStarted(pluginId: string): Promise<PluginPipelineEnsureStartedResult> {
    let startedHost = false;
    return this.enqueueAction(pluginId, async () => {
      // Sampled inside the job, not before it was queued: whatever ran ahead
      // of this call in the queue has already finished starting the host.
      const runningBefore = Boolean(this.options.pluginHost.getStatus(pluginId));
      const result = await this.runEnsureStarted(pluginId);
      startedHost = result.ok &&
        !runningBefore &&
        Boolean(this.options.pluginHost.getStatus(pluginId));
      return result;
    }).then((result) => (result.ok ? { ...result, startedHost } : result));
  }

  private async runEnsureStarted(
    pluginId: string,
  ): Promise<PluginPipelineActionResult> {
    const candidate = this.requireValidCandidate(pluginId);
    const state = await this.localRecord(pluginId);
    if (state?.disabled === true) {
      return this.failure(
        pluginId,
        pipelineError(
          "state",
          "plugin-disabled",
          `Plugin "${pluginId}" is disabled. Enable it before opening it.`,
        ),
      );
    }
    if (!state?.approvedHash) {
      return this.runFullBuild({
        candidate,
        startRuntime: true,
        disabledReasonAfterBuild: null,
        resetCrashAccounting: true,
        freshInstall: true,
      });
    }
    return this.startFromApprovedSource(candidate, state, state.approvedHash, {
      clearDisabled: false,
      resetCrashAccounting: false,
      runtimeErrorCode: "start-failed",
    });
  }

  approve(pluginId: string): Promise<PluginPipelineActionResult> {
    return this.enqueueAction(pluginId, async () => {
      const candidate = this.requireValidCandidate(pluginId);
      // The disabled bit is the user's own choice, orthogonal to approval:
      // approving new content trusts that content, but must never silently
      // re-enable a plugin the user explicitly turned off before the
      // out-of-band change arrived (#779 round 3 finding 5).
      const staysDisabled = this.statuses.get(pluginId)?.disabledReason === "user";
      return this.runFullBuild({
        candidate,
        startRuntime: !staysDisabled,
        disabledReasonAfterBuild: staysDisabled ? "user" : null,
        resetCrashAccounting: true,
        freshInstall: false,
      });
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
   * mirror delivery — into the door write's auto-approval (#779 round 14
   * A1, security-grade). Deltas are recorded synchronously and keyed per
   * plugin, so the dedup in enqueueSourceRefresh can drop this
   * notification's queue entry and the surviving refresh still sees every
   * write, newest content per path (#779 round 13 A3).
   */
  handleDoorWrittenSourceChange(
    pluginId: string,
    write: { absolutePath: string; text: string },
  ): void {
    const candidate = this.validCandidate(pluginId);
    if (!candidate) return;
    const root = resolve(candidate.rootPath);
    const target = resolve(write.absolutePath);
    if (target === root || !isInside(root, target)) return;
    const relPath = relative(root, target).replaceAll("\\", "/");
    // node_modules and .dohc are excluded from every source digest, so a
    // write under them cannot change the hash this predicate compares.
    if (relPath.split("/").some((segment) => EXCLUDED_SOURCE_NAMES.has(segment))) {
      return;
    }
    const deltas = this.doorWrittenDeltas.get(pluginId) ??
      new Map<string, { sha256: string; seq: number }>();
    deltas.set(relPath, {
      sha256: createHash("sha256").update(write.text, "utf8").digest("hex"),
      seq: ++this.doorWriteSeq,
    });
    this.doorWrittenDeltas.set(pluginId, deltas);
    this.enqueueSourceRefresh(pluginId, () =>
      this.reconcileApprovedCandidate(pluginId, true));
  }

  handleWatcherEvents(events: readonly WatcherEvent[]): void {
    if (this.disposed || !events.some(pluginTreeEvent)) return;
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
  }

  noteRuntimeStatus(pluginId: string, runtimeStatus: PluginRuntimeStatus): void {
    if (this.disposed) return;
    const candidate = this.validCandidate(pluginId);
    if (!candidate) return;
    if (runtimeStatus === "disabled") {
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
  ): Promise<PluginPipelineUninstallPreflightResult> {
    return this.enqueueActionValue(pluginId, async () => {
      try {
        const record = await this.localRecord(pluginId);
        const pluginRoot = this.uninstallRootPath(pluginId, record);
        const sourcePresent = await this.sourceRootPresent(pluginRoot);
        const preflight = await this.operations.uninstallPreflight({
          dohcDir: this.dohcDir,
          pluginId,
          pluginRoot,
          stateRoot: pluginStateRoot(this.dohcDir, pluginId),
          installedBaselineHash: record?.installedBaselineHash,
          engineCaptureAvailable: this.engineCaptureAvailable(),
        });
        const confirmationToken = randomUUID();
        this.uninstallConfirmations.set(pluginId, {
          token: confirmationToken,
          pluginRoot: sourcePresent ? resolve(pluginRoot) : null,
          liveHash: preflight.liveHash,
        });
        return {
          ok: true,
          confirmationToken,
          preflight: summarizeUninstallPreflight(preflight),
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
    confirmationToken: string,
  ): Promise<PluginPipelineActionResult> {
    return this.enqueueAction(pluginId, async () => {
      const confirmation = this.uninstallConfirmations.get(pluginId);
      this.uninstallConfirmations.delete(pluginId);
      if (!confirmation || confirmation.token !== confirmationToken) {
        return this.failure(
          pluginId,
          pipelineError(
            "uninstall",
            "confirmation-required",
            `Plugin "${pluginId}" requires a current uninstall preflight confirmation.`,
          ),
        );
      }

      const record = await this.localRecord(pluginId);
      if (confirmation.pluginRoot === null) {
        return this.finishSourcelessUninstall(pluginId);
      }
      const candidate = this.requireUninstallableCandidate(pluginId, record);
      if (resolve(candidate.rootPath) !== confirmation.pluginRoot) {
        return this.failure(
          pluginId,
          pipelineError(
            "uninstall",
            "confirmation-stale",
            `Plugin "${pluginId}" moved after uninstall preflight. Run preflight again.`,
          ),
        );
      }
      const currentPreflight = await this.operations.uninstallPreflight({
        dohcDir: this.dohcDir,
        pluginId,
        pluginRoot: candidate.rootPath,
        stateRoot: pluginStateRoot(this.dohcDir, pluginId),
        installedBaselineHash: record?.installedBaselineHash,
        engineCaptureAvailable: this.engineCaptureAvailable(),
      });
      const staleReason = uninstallVerificationFailure(
        currentPreflight.liveHash,
        confirmation.liveHash,
        "changed after uninstall preflight",
      );
      if (staleReason !== null) {
        return this.failure(
          pluginId,
          pipelineError(
            "uninstall",
            "confirmation-stale",
            `Plugin "${pluginId}" ${staleReason}. Review it again.`,
          ),
        );
      }

      this.setStatus(candidate, {
        status: "uninstalling",
        disabledReason: "user",
        error: null,
      });
      try {
        await this.operations.mutateRecord(
          this.options.stateDir,
          this.workspaceRoot,
          pluginId,
          (existing) => ({ ...existing, disabled: true }),
        );
        await this.options.pluginHost.stop(pluginId);

        // Re-verify immediately before the actual delete: pluginHost.stop()
        // can take real wall-clock time (a grace period, then signal
        // escalation), and the earlier check above is no longer "immediately
        // before delete" once that wait has happened — this must never
        // delete content different from what the confirmation actually
        // covered (#779 round 3 finding 3).
        const preDeletePreflight = await this.operations.uninstallPreflight({
          dohcDir: this.dohcDir,
          pluginId,
          pluginRoot: candidate.rootPath,
          stateRoot: pluginStateRoot(this.dohcDir, pluginId),
          installedBaselineHash: record?.installedBaselineHash,
          engineCaptureAvailable: this.engineCaptureAvailable(),
        });
        const preDeleteReason = uninstallVerificationFailure(
          preDeletePreflight.liveHash,
          confirmation.liveHash,
          "changed while its process was stopping",
        );
        if (preDeleteReason !== null) {
          const detail = pipelineError(
            "uninstall",
            "confirmation-stale",
            `Plugin "${pluginId}" ${preDeleteReason}. Review uninstall again.`,
          );
          // Nothing was deleted, the record still says disabled, and the host
          // is stopped — but the status set above still reads "uninstalling",
          // which disables every action for good (#779 round 7 B6).
          this.setStatus(candidate, {
            status: "disabled",
            disabledReason: "user",
            runtimeStatus: null,
            error: detail,
          });
          return this.failure(pluginId, detail);
        }

        // Both deletes are attempted even if one rejects (round 4 finding 2)
        // — skipping the live bundle because the source delete failed, or
        // vice versa, would silently leave the other one behind with no
        // record that cleanup is still owed.
        const [rootDeleted, liveDeleted] = await Promise.allSettled([
          this.operations.removePath(candidate.rootPath, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
          }),
          this.removePluginData(pluginId),
        ]);
        if (rootDeleted.status === "rejected") throw rootDeleted.reason;
        if (liveDeleted.status === "rejected") throw liveDeleted.reason;

        await this.operations.mutateRecord(
          this.options.stateDir,
          this.workspaceRoot,
          pluginId,
          () => undefined,
        );
        this.statuses.delete(pluginId);
        this.doorWrittenDeltas.delete(pluginId);
        // One directory is one discovery entry, so the deleted root — not the
        // id, which an invalid candidate does not share with its record — is
        // what identifies the entry that just went away.
        this.discovery = this.discovery.filter((entry) =>
          resolve(entry.rootPath) !== resolve(candidate.rootPath)
        );
        this.emit({ kind: "removed", pluginId });
        return {
          ok: true,
          plugin: {
            ...this.baseStatus(candidate),
            status: "disabled",
            disabledReason: "user",
          },
        };
      } catch (error) {
        // A failed delete must never disappear as a stuck "uninstalling"
        // spinner with orphaned files left behind and no way back in. The
        // local record is left untouched (still disabled, still pointing at
        // whatever survived) so a retry's preflight has something real to
        // re-check, and the status becomes the same actionable
        // disabled-pending-repair state a failed fresh install already uses
        // (#779 round 4 finding 2).
        const detail = pipelineError("uninstall", "delete-failed", errorMessage(error));
        this.setStatus(candidate, {
          status: "disabled-pending-repair",
          disabledReason: "repair",
          runtimeStatus: null,
          error: detail,
        });
        return this.failure(pluginId, detail);
      }
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort();
    this.options.pluginHost.bumpGeneration();
    await this.discoveryTail.catch(() => undefined);
    await Promise.all(
      [...this.queues.values()]
        .map((queue) => queue.draining)
        .filter((draining): draining is Promise<void> => draining !== null),
    );
    await this.options.pluginHost.stopAll();
    this.uninstallConfirmations.clear();
  }

  private async startInternal(): Promise<void> {
    try {
      this.discovery = await this.discoverCandidates();
      await this.seedStatuses();
      for (const candidate of this.discovery) {
        if (!candidate.valid || !candidate.manifest) continue;
        const record = await this.localRecord(candidate.id);
        if (!record?.approvedHash) continue;
        this.enqueueSourceRefresh(candidate.id, () =>
          this.reconcileApprovedCandidate(candidate.id, true));
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
   * record carries the directory it was installed from (#779 round 9 B3).
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
   * and the app's own plugin data by hand (#779 round 8 D2).
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
      // here uninstalled a plugin that only needed its manifest finished
      // (#779 round 12 A1); the invalid state has its own handling, which
      // keeps the installation and still offers Uninstall (round 8 D2). It
      // is a departure only when the root is gone, when a valid manifest
      // gave this root a different id, or when another valid root took this
      // id — and that last one must still clean up before its replacement
      // is reconciled (CERT779 A4).
      if (!sameId && !sameRoot && nextRoots.has(resolve(oldCandidate.rootPath))) {
        continue;
      }

      departing.push(oldCandidate);
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
    // approval and running state across without ever holding for approval
    // (#779 round 3 finding 2 — CERT779 A4 keyed reconcileApprovedCandidate
    // strictly by (id, hash), but a same-batch ordering race let a
    // replacement read the departing identity's own not-yet-cleaned-up
    // record and host status under that same id).
    for (const oldCandidate of departing) {
      await this.enqueueActionValue(oldCandidate.id, () =>
        this.removeOldIdentity(oldCandidate));
    }
    // The old identity's approval never carries to the replacement
    // (CERT779 A4): a manifest-name change or root swap is a new identity,
    // and reconcileApprovedCandidate keys approval strictly by this
    // identity's own (id, content hash) record — matching a mismatch or
    // a never-approved id the same way any other unapproved discovery
    // does, and continuing seamlessly only when this identity's own
    // approval already matches its current content.
    for (const replacement of replacements) {
      this.enqueueSourceRefresh(replacement.id, () =>
        this.reconcileApprovedCandidate(replacement.id, true));
    }

    for (const candidate of nextValid) {
      if (replaced.has(candidateKey(candidate))) continue;
      const sourceRoot = relativeSourceRoot(this.workspaceRoot, candidate.rootPath);
      if (!events.some((event) => eventTouchesRoot(event, sourceRoot))) continue;
      // Joined by root, not by id alone: a root whose manifest was invalid a
      // moment ago carries discovery's fallback id, and restoring the
      // manifest has to reconcile the installation whose record survived
      // that invalid window back to running (#779 round 12 A1).
      const old = previous.find((entry) =>
        resolve(entry.rootPath) === resolve(candidate.rootPath) &&
        (entry.valid && entry.manifest !== null ? entry.id === candidate.id : true)
      );
      if (!old) continue;
      this.enqueueSourceRefresh(candidate.id, () =>
        this.reconcileApprovedCandidate(candidate.id, false));
    }
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
      // it the status a fresh launch would (#779 round 12 A1).
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
   * sequence for approval (#779 round 14 A2).
   */
  private async reconcileApprovedCandidate(
    pluginId: string,
    startRuntime: boolean,
  ): Promise<void> {
    const candidate = this.validCandidate(pluginId);
    if (!candidate) return;
    const record = await this.localRecord(pluginId);
    if (!record?.approvedHash) {
      this.setStatus(candidate, { status: "discovered" });
      return;
    }
    // The disabled bit is the user's own choice only when the user chose
    // it: the approval path's hold also writes disabled: true, and a tree
    // whose deviation from baseline is all door-written satisfies that
    // hold — an out-of-band change on an explicitly disabled plugin must
    // still never silently re-enable it (#779 round 3 finding 5, round 13
    // A3).
    const priorDisabledReason = record.disabled === true
      ? this.statuses.get(pluginId)?.disabledReason ?? "user"
      : undefined;
    const verified = await this.verifyApprovedSource(candidate, record.approvedHash);
    if (verified.kind === "failed") return;
    if (verified.kind === "changed") {
      const doorHash = await this.doorApprovedHash(pluginId, record.approvedHash);
      if (doorHash === null || verified.sourceHash !== doorHash) {
        await this.holdForApproval(candidate, verified.sourceHash, priorDisabledReason);
        return;
      }
      const disabled = priorDisabledReason === "user";
      await this.runFullBuild({
        candidate,
        startRuntime: !disabled,
        disabledReasonAfterBuild: disabled ? "user" : null,
        resetCrashAccounting: !disabled,
        freshInstall: false,
        // The build snapshots the tree again, and this comparison is
        // already stale by then. Binding the build to the hash this check
        // passed on is what stops a change landing in that window from
        // riding the door write to approval (#779 round 9 B2).
        expectedHash: doorHash,
      });
      return;
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
      // idling under a hold whose cause is gone (#779 round 14 A1 pin b).
      // Only that hold waits on content. A user disable, a crash loop, and a
      // failed repair are all decisions about the plugin, so releasing them
      // here restarted a plugin the app had turned off — and reset the crash
      // accounting that turned it off (#779 round 15 A1).
      const doorHash = priorDisabledReason === "approval"
        ? await this.doorApprovedHash(pluginId, record.approvedHash)
        : null;
      if (doorHash !== record.approvedHash) {
        this.setStatus(candidate, {
          status: "disabled",
          disabledReason: priorDisabledReason ?? "user",
          runtimeStatus: null,
        });
        return;
      }
      await this.runFullBuild({
        candidate,
        startRuntime: true,
        disabledReasonAfterBuild: null,
        resetCrashAccounting: true,
        freshInstall: false,
        expectedHash: record.approvedHash,
      });
      return;
    }
    if (!startRuntime || this.options.pluginHost.getStatus(pluginId)) {
      // A no-op reconcile (nothing to rebuild, nothing to start) must
      // restore the status this function's own snapshotOrThrow set to
      // "snapshotting" at the top — otherwise a watcher event for an
      // already-running, unchanged plugin left it permanently stuck
      // reading "Checking source" (fixround Section B item 12).
      const runtimeStatus = this.options.pluginHost.getStatus(pluginId);
      this.setStatus(candidate, {
        status: runtimeStatus ?? "queued",
        runtimeStatus: runtimeStatus ?? null,
        error: null,
      });
      return;
    }
    await this.runFullBuild({
      candidate,
      startRuntime: true,
      disabledReasonAfterBuild: null,
      resetCrashAccounting: true,
      freshInstall: false,
      // Bound to the hash verifyApprovedSource just confirmed: the build's
      // own snapshot is two full tree copies later, and an out-of-band write
      // landing in between must hold for approval, not ride this reconcile
      // to auto-approval (#779 round 13 A1).
      expectedHash: record.approvedHash,
    });
  }

  private async removeOldIdentity(candidate: InstalledPluginRecord): Promise<void> {
    try {
      await this.options.pluginHost.stop(candidate.id);
      await this.operations.mutateRecord(
        this.options.stateDir,
        this.workspaceRoot,
        candidate.id,
        () => undefined,
      );
      await this.removePluginData(candidate.id);
      this.statuses.delete(candidate.id);
      this.doorWrittenDeltas.delete(candidate.id);
      this.uninstallConfirmations.delete(candidate.id);
      this.emit({ kind: "removed", pluginId: candidate.id });
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
   * so a delta only ever adds or replaces one file.
   */
  private async doorApprovedHash(
    pluginId: string,
    approvedHash: string,
  ): Promise<string | null> {
    const baseline = await readPluginBaselineManifest(this.dohcDir, pluginId);
    if (!baseline || baseline.sourceHash !== approvedHash) return null;
    const files = new Map(
      baseline.files.map((file) => [file.relPath, file.sha256]),
    );
    for (const [relPath, delta] of this.doorWrittenDeltas.get(pluginId) ?? []) {
      files.set(relPath, delta.sha256);
    }
    return canonicalPluginSourceHash(
      [...files].map(([relPath, sha256]) => ({ relPath, sha256 })),
    );
  }

  private async runFullBuild(
    input: FullBuildOptions,
  ): Promise<PluginPipelineActionResult> {
    const { candidate } = input;
    if (!candidate.manifest) {
      return this.failure(
        candidate.id,
        pipelineError("discovery", "invalid-plugin", "Plugin manifest is invalid."),
      );
    }
    const validCandidate = { ...candidate, manifest: candidate.manifest };
    const oldRuntime = this.options.pluginHost.getStatus(candidate.id) ?? null;
    let sourceHash: string | null = null;
    // The staged source tree, until it is published or discarded. Anything
    // that throws below leaves it staged, so the catch has to drop it.
    let unpublishedSource: { discard: () => Promise<void> } | null = null;
    // Sampled before the snapshot reads the tree: a delta at or below this
    // mark is settled by this build's success (its bytes are in the new
    // baseline, or a user gesture approved whatever superseded them); a
    // delta above it landed after the snapshot and must survive for its own
    // queued refresh (#779 round 14 A1).
    const doorSeqAtSnapshot = this.doorWriteSeq;
    try {
      const snapshot = await this.snapshotOrThrow(validCandidate);
      unpublishedSource = snapshot;
      sourceHash = snapshot.sourceHash;
      if (
        input.expectedHash !== undefined &&
        snapshot.sourceHash !== input.expectedHash
      ) {
        // Ownership passes back only once the tree is actually gone: a
        // discard that rejects here has to reach the catch's own cleanup
        // instead of leaving staged bytes beside the live root (#779 round
        // 10 A5).
        await snapshot.discard();
        unpublishedSource = null;
        const priorDisabledReason = input.disabledReasonAfterBuild === "user"
          ? this.statuses.get(candidate.id)?.disabledReason ?? "user"
          : undefined;
        return await this.holdForApproval(
          validCandidate,
          snapshot.sourceHash,
          priorDisabledReason,
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
      // itself, never that stale copy (#779 round 4 finding 5).
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
      // publishing bytes whose approval was never recorded (#779 round 6 F5).
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

      // The old process stops before either publish. It is full-trust code
      // that knows its own live root, so leaving it running while the live
      // root is replaced let it overwrite the published bundle in the window
      // before the new process starts — unapproved bytes running under the
      // approvedBundleHash just recorded for them (#779 round 12 A3).
      if (oldRuntime) await this.options.pluginHost.stop(candidate.id);

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
          this.options.pluginHost.resetCrashAccounting(candidate.id);
        }
        // The published bundle is re-read here, not trusted from the build:
        // approval binds the bytes that execute, and anything that reached
        // the live root between publication and this start is not what the
        // record approves (#779 round 12 A3).
        if (!await this.verifiedLiveBundle(built.liveRoot, built.bundleHash)) {
          throw new PipelineFailure(pipelineError(
            "build",
            "bundle-changed",
            `Plugin "${candidate.id}" bundle at ${built.liveRoot} changed after ` +
              "it was published, so it no longer matches the approval recorded " +
              "for it. Install the plugin again.",
          ));
        }
        await this.options.pluginHost.start(
          built.liveRoot,
          generatedManifest(manifest),
        );
      }

      return this.success(this.setStatus(candidate, {
        status: input.startRuntime ? "starting" : "disabled",
        disabledReason: input.disabledReasonAfterBuild,
        runtimeStatus: input.startRuntime ? "starting" : null,
        sourceHash: snapshot.sourceHash,
        approvedHash: snapshot.sourceHash,
        installedBaselineHash: snapshot.sourceHash,
        warnings,
        error: null,
      }));
    } catch (error) {
      await unpublishedSource?.discard().catch(() => undefined);
      const detail = error instanceof PipelineFailure
        ? error.detail
        : pipelineError("runtime", "pipeline-failed", errorMessage(error));
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
        this.setStatus(candidate, {
          status: "failed",
          runtimeStatus: oldRuntime,
          sourceHash,
          error: detail,
        });
      }
      return this.failure(candidate.id, detail);
    }
  }

  private async holdForApproval(
    candidate: InstalledPluginRecord & { manifest: DohcPluginManifest },
    sourceHash: string,
    priorDisabledReason?: PluginPipelinePluginStatus["disabledReason"],
  ): Promise<PluginPipelineActionResult> {
    try {
      await this.operations.mutateRecord(
        this.options.stateDir,
        this.workspaceRoot,
        candidate.id,
        (record) => ({ ...record, disabled: true }),
      );
      await this.options.pluginHost.stop(candidate.id);
      const record = await this.localRecord(candidate.id);
      return this.success(this.setStatus(candidate, {
        status: "disabled-pending-approval",
        disabledReason: priorDisabledReason ?? "approval",
        runtimeStatus: null,
        sourceHash,
        approvedHash: record?.approvedHash ?? null,
        installedBaselineHash: record?.installedBaselineHash ?? null,
        error: null,
      }));
    } catch (error) {
      return this.failure(
        candidate.id,
        pipelineError("state", "approval-hold-failed", errorMessage(error)),
      );
    }
  }

  /**
   * The source check for every caller that only verifies an already-approved
   * hash: enable, ensureStarted, and reconcile. The snapshot is staged, never
   * published on sight. A tree that no longer hashes to the approved value is
   * discarded, so the live snapshot keeps serving the approved bytes while
   * the change waits for approval — it is the tree a panel's static preview
   * and a brokered `snapshot/server.mjs` child both read, and publishing it
   * eagerly let a running host execute source nobody had approved (#779
   * round 9 B1). A tree that still matches is published, which costs nothing
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
    // stay beside the live root with nothing left to remove them (#779 round
    // 10 A5).
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
      // snapshotOrThrow set "snapshotting" on its way in. That is a busy
      // status: it disables every Settings action for this plugin, and
      // nothing else restores it, so a failed source check left the plugin
      // unrecoverable short of reopening the workspace (#779 round 7 B5).
      // Land where runFullBuild's own failure path lands instead.
      this.setStatus(candidate, {
        status: "failed",
        runtimeStatus: this.options.pluginHost.getStatus(candidate.id) ?? null,
        error: detail,
      });
      return { kind: "failed", result: this.failure(candidate.id, detail) };
    }
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
   * the approval and uninstall paths recorded for another root (#779 round
   * 11 A4).
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
   * record — so a broken manifest must not remove the way back (#779 round 8
   * D2).
   */
  private uninstallableCandidate(
    pluginId: string,
    record: PluginRecordShape | undefined,
  ): InstalledPluginRecord | null {
    const valid = this.validCandidate(pluginId);
    if (valid) return valid;
    // Joined by root path, not by id: this plugin's discovery entry carries
    // the fallback id its broken manifest left it with, which is not the id
    // its installation is recorded under (#779 round 9 B3).
    const status = this.statuses.get(pluginId);
    const installed = record?.approvedHash && status
      ? this.discovery.find((entry) =>
        resolve(entry.rootPath) === resolve(status.rootPath)
      )
      : undefined;
    return installed ?? null;
  }

  private requireUninstallableCandidate(
    pluginId: string,
    record: PluginRecordShape | undefined,
  ): InstalledPluginRecord {
    const candidate = this.uninstallableCandidate(pluginId, record);
    if (candidate) return candidate;
    throw new PipelineFailure(notDiscoveredError(pluginId));
  }

  /**
   * The plugin root an uninstall acts on. Normally the discovered
   * candidate's. When an earlier uninstall deleted the root and then failed
   * on the plugin data or the record, discovery has no candidate left and
   * the installation's own status names the root that is gone — preflight
   * still has to report what is left, or the interrupted uninstall can never
   * be finished (#779 round 12 A2).
   */
  private uninstallRootPath(
    pluginId: string,
    record: PluginRecordShape | undefined,
  ): string {
    const candidate = this.uninstallableCandidate(pluginId, record);
    if (candidate) return candidate.rootPath;
    const status = this.statuses.get(pluginId);
    if (status) return status.rootPath;
    throw new PipelineFailure(notDiscoveredError(pluginId));
  }

  /**
   * Only ENOENT means the source tree is gone. Any other inspection error —
   * a Windows EPERM or EBUSY on a locked root — used to read as "nothing
   * left to delete", and the confirmed uninstall then dropped the record and
   * plugin data while the source tree survived: a half-uninstall that
   * re-discovered as a fresh install (#779 round 13 D3). The preflight
   * refuses instead.
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
   * Finishes an uninstall that has no source tree left to delete. An earlier
   * attempt deleted the root and then failed on the plugin data or the
   * record, stranding both: discovery offers no candidate, and every live
   * hash the normal path re-checks describes a tree that is gone. What the
   * user confirmed was that irreversible source delete, and it already
   * happened; what remains is what dohc itself built and recorded (#779
   * round 12 A2).
   */
  private async finishSourcelessUninstall(
    pluginId: string,
  ): Promise<PluginPipelineActionResult> {
    const status = this.statuses.get(pluginId);
    if (!status) return this.failure(pluginId, notDiscoveredError(pluginId));
    const candidate: InstalledPluginRecord = {
      id: pluginId,
      directoryName: status.directoryName,
      rootPath: status.rootPath,
      manifest: null,
      iconPath: null,
      diagnostics: status.diagnostics,
      valid: status.valid,
    };
    this.setStatus(candidate, {
      status: "uninstalling",
      disabledReason: "user",
      valid: status.valid,
      error: null,
    });
    try {
      await this.options.pluginHost.stop(pluginId);
      await this.removePluginData(pluginId);
      await this.operations.mutateRecord(
        this.options.stateDir,
        this.workspaceRoot,
        pluginId,
        () => undefined,
      );
      this.statuses.delete(pluginId);
      this.doorWrittenDeltas.delete(pluginId);
      this.emit({ kind: "removed", pluginId });
      return {
        ok: true,
        plugin: {
          ...cloneStatus(status),
          status: "disabled",
          disabledReason: "user",
        },
      };
    } catch (error) {
      const detail = pipelineError(
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
      return this.failure(pluginId, detail);
    }
  }

  private engineCaptureAvailable(): boolean {
    return this.options.isEngineCaptureAvailable?.() ?? true;
  }

  private liveRoot(pluginId: string): string {
    return join(this.dohcDir, "plugins", pluginIdToSafePath(pluginId));
  }

  /**
   * The live root and anything the pipeline left beside it. A build stages at
   * `<liveRoot>.staging-<uuid>` and swaps through `<liveRoot>.previous-<uuid>`
   * (#779 round 7 A1), and a source snapshot stages at
   * `<liveRoot>.snap-staging-<uuid>`, so a job that died mid-rename leaves
   * plugin bytes outside the live root that a recursive delete of the live
   * root alone would not reach. Only those exact families match: plugin ids
   * may contain dots, so any looser test deletes plugin `foo.bar`'s live root
   * while uninstalling `foo` (#779 round 10 B1).
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
   * approvedBundleHash (CERT779: a bundle tampered after the build, with its
   * source tree untouched, previously started because only file presence
   * was checked, never content).
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
   * host directly; when it can't (never built, or tampered since — CERT779),
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
  ): Promise<PluginPipelineActionResult> {
    const verified = await this.verifyApprovedSource(candidate, approvedHash);
    if (verified.kind === "failed") return verified.result;
    if (verified.kind === "changed") {
      return this.holdForApproval(candidate, verified.sourceHash);
    }

    const pluginId = candidate.id;
    const liveRoot = this.liveRoot(pluginId);
    if (!await this.verifiedLiveBundle(liveRoot, state.approvedBundleHash)) {
      return this.runFullBuild({
        candidate,
        startRuntime: true,
        disabledReasonAfterBuild: null,
        resetCrashAccounting: options.resetCrashAccounting,
        freshInstall: false,
        // The build snapshots the tree again, two full tree copies after the
        // verify pass above. Binding it to the hash that pass verified is
        // what keeps an out-of-band write landing in that window from being
        // auto-approved (#779 round 13 A1 — the same window round 9 B2
        // closed on the door-write path).
        expectedHash: approvedHash,
      });
    }

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
        this.options.pluginHost.resetCrashAccounting(pluginId);
      }
      if (!this.options.pluginHost.getStatus(pluginId)) {
        await this.options.pluginHost.start(
          liveRoot,
          generatedManifest(candidate.manifest),
        );
      }
      return this.success(this.setStatus(candidate, {
        status: "starting",
        disabledReason: null,
        runtimeStatus: "starting",
        error: null,
      }));
    } catch (error) {
      return this.failure(
        pluginId,
        pipelineError("runtime", options.runtimeErrorCode, errorMessage(error)),
      );
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
      diagnostics: boundedStatusLines(candidate.diagnostics),
      warnings: [],
      error: null,
    };
  }

  private setStatus(
    candidate: InstalledPluginRecord,
    patch: Partial<PluginPipelinePluginStatus>,
  ): PluginPipelinePluginStatus {
    const current = this.statuses.get(candidate.id) ?? this.baseStatus(candidate);
    const next: PluginPipelinePluginStatus = {
      ...current,
      ...patch,
      directoryName: candidate.directoryName,
      rootPath: candidate.rootPath,
      // A caller with no real discovery candidate left (failure()'s
      // synthetic fallback, below) explicitly states the validity it wants
      // preserved via patch.valid; every other caller passes a real
      // discovered candidate and gets the normal derived computation
      // (CodeRabbit #779 R23: without this, a failure recorded after a
      // still-valid plugin's discovery entry was replaced always read back
      // as invalid).
      valid: patch.valid ?? (candidate.valid && candidate.manifest !== null),
      // Derived from the candidate like directoryName/rootPath: an approved
      // manifest edit that adds or renames a web app must become visible on
      // the next status change, not stay frozen at first discovery. The
      // manifest's own metadata is derived the same way — except from a
      // synthetic candidate (failure()'s fallback, a sourceless uninstall),
      // which has no manifest to read. The status keeps the name and icon it
      // already carried rather than losing them mid-action.
      ...(candidate.manifest ? manifestMetadata(candidate) : {}),
      settings: candidate.manifest
        ? manifestSettings(candidate.manifest)
        : current.settings,
      webApps: patch.webApps ?? manifestWebApps(candidate.manifest),
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

  private failure(pluginId: string, error: PluginPipelineError): PluginPipelineActionResult {
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

  private enqueueSourceRefresh(pluginId: string, run: () => Promise<void>): void {
    if (this.disposed) return;
    const queue = this.queueFor(pluginId);
    if (queue.sourceRefreshQueued) return;
    queue.sourceRefreshQueued = true;
    queue.jobs.push({
      sourceRefresh: true,
      run: async () => {
        queue.sourceRefreshQueued = false;
        await run();
      },
    });
    this.drain(pluginId, queue);
  }

  private enqueueAction(
    pluginId: string,
    run: () => Promise<PluginPipelineActionResult>,
  ): Promise<PluginPipelineActionResult> {
    return this.enqueueActionValue(pluginId, async () => {
      try {
        return await run();
      } catch (error) {
        const detail = error instanceof PipelineFailure
          ? error.detail
          : pipelineError("runtime", "action-failed", errorMessage(error));
        return this.failure(pluginId, detail);
      }
    });
  }

  private enqueueActionValue<T>(pluginId: string, run: () => Promise<T>): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("Plugin pipeline is closed."));
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
