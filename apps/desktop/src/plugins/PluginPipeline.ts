import type { WatcherEvent } from "@dohc/workspace-core";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
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
  type PluginRecordShape,
} from "./pluginLocalState";
import { readPluginManifestFile } from "./pluginManifest";
import type { DohcPluginManifest } from "./pluginManifestSchema";
import type { PluginRuntimeStatus } from "./pluginHostProtocol";
import {
  hashPluginSourceFiles,
  pluginIdToSafePath,
  snapshotPluginSource,
  type PluginSourceSnapshotResult,
} from "./pluginSourceSnapshot";
import {
  pluginUninstallPreflight,
  summarizeUninstallPreflight,
  writePluginBaselineManifest,
  type PluginUninstallPreflightSummary,
} from "./pluginUninstallPreflight";

export { PLUGIN_PIPELINE_ERROR_STAGES, PLUGIN_PIPELINE_STATUSES };

export type PluginPipelineStatus = typeof PLUGIN_PIPELINE_STATUSES[number];

export type PluginPipelineErrorStage =
  typeof PLUGIN_PIPELINE_ERROR_STAGES[number];

export interface PluginPipelineError {
  stage: PluginPipelineErrorStage;
  code: string;
  message: string;
}

export interface PluginPipelinePluginStatus {
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
  pnpmRunnerEntry?: string;
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
  pluginRoot: string;
  liveHash: string | null;
}

interface FullBuildOptions {
  candidate: InstalledPluginRecord;
  startRuntime: boolean;
  disabledReasonAfterBuild: PluginPipelinePluginStatus["disabledReason"];
  resetCrashAccounting: boolean;
  freshInstall: boolean;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pipelineError(
  stage: PluginPipelineErrorStage,
  code: string,
  message: string,
): PluginPipelineError {
  return { stage, code, message };
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
    diagnostics: [...status.diagnostics],
    warnings: [...status.warnings],
    error: cloneError(status.error),
  };
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
          diagnostics: [...candidate.diagnostics],
          warnings: [],
          error: candidate.diagnostics.length > 0
            ? pipelineError(
              "discovery",
              "invalid-plugin",
              candidate.diagnostics.join(" "),
            )
            : null,
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
      const root = resolve(candidate.rootPath);
      if (target === root) return candidate.id;
      const fromRoot = relative(root, target);
      if (fromRoot.length > 0 && !fromRoot.startsWith("..") && !isAbsolute(fromRoot)) {
        return candidate.id;
      }
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

      const snapshot = await this.snapshot(candidate, state.approvedHash);
      if (!snapshot.ok) return snapshot.result;
      if (snapshot.value.sourceHash !== state.approvedHash) {
        return this.holdForApproval(candidate, snapshot.value.sourceHash);
      }

