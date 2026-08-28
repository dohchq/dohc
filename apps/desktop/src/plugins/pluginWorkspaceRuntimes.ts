import { normalizeAbsolutePath, type WatcherEvent } from "@dohc/workspace-core";
import type { PluginAgentDrivers } from "./pluginAgentDrivers";
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
}

export interface PluginWorkspaceRuntime {
  readonly pipeline: PluginPipeline;
  readonly agentDrivers: PluginAgentDrivers;
  readonly workspaceEvents: PluginWorkspaceEvents;
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
