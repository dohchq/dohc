import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import type {
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

export interface EngineDaemonClient {
  sendRequest(request: Request): Promise<Response>;
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
  onFailure?: (error: Error, terminal: boolean) => void;
}

export interface EngineBinaryPathOptions {
  isPackaged: boolean;
  appPath: string;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
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
  private launchGeneration = 0;
  private activeGeneration = 0;
  private nextRequestId = 1;
  private running = false;
  private stopping = false;
  private readonly exitedGenerations = new Set<number>();

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
    await this.launchOnce();
  }

  async smokeWorkspace(
    rootDir: string,
    workspaceId: string,
  ): Promise<JsonValue> {
    const client = this.requireClient();
    const opened = resultObject(
      await client.sendRequest({
        id: this.requestId(),
        method: "workspace.open",
        params: { rootDir, workspaceId },
      }),
      "workspace.open",
    );
    if (typeof opened.workspace !== "string" || opened.workspace.length === 0) {
      throw new EngineDaemonUnavailableError(
        "Rust engine workspace.open returned no workspace handle.",
      );
    }
    const workspace = opened.workspace as WorkspaceHandle;
    try {
      const active = await client.sendRequest({
        id: this.requestId(),
        method: "versions.active",
        workspace,
        params: {},
      });
      return active.result;
    } finally {
      await client.sendRequest({
        id: this.requestId(),
        method: "workspace.close",
        workspace,
        params: {},
      });
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.running = false;
    const client = this.client;
    this.client = null;
    client?.close();
    await client?.waitForExit?.();
    await this.restartPromise?.catch(() => undefined);
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

  private assertBinaryPresent(): void {
    if (!this.fileExists(this.options.command)) {
      throw new EngineDaemonUnavailableError(
        `Rust engine binary not found: ${this.options.command}`,
      );
    }
  }

  private async launchOnce(): Promise<void> {
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
        onExit: (code, signal) => {
          this.handleUnexpectedExit(generation, code, signal);
        },
      });
    } catch (error) {
      throw new EngineDaemonUnavailableError(
        "Rust engine failed its startup handshake.",
        { cause: error },
      );
    }
    if (this.stopping || this.exitedGenerations.has(generation)) {
      client.close();
      if (this.stopping) return;
      throw new EngineDaemonUnavailableError(
        "Rust engine exited during its startup handshake.",
      );
    }
    this.client = client;
    this.running = true;
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
    for (let attempt = 1; attempt <= maxRestarts; attempt += 1) {
      const delay = Math.min(
        (this.options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS) *
          2 ** (attempt - 1),
        this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      );
      if (delay > 0) await this.sleep(delay);
      if (this.stopping) return;
      try {
        await this.launchOnce();
        return;
      } catch (error) {
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

  private reportFailure(error: Error, terminal: boolean): void {
    try {
      this.options.onFailure?.(error, terminal);
    } catch {
      // Failure reporting must never restart or crash the supervisor itself.
    }
  }
}

export async function runEngineDaemonStartupSmoke(
  lifecycle: EngineDaemonLifecycle,
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
    return await lifecycle.smokeWorkspace(
      rootDir,
      `desktop-startup-smoke-${process.pid}`,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

export function createRustEngineDaemonIfEnabled(
  enabled: boolean,
  options: EngineDaemonLifecycleOptions,
): EngineDaemonLifecycle | null {
  return enabled ? new EngineDaemonLifecycle(options) : null;
}
