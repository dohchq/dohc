import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import type {
  CompletedDaemonBlob,
  Event,
  JsonValue,
  Request,
  Response,
  WorkspaceHandle,
} from "@dohc/workspace-engine-client";
import {
  createEngineClient,
  type EngineClientSpawnOptions,
} from "./engineClient";

const ENGINE_BINARY_RESOURCE_DIR = "workspace-engine";
const ENGINE_BINARY_BASENAME = "dohc-workspace-engine";
const ENGINE_PROTOCOL_VERSION = 1;
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_INITIAL_BACKOFF_MS = 100;
const DEFAULT_MAX_BACKOFF_MS = 2_000;
const DEFAULT_HEALTHY_RESET_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export interface EngineDaemonClient {
  sendRequest(request: Request): Promise<Response>;
  onBlob?(handler: (blob: CompletedDaemonBlob) => void): () => void;
  onEvent?(handler: (event: Event) => void): () => void;
  close(): void;
  waitForExit?(): Promise<void>;
}

export interface EngineDaemonLifecycleOptions {
  command: string;
  launch?: (options: EngineClientSpawnOptions) => Promise<EngineDaemonClient>;
  fileExists?: (path: string) => boolean;
  tokenFactory?: () => string;
  sleep?: (delayMs: number) => Promise<void>;
  maxRestarts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  healthyResetMs?: number;
  requestTimeoutMs?: number;
  onFailure?: (error: Error, terminal: boolean) => void;
}

export interface EngineBinaryPathOptions {
  isPackaged: boolean;
  appPath: string;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
}

interface InFlightLaunch {
  readonly abortController: AbortController;
  readonly promise: Promise<void>;
}

export class EngineDaemonUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EngineDaemonUnavailableError";
  }
}

function engineBinaryName(platform: NodeJS.Platform): string {
  return `${ENGINE_BINARY_BASENAME}${platform === "win32" ? ".exe" : ""}`;
}

