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
  spawnCommand: "childProcesses.command.spawn",
  subscribeOutput: "childProcesses.output.subscribe",
  send: "childProcesses.send",
  write: "childProcesses.stdin.write",
  endInput: "childProcesses.stdin.end",
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

/**
 * A working directory in the workspace.
 *
 * `{ workspaceRoot: true }` is the workspace root itself. Adding `path` names
 * one directory inside it — the site a preview builds, the package a tool
 * runs on. dohc resolves the path and refuses one that leaves the workspace,
 * so a child always runs in the workspace or in the plugin's own built root,
 * and nowhere else.
 */
export interface PluginChildProcessWorkspaceCwd {
  workspaceRoot: true;
  /** Workspace-relative directory. Omit it for the workspace root. */
  path?: string;
}

export interface PluginChildProcessSpawnOptions {
  /** Plugin-built-root-relative JavaScript entry passed to utilityProcess.fork(). */
  modulePath: string;
  args?: string[];
  /**
   * Plugin-built-root-relative working directory, or a workspace directory —
   * the one place outside the plugin's built root a child may run (a
   * wrapper's server works on the workspace). Defaults to the built root.
   */
  cwd?: string | PluginChildProcessWorkspaceCwd;
  /** String environment overrides merged over the host environment. */
  env?: Record<string, string>;
}

/**
 * An executable to run as a supervised child.
 *
 * dohc runs the file this names and passes `args` as argv entries. There is
 * no shell and no command line: a whole command written into `command` is one
 * executable name that will not be found, not a script to interpret.
 */
export interface PluginChildProcessCommandOptions {
  /**
   * An absolute path to an executable, or a bare name (no path separator)
   * looked up on the child's PATH — where a harness CLI installed on the
   * machine lives.
   */
  command: string;
  args?: string[];
  /**
   * Plugin-built-root-relative working directory, or a workspace directory.
   * Defaults to the built root. Identical to a module child's rule: the
   * executable may come from anywhere, the directory it runs in may not.
   */
  cwd?: string | PluginChildProcessWorkspaceCwd;
  /** String environment overrides merged over the host environment. */
  env?: Record<string, string>;
}

interface PluginChildProcessHandleBase {
  readonly id: string;
  /** The child's OS pid at spawn time, or null if it exited before one was
   * observed. Wrapper plugins record it beside their server's state so a
   * later start can tell a live orphan from a stale runtime file. */
  readonly pid: number | null;
  onOutput(
    listener: (output: PluginChildProcessOutput) => void,
    options?: DohcRequestOptions,
  ): Promise<DohcUnsubscribe>;
  logs(options?: DohcRequestOptions): Promise<PluginChildProcessOutput[]>;
  wait(options?: DohcRequestOptions): Promise<PluginChildProcessExit>;
  terminate(options?: DohcRequestOptions): Promise<PluginChildProcessExit>;
}

/** A module child, started by `spawn`. Input is a structured message. */
export interface PluginChildProcessHandle extends PluginChildProcessHandleBase {
  send(message: unknown, options?: DohcRequestOptions): Promise<void>;
}

/** A command child, started by `spawnCommand`. Input is bytes on standard
 * input, which is how a harness CLI takes a prompt or speaks a protocol. */
