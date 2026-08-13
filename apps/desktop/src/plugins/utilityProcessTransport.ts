import { utilityProcess } from "electron";
import { createInterface } from "node:readline";
import type { PluginTransport } from "./pluginHostProtocol";

type RpcId = string | number;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

class UtilityProcessRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "UtilityProcessRpcError";
    this.code = code;
    this.data = data;
  }
}

export interface SpawnUtilityProcessOptions {
  modulePath: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  onStderr?: (line: string) => void;
  onRequest?: (method: string, params: unknown) => Promise<unknown> | unknown;
  onNotification?: (method: string, params: unknown) => void;
  onExit?: (code: number | null) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" || typeof value === "number";
}

export function spawnUtilityProcessTransport(
  options: SpawnUtilityProcessOptions,
): PluginTransport {
  const child = utilityProcess.fork(options.modulePath, options.args ?? [], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    serviceName: "dohc-plugin-host",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pending = new Map<RpcId, PendingRequest>();
  let nextId = 1;
  let closed = false;

  function close(error: Error): void {
    if (closed) return;
    closed = true;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  function send(message: unknown): boolean {
    if (closed) return false;
    try {
      child.postMessage(message);
      return true;
    } catch (error) {
      close(error instanceof Error ? error : new Error("Utility process write failed."));
      return false;
    }
  }

  async function handleRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id as RpcId;
    const method = message.method as string;
    if (!options.onRequest) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
      return;
    }

    try {
      const result = await options.onRequest(method, message.params);
      send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "JSON-RPC handler failed.",
        },
      });
    }
  }

  function handleMessage(message: unknown): void {
    if (!isRecord(message) || message.jsonrpc !== "2.0") return;

    if (typeof message.method === "string") {
      if (isRpcId(message.id)) void handleRequest(message);
      else options.onNotification?.(message.method, message.params);
      return;
    }
    if (!isRpcId(message.id)) return;

    const request = pending.get(message.id);
    if (!request) return;
    const hasResult = "result" in message;
    const hasError = "error" in message;
    if (hasResult === hasError) return;

    if (hasResult) {
      pending.delete(message.id);
      request.resolve(message.result);
      return;
    }
    if (!isRecord(message.error)) return;
    const { code, message: errorMessage, data } = message.error;
    if (typeof code !== "number" || typeof errorMessage !== "string") return;
    pending.delete(message.id);
    request.reject(new UtilityProcessRpcError(code, errorMessage, data));
  }

  child.on("message", (message: unknown) => handleMessage(message));
  child.on("exit", (code) => {
    options.onExit?.(code);
    close(new Error(`Plugin utility process exited (${code}).`));
  });
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on("line", (line) => options.onStderr?.(line));
  }

  return {
    request<T = unknown>(method: string, params?: unknown): Promise<T> {
      if (closed) return Promise.reject(new Error("Plugin utility process is closed."));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
        });
        if (!send({ jsonrpc: "2.0", id, method, params })) {
          pending.delete(id);
          reject(new Error("Plugin utility process is closed."));
        }
      });
    },
    notify(method, params) {
      send({ jsonrpc: "2.0", method, params });
    },
    async dispose() {
      child.kill();
      close(new Error("Plugin utility process disposed."));
    },
  };
}
