import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { createInterface } from "node:readline";

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

export function resolveSpawnCommand(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    exists?: (path: string) => boolean;
  } = {},
): { command: string; args: string[] } {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command, args };

  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const pathValue = env.Path ?? env.PATH ?? "";
  const pathext = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  const hasPathSegment = /[\\/]/.test(command);
  const hasExtension = win32.extname(command).length > 0;
  const bases = hasPathSegment
    ? [command]
    : pathValue
        .split(win32.delimiter)
        .filter(Boolean)
        .map((dir) => win32.join(dir, command));
  const candidates = bases.flatMap((base) =>
    hasExtension ? [base] : pathext.map((ext) => `${base}${ext}`),
  );
  const resolved = candidates.find((candidate) => exists(candidate));
  if (!resolved) return { command, args };

  const extension = win32.extname(resolved).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    return {
      command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", resolved, ...args],
    };
  }
  return { command: resolved, args };
}

export class JsonRpcTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string | number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  private constructor(child: ChildProcessWithoutNullStreams, private readonly options: JsonRpcTransportOptions) {
    this.child = child;
    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.handleLine(line));
    const stderr = createInterface({ input: child.stderr });
    stderr.on("line", (line) => options.onStderr?.(line));
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
    });
    const child = spawn(resolved.command, resolved.args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
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

  dispose(): void {
    this.close(new Error("JSON-RPC transport disposed."));
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
      setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) {
          this.child.kill("SIGKILL");
        }
      }, 2000).unref();
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