export function defaultEngineBinaryPath(
  options: EngineBinaryPathOptions,
): string {
  const platform = options.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  if (options.isPackaged) {
    if (!options.resourcesPath) {
      throw new EngineDaemonUnavailableError(
        "Electron resources path is unavailable for the packaged Rust engine.",
      );
    }
    return path.join(
      options.resourcesPath,
      ENGINE_BINARY_RESOURCE_DIR,
      engineBinaryName(platform),
    );
  }
  return path.resolve(
    options.appPath,
    "../..",
    "target",
    "debug",
    engineBinaryName(platform),
  );
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function resultObject(
  response: Response,
  method: string,
): Record<string, JsonValue | undefined> {
  const result = response.result;
  if (result === null || Array.isArray(result) || typeof result !== "object") {
    throw new EngineDaemonUnavailableError(
      `Rust engine ${method} returned an invalid result.`,
    );
  }
  return result;
}

export class EngineDaemonLifecycle {
  private readonly options: EngineDaemonLifecycleOptions;
  private readonly launch: (
    options: EngineClientSpawnOptions,
  ) => Promise<EngineDaemonClient>;
  private readonly fileExists: (path: string) => boolean;
  private readonly tokenFactory: () => string;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private client: EngineDaemonClient | null = null;
  private restartPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private launchGeneration = 0;
  private activeGeneration = 0;
  private nextRequestId = 1;
  private restartAttempts = 0;
  private running = false;
  private stopping = false;
  private healthyResetTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly exitedGenerations = new Set<number>();
  private readonly inFlightLaunches = new Set<InFlightLaunch>();
  private readonly launchingClients = new Set<EngineDaemonClient>();

  constructor(options: EngineDaemonLifecycleOptions) {
    this.options = options;
    this.launch = options.launch ?? createEngineClient;
    this.fileExists = options.fileExists ?? isFile;
    // The token is deliberately process-local and regenerated for every
    // launch. On Linux, another process owned by the same uid can inspect
    // /proc/<pid>/environ; the boundary here is other OS accounts. If the
    // threat model expands, replace this with an inherited fd or a 0600
    // create-exclusive file rather than persisting this token normally.
    this.tokenFactory =
      options.tokenFactory ?? (() => randomBytes(32).toString("hex"));
    this.sleep =
      options.sleep ??
      ((delayMs) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          timer.unref();
        }));
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.stopping) {
      throw new EngineDaemonUnavailableError(
        "Rust engine lifecycle is already stopping.",
      );
    }
    await this.launchTracked();
  }

  async smokeWorkspace(
    rootDir: string,
    workspaceId: string,
  ): Promise<JsonValue> {
    const client = this.requireClient();
    return await this.smokeWorkspaceWithClient(client, rootDir, workspaceId);
  }

  currentClient(): EngineDaemonClient {
    return this.requireClient();
  }

  async stop(): Promise<void> {
    if (!this.stopPromise) this.stopPromise = this.stopOnce();
    await this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    this.stopping = true;
    this.running = false;
    this.clearHealthyResetTimer();
    for (const launch of this.inFlightLaunches) {
      launch.abortController.abort();
    }
    const clients = new Set(this.launchingClients);
    if (this.client) clients.add(this.client);
    this.client = null;
    for (const client of clients) client.close();
    await Promise.allSettled(
      [...clients].map(async (client) => await client.waitForExit?.()),
    );
    await Promise.allSettled(
      [...this.inFlightLaunches].map(async ({ promise }) => await promise),
    );
    await this.restartPromise?.catch(() => undefined);
  }

  private async smokeWorkspaceWithClient(
    client: EngineDaemonClient,
    rootDir: string,
    workspaceId: string,
  ): Promise<JsonValue> {
    const opened = resultObject(
      await this.sendSmokeRequest(
        client,
        {
          id: this.requestId(),
          method: "workspace.open",
          params: { rootDir, workspaceId },
        },
        "workspace.open",
      ),
      "workspace.open",
    );
    if (typeof opened.workspace !== "string" || opened.workspace.length === 0) {
      throw new EngineDaemonUnavailableError(
        "Rust engine workspace.open returned no workspace handle.",
      );
    }
    const workspace = opened.workspace as WorkspaceHandle;
    try {
      const active = await this.sendSmokeRequest(
        client,
        {
          id: this.requestId(),
          method: "versions.active",
          workspace,
          params: {},
        },
        "versions.active",
      );
      return active.result;
    } finally {
      await this.sendSmokeRequest(
        client,
        {
          id: this.requestId(),
          method: "workspace.close",
          workspace,
          params: {},
        },
        "workspace.close",
      );
    }
  }

  private requestId(): number {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return id;
  }

  private requireClient(): EngineDaemonClient {
    if (!this.running || !this.client) {
      throw new EngineDaemonUnavailableError(
        "Rust engine daemon is not available.",
      );
    }
    return this.client;
  }

  private async sendSmokeRequest(
    client: EngineDaemonClient,
    request: Request,
    method: string,
  ): Promise<Response> {
    const timeoutMs =
      this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(
          new EngineDaemonUnavailableError(
            `Rust engine ${method} timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);
      timeout.unref();
    });
    try {
      return await Promise.race([client.sendRequest(request), deadline]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private assertBinaryPresent(): void {
    if (!this.fileExists(this.options.command)) {
      throw new EngineDaemonUnavailableError(
        `Rust engine binary not found: ${this.options.command}`,
      );
    }
  }

  private launchTracked(): Promise<void> {
    const abortController = new AbortController();
    const promise = this.launchOnce(abortController.signal);
    const launch: InFlightLaunch = { abortController, promise };
    this.inFlightLaunches.add(launch);
    void promise.then(
      () => this.inFlightLaunches.delete(launch),
      () => this.inFlightLaunches.delete(launch),
    );
    return promise;
  }

  private async launchOnce(signal: AbortSignal): Promise<void> {
    this.assertBinaryPresent();
    if (this.stopping) return;
    const generation = ++this.launchGeneration;
    this.activeGeneration = generation;
    const authToken = this.tokenFactory();
    let client: EngineDaemonClient;
    try {
      client = await this.launch({
        command: this.options.command,
        cwd: dirname(this.options.command),
        authToken,
        protocolVersion: ENGINE_PROTOCOL_VERSION,
        capabilities: ["blobs"],
        signal,
        onExit: (code, signal) => {
          this.handleUnexpectedExit(generation, code, signal);
        },
      });
    } catch (error) {
      if (this.stopping) return;
      throw new EngineDaemonUnavailableError(
        "Rust engine failed its startup handshake.",
        { cause: error },
      );
    }
    this.launchingClients.add(client);
    try {
      if (this.stopping || this.exitedGenerations.has(generation)) {
        await this.closeClient(client);
        if (this.stopping) return;
        throw new EngineDaemonUnavailableError(
          "Rust engine exited during its startup handshake.",
        );
      }
      await runEngineDaemonSmoke(async (rootDir, workspaceId) =>
        await this.smokeWorkspaceWithClient(client, rootDir, workspaceId),
      );
      if (this.stopping || this.exitedGenerations.has(generation)) {
        await this.closeClient(client);
        if (this.stopping) return;
        throw new EngineDaemonUnavailableError(
          "Rust engine exited during its startup health check.",
        );
      }
      this.client = client;
      this.running = true;
      this.scheduleHealthyReset(generation);
    } catch (error) {
      await this.closeClient(client);
      if (this.stopping) return;
      throw error;
    } finally {
      this.launchingClients.delete(client);
    }
  }

  private async closeClient(client: EngineDaemonClient): Promise<void> {
    client.close();
    await client.waitForExit?.();
  }

  private handleUnexpectedExit(
    generation: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    this.exitedGenerations.add(generation);
    if (
      this.stopping ||
      !this.running ||
      generation !== this.activeGeneration
    ) {
      return;
    }
    this.clearHealthyResetTimer();
    this.running = false;
    this.client = null;
    const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    this.reportFailure(
      new EngineDaemonUnavailableError(
        `Rust engine daemon exited unexpectedly with ${detail}.`,
      ),
      false,
    );
    if (!this.restartPromise) {
      this.restartPromise = this.restartAfterExit().finally(() => {
        this.restartPromise = null;
      });
      void this.restartPromise.catch(() => undefined);
    }
  }

  private async restartAfterExit(): Promise<void> {
    const maxRestarts = this.options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    let lastError: Error = new EngineDaemonUnavailableError(
      "Rust engine daemon exited unexpectedly.",
    );
    while (this.restartAttempts < maxRestarts) {
      const attempt = ++this.restartAttempts;
      const delay = Math.min(
        (this.options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS) *
          2 ** (attempt - 1),
        this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      );
      if (delay > 0) await this.sleep(delay);
      if (this.stopping) return;
      try {
        await this.launchTracked();
        return;
      } catch (error) {
        if (this.stopping) return;
        lastError = asError(error);
        this.reportFailure(lastError, false);
      }
    }
    const terminal = new EngineDaemonUnavailableError(
      `Rust engine restart limit exceeded after ${maxRestarts} attempts.`,
      { cause: lastError },
    );
    this.reportFailure(terminal, true);
    throw terminal;
  }

  private scheduleHealthyReset(generation: number): void {
    this.clearHealthyResetTimer();
    const healthyResetMs =
      this.options.healthyResetMs ?? DEFAULT_HEALTHY_RESET_MS;
    this.healthyResetTimer = setTimeout(() => {
      this.healthyResetTimer = null;
      if (
        this.running &&
        !this.stopping &&
        generation === this.activeGeneration
      ) {
        this.restartAttempts = 0;
      }
    }, healthyResetMs);
    this.healthyResetTimer.unref();
  }

  private clearHealthyResetTimer(): void {
    if (!this.healthyResetTimer) return;
    clearTimeout(this.healthyResetTimer);
    this.healthyResetTimer = null;
  }

  private reportFailure(error: Error, terminal: boolean): void {
    try {
      this.options.onFailure?.(error, terminal);
    } catch {
      // Failure reporting must never restart or crash the supervisor itself.
    }
  }
}

async function runEngineDaemonSmoke(
  smokeWorkspace: (rootDir: string, workspaceId: string) => Promise<JsonValue>,
): Promise<JsonValue> {
  const rootDir = await mkdtemp(join(tmpdir(), "dohc-rust-engine-smoke-"));
  try {
    const markerDirectory = join(rootDir, ".dohc", "engine");
    await mkdir(markerDirectory, { recursive: true });
    await writeFile(
      join(markerDirectory, "SHADOW_CLONE"),
      randomBytes(32).toString("hex"),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    return await smokeWorkspace(
      rootDir,
      `desktop-startup-smoke-${process.pid}`,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

export async function runEngineDaemonStartupSmoke(
  lifecycle: EngineDaemonLifecycle,
): Promise<JsonValue> {
  return await runEngineDaemonSmoke(async (rootDir, workspaceId) =>
    await lifecycle.smokeWorkspace(rootDir, workspaceId),
  );
}

export function createRustEngineDaemonIfEnabled(
  enabled: boolean,
  options: EngineDaemonLifecycleOptions,
): EngineDaemonLifecycle | null {
  return enabled ? new EngineDaemonLifecycle(options) : null;
}
