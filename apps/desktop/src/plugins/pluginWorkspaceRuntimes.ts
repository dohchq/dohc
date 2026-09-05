import { normalizeAbsolutePath, type WatcherEvent } from "@dohc/workspace-core";
import type { PluginAgentDrivers } from "./pluginAgentDrivers";
import type { PluginAutomations } from "./pluginAutomations";
import {
  forgetRemovedPlugin,
  forgetUninstalledPlugin,
  rememberPluginRegistration,
  resolveRegisteredPlugin,
  type RegisteredPlugin,
} from "./pluginPanelRegistration";
import type {
  PluginPipeline,
  PluginPipelineStatusEvent,
} from "./PluginPipeline";
import type { PluginWorkspaceEvents } from "./pluginWorkspaceEvents";

export interface PluginWorkspaceIdentity {
  readonly workspaceId: string;
  readonly rootPath: string;
}

export interface PluginWorkspaceRuntimeParts {
  readonly pipeline: PluginPipeline;
  readonly agentDrivers: PluginAgentDrivers;
  readonly workspaceEvents: PluginWorkspaceEvents;
  readonly automations: PluginAutomations;
}

export interface PluginWorkspaceRuntime {
  readonly pipeline: PluginPipeline;
  readonly agentDrivers: PluginAgentDrivers;
  readonly workspaceEvents: PluginWorkspaceEvents;
  readonly automations: PluginAutomations;
  registeredPlugin(pluginId: string): RegisteredPlugin | undefined;
  rememberPlugin(registration: RegisteredPlugin): RegisteredPlugin;
  forgetUninstalledPlugin(input: {
    pluginId: string;
    directoryName: string;
    released: boolean;
  }): void;
  handleWatcherEvents(events: readonly WatcherEvent[]): void;
}

interface PluginWorkspaceRuntimeHooks {
  onPipelineStatus(event: PluginPipelineStatusEvent): void;
}

export interface PluginWorkspaceRuntimesDependencies<
  TWorkspace extends PluginWorkspaceIdentity,
> {
  assertWritable(workspace: TWorkspace): void;
  isOpen(workspaceId: string): boolean;
  create(
    workspace: TWorkspace,
    hooks: PluginWorkspaceRuntimeHooks,
  ): PluginWorkspaceRuntimeParts;
  onPipelineStatus(
    workspaceId: string,
    event: PluginPipelineStatusEvent,
  ): void;
  onCleanupError?(workspaceId: string, error: unknown): void;
}

class OwnedPluginWorkspaceRuntime implements PluginWorkspaceRuntime {
  readonly pipeline: PluginPipeline;
  readonly agentDrivers: PluginAgentDrivers;
  readonly workspaceEvents: PluginWorkspaceEvents;
  readonly automations: PluginAutomations;
  private readonly workspaceId: string;
  private readonly workspaceRoot: string;
  private readonly registrations = new Map<string, RegisteredPlugin>();
  private startPromise: Promise<void> | undefined;
  private startSettled = false;

  constructor(
    workspace: PluginWorkspaceIdentity,
    parts: PluginWorkspaceRuntimeParts,
    private readonly onCleanupError: (error: unknown) => void,
  ) {
    this.workspaceId = workspace.workspaceId;
    this.workspaceRoot = normalizeAbsolutePath(workspace.rootPath);
    this.pipeline = parts.pipeline;
    this.agentDrivers = parts.agentDrivers;
    this.workspaceEvents = parts.workspaceEvents;
    this.automations = parts.automations;
  }

  start(): Promise<void> {
    this.startPromise ??= this.pipeline.start().finally(() => {
      this.startSettled = true;
    });
    return this.startPromise;
  }

  cancelStart(): void {
    if (this.startPromise && !this.startSettled) this.pipeline.cancelStart();
  }

  assertSameRoot(workspaceRoot: string): void {
    if (this.workspaceRoot === workspaceRoot) return;
    throw new Error(
      `Workspace "${this.workspaceId}" is already open from another folder. Close it and try again.`,
    );
  }

  async dispose(): Promise<void> {
    let failure: unknown;
    let pipelineDisposal: Promise<void>;
    try {
      pipelineDisposal = this.pipeline.dispose().catch((error: unknown) => {
        failure = error;
      });
    } catch (error) {
      failure = error;
      pipelineDisposal = Promise.resolve();
    }

    await pipelineDisposal;

    // Workspace close removes this desktop's automation subscriptions;
    // best-effort, after the pipeline stops feeding it status events.
    try {
      await this.automations.dispose();
    } catch (error) {
      if (failure === undefined) failure = error;
      else this.onCleanupError(error);
    }

    try {
      this.workspaceEvents.dispose();
    } catch (error) {
      if (failure === undefined) failure = error;
      else this.onCleanupError(error);
    } finally {
      this.registrations.clear();
    }
    if (failure !== undefined) throw failure;
  }

  registeredPlugin(pluginId: string): RegisteredPlugin | undefined {
    return resolveRegisteredPlugin(pluginId, this.pipeline, this.registrations);
  }

