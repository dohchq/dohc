import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export type KernelRequestId = string | number;

export interface KernelFileMetadata {
  path: string;
  size: number;
  sha256: string;
  mediaType: string;
}

export interface KernelHashPathResult {
  path: string;
  status: "ok" | "error";
  size?: number;
  sha256?: string;
  error?: string;
}

export interface KernelManifestEntry {
  path: string;
  sha256: string;
  size: number;
  mtime: number;
}

export interface KernelHandshakeResult {
  protocolVersion: number;
  capabilities: string[];
}

export interface KernelScanResult {
  files: KernelFileMetadata[];
}

export interface KernelHashChangedResult {
  files: KernelHashPathResult[];
}

export interface KernelReconcileResult {
  changed: KernelFileMetadata[];
  added: KernelFileMetadata[];
  removed: string[];
}

export interface KernelCancelResult {
  cancelled: boolean;
}

export interface KernelCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface WorkspaceKernelClientOptions {
  binaryPath: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxRestarts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  killGraceMs?: number;
  onStderr?: (line: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

interface JsonRpcResponse {
  id?: KernelRequestId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  timingMs?: { total?: number };
}

interface PendingRequest<T> {
  method: string;
  resolve(value: T): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  settled: boolean;
  abort?: () => void;
}

export class KernelClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KernelClientError";
  }
}

export class KernelJsonRpcError extends KernelClientError {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "KernelJsonRpcError";
    this.code = code;
    this.data = data;
  }
}

export class KernelUnavailableError extends KernelClientError {
  constructor(message = "Workspace kernel is unavailable.", options?: ErrorOptions) {
    super(message, options);
    this.name = "KernelUnavailableError";
  }
}

export class KernelTimeoutError extends KernelClientError {
  constructor(method: string, timeoutMs: number) {
    super(`Workspace kernel ${method} timed out after ${timeoutMs}ms.`);
    this.name = "KernelTimeoutError";
  }
}

export class KernelProtocolError extends KernelClientError {
  constructor(message: string) {
    super(message);
    this.name = "KernelProtocolError";
  }
}

export function defaultWorkspaceKernelBinaryPath(repoRoot = resolve(process.cwd())): string {
  return join(
    repoRoot,
    "crates/workspace-kernel/target/release",
    `dohc-workspace-kernel${process.platform === "win32" ? ".exe" : ""}`,
  );
}

export function defaultWorkspaceKernelDebugBinaryPath(repoRoot = resolve(process.cwd())): string {
  return join(
    repoRoot,
    "crates/workspace-kernel/target/debug",
    `dohc-workspace-kernel${process.platform === "win32" ? ".exe" : ""}`,
  );
}

export class WorkspaceKernelClient {
  private readonly token = randomBytes(32).toString("hex");
  private readonly pending = new Map<KernelRequestId, PendingRequest<unknown>>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private disposed = false;
  private restartFailures = 0;
  private restarting: Promise<void> | null = null;

  constructor(private readonly options: WorkspaceKernelClientOptions) {}

  async handshake(options?: KernelCallOptions): Promise<KernelHandshakeResult> {
    return this.request<KernelHandshakeResult>("kernel.handshake", {}, options);
  }

  async scan(root: string, options?: KernelCallOptions): Promise<KernelScanResult> {
    return this.request<KernelScanResult>("kernel.scan", { root }, options);
  }

  async hashChanged(
    root: string,
    paths: readonly string[],
    options?: KernelCallOptions,
  ): Promise<KernelHashChangedResult> {
    return this.request<KernelHashChangedResult>(
      "kernel.hashChanged",
      { root, paths: [...paths] },
      options,
    );
  }

  async reconcile(
    root: string,
    manifest: readonly KernelManifestEntry[],
    options?: KernelCallOptions,
  ): Promise<KernelReconcileResult> {
    return this.request<KernelReconcileResult>(
      "kernel.reconcile",
      { root, manifest: [...manifest] },
      options,
    );
  }

