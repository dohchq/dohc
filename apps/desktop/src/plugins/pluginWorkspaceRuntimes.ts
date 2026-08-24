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
  readonly workspaceId: string;
  readonly workspaceRoot: string;
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
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly pipeline: PluginPipeline;
  readonly agentDrivers: PluginAgentDrivers;
  readonly workspaceEvents: PluginWorkspaceEvents;
  readonly registrations = new Map<string, RegisteredPlugin>();
  private startPromise: Promise<void> | undefined;

  constructor(
    workspace: PluginWorkspaceIdentity,
    parts: PluginWorkspaceRuntimeParts,
  ) {
    this.workspaceId = workspace.workspaceId;
    this.workspaceRoot = normalizeAbsolutePath(workspace.rootPath);
    this.pipeline = parts.pipeline;
    this.agentDrivers = parts.agentDrivers;
    this.workspaceEvents = parts.workspaceEvents;
  }

  start(): Promise<void> {
    this.startPromise ??= this.pipeline.start();
    return this.startPromise;
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

type RuntimeSlot =
  | { readonly kind: "live"; readonly record: OwnedPluginWorkspaceRuntime }
  | {
      readonly kind: "stopping";
      readonly record: OwnedPluginWorkspaceRuntime;
      readonly stop: Promise<void>;
    };

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
        this.assertSameRoot(slot.record, workspaceRoot);
        if (slot.kind === "stopping") {
          await slot.stop.catch(() => undefined);
          continue;
        }
        const record = slot.record;
        try {
          await record.start();
        } catch (error) {
          await this.retireFailedStart(record);
          throw error;
        }
        this.assertStillLive(record);
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
          if (record) this.handlePipelineStatus(record, event);
          else pendingStatus.push(event);
        },
      });
      record = new OwnedPluginWorkspaceRuntime(workspace, parts);
      this.slots.set(workspace.workspaceId, { kind: "live", record });
      for (const event of pendingStatus) {
        this.handlePipelineStatus(record, event);
      }
      try {
        await record.start();
      } catch (error) {
        await this.retireFailedStart(record);
        throw error;
      }
      this.assertStillLive(record);
      return record;
    }
  }

  stop(workspaceId: string): Promise<void> {
    const slot = this.slots.get(workspaceId);
    if (!slot) return Promise.resolve();
    if (slot.kind === "stopping") return slot.stop;
    return this.beginStop(slot.record);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const stops = [...this.slots.values()].map((slot) =>
      slot.kind === "stopping" ? slot.stop : this.beginStop(slot.record),
    );
    this.closePromise = Promise.allSettled(stops).then((outcomes) => {
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
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

  private assertSameRoot(
    record: OwnedPluginWorkspaceRuntime,
    workspaceRoot: string,
  ): void {
    if (record.workspaceRoot === workspaceRoot) return;
    throw new Error(
      `Workspace "${record.workspaceId}" is already open from another folder. Close it and try again.`,
    );
  }

  private assertStillLive(record: OwnedPluginWorkspaceRuntime): void {
    const slot = this.slots.get(record.workspaceId);
    if (slot?.kind === "live" && slot.record === record) return;
    throw new Error("Plugin pipeline closed while the workspace was opening.");
  }

  private beginStop(record: OwnedPluginWorkspaceRuntime): Promise<void> {
    const stop = Promise.resolve().then(() => this.disposeRecord(record));
    this.slots.set(record.workspaceId, { kind: "stopping", record, stop });
    return stop;
  }

  private async retireFailedStart(
    record: OwnedPluginWorkspaceRuntime,
  ): Promise<void> {
    const slot = this.slots.get(record.workspaceId);
    const stop = slot?.record === record && slot.kind === "stopping"
      ? slot.stop
      : slot?.record === record
      ? this.beginStop(record)
      : undefined;
    if (!stop) return;
    try {
      await stop;
    } catch (error) {
      this.dependencies.onCleanupError?.(record.workspaceId, error);
    }
  }

  private async disposeRecord(
    record: OwnedPluginWorkspaceRuntime,
  ): Promise<void> {
    let failure: unknown;
    try {
      await record.pipeline.dispose();
    } catch (error) {
      failure = error;
    }
    try {
      record.workspaceEvents.dispose();
    } catch (error) {
      if (failure === undefined) failure = error;
      else this.dependencies.onCleanupError?.(record.workspaceId, error);
    } finally {
      record.registrations.clear();
      const slot = this.slots.get(record.workspaceId);
      if (slot?.kind === "stopping" && slot.record === record) {
        this.slots.delete(record.workspaceId);
      }
    }
    if (failure !== undefined) throw failure;
  }

  private handlePipelineStatus(
    record: OwnedPluginWorkspaceRuntime,
    event: PluginPipelineStatusEvent,
  ): void {
    const slot = this.slots.get(record.workspaceId);
    if (!slot || slot.record !== record) return;
    record.forgetRemovedPlugin(event);
    this.dependencies.onPipelineStatus(record.workspaceId, event);
  }
}
