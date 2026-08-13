import { createInterface } from "node:readline";
import {
  DohcSdkError,
  DohcSdkErrorCodes,
  createDohcClient,
  type DohcClient,
  type DohcTransport,
} from "./index.js";
import { abortedError, assertRequestOptions } from "./requestOptions.js";

export { createDohcClient };
export type { DohcClient };

interface ElectronParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  start?(): void;
}

type RpcId = string | number;
type RequestHandler = (params: unknown) => Promise<unknown> | unknown;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: DohcSdkError): void;
}

export interface ProcessTransport extends DohcTransport {
  /** Registers a handler for an incoming request from the parent host (e.g. "plugin.activate"). */
  onRequest(method: string, handler: RequestHandler): void;
  /** Sends a one-way notification to the parent host (e.g. "plugin.log"). */
  notify(method: string, params?: unknown): void;
}

export interface CreateProcessTransportOptions {
  /** Stdio-binding-only. Defaults to process.stdin. Ignored under the message-channel binding. Injectable for tests. */
  input?: NodeJS.ReadableStream;
  /** Stdio-binding-only. Defaults to process.stdout. Ignored under the message-channel binding. Injectable for tests. */
  output?: NodeJS.WritableStream;
}

export interface PluginActivateContext {
  pluginId: string;
  workspaceRoot: string;
  pluginRoot: string;
  client: DohcClient;
  commands: {
    register(id: string, run: (...args: unknown[]) => unknown): void;
  };
}

export interface PluginHandler {
  activate(ctx: PluginActivateContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const streamBindings = new WeakMap<
  NodeJS.ReadableStream,
  { output: NodeJS.WritableStream; transport: ProcessTransport }
>();
let parentPortBinding: { port: ElectronParentPort; transport: ProcessTransport } | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" || typeof value === "number";
}

function createTransport(
  sendMessage: (message: unknown) => void,
  receiveMessages: (listener: (message: unknown) => void) => void,
): ProcessTransport {
  const handlers = new Map<string, RequestHandler>();
  const pending = new Map<RpcId, PendingRequest>();
  let nextId = 1;

  function send(message: unknown): boolean {
    try {
      sendMessage(message);
      return true;
    } catch {
      return false;
    }
  }

  async function handleRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id as RpcId;
    const method = message.method as string;
    const handler = handlers.get(method);
    if (!handler) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
      return;
    }

    try {
      const result = await handler(message.params);
      if (!send({ jsonrpc: "2.0", id, result: result === undefined ? null : result })) {
        send({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: `JSON-RPC method "${method}" returned a result that was not serializable.`,
          },
        });
      }
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

    if (typeof message.method === "string" && isRpcId(message.id)) {
      void handleRequest(message);
      return;
    }
    if ("method" in message || !isRpcId(message.id)) return;

    const pendingRequest = pending.get(message.id);
    if (!pendingRequest) return;
    const hasResult = "result" in message;
    const hasError = "error" in message;
    if (hasResult === hasError) return;

    if (hasResult) {
      pendingRequest.resolve(message.result);
      return;
    }
    if (!isRecord(message.error)) return;
    const { code, message: errorMessage } = message.error;
    if ((typeof code !== "string" && typeof code !== "number") || typeof errorMessage !== "string") {
      return;
    }
    pendingRequest.reject(new DohcSdkError(String(code), errorMessage));
  }

  const transport: ProcessTransport = {
    request(method, params, requestOptions) {
      assertRequestOptions(requestOptions);
      if (requestOptions?.signal?.aborted) {
        return Promise.reject(abortedError(method));
      }

      const id = nextId++;
      const timeoutMs = requestOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = globalThis.setTimeout(() => {
          finish(
            undefined,
            new DohcSdkError(
              DohcSdkErrorCodes.hostTimeout,
              `dohc host did not answer ${method} within ${timeoutMs}ms.`,
            ),
          );
        }, timeoutMs);

        function cleanup(): void {
          globalThis.clearTimeout(timer);
          pending.delete(id);
          requestOptions?.signal?.removeEventListener("abort", onAbort);
        }

        function finish(value: unknown, error?: DohcSdkError): void {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve(value);
        }

        function onAbort(): void {
          finish(undefined, abortedError(method));
        }

        pending.set(id, {
          resolve: (value) => finish(value),
          reject: (error) => finish(undefined, error),
        });
        requestOptions?.signal?.addEventListener("abort", onAbort, { once: true });
        if (requestOptions?.signal?.aborted) onAbort();
        if (settled) return;

        const nestedParams = params === undefined ? { method } : { method, params };
        if (!send({
          jsonrpc: "2.0",
          id,
          method: "sdk.request",
          params: nestedParams,
        })) {
          finish(
            undefined,
            new DohcSdkError(
              DohcSdkErrorCodes.hostUnavailable,
              `Failed to send dohc SDK request ${method}.`,
            ),
          );
        }
      });
    },
    onRequest(method, handler) {
      handlers.set(method, handler);
    },
    notify(method, params) {
      send(params === undefined
        ? { jsonrpc: "2.0", method }
        : { jsonrpc: "2.0", method, params });
    },
  };

  receiveMessages(handleMessage);
  return transport;
}

function createParentPortTransport(port: ElectronParentPort): ProcessTransport {
  const transport = createTransport(
    (message) => port.postMessage(message),
    (listener) => port.on("message", (event) => listener(event.data)),
  );
  port.start?.();
  return transport;
}

function createStdioTransport(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): ProcessTransport {
  return createTransport(
    (message) => {
      output.write(`${JSON.stringify(message)}\n`);
    },
    (listener) => {
      const lines = createInterface({ input });
      lines.on("line", (line) => {
        try {
          listener(JSON.parse(line) as unknown);
        } catch {
          // Ignore malformed input and continue reading later lines.
        }
      });
    },
  );
}

function getElectronParentPort(): ElectronParentPort | undefined {
  return (process as typeof process & { parentPort?: ElectronParentPort }).parentPort;
}

export function createProcessTransport(
  options: CreateProcessTransportOptions = {},
): ProcessTransport {
  const parentPort = getElectronParentPort();
  if (parentPort) {
    if (!parentPortBinding || parentPortBinding.port !== parentPort) {
      parentPortBinding = {
        port: parentPort,
        transport: createParentPortTransport(parentPort),
      };
    }
    return parentPortBinding.transport;
  }

  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const existing = streamBindings.get(input);
  if (existing && existing.output === output) return existing.transport;

  const transport = createStdioTransport(input, output);
  streamBindings.set(input, { output, transport });
  return transport;
}