export interface PluginChildProcessCommandHandle
  extends PluginChildProcessHandleBase {
  /** Writes to the child's standard input. */
  write(data: string, options?: DohcRequestOptions): Promise<void>;
  /** Closes the child's standard input, so a child that reads to end of file
   * sees one. Later writes fail. */
  endInput(options?: DohcRequestOptions): Promise<void>;
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
  /** Runs a JavaScript file from the plugin's own built root. */
  spawn(
    input: PluginChildProcessSpawnOptions,
    options?: DohcRequestOptions,
  ): Promise<PluginChildProcessHandle>;
  /**
   * Runs any executable the machine has, supervised the same way: dohc owns
   * the process tree and kills it when the plugin stops.
   */
  spawnCommand(
    input: PluginChildProcessCommandOptions,
    options?: DohcRequestOptions,
  ): Promise<PluginChildProcessCommandHandle>;
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

/** A setting's value. The manifest's declared type decides which of these. */
export type PluginSettingValue = string | number | boolean;

/**
 * The plugin's own settings, as declared in its manifest and answered by the
 * user. Two members and no more: read them now, and hear about it when they
 * change.
 *
 * Every declared key is always present and always the declared type, so a
 * plugin never checks whether a setting exists. A stored answer that no longer
 * fits the manifest never arrives — the host resolves it back to the declared
 * default first.
 */
export interface PluginSettings {
  /** This plugin's settings as they stand now. */
  get(): Record<string, PluginSettingValue>;
  /**
   * Runs the listener with the complete new settings each time the user
   * changes one. Returns a function that stops it.
   */
  onChange(
    listener: (values: Record<string, PluginSettingValue>) => void,
  ): () => void;
}

/** Data that survives JSON, which is what a driver's resume cursor is. */
export type PluginJsonValue =
  | string
  | number
  | boolean
  | null
  | PluginJsonValue[]
  | { [key: string]: PluginJsonValue };

export type PluginPermissionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export interface PluginPermissionOption {
  optionId: string;
  name: string;
  kind: PluginPermissionKind;
}

export type PluginPermissionDecision = PluginPermissionKind | "cancel";

/**
 * What a driver tells dohc while a session runs.
 *
 * This is dohc's own normalized agent-event union, as it crosses the process
 * boundary: every member is data dohc renders itself. There is deliberately no
 * pass-through field for the harness's own message — a provider payload
 * carries tool arguments, file contents, and account detail, and dohc drops it
 * at this boundary rather than route it onward.
 */
export type PluginAgentEvent =
  | {
      kind: "session-state";
      state: "starting" | "ready" | "running" | "error" | "closed";
      reason?: string;
    }
  | {
      kind: "text-delta";
      itemId: string;
      stream: "assistant" | "reasoning";
      text: string;
    }
  | {
      kind: "item";
      phase: "started" | "updated" | "completed";
      item: {
        id: string;
        type:
          | "tool_call"
          | "command"
          | "file_change"
          | "mcp_tool_call"
          | "web_search"
          | "plan"
          | "other";
        title: string;
        detail?: string;
        status: "pending" | "in_progress" | "completed" | "failed";
        locations?: string[];
      };
    }
  | {
      kind: "plan";
      steps: Array<{
        step: string;
        status: "pending" | "inProgress" | "completed";
      }>;
    }
  | {
      kind: "permission-request";
      requestId: string;
      requestType: "command" | "file-change" | "file-read" | "tool" | "other";
      title: string;
      detail?: string;
      locations?: string[];
      options: PluginPermissionOption[];
    }
  | {
      kind: "permission-resolved";
      requestId: string;
      decision: PluginPermissionDecision;
    }
  | {
      kind: "token-usage";
      used: number;
      max?: number;
      input?: number;
      output?: number;
    }
  | {
      kind: "turn-completed";
      turnId: string;
      status: "completed" | "failed" | "cancelled";
      errorMessage?: string;
    }
  | {
      kind: "auth";
      event:
        | "account-updated"
        | "rate-limits"
        | "mcp-oauth-completed"
        | "login-required";
      detail?: string;
    }
  | { kind: "error"; message: string; fatal: boolean };

export interface PluginAgentModel {
  id: string;
  name: string;
  planIncluded: boolean;
  options?: Array<{ id: string; values: string[]; default?: string }>;
}

/**
 * What a driver reports about its harness on this machine.
 *
 * `auth.email` and `loginHint` are personal data. dohc keeps them out of its
 * renderer, its logs, and anything it stores; report the account only when the
 * harness itself already tells you, and never report a credential.
 */
export interface PluginAgentProbe {
  installed: boolean;
  version?: string;
  auth: {
    status: "authenticated" | "unauthenticated" | "unknown";
    label?: string;
    email?: string;
    loginHint?: string;
  };
  models: PluginAgentModel[];
  errorMessage?: string;
}

export interface PluginAgentSessionStartInput {
  /** The canonical workspace root. Run the harness here. */
  workspaceRoot: string;
  mode: "approval-required" | "auto-accept-edits" | "full-access";
  model?: string;
  /** A cursor a previous session of this driver returned, to resume it. */
  resumeCursor?: PluginJsonValue;
  /** dohc's own MCP server, for the harness to connect to the workspace. */
  mcp: { command: string; args: string[]; env?: Record<string, string> };
  logDir?: string;
  /** Reports one event to dohc. Safe to call until `dispose` returns. */
  onEvent(event: PluginAgentEvent): void;
}

export interface PluginAgentSession {
  /** The harness's own id for this session, for logs and resume. */
  sessionId: string;
  /** What a later session needs to continue this one, or nothing. */
  resumeCursor?: PluginJsonValue;
  prompt(input: {
    text: string;
    attachments?: Array<{ type: "image"; pathOrUrl: string }>;
  }): Promise<{ turnId: string }> | { turnId: string };
  cancel(): Promise<void> | void;
  answerPermission(
    requestId: string,
    decision: PluginPermissionDecision,
  ): Promise<void> | void;
  answerUserInput?(
    requestId: string,
    answers: Record<string, string | string[]>,
  ): Promise<void> | void;
  setModel?(modelId: string): Promise<void> | void;
  /** Ends the turn and the harness process. The session stays readable. */
  stop(): Promise<void> | void;
  /** Releases everything this session holds. */
  dispose(): Promise<void> | void;
}

/**
 * One harness dohc can talk to.
 *
 * dohc owns the conversation: it decides when to probe, when to start a
 * session, and what the workspace shows. A driver's job is to run the harness
 * and report what it says. dohc keeps the authority it already has over every
 * child a driver starts — it takes the harness's whole process tree down with
 * the plugin, without asking the driver.
 */
export interface PluginAgentDriver {
  probe(): Promise<PluginAgentProbe> | PluginAgentProbe;
  startSession(
    input: PluginAgentSessionStartInput,
  ): Promise<PluginAgentSession> | PluginAgentSession;
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
  settings: PluginSettings;
  commands: {
    register(id: string, run: (...args: unknown[]) => unknown): void;
  };
  /**
   * Registers the agent drivers this plugin's manifest declares. Register
   * every declared driver during activation: dohc lists a declared driver in
   * its own probe list, so one that never registers would be a row that can
   * never answer.
   */
  drivers: {
    register(id: string, driver: PluginAgentDriver): void;
  };
}

/** What PluginHandler.startWebApp returns: the URL the host navigates the
 * guest WebContentsView to. It may carry a one-time credential in its
 * fragment, so it crosses process boundaries in memory only — never logs. */
export interface PluginWebAppStart {
  url: string;
  /**
   * What to call this instance's tab. Every instance of one web app shares
   * the manifest title, so a plugin that opens a tab per site names each one
   * here. Omit it to use the manifest title. Titles longer than 120
   * characters are refused.
   */
  title?: string;
}

export interface PluginHandler {
  activate(ctx: PluginActivateContext): Promise<void> | void;
  /**
   * Starts (or reuses) the embedded web app declared under the manifest's
   * `webApps` and returns the loopback URL to show. Called on demand when
   * the user opens the web app's tab, never during activate — a wrapper's
   * server start is exactly the long-running readiness work activation must
   * not await.
   *
   * `instanceKey` is the instance the user opened, for a web app the manifest
   * marks `"instanced": true`, and null for one that opens a single app. dohc
   * holds no opinion about what an instance is: the key is whatever the
   * plugin's panel named when it opened the tab. Each instance is its own tab
   * over its own origin, so a handler may run one server per instance or one
   * server serving all of them — but it must return the URL that shows this
   * instance, because the guest is locked to that URL's origin.
   */
  startWebApp?(
    webAppId: string,
    instanceKey: string | null,
  ): Promise<PluginWebAppStart> | PluginWebAppStart;
  /**
   * Ends the session the matching `startWebApp` began, so the next start
   * pairs from scratch. The host calls this when the guest it started the app
   * for never arrived: a start URL's one-time credential is spent by then, and
   * only the plugin can retire the session it paired. A handler that
   * implements `startWebApp` must implement this too — the host reports a
   * handler that does not.
   *
   * It names one instance. Ending it must leave the plugin's other instances
   * of the same web app running.
   */
  stopWebApp?(webAppId: string, instanceKey: string | null): Promise<void> | void;
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
  ): PluginChildProcessHandleBase => ({
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

  const started = async (
    method: string,
    input: unknown,
    options: DohcRequestOptions | undefined,
  ): Promise<PluginChildProcessHandleBase> => {
    if (!isRecord(input)) {
      throw new DohcSdkError(
        DohcSdkErrorCodes.invalidInput,
        `Child-process input for ${method} must be an object.`,
      );
    }
    const result = await transport.request(method, input, options);
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
  };

  return {
    async spawn(input, options) {
      const base = await started(
        PLUGIN_CHILD_PROCESS_METHODS.spawn,
        input,
        options,
      );
      return {
        ...base,
        async send(message, sendOptions) {
          await transport.request(
            PLUGIN_CHILD_PROCESS_METHODS.send,
            { childId: base.id, message },
            sendOptions,
          );
        },
      };
    },
    async spawnCommand(input, options) {
      const base = await started(
        PLUGIN_CHILD_PROCESS_METHODS.spawnCommand,
        input,
        options,
      );
      return {
        ...base,
        async write(data, writeOptions) {
          if (typeof data !== "string") {
            throw new DohcSdkError(
              DohcSdkErrorCodes.invalidInput,
              "Child-process standard input takes a string.",
            );
          }
          await transport.request(
            PLUGIN_CHILD_PROCESS_METHODS.write,
            { childId: base.id, data },
            writeOptions,
          );
        },
        async endInput(endOptions) {
          await transport.request(
            PLUGIN_CHILD_PROCESS_METHODS.endInput,
            { childId: base.id },
            endOptions,
          );
        },
      };
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