  async cancel(requestId: KernelRequestId, options?: KernelCallOptions): Promise<KernelCancelResult> {
    return this.request<KernelCancelResult>("kernel.cancel", { requestId }, options);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    this.child = null;
    for (const [id, pending] of this.pending) {
      this.rejectPending(id, pending, new KernelUnavailableError("Workspace kernel client disposed."));
    }
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const grace = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      }, this.options.killGraceMs ?? 2000);
      grace.unref();
      child.once("exit", () => {
        clearTimeout(grace);
        resolve();
      });
    });
  }

  private async request<T>(
    method: string,
    params: Record<string, unknown>,
    options: KernelCallOptions = {},
  ): Promise<T> {
    if (this.disposed) throw new KernelUnavailableError("Workspace kernel client disposed.");
    await this.ensureProcess();
    const child = this.child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) {
      throw new KernelUnavailableError();
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 30_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.rejectPending(id, pending, new KernelTimeoutError(method, timeoutMs));
        this.sendCancel(id);
      }, timeoutMs);
      timer.unref();
      const pending: PendingRequest<T> = {
        method,
        resolve,
        reject,
        timer,
        settled: false,
      };
      if (options.signal) {
        const abort = () => {
          this.rejectPending(id, pending, new KernelClientError(`Workspace kernel ${method} aborted.`));
          this.sendCancel(id);
        };
        pending.abort = abort;
        if (options.signal.aborted) {
          abort();
          return;
        }
        options.signal.addEventListener("abort", abort, { once: true });
      }
      this.pending.set(id, pending as PendingRequest<unknown>);
      this.write({
        jsonrpc: "2.0",
        id,
        method,
        token: this.token,
        params,
      }).catch((error) => {
        this.rejectPending(
          id,
          pending,
          error instanceof Error ? error : new KernelProtocolError("Workspace kernel write failed."),
        );
      });
    });
  }

  private async ensureProcess(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) return;
    if (this.restarting) {
      await this.restarting;
      return;
    }
    this.restarting = this.startOrRestart();
    try {
      await this.restarting;
    } finally {
      this.restarting = null;
    }
  }

  private async startOrRestart(): Promise<void> {
    if (!existsSync(this.options.binaryPath)) {
      throw new KernelUnavailableError(`Workspace kernel binary not found: ${this.options.binaryPath}`);
    }
    if (this.restartFailures > 0) {
      const delay = Math.min(
        (this.options.initialBackoffMs ?? 100) * 2 ** (this.restartFailures - 1),
        this.options.maxBackoffMs ?? 2000,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (this.restartFailures > (this.options.maxRestarts ?? 3)) {
      throw new KernelUnavailableError("Workspace kernel restart limit exceeded.");
    }
    const child = spawn(this.options.binaryPath, [], {
      cwd: this.options.cwd ?? dirname(this.options.binaryPath),
      env: {
        ...process.env,
        ...this.options.env,
        DOHC_KERNEL_TOKEN: this.token,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.handleLine(line));
    const stderr = createInterface({ input: child.stderr });
    stderr.on("line", (line) => this.options.onStderr?.(line));
    child.once("error", (error) => this.handleUnexpectedExit(error));
    child.once("exit", (code, signal) => {
      this.options.onExit?.(code, signal);
      if (!this.disposed) this.handleUnexpectedExit(new KernelUnavailableError(`Workspace kernel exited (${code ?? signal ?? "unknown"}).`));
    });
  }

  private handleUnexpectedExit(error: Error): void {
    if (this.disposed) return;
    this.child = null;
    this.restartFailures += 1;
    for (const [id, pending] of this.pending) {
      this.rejectPending(id, pending, error);
    }
    if (this.restartFailures <= (this.options.maxRestarts ?? 3)) {
      this.restarting = this.startOrRestart().finally(() => {
        this.restarting = null;
      });
      this.restarting.catch(() => undefined);
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.failAll(new KernelProtocolError(`Invalid JSON-RPC line from workspace kernel: ${line.slice(0, 200)}`));
      return;
    }
    if (!isRecord(parsed) || !isKernelRequestId(parsed.id)) return;
    const id = parsed.id;
    const message = parsed as JsonRpcResponse;
    const pending = this.pending.get(id);
    if (!pending) return;
    if (message.error) {
      this.rejectPending(
        id,
        pending,
        new KernelJsonRpcError(message.error.code, message.error.message, message.error.data),
      );
    } else {
      this.resolvePending(id, pending, message.result);
    }
  }

  private async write(message: Record<string, unknown>): Promise<void> {
    const child = this.child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) {
      throw new KernelUnavailableError();
    }
    await new Promise<void>((resolveWrite, rejectWrite) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) rejectWrite(error);
        else resolveWrite();
      });
    });
  }

  private sendCancel(requestId: KernelRequestId): void {
    if (!this.child || this.disposed) return;
    const id = this.nextId++;
    this.write({
      jsonrpc: "2.0",
      id,
      method: "kernel.cancel",
      token: this.token,
      params: { requestId },
    }).catch(() => undefined);
  }

  private resolvePending(id: KernelRequestId, pending: PendingRequest<unknown>, value: unknown): void {
    if (pending.settled) return;
    pending.settled = true;
    this.restartFailures = 0;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(value);
  }

  private rejectPending(id: KernelRequestId, pending: PendingRequest<unknown>, error: Error): void {
    if (pending.settled) return;
    pending.settled = true;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.rejectPending(id, pending, error);
    }
  }
}

export function repoRootFromPackage(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKernelRequestId(value: unknown): value is KernelRequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
