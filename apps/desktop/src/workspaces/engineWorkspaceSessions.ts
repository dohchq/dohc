import {
  DaemonRefusalError,
  WORKSPACE_METHOD,
  WorkspaceDaemonRequester,
  decodeWorkspaceResult,
  type WorkspaceHandle,
} from "@dohc/workspace-engine-client";
import {
  EngineDaemonUnavailableError,
  type EngineDaemonClient,
} from "./engineDaemonLifecycle";

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
  closing: Promise<void> | null;
  activeRuns: number;
  idleWaiters: Set<() => void>;
}

export interface EngineWorkspaceRunOptions {
  /**
   * Replays the operation after transport rebinding. Callers must enable this
   * only for idempotent operations or calls that verify a possibly committed
   * first attempt before applying another write.
   */
  retryTransportErrors?: boolean;
}

export interface EngineWorkspaceSessionsOptions {
  transportRebindAttempts?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

const TRANSPORT_REBIND_ATTEMPTS = 6;
const TRANSPORT_REBIND_INITIAL_BACKOFF_MS = 100;
const TRANSPORT_REBIND_MAX_BACKOFF_MS = 1_000;
export const WORKSPACE_OPEN_DEADLINE_MS = 2_000;

export class EngineWorkspaceRebindError extends Error {
  readonly workspaceId: string;

  constructor(workspaceId: string, cause: unknown) {
    super(`Rust engine could not re-open workspace ${workspaceId}.`, { cause });
    this.name = "EngineWorkspaceRebindError";
    this.workspaceId = workspaceId;
  }
}

export class EngineWorkspaceSessionsClosedError extends Error {
  constructor() {
    super("Rust engine workspace sessions are closed.");
    this.name = "EngineWorkspaceSessionsClosedError";
  }
}

function requiresReconnect(error: unknown): boolean {
  return (
    error instanceof DaemonRefusalError &&
    error.disposition === "afterReconnect"
  );
}

function isTransportError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "transport-error"
  );
}

function daemonMayBeRelaunching(error: unknown): boolean {
  return (
    isTransportError(error) || error instanceof EngineDaemonUnavailableError
  );
}

function transportBackoffMs(attempt: number): number {
  return Math.min(
    TRANSPORT_REBIND_INITIAL_BACKOFF_MS * 2 ** Math.max(0, attempt - 1),
    TRANSPORT_REBIND_MAX_BACKOFF_MS,
  );
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

export class EngineWorkspaceSessions {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly transportRebindAttempts: number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private acceptingRuns = true;

  constructor(
    private readonly source: EngineDaemonClientSource,
    options: EngineWorkspaceSessionsOptions = {},
  ) {
    this.transportRebindAttempts =
      options.transportRebindAttempts ?? TRANSPORT_REBIND_ATTEMPTS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async run<T>(
    workspace: EngineWorkspace,
    operation: (binding: EngineWorkspaceBinding) => Promise<T>,
    options: EngineWorkspaceRunOptions = {},
  ): Promise<T> {
    const entry = await this.acquire(workspace.workspaceId);
    try {
      const maxAttempts = options.retryTransportErrors
        ? this.transportRebindAttempts
        : 2;
      let rebindStarted = false;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const binding = await this.openForRun(
          workspace,
          entry,
          options,
          rebindStarted,
        );
        try {
          return await operation(binding);
        } catch (error) {
          const retryAfterReconnect = requiresReconnect(error);
          const retryAfterTransport =
            options.retryTransportErrors === true && isTransportError(error);
          if (
            (!retryAfterReconnect && !retryAfterTransport) ||
            attempt >= maxAttempts
          ) {
            throw error;
          }
          if (entry.binding === binding) entry.binding = null;
          rebindStarted = true;
          lastError = error;
          if (retryAfterTransport) {
            await this.sleep(transportBackoffMs(attempt));
          }
        }
      }
      throw new EngineWorkspaceRebindError(workspace.workspaceId, lastError);
    } finally {
      this.release(entry);
    }
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    const entry = this.entries.get(workspaceId);
    if (!entry) return;
    if (entry.closing) {
      await entry.closing;
      return;
    }

    const closing = this.closeEntry(entry);
    entry.closing = closing;
    try {
      await closing;
    } finally {
      if (entry.closing === closing) entry.closing = null;
      if (this.entries.get(workspaceId) === entry) {
        this.entries.delete(workspaceId);
      }
    }
  }

  async closeAll(): Promise<void> {
    this.acceptingRuns = false;
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
      entry = {
        binding: null,
        opening: null,
        closing: null,
        activeRuns: 0,
        idleWaiters: new Set(),
      };
      this.entries.set(workspaceId, entry);
    }
    return entry;
  }

  private async acquire(workspaceId: string): Promise<SessionEntry> {
    for (;;) {
      if (!this.acceptingRuns) {
        throw new EngineWorkspaceSessionsClosedError();
      }
      const entry = this.entry(workspaceId);
      if (entry.closing) {
        await entry.closing;
        continue;
      }
      entry.activeRuns += 1;
      return entry;
    }
  }

  private release(entry: SessionEntry): void {
    entry.activeRuns -= 1;
    if (entry.activeRuns !== 0) return;
    const waiters = [...entry.idleWaiters];
    entry.idleWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private async waitForIdle(entry: SessionEntry): Promise<void> {
    if (entry.activeRuns === 0) return;
    await new Promise<void>((resolve) => {
      entry.idleWaiters.add(resolve);
    });
  }

  private async closeEntry(entry: SessionEntry): Promise<void> {
    await this.waitForIdle(entry);
    let binding = entry.binding;
    if (!binding && entry.opening) {
      binding = await entry.opening.promise.catch(() => null);
    }
    entry.binding = null;
    entry.opening = null;
    if (binding) await this.closeBinding(binding);
  }

  private async openForRun(
    workspace: EngineWorkspace,
    entry: SessionEntry,
    options: EngineWorkspaceRunOptions,
    rebindStarted: boolean,
  ): Promise<EngineWorkspaceBinding> {
    const maxAttempts = options.retryTransportErrors
      ? this.transportRebindAttempts
      : 2;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.open(workspace, entry);
      } catch (error) {
        if (error instanceof EngineWorkspaceRebindError) throw error;
        lastError = error;
        if (attempt >= maxAttempts) break;
        if (daemonMayBeRelaunching(error)) {
          await this.sleep(transportBackoffMs(attempt));
        }
      }
    }
    if (rebindStarted) {
      throw new EngineWorkspaceRebindError(workspace.workspaceId, lastError);
    }
    throw lastError;
  }

  private async open(
    workspace: EngineWorkspace,
    entry: SessionEntry,
  ): Promise<EngineWorkspaceBinding> {
    for (let attempt = 1; ; attempt += 1) {
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
        if (attempt >= this.transportRebindAttempts) {
          throw new EngineWorkspaceRebindError(
            workspace.workspaceId,
            new Error("Rust engine client changed on every open attempt."),
          );
        }
        await this.sleep(transportBackoffMs(attempt));
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
    const raw = await requester.request(
      WORKSPACE_METHOD.open,
      {
        rootDir: workspace.rootPath,
        workspaceId: workspace.workspaceId,
        // The desktop recovery sweep owns user-visible crash reconciliation.
        // A daemon-side open must therefore preserve running claims on both a
        // fresh desktop boot and a sidecar-only rebind.
        recoverRunningDispatches: false,
      },
      { deadlineMs: WORKSPACE_OPEN_DEADLINE_MS },
    );
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
