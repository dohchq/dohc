import {
  DaemonRefusalError,
  WORKSPACE_METHOD,
  WorkspaceDaemonRequester,
  decodeWorkspaceResult,
  type WorkspaceHandle,
} from "@dohc/workspace-engine-client";
import type { EngineDaemonClient } from "./engineDaemonLifecycle";

export interface EngineWorkspace {
  workspaceId: string;
  rootPath: string;
}

export interface EngineWorkspaceBinding {
  client: EngineDaemonClient;
  workspace: WorkspaceHandle;
}

export interface EngineDaemonClientSource {
  currentClient(): EngineDaemonClient;
}

interface SessionEntry {
  binding: EngineWorkspaceBinding | null;
  opening: {
    client: EngineDaemonClient;
    promise: Promise<EngineWorkspaceBinding>;
  } | null;
}

export class EngineWorkspaceRebindError extends Error {
  readonly workspaceId: string;

  constructor(workspaceId: string, cause: unknown) {
    super(`Rust engine could not re-open workspace ${workspaceId}.`, { cause });
    this.name = "EngineWorkspaceRebindError";
    this.workspaceId = workspaceId;
  }
}

function requiresReconnect(error: unknown): boolean {
  return (
    error instanceof DaemonRefusalError &&
    error.disposition === "afterReconnect"
  );
}

export class EngineWorkspaceSessions {
  private readonly entries = new Map<string, SessionEntry>();

  constructor(private readonly source: EngineDaemonClientSource) {}

  async run<T>(
    workspace: EngineWorkspace,
    operation: (binding: EngineWorkspaceBinding) => Promise<T>,
  ): Promise<T> {
    const binding = await this.open(workspace);
    try {
      return await operation(binding);
    } catch (error) {
      if (!requiresReconnect(error)) throw error;
      const entry = this.entry(workspace.workspaceId);
      if (entry.binding === binding) entry.binding = null;
      entry.opening = null;
      let rebound: EngineWorkspaceBinding;
      try {
        rebound = await this.open(workspace);
      } catch (reopenError) {
        throw new EngineWorkspaceRebindError(
          workspace.workspaceId,
          reopenError,
        );
      }
      return await operation(rebound);
    }
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    const entry = this.entries.get(workspaceId);
    if (!entry) return;
    this.entries.delete(workspaceId);
    let binding = entry.binding;
    if (!binding && entry.opening) {
      binding = await entry.opening.promise.catch(() => null);
    }
    if (!binding) return;
    await this.closeBinding(binding);
  }

  async closeAll(): Promise<void> {
    const workspaceIds = [...this.entries.keys()];
    await Promise.allSettled(
      workspaceIds.map(async (workspaceId) => {
        await this.closeWorkspace(workspaceId);
      }),
    );
  }

  private entry(workspaceId: string): SessionEntry {
    let entry = this.entries.get(workspaceId);
    if (!entry) {
      entry = { binding: null, opening: null };
      this.entries.set(workspaceId, entry);
    }
    return entry;
  }

  private async open(
    workspace: EngineWorkspace,
  ): Promise<EngineWorkspaceBinding> {
    const entry = this.entry(workspace.workspaceId);
    for (;;) {
      const client = this.source.currentClient();
      if (entry.binding?.client === client) return entry.binding;
      if (entry.binding?.client !== client) entry.binding = null;
      if (entry.opening?.client === client) return await entry.opening.promise;

      const promise = this.openWithClient(client, workspace);
      entry.opening = { client, promise };
      let binding: EngineWorkspaceBinding;
      try {
        binding = await promise;
      } finally {
        if (entry.opening?.promise === promise) entry.opening = null;
      }
      if (this.source.currentClient() !== client) {
        await this.closeBinding(binding).catch(() => undefined);
        continue;
      }
      entry.binding = binding;
      return binding;
    }
  }

  private async openWithClient(
    client: EngineDaemonClient,
    workspace: EngineWorkspace,
  ): Promise<EngineWorkspaceBinding> {
    const requester = new WorkspaceDaemonRequester(client);
    const raw = await requester.request(WORKSPACE_METHOD.open, {
      rootDir: workspace.rootPath,
      workspaceId: workspace.workspaceId,
    });
    const opened = decodeWorkspaceResult(WORKSPACE_METHOD.open, raw);
    return { client, workspace: opened.workspace as WorkspaceHandle };
  }

  private async closeBinding(binding: EngineWorkspaceBinding): Promise<void> {
    const requester = new WorkspaceDaemonRequester(binding.client);
    const raw = await requester.request(
      WORKSPACE_METHOD.close,
      {},
      { workspace: binding.workspace },
    );
    decodeWorkspaceResult(WORKSPACE_METHOD.close, raw);
  }
}