  rememberPlugin(registration: RegisteredPlugin): RegisteredPlugin {
    return rememberPluginRegistration(this.registrations, registration);
  }

  forgetUninstalledPlugin(input: {
    pluginId: string;
    directoryName: string;
    released: boolean;
  }): void {
    forgetUninstalledPlugin({ registrations: this.registrations, ...input });
  }

  forgetRemovedPlugin(event: PluginPipelineStatusEvent): void {
    forgetRemovedPlugin({ registrations: this.registrations, event });
  }

  handleWatcherEvents(events: readonly WatcherEvent[]): void {
    void this.pipeline.handleWatcherEvents(events);
    this.workspaceEvents.handleWatcherEvents(events);
  }
}

interface LiveRuntimeSlot {
  readonly kind: "live";
  readonly record: OwnedPluginWorkspaceRuntime;
}

interface StoppingRuntimeSlot {
  readonly kind: "stopping";
  readonly record: OwnedPluginWorkspaceRuntime | undefined;
  readonly stop: Promise<void>;
}

type RuntimeSlot = LiveRuntimeSlot | StoppingRuntimeSlot;
type PluginWorkspaceCleanup = () => void | Promise<void>;

const noCleanup = (): void => undefined;

export class PluginWorkspaceRuntimes<
  TWorkspace extends PluginWorkspaceIdentity,