      const current = this.statuses.get(pluginId);
      return this.startVerified(candidate, state, {
        clearDisabled: true,
        resetCrashAccounting: current?.disabledReason === "crash-loop",
        freshInstall: false,
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
  ensureStarted(pluginId: string): Promise<PluginPipelineActionResult> {
    return this.enqueueAction(pluginId, async () => {
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

      const snapshot = await this.snapshot(candidate, state.approvedHash);
      if (!snapshot.ok) return snapshot.result;
      if (snapshot.value.sourceHash !== state.approvedHash) {
        return this.holdForApproval(candidate, snapshot.value.sourceHash);
      }

      return this.startVerified(candidate, state, {
        clearDisabled: false,
        resetCrashAccounting: false,
        freshInstall: false,
        runtimeErrorCode: "start-failed",
      });
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

  handleDoorWrittenSourceChange(pluginId: string): void {
    const candidate = this.validCandidate(pluginId);
    if (!candidate) return;
    // Hashed synchronously, before this refresh waits in the per-plugin
    // job queue: this is the tree's hash at door-write time. The queue
    // delay is unbounded — another job for this plugin may already be
    // running — so a disk-only write can land after the door write but
    // before this refresh gets its turn. The queued job below re-hashes
    // the live tree once it actually runs and holds for approval instead
    // of building if the two disagree, so that interloping change can
    // never ride the door write's auto-approval (#779 round 3 finding 1,
    // security-grade).
    const doorWrittenHash = hashPluginSourceFiles(candidate.rootPath)
      .then((digest) => digest.sourceHash)
      .catch(() => null);

    this.enqueueSourceRefresh(pluginId, async () => {
      const freshCandidate = this.validCandidate(pluginId);
      if (!freshCandidate) return;
      const state = await this.localRecord(pluginId);
      if (!state?.approvedHash) {
        this.setStatus(freshCandidate, { status: "discovered" });
        return;
      }
      const disabled = state.disabled === true;
      const [expectedHash, liveDigest] = await Promise.all([
        doorWrittenHash,
        hashPluginSourceFiles(freshCandidate.rootPath).catch(() => null),
      ]);
      if (
        expectedHash === null ||
        liveDigest === null ||
        liveDigest.sourceHash !== expectedHash
      ) {
        const priorDisabledReason = disabled
          ? this.statuses.get(pluginId)?.disabledReason ?? "user"
          : undefined;
        await this.holdForApproval(
          freshCandidate,
          liveDigest?.sourceHash ?? state.approvedHash,
          priorDisabledReason,
        );
        return;
      }
      await this.runFullBuild({
        candidate: freshCandidate,
        startRuntime: !disabled,
        disabledReasonAfterBuild: disabled ? "user" : null,
        resetCrashAccounting: !disabled,
        freshInstall: false,
      });
    });
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
        const candidate = this.requireValidCandidate(pluginId);
        const record = await this.localRecord(pluginId);
        const preflight = await this.operations.uninstallPreflight({
          dohcDir: this.dohcDir,
          pluginId,
          pluginRoot: candidate.rootPath,
          installedBaselineHash: record?.installedBaselineHash,
          engineCaptureAvailable: this.engineCaptureAvailable(),
        });
        const confirmationToken = randomUUID();
        this.uninstallConfirmations.set(pluginId, {
          token: confirmationToken,
          pluginRoot: resolve(candidate.rootPath),
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

      const candidate = this.requireValidCandidate(pluginId);
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
      const record = await this.localRecord(pluginId);
      const currentPreflight = await this.operations.uninstallPreflight({
        dohcDir: this.dohcDir,
        pluginId,
        pluginRoot: candidate.rootPath,
        installedBaselineHash: record?.installedBaselineHash,
        engineCaptureAvailable: this.engineCaptureAvailable(),
      });
      if (currentPreflight.liveHash !== confirmation.liveHash) {
        return this.failure(
          pluginId,
          pipelineError(
            "uninstall",
            "confirmation-stale",
            `Plugin "${pluginId}" changed after uninstall preflight. Review it again.`,
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
          installedBaselineHash: record?.installedBaselineHash,
          engineCaptureAvailable: this.engineCaptureAvailable(),
        });
        if (preDeletePreflight.liveHash !== confirmation.liveHash) {
          const detail = pipelineError(
            "uninstall",
            "confirmation-stale",
            `Plugin "${pluginId}" changed while its process was stopping. Review uninstall again.`,
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
          this.operations.removePath(this.liveRoot(pluginId), {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
          }),
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
        this.discovery = this.discovery.filter((entry) =>
          entry.id !== pluginId || resolve(entry.rootPath) !== resolve(candidate.rootPath)
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
      this.discovery = await this.operations.discover(this.workspaceRoot);
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
    const stateResult = await this.operations.readLocalState(
      this.options.stateDir,
      this.workspaceRoot,
    );
    if (!stateResult.ok) {
      throw new PipelineFailure(
        pipelineError("state", "local-state-unreadable", stateResult.warning),
      );
    }
    for (const candidate of this.discovery) {
      if (!candidate.valid || !candidate.manifest) continue;
      const record = stateResult.state.plugins[candidate.id];
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
  }

  private async processWatcherBatch(events: readonly WatcherEvent[]): Promise<void> {
    if (this.disposed) return;
    const previous = this.discovery;
    const next = await this.operations.discover(this.workspaceRoot);
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
      const old = previousValid.find((entry) =>
        entry.id === candidate.id && resolve(entry.rootPath) === resolve(candidate.rootPath)
      );
      if (!old) continue;
      this.enqueueSourceRefresh(candidate.id, () =>
        this.reconcileApprovedCandidate(candidate.id, false));
    }
  }

  private async seedStatusesForNewCandidates(
    candidates: readonly InstalledPluginRecord[],
  ): Promise<void> {
    for (const candidate of candidates) {
      if (!candidate.valid || !candidate.manifest || this.statuses.has(candidate.id)) {
        continue;
      }
      const record = await this.localRecord(candidate.id);
      this.setStatus(candidate, {
        status: record?.approvedHash
          ? record.disabled === true
            ? "disabled"
            : "queued"
          : "discovered",
        disabledReason: record?.disabled === true ? "user" : null,
        approvedHash: record?.approvedHash ?? null,
        installedBaselineHash: record?.installedBaselineHash ?? null,
      });
    }
  }

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
    const snapshot = await this.snapshot(candidate, record.approvedHash);
    if (!snapshot.ok) return;
    if (snapshot.value.sourceHash !== record.approvedHash) {
      // The disabled bit is the user's own choice, orthogonal to whether
      // this content is approved — an out-of-band change landing on an
      // already-disabled plugin must not let a later approve() silently
      // re-enable it (#779 round 3 finding 5).
      const priorDisabledReason = record.disabled === true
        ? this.statuses.get(pluginId)?.disabledReason ?? "user"
        : undefined;
      await this.holdForApproval(candidate, snapshot.value.sourceHash, priorDisabledReason);
      return;
    }
    this.setStatus(candidate, {
      sourceHash: snapshot.value.sourceHash,
      approvedHash: record.approvedHash,
      installedBaselineHash: record.installedBaselineHash ?? null,
    });
    if (record.disabled === true) {
      this.setStatus(candidate, {
        status: "disabled",
        disabledReason: this.statuses.get(pluginId)?.disabledReason ?? "user",
        runtimeStatus: null,
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
      await this.operations.removePath(this.liveRoot(candidate.id), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
      this.statuses.delete(candidate.id);
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
    try {
      const snapshot = await this.snapshotOrThrow(validCandidate);
      sourceHash = snapshot.sourceHash;
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
      this.unwrap("install", await this.operations.install({
        workspaceRoot: this.workspaceRoot,
        pluginId: candidate.id,
        snapshotRoot: snapshot.snapshotRoot,
        pnpmPaths: snapshot.pnpmPaths,
        resourcesBasePath: this.options.resourcesBasePath,
        pnpmRunnerEntry: this.options.pnpmRunnerEntry,
        signal: this.abortController.signal,
      }));

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
          }),
        );
      } catch (error) {
        // The next install re-stages the snapshot, so a discard that also
        // fails cannot make the recorded state wrong — only the staged tree
        // is lost.
        await built.discard().catch(() => undefined);
        throw failureFromUnknown("state", "state-write-failed", error);
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
      const warnings = [
        ...scan.warningLines,
        ...(published.cleanupWarning ? [published.cleanupWarning] : []),
      ];

      if (input.startRuntime) {
        this.setStatus(candidate, { status: "starting", warnings });
        if (oldRuntime) await this.options.pluginHost.stop(candidate.id);
        if (input.resetCrashAccounting) {
          this.options.pluginHost.resetCrashAccounting(candidate.id);
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

  private async snapshot(
    candidate: InstalledPluginRecord & { manifest: DohcPluginManifest },
    preserveIfHashMatches?: string,
  ): Promise<
    | { ok: true; value: Extract<PluginSourceSnapshotResult, { ok: true }> }
    | { ok: false; result: PluginPipelineActionResult }
  > {
    try {
      return {
        ok: true,
        value: await this.snapshotOrThrow(candidate, preserveIfHashMatches),
      };
    } catch (error) {
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
      return { ok: false, result: this.failure(candidate.id, detail) };
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

  private async localRecord(pluginId: string): Promise<PluginRecordShape | undefined> {
    const result = await this.operations.readLocalState(
      this.options.stateDir,
      this.workspaceRoot,
    );
    if (!result.ok) {
      throw new PipelineFailure(
        pipelineError("state", "local-state-unreadable", result.warning),
      );
    }
    return result.state.plugins[pluginId];
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

  private engineCaptureAvailable(): boolean {
    return this.options.isEngineCaptureAvailable?.() ?? true;
  }

  private liveRoot(pluginId: string): string {
    return join(this.dohcDir, "plugins", pluginIdToSafePath(pluginId));
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
   * The shared tail of enable() and ensureStarted(): the candidate's source
   * hash already matches its approvedHash, so the only remaining question is
   * whether the already-built bundle.mjs on disk can still be trusted to run
   * as-is. When it can, this starts the host directly; when it can't (never
   * built, or tampered since — CERT779), this rebuilds from the still-
   * approved source rather than starting whatever bytes are on disk.
   */
  private async startVerified(
    candidate: InstalledPluginRecord & { manifest: DohcPluginManifest },
    state: PluginRecordShape,
    options: {
      clearDisabled: boolean;
      resetCrashAccounting: boolean;
      freshInstall: boolean;
      runtimeErrorCode: string;
    },
  ): Promise<PluginPipelineActionResult> {
    const pluginId = candidate.id;
    const liveRoot = this.liveRoot(pluginId);
    const verified = await this.verifiedLiveBundle(liveRoot, state.approvedBundleHash);
    if (!verified) {
      return this.runFullBuild({
        candidate,
        startRuntime: true,
        disabledReasonAfterBuild: null,
        resetCrashAccounting: options.resetCrashAccounting,
        freshInstall: options.freshInstall,
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
      diagnostics: [...candidate.diagnostics],
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
      diagnostics: patch.diagnostics
        ? [...patch.diagnostics]
        : [...current.diagnostics],
      warnings: patch.warnings ? [...patch.warnings] : [...current.warnings],
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
