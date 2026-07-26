import {
  DaemonRefusalError,
  WORKSPACE_METHOD,
  WorkspaceDaemonRequester,
  decodeWorkspaceResult,
  type WorkspaceHandle,
} from "@dohc/workspace-engine-client";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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

export interface EngineWorkspaceRunOptions {
  retryTransportErrors?: boolean;
}

export interface EngineWorkspaceSessionsOptions {
  transportRebindAttempts?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

const TRANSPORT_REBIND_ATTEMPTS = 6;
const TRANSPORT_REBIND_INITIAL_BACKOFF_MS = 100;
const TRANSPORT_REBIND_MAX_BACKOFF_MS = 1_000;
const SHADOW_CLONE_TOKEN = /^[0-9a-f]{64}$/;

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

export class EngineWorkspaceRebindError extends Error {
  readonly workspaceId: string;

  constructor(workspaceId: string, cause: unknown) {
    super(`Rust engine could not re-open workspace ${workspaceId}.`, { cause });
    this.name = "EngineWorkspaceRebindError";
    this.workspaceId = workspaceId;
  }
}

export function isEngineSessionReconnectError(error: unknown): boolean {
  return (
    (error instanceof DaemonRefusalError &&
      error.disposition === "afterReconnect") ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "transport-error")
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
  private readonly preparations = new Map<string, Promise<void>>();
  private readonly transportRebindAttempts: number;
  private readonly sleep: (delayMs: number) => Promise<void>;

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
    const maxAttempts = options.retryTransportErrors
      ? this.transportRebindAttempts
      : 1;
    let rebindStarted = false;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let binding: EngineWorkspaceBinding;
      try {
        binding = await this.open(workspace);
      } catch (reopenError) {
        if (
          rebindStarted &&
          options.retryTransportErrors &&
          attempt < maxAttempts
        ) {
          lastError = reopenError;
          await this.sleep(transportBackoffMs(attempt));
          continue;
        }
        if (!rebindStarted) throw reopenError;
        throw new EngineWorkspaceRebindError(
          workspace.workspaceId,
          reopenError,
        );
      }
      try {
        return await operation(binding);
      } catch (error) {
        const reconnectRequired = isEngineSessionReconnectError(error);
        const retryAfterTransport =
          options.retryTransportErrors === true &&
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "transport-error";
        if (reconnectRequired) {
          const entry = this.entry(workspace.workspaceId);
          if (entry.binding === binding) entry.binding = null;
        }
        const retryAfterReconnect =
          options.retryTransportErrors === true && reconnectRequired;
        if (
          (!retryAfterReconnect && !retryAfterTransport) ||
          attempt >= maxAttempts
        ) {
          throw error;
        }
        rebindStarted = true;
        lastError = error;
        if (retryAfterTransport) {
          await this.sleep(transportBackoffMs(attempt));
        }
      }
    }
    throw new EngineWorkspaceRebindError(workspace.workspaceId, lastError);
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
    await this.prepareWorkspace(workspace.rootPath);
    const requester = new WorkspaceDaemonRequester(client);
    const raw = await requester.request(WORKSPACE_METHOD.open, {
      rootDir: workspace.rootPath,
      workspaceId: workspace.workspaceId,
    });
    const opened = decodeWorkspaceResult(WORKSPACE_METHOD.open, raw);
    return { client, workspace: opened.workspace };
  }

  private async prepareWorkspace(rootPath: string): Promise<void> {
    let preparation = this.preparations.get(rootPath);
    if (!preparation) {
      preparation = (async () => {
        const workspaceRoot = resolve(rootPath);
        const rootInfo = await lstat(workspaceRoot);
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
          throw new Error(
            `Rust engine workspace root must be a real directory: ${rootPath}.`,
          );
        }
        const realRoot = await realpath(workspaceRoot);
        const dohcDirectory = join(workspaceRoot, ".dohc");
        const markerDirectory = join(dohcDirectory, "engine");
        const markerPath = join(markerDirectory, "SHADOW_CLONE");
        await this.ensureRealDirectory(dohcDirectory, realRoot);
        await this.ensureRealDirectory(markerDirectory, realRoot);
        try {
          await writeFile(
            markerPath,
            randomBytes(32).toString("hex"),
            { encoding: "utf8", flag: "wx", mode: 0o600 },
          );
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
          const markerInfo = await lstat(markerPath);
          if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) {
            throw new Error(
              `Rust engine shadow marker must be a real file: ${markerPath}.`,
            );
          }
          const token = await readFile(markerPath, "utf8");
          if (!SHADOW_CLONE_TOKEN.test(token)) {
            throw new Error(
              `Rust engine shadow marker is invalid for ${rootPath}.`,
            );
          }
        }
      })();
      this.preparations.set(rootPath, preparation);
      const release = () => {
        if (this.preparations.get(rootPath) === preparation) {
          this.preparations.delete(rootPath);
        }
      };
      void preparation.then(release, release);
    }
    await preparation;
  }

  private async ensureRealDirectory(
    directory: string,
    realRoot: string,
  ): Promise<void> {
    try {
      await mkdir(directory);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Rust engine directory must not be a symlink: ${directory}.`);
    }
    const resolvedDirectory = await realpath(directory);
    const escape = relative(realRoot, resolvedDirectory);
    if (
      escape === ".." ||
      escape.startsWith(`..${sep}`) ||
      isAbsolute(escape)
    ) {
      throw new Error(`Rust engine directory escapes the workspace: ${directory}.`);
    }
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
