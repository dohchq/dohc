import { createInterface } from "node:readline";
import {
  DohcSdkError,
  DohcSdkErrorCodes,
  createDohcClient,
  type DohcClient,
  type DohcRequestOptions,
  type DohcSubscriptionEvent,
  type DohcTransport,
  type DohcUnsubscribe,
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

export const PLUGIN_CHILD_PROCESS_METHODS = {
  spawn: "childProcesses.spawn",
  subscribeOutput: "childProcesses.output.subscribe",
  send: "childProcesses.send",
  logs: "childProcesses.logs",
  wait: "childProcesses.wait",
  terminate: "childProcesses.terminate",
  unsubscribe: "subscriptions.unsubscribe",
} as const;

export type PluginChildProcessStream = "stdout" | "stderr";

export interface PluginChildProcessOutput {
  sequence: number;
  stream: PluginChildProcessStream;
  text: string;
}

export interface PluginChildProcessExit {
  code: number | null;
  reason: "exited" | "terminated";
}

export interface PluginChildProcessSpawnOptions {
  /** Plugin-built-root-relative JavaScript entry passed to utilityProcess.fork(). */
  modulePath: string;
  args?: string[];
  /**
   * Plugin-built-root-relative working directory, or
   * `{ workspaceRoot: true }` for the canonical workspace root — the one
   * location outside the plugin's built root a wrapper's server may run in
   * (its provider sessions work on the workspace). Defaults to the built
   * root.
   */
  cwd?: string | { workspaceRoot: true };
  /** String environment overrides merged over the host environment. */
  env?: Record<string, string>;
}

export interface PluginChildProcessHandle {
  readonly id: string;
  /** The child's OS pid at spawn time, or null if it exited before one was
   * observed. Wrapper plugins record it beside their server's state so a
   * later start can tell a live orphan from a stale runtime file. */
  readonly pid: number | null;
  onOutput(
    listener: (output: PluginChildProcessOutput) => void,
    options?: DohcRequestOptions,
  ): Promise<DohcUnsubscribe>;
  send(message: unknown, options?: DohcRequestOptions): Promise<void>;
  logs(options?: DohcRequestOptions): Promise<PluginChildProcessOutput[]>;
  wait(options?: DohcRequestOptions): Promise<PluginChildProcessExit>;
  terminate(options?: DohcRequestOptions): Promise<PluginChildProcessExit>;
}

/**
 * Spawns child processes for one plugin activation.
 *
 * Retention: an exited child's handle stays readable so `logs()` and `wait()`
 * still work after it exits, but the host retains at most 200 exited children
 * per activation and discards the oldest first. A handle discarded that way
 * fails with a "was not found" error that names the limit. Read a child's
 * logs and exit result before spawning more.
 */
export interface PluginChildProcessClient {
  spawn(
    input: PluginChildProcessSpawnOptions,
    options?: DohcRequestOptions,
  ): Promise<PluginChildProcessHandle>;
}

export interface ProcessTransport extends DohcTransport {
  subscribe<T = unknown>(
    method: string,
    params: unknown,
    listener: (event: DohcSubscriptionEvent<T>) => void,
    options?: DohcRequestOptions,
  ): Promise<DohcUnsubscribe>;
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
  /**
   * The plugin's durable per-workspace data directory, under the app's own
   * userData beside the built plugin — never inside the workspace. It
   * survives rebuilds and reinstalls; uninstalling the plugin deletes it,
   * and the uninstall warning names it. The host only computes the path;
   * a plugin that wants it creates it.
   */
  stateRoot: string;
  client: DohcClient;
  childProcesses: PluginChildProcessClient;
  commands: {
    register(id: string, run: (...args: unknown[]) => unknown): void;
  };
}

/** What PluginHandler.startWebApp returns: the URL the host navigates the
 * guest WebContentsView to. It may carry a one-time credential in its
 * fragment, so it crosses process boundaries in memory only — never logs. */
export interface PluginWebAppStart {
  url: string;
}

export interface PluginHandler {
  activate(ctx: PluginActivateContext): Promise<void> | void;
  /**
   * Starts (or reuses) the embedded web app declared under the manifest's
   * `webApps` and returns the loopback URL to show. Called on demand when
   * the user opens the web app's tab, never during activate — a wrapper's
   * server start is exactly the long-running readiness work activation must
   * not await.
   */
  startWebApp?(webAppId: string): Promise<PluginWebAppStart> | PluginWebAppStart;
  /**
   * Ends the session the matching `startWebApp` began, so the next start
   * pairs from scratch. The host calls this when the guest it started the app
   * for never arrived: a start URL's one-time credential is spent by then, and
   * only the plugin can retire the session it paired. A handler that
   * implements `startWebApp` must implement this too — the host reports a
   * handler that does not.
   */
  stopWebApp?(webAppId: string): Promise<void> | void;
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

function isSdkSubscriptionEvent(
  value: unknown,
): value is { subscriptionId: string; event: string; data: unknown } {
  return (
    isRecord(value) &&
    typeof value.subscriptionId === "string" &&
    value.subscriptionId.length > 0 &&
    typeof value.event === "string" &&
    value.event.length > 0 &&
    "data" in value
  );
}

function createTransport(
  sendMessage: (message: unknown) => void,
  receiveMessages: (listener: (message: unknown) => void) => void,
): ProcessTransport {
  const handlers = new Map<string, RequestHandler>();
  const pending = new Map<RpcId, PendingRequest>();
  const subscriptionListeners = new Map<
    string,
    (event: DohcSubscriptionEvent<unknown>) => void
  >();
  const queuedSubscriptionEvents = new Map<
    string,
    Array<DohcSubscriptionEvent<unknown>>
  >();
  let nextId = 1;

  const queueSubscriptionEvent = (
    subscriptionId: string,
    event: DohcSubscriptionEvent<unknown>,
  ): void => {
    const queued = queuedSubscriptionEvents.get(subscriptionId) ?? [];
    queued.push(event);
    if (queued.length > 200) queued.shift();
    queuedSubscriptionEvents.set(subscriptionId, queued);
  };

  const handleSdkEvent = (params: unknown): void => {
    if (!isSdkSubscriptionEvent(params)) return;
    const event = { event: params.event, data: params.data };
    const listener = subscriptionListeners.get(params.subscriptionId);
    if (listener) listener(event);
    else queueSubscriptionEvent(params.subscriptionId, event);
  };

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

    if (typeof message.method === "string") {
      if (isRpcId(message.id)) void handleRequest(message);
      else if (message.method === "sdk.event") handleSdkEvent(message.params);
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
    async subscribe<T = unknown>(
      method: string,
      params: unknown,
      listener: (event: DohcSubscriptionEvent<T>) => void,
      requestOptions?: DohcRequestOptions,
    ): Promise<DohcUnsubscribe> {
      if (typeof listener !== "function") {
        throw new DohcSdkError(
          DohcSdkErrorCodes.invalidInput,
          "Subscription listener must be a function.",
        );
      }
      const result = await transport.request(method, params, requestOptions);
      if (
        !isRecord(result) ||
        typeof result.subscriptionId !== "string" ||
        result.subscriptionId.length === 0
      ) {
        throw new DohcSdkError(
          DohcSdkErrorCodes.badResponse,
          `dohc host returned an invalid subscription response for ${method}.`,
        );
      }

      const subscriptionId = result.subscriptionId;
      let active = true;
      let remoteClosed = false;
      let pendingClose: Promise<void> | null = null;
      const untypedListener = listener as (
        event: DohcSubscriptionEvent<unknown>,
      ) => void;
      subscriptionListeners.set(subscriptionId, untypedListener);
      for (const event of queuedSubscriptionEvents.get(subscriptionId) ?? []) {
        untypedListener(event);
      }
      queuedSubscriptionEvents.delete(subscriptionId);

      const unsubscribe: DohcUnsubscribe = async () => {
        if (active) {
          active = false;
          subscriptionListeners.delete(subscriptionId);
          queuedSubscriptionEvents.delete(subscriptionId);
          requestOptions?.signal?.removeEventListener("abort", onAbort);
        }
        if (remoteClosed) return;
        if (pendingClose) return pendingClose;
        pendingClose = transport
          .request(PLUGIN_CHILD_PROCESS_METHODS.unsubscribe, { subscriptionId })
          .then(() => {
            remoteClosed = true;
          })
          .finally(() => {
            pendingClose = null;
          });
        return pendingClose;
      };
      const onAbort = (): void => {
        void unsubscribe().catch(() => undefined);
      };
      requestOptions?.signal?.addEventListener("abort", onAbort, { once: true });
      if (requestOptions?.signal?.aborted) onAbort();

      return unsubscribe;
    },
  };

  receiveMessages(handleMessage);
  return transport;
}

function isPluginChildProcessOutput(
  value: unknown,
): value is PluginChildProcessOutput {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.sequence) &&
    (value.stream === "stdout" || value.stream === "stderr") &&
    typeof value.text === "string"
  );
}