> {
  private readonly slots = new Map<string, RuntimeSlot>();
  private readonly workspaces = new Map<string, TWorkspace>();
  private engineRestart: {
    ready: Promise<void>;
    resume(): void;
    fail(error: unknown): void;
    stopped: Promise<void>;
    workspaces: TWorkspace[];
  } | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly dependencies: PluginWorkspaceRuntimesDependencies<TWorkspace>,
  ) {}

  current(workspaceId: string): PluginWorkspaceRuntime | undefined {
    if (this.closed) return undefined;
    const slot = this.slots.get(workspaceId);
    return slot?.kind === "live" ? slot.record : undefined;
  }

  async ensure(workspace: TWorkspace): Promise<PluginWorkspaceRuntime> {
    this.assertOpen();
    this.dependencies.assertWritable(workspace);
    const workspaceRoot = normalizeAbsolutePath(workspace.rootPath);

    for (;;) {
      if (this.engineRestart) await this.engineRestart.ready;
      this.assertOpen();
      const slot = this.slots.get(workspace.workspaceId);
      if (slot) {
        if (slot.kind === "stopping") {
          slot.record?.assertSameRoot(workspaceRoot);
          await slot.stop;
          continue;
        }
        slot.record.assertSameRoot(workspaceRoot);
        const record = slot.record;
        try {
          await record.start();
        } catch (error) {
          await this.retireFailedStart(workspace.workspaceId, record);
          throw error;
        }
        this.assertStillLive(workspace.workspaceId, record);
        return record;
      }

      this.dependencies.assertWritable(workspace);
      this.assertOpen();
      if (!this.dependencies.isOpen(workspace.workspaceId)) {
        throw new Error(
          `Workspace "${workspace.workspaceId}" is no longer open. Open it again and retry.`,
        );
      }

      let record: OwnedPluginWorkspaceRuntime | undefined;
      const pendingStatus: PluginPipelineStatusEvent[] = [];
      const parts = this.dependencies.create(workspace, {
        onPipelineStatus: (event) => {
          if (record) {
            this.handlePipelineStatus(workspace.workspaceId, record, event);
          } else {
            pendingStatus.push(event);
          }
        },
      });
      record = new OwnedPluginWorkspaceRuntime(
        workspace,
        parts,
        (error) =>
          this.dependencies.onCleanupError?.(workspace.workspaceId, error),
      );
      this.slots.set(workspace.workspaceId, { kind: "live", record });
      this.workspaces.set(workspace.workspaceId, workspace);
      for (const event of pendingStatus) {
        this.handlePipelineStatus(workspace.workspaceId, record, event);
      }
      try {
        await record.start();
      } catch (error) {
        await this.retireFailedStart(workspace.workspaceId, record);
        throw error;
      }
      this.assertStillLive(workspace.workspaceId, record);
      return record;
    }
  }

  /** Stop surviving hosts before a replacement engine can reclaim their work. */
  prepareForEngineRestart(): Promise<void> {
    if (this.engineRestart) return this.engineRestart.stopped;
    const paused = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    // The shared gate can fail before any caller starts waiting on it.
    void paused.promise.catch(() => undefined);
    void stopped.promise.catch(paused.reject);
    const slots = [...this.slots.entries()];
    this.engineRestart = {
      ready: paused.promise,
      resume: paused.resolve,
      fail: paused.reject,
      stopped: stopped.promise,
      workspaces: slots.flatMap(([workspaceId, slot]) => {
        const workspace = this.workspaces.get(workspaceId);
        return slot.kind === "live" && workspace ? [workspace] : [];
      }),
    };
    // Invalidate every executor before any host teardown can yield or emit status.
    for (const [, slot] of slots) slot.record?.automations.stopForEngineRestart();
    try {
      const stops = slots.map(([workspaceId, slot]) =>
        // Close admission now even if a workspace close is awaiting surface cleanup.
        slot.kind === "live"
          ? this.stop(workspaceId)
          : slot.record?.pipeline.dispose() ?? Promise.resolve(),
      );
      void Promise.all(stops).then(() => stopped.resolve(), stopped.reject);
    } catch (error) {
      stopped.reject(error);
    }
    return stopped.promise;
  }

  failEngineRestart(error: unknown): void {
    this.engineRestart?.fail(error);
  }

  /** Recreate registered executors only after the replacement engine is reachable. */
  resumeAfterEngineRestart(): void {
    const restart = this.engineRestart;
    if (!restart) return;
    this.engineRestart = undefined;
    restart.resume();
    if (this.closed) return;
    for (const workspace of restart.workspaces) {
      if (!this.dependencies.isOpen(workspace.workspaceId)) continue;
      void this.ensure(workspace).catch((error: unknown) =>
        this.dependencies.onCleanupError?.(workspace.workspaceId, error),
      );
    }
  }

  /** Hides the runtime before cleanup starts, then disposes it after cleanup. */
  stop(
    workspaceId: string,
    beforeDispose: PluginWorkspaceCleanup = noCleanup,
  ): Promise<void> {
    const slot = this.slots.get(workspaceId);
    if (slot?.kind === "stopping") return slot.stop;
    return this.beginStop(workspaceId, slot?.record, beforeDispose);
  }

  /** Refuses new runtimes before cleanup starts, then drains every runtime. */
  close(beforeDispose: PluginWorkspaceCleanup = noCleanup): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.engineRestart?.resume();
    const {
      promise: cleanup,
      resolve: resolveCleanup,
      reject: rejectCleanup,
    } = Promise.withResolvers<void>();
    const stops = [...this.slots.entries()].map(([workspaceId, slot]) => {
      if (slot.kind === "stopping") {
        return { stop: slot.stop, waitsForCleanup: false };
      }
      return {
        stop: this.beginStop(workspaceId, slot.record, () => cleanup),
        waitsForCleanup: true,
      };
    });
    try {
      void Promise.resolve(beforeDispose()).then(resolveCleanup, rejectCleanup);
    } catch (error) {
      rejectCleanup(error);
    }
    this.closePromise = Promise.allSettled([
      cleanup,
      ...stops.map(({ stop }) => stop),
    ]).then(([cleanupOutcome, ...stopOutcomes]) => {
      const failures = cleanupOutcome.status === "rejected"
        ? [cleanupOutcome.reason]
        : [];
      stopOutcomes.forEach((outcome, index) => {
        if (
          outcome.status === "rejected" &&
          (cleanupOutcome.status === "fulfilled" || !stops[index]?.waitsForCleanup)
        ) {
          failures.push(outcome.reason);
        }
      });
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Plugin workspace cleanup failed.");
      }
    });
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Plugins are closed. Reopen dohc and try again.");
    }
  }

  private assertStillLive(
    workspaceId: string,
    record: OwnedPluginWorkspaceRuntime,
  ): void {
    const slot = this.slots.get(workspaceId);
    if (slot?.kind === "live" && slot.record === record) return;
    throw new Error("Plugin pipeline closed while the workspace was opening.");
  }

  private beginStop(
    workspaceId: string,
    record: OwnedPluginWorkspaceRuntime | undefined,
    beforeDispose: PluginWorkspaceCleanup = noCleanup,
  ): Promise<void> {
    const { promise: stop, resolve, reject } = Promise.withResolvers<void>();
    const slot: StoppingRuntimeSlot = { kind: "stopping", record, stop };
    this.slots.set(workspaceId, slot);
    record?.cancelStart();
    void this.disposeRecord(workspaceId, slot, beforeDispose).then(resolve, reject);
    return stop;
  }

  private async retireFailedStart(
    workspaceId: string,
    record: OwnedPluginWorkspaceRuntime,
  ): Promise<void> {
    const slot = this.slots.get(workspaceId);
    const stop = slot?.record === record && slot.kind === "stopping"
      ? slot.stop
      : slot?.record === record
      ? this.beginStop(workspaceId, record)
      : undefined;
    if (!stop) return;
    try {
      await stop;
    } catch (error) {
      this.dependencies.onCleanupError?.(workspaceId, error);
    }
  }

  private async disposeRecord(
    workspaceId: string,
    slot: StoppingRuntimeSlot,
    beforeDispose: PluginWorkspaceCleanup,
  ): Promise<void> {
    const cleanup = beforeDispose();
    if (cleanup) await cleanup;
    await slot.record?.dispose();
    if (this.slots.get(workspaceId) === slot) {
      this.slots.delete(workspaceId);
      this.workspaces.delete(workspaceId);
    }
  }

  private handlePipelineStatus(
    workspaceId: string,
    record: OwnedPluginWorkspaceRuntime,
    event: PluginPipelineStatusEvent,
  ): void {
    const slot = this.slots.get(workspaceId);
    if (!slot || slot.record !== record) return;
    record.forgetRemovedPlugin(event);
    this.dependencies.onPipelineStatus(workspaceId, event);
  }
}
