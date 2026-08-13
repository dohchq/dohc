import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { killChildTreeWin32, resolveSpawnCommand } from "../process/windowsSpawn";

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
}

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface JsonRpcTransportOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  /**
   * POSIX only. Spawns the child as the leader of a new process group so
   * dispose() can signal the whole group, not just the direct child. Ignored
   * on win32 (killChildTreeWin32 already handles the whole tree there).
   * Defaults to false, preserving existing behavior for every current caller.
   */
  detached?: boolean;
  label?: string;
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: (method: string, params: unknown) => Promise<unknown> | unknown;
  onStderr?: (line: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasMethod(value: JsonRpcMessage): value is JsonRpcRequest | JsonRpcNotification {
  return "method" in value && typeof value.method === "string";
}

function hasId(value: JsonRpcMessage): value is JsonRpcRequest | JsonRpcResponse {
  return "id" in value && (typeof value.id === "string" || typeof value.id === "number");
}

function normalizeError(error: unknown): JsonRpcError {
  if (error instanceof JsonRpcError) return error;
  if (error instanceof Error) return new JsonRpcError(-32603, error.message);
  return new JsonRpcError(-32603, "JSON-RPC handler failed.");
}

export { resolveSpawnCommand } from "../process/windowsSpawn";

export class JsonRpcTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly exited: Promise<void>;
  private nextId = 1;
  private closed = false;

  private constructor(child: ChildProcessWithoutNullStreams, private readonly options: JsonRpcTransportOptions) {
    this.child = child;
    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.handleLine(line));
    const stderr = createInterface({ input: child.stderr });
    stderr.on("line", (line) => options.onStderr?.(line));
    this.exited = new Promise((resolve) => {
      child.once("exit", () => resolve());
      // A spawn failure may never emit "exit"; treat it as terminal too.
      child.once("error", () => resolve());
    });
    child.once("error", (error) => this.close(error));
    child.once("exit", (code, signal) => {
      options.onExit?.(code, signal);
      this.close(new Error(`${options.label ?? options.command} exited (${code ?? signal ?? "unknown"})`));
    });
  }

  static spawn(options: JsonRpcTransportOptions): JsonRpcTransport {
    const env = { ...process.env, ...options.env };
    const resolved = resolveSpawnCommand(options.command, options.args, {
      env,
      cwd: options.cwd,
    });
    const child = spawn(resolved.command, resolved.args, {
      cwd: options.cwd,
      env,
      detached: options.detached === true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    });
    return new JsonRpcTransport(child, options);
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("JSON-RPC transport is closed."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      if (!this.send({ jsonrpc: "2.0", id, method, params })) {
        this.pending.delete(id);
        reject(new Error("JSON-RPC transport is closed."));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  async dispose(): Promise<void> {
    this.close(new Error("JSON-RPC transport disposed."));
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    // Shim-launched agents (.cmd via cmd.exe) must die as a tree: killing
    // only the wrapper leaves the real agent alive with the workspace root
    // as its cwd, keeping that directory locked on Windows.
    await killChildTreeWin32(this.child);
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const processGroupId =
      this.options.detached === true && process.platform !== "win32"
        ? this.child.pid
        : undefined;
    if (processGroupId !== undefined) {
      try {
        process.kill(-processGroupId, "SIGTERM");
      } catch {
        // The process group may already be gone.
      }
    } else {
      this.child.kill("SIGTERM");
    }
    // The escalation timer self-guards on exit state and is unref'd, so it
    // never needs cancelling — clearing it could skip the SIGKILL in the
    // exotic case where "error" resolves the exit promise while the child
    // still lives.
    const forceKill = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        if (processGroupId !== undefined) {
          try {
            process.kill(-processGroupId, "SIGKILL");
          } catch {
            // The process group may already be gone.
          }
        } else {
          this.child.kill("SIGKILL");
        }
      }
    }, 2000);
    forceKill.unref();
    // Wait for the child to actually exit: a live child whose cwd is the
    // workspace root keeps that directory locked on Windows, so a dispose
    // that returns before exit leaves the workspace undeletable. Bounded so
    // an unkillable child cannot hang dispose forever.
    let waitCap: NodeJS.Timeout | undefined;
    const capped = new Promise<void>((resolve) => {
      waitCap = setTimeout(resolve, 5000);
      waitCap.unref?.();
    });
    try {
      await Promise.race([this.exited, capped]);
    } finally {
      if (waitCap) clearTimeout(waitCap);
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.options.onStderr?.(`Invalid JSON-RPC line: ${line.slice(0, 200)}`);
      return;
    }
    if (!isRecord(parsed)) return;
    const message = parsed as unknown as JsonRpcMessage;
    if (hasMethod(message) && hasId(message)) {
      void this.handleIncomingRequest(message);
      return;
    }
    if (hasMethod(message)) {
      this.options.onNotification?.(message.method, message.params);
      return;
    }
    if (hasId(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if ("error" in message && message.error) {
        pending.reject(
          new JsonRpcError(
            message.error.code,
            message.error.message,
            message.error.data,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private async handleIncomingRequest(message: JsonRpcRequest): Promise<void> {
    try {
      if (!this.options.onRequest) {
        throw new JsonRpcError(-32601, `Method not found: ${message.method}`);
      }
      const result = await this.options.onRequest(message.method, message.params);
      this.send({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      const rpcError = normalizeError(error);
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: rpcError.code,
          message: rpcError.message,
          data: rpcError.data,
        },
      });
    }
  }

  private send(message: JsonRpcMessage): boolean {
    if (this.closed) return false;
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      this.close(new Error("JSON-RPC transport stdin is closed."));
      return false;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch (error) {
      this.close(error instanceof Error ? error : new Error("JSON-RPC write failed."));
      return false;
    }
  }

  private close(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