function pluginChildProcessExit(
  value: unknown,
  method: string,
): PluginChildProcessExit {
  if (
    !isRecord(value) ||
    (value.code !== null && !Number.isSafeInteger(value.code)) ||
    (value.reason !== "exited" && value.reason !== "terminated")
  ) {
    throw new DohcSdkError(
      DohcSdkErrorCodes.badResponse,
      `dohc host returned an invalid child-process response for ${method}.`,
    );
  }
  return value as unknown as PluginChildProcessExit;
}

export function createPluginChildProcessClient(
  transport: ProcessTransport,
): PluginChildProcessClient {
  const handle = (
    childId: string,
    pid: number | null,
  ): PluginChildProcessHandle => ({
    id: childId,
    pid,
    async onOutput(listener, options) {
      if (typeof listener !== "function") {
        throw new DohcSdkError(
          DohcSdkErrorCodes.invalidInput,
          "Child-process output listener must be a function.",
        );
      }
      if (!transport.subscribe) {
        throw new DohcSdkError(
          DohcSdkErrorCodes.subscriptionsUnsupported,
          "This dohc host transport does not support child-process output.",
        );
      }
      return transport.subscribe(
        PLUGIN_CHILD_PROCESS_METHODS.subscribeOutput,
        { childId },
        (event) => {
          if (
            (event.event === "stdout" || event.event === "stderr") &&
            isPluginChildProcessOutput(event.data)
          ) {
            listener(event.data);
          }
        },
        options,
      );
    },
    async send(message, options) {
      await transport.request(
        PLUGIN_CHILD_PROCESS_METHODS.send,
        { childId, message },
        options,
      );
    },
    async logs(options) {
      const result = await transport.request(
        PLUGIN_CHILD_PROCESS_METHODS.logs,
        { childId },
        options,
      );
      if (!Array.isArray(result) || !result.every(isPluginChildProcessOutput)) {
        throw new DohcSdkError(
          DohcSdkErrorCodes.badResponse,
          "dohc host returned invalid child-process logs.",
        );
      }
      return result;
    },
    async wait(options) {
      return pluginChildProcessExit(
        await transport.request(
          PLUGIN_CHILD_PROCESS_METHODS.wait,
          { childId },
          options,
        ),
        PLUGIN_CHILD_PROCESS_METHODS.wait,
      );
    },
    async terminate(options) {
      return pluginChildProcessExit(
        await transport.request(
          PLUGIN_CHILD_PROCESS_METHODS.terminate,
          { childId },
          options,
        ),
        PLUGIN_CHILD_PROCESS_METHODS.terminate,
      );
    },
  });

  return {
    async spawn(input, options) {
      if (!isRecord(input)) {
        throw new DohcSdkError(
          DohcSdkErrorCodes.invalidInput,
          "Child-process spawn input must be an object.",
        );
      }
      const result = await transport.request(
        PLUGIN_CHILD_PROCESS_METHODS.spawn,
        input,
        options,
      );
      if (
        !isRecord(result) ||
        typeof result.childId !== "string" ||
        result.childId.length === 0 ||
        (result.pid !== null && !Number.isSafeInteger(result.pid))
      ) {
        throw new DohcSdkError(
          DohcSdkErrorCodes.badResponse,
          "dohc host returned an invalid child-process spawn response.",
        );
      }
      return handle(result.childId, result.pid as number | null);
    },
  };
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
