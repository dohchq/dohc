import type { UtilityProcess } from "electron";
import { createInterface } from "node:readline";
import { stopProcessTreePosix } from "../process/posixSpawn";
import { killProcessTreeWin32 } from "../process/windowsSpawn";
import type { PluginHostOptions } from "./PluginHost";
import type { PluginTransport } from "./pluginHostProtocol";

type RpcId = string | number;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" || typeof value === "number";
}

function rpcError(error: unknown): { code: number; message: string } {
  return {
    code: -32603,
    message: error instanceof Error ? error.message : "JSON-RPC handler failed.",
  };
}

function unrefDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function createPluginUtilityTransport(
  child: UtilityProcess,
  callbacks: Pick<
    Parameters<PluginHostOptions["spawnTransport"]>[0],
    "onExit" | "onNotification" | "onRequest" | "onStderr"
  >,
): PluginTransport {
  const pending = new Map<RpcId, PendingRequest>();
  let nextId = 1;
  let closed = false;

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

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
      close(
        error instanceof Error
          ? error
          : new Error("Plugin utility process message failed."),
      );
      return false;
    }
  }

  async function handleRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id as RpcId;
    const method = message.method as string;
    try {
      const result = await callbacks.onRequest(method, message.params);
      if (!send({ jsonrpc: "2.0", id, result })) return;
    } catch (error) {
      send({ jsonrpc: "2.0", id, error: rpcError(error) });
    }
  }

  child.on("message", (message: unknown) => {
    if (!isRecord(message) || message.jsonrpc !== "2.0") return;
    if (typeof message.method === "string") {
      if (isRpcId(message.id)) void handleRequest(message);
      else callbacks.onNotification(message.method, message.params);
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
    const code = message.error.code;
    const errorMessage = message.error.message;
    if (
      (typeof code !== "number" && typeof code !== "string") ||
      typeof errorMessage !== "string"
    ) {
      return;
    }
    pending.delete(message.id);
    request.reject(new Error(`Plugin host RPC ${String(code)}: ${errorMessage}`));
  });

  if (child.stderr) {
    createInterface({ input: child.stderr }).on("line", callbacks.onStderr);
  }
  child.once("exit", (code) => {
    callbacks.onExit({ code, signal: null });
    close(new Error(`Plugin utility process exited (${code}).`));
  });

  return {
    request<T = unknown>(method: string, params?: unknown): Promise<T> {
      if (closed) {
        return Promise.reject(new Error("Plugin utility transport is closed."));
      }
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
        });
        if (!send({ jsonrpc: "2.0", id, method, params })) {
          pending.delete(id);
          reject(new Error("Plugin utility transport is closed."));
        }
      });
    },
    notify(method: string, params?: unknown): void {
      send(
        params === undefined
          ? { jsonrpc: "2.0", method }
          : { jsonrpc: "2.0", method, params },
      );
    },
    async dispose(): Promise<void> {
      close(new Error("Plugin utility transport disposed."));
      const pid = child.pid;
      if (pid === undefined) return;
      if (process.platform === "win32") {
        await killProcessTreeWin32(pid, () => child.pid === undefined);
        if (child.pid === undefined) return;
        child.kill();
      } else {
        await stopProcessTreePosix(pid, exited, 2_000, () => {
          try {
            child.kill();
          } catch {
            // The force signal below is the owned-handle fallback's guarantee.
          }
          const livePid = child.pid;
          if (livePid === undefined) return;
          try {
            process.kill(livePid, "SIGKILL");
          } catch {
            // The process exited before the force signal reached it.
          }
        });
      }
      const capped = unrefDelay(5_000).then(() => "capped" as const);
      const outcome = await Promise.race([
        exited.then(() => "exited" as const),
        capped,
      ]);
      if (outcome === "capped" && child.pid !== undefined) {
        console.error(
          `[desktop] plugin utility process PID ${child.pid} did not exit before the 5000 ms descendant shutdown limit.`,
        );
      }
    },
  };
}
