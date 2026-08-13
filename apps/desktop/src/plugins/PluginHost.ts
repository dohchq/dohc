import { randomUUID } from "node:crypto";
import type { DohcPluginManifest } from "./pluginManifestSchema";
import { readPluginLocalState, setPluginDisabled } from "./pluginLocalState";
import {
  PLUGIN_ACTIVATION_TIMEOUT_MS,
  PLUGIN_CRASH_LOOP_THRESHOLD,
  PLUGIN_FAST_FAILURE_WINDOW_MS,
  PLUGIN_HOST_METHODS,
  type PluginActivateParams,
  type PluginActivateResult,
  type PluginInvokeCommandParams,
  type PluginLogParams,
  type PluginRuntimeStatus,
  type PluginTransport,
  type SdkRequestParams,
} from "./pluginHostProtocol";

const STDERR_LOG_LIMIT = 200;
const DEACTIVATION_TIMEOUT_MS = 5_000;

export interface PluginHostOptions {
  stateDir: string;
  workspaceRoot: string;
  spawnTransport: (params: {
    pluginId: string;
    pluginRoot: string;
    onStderr: (line: string) => void;
    onRequest: (
      method: string,
      params: unknown,
    ) => Promise<unknown> | unknown;
    onNotification: (method: string, params: unknown) => void;
    onExit: (info: {
      code: number | null;
      signal: NodeJS.Signals | null;
    }) => void;
  }) => PluginTransport;
  routeSdkRequest: (
    pluginId: string,
    method: string,
    params: unknown,
    /** The requesting spawn's run id (PluginSpawn.spawnId) at request time — avoids a race against a respawn between issuing and routing the request. */
    spawnId: string,
  ) => Promise<unknown>;
  onStatusChange?: (pluginId: string, status: PluginRuntimeStatus) => void;
  now?: () => number;
  activationTimeoutMs?: number;
}

interface PluginSpawn {
  /**
   * One UUID per spawn attempt, not per plugin. It is the agentRunId a
   * later PR's production SDK router attaches to every write attribution
   * for this run — a respawn after a crash is a new run, so it gets a new
   * id, the same way AgentSessionManager mints a fresh run id per session.
   */
  spawnId: string;
  generation: number;
  spawnedAt: number;
  stopping: boolean;
  failureHandled: boolean;
  transport?: PluginTransport;
  shutdown?: Promise<void>;
}

interface PluginRecord {
  pluginId: string;
  pluginRoot: string;
  manifest: DohcPluginManifest;
  status: PluginRuntimeStatus;
  stderr: string[];
  commands?: string[];
  current?: PluginSpawn;
}

function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isSdkRequestParams(params: unknown): params is SdkRequestParams {
  return (
    typeof params === "object" &&
    params !== null &&
    "method" in params &&
    typeof params.method === "string" &&
    params.method.length > 0
  );
}

function isPluginLogParams(params: unknown): params is PluginLogParams {
  return (
    typeof params === "object" &&
    params !== null &&
    "level" in params &&
    (params.level === "info" ||
      params.level === "warn" ||
      params.level === "error") &&
    "message" in params &&
    typeof params.message === "string"
  );
}

function isPluginActivateResult(value: unknown): value is PluginActivateResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "commands" in value &&
    Array.isArray(value.commands) &&
    value.commands.every(
      (command) => typeof command === "string" && command.length > 0,
    )
  );
}

export class PluginHost {
  private readonly plugins = new Map<string, PluginRecord>();
  private readonly pendingStarts = new Set<string>();
  private readonly abortedStarts = new Set<string>();
  private readonly consecutiveFastFailures = new Map<string, number>();
  private readonly activationTimeoutMs: number;
  private currentGeneration = 0;

  constructor(private readonly options: PluginHostOptions) {
    this.activationTimeoutMs =
      options.activationTimeoutMs ?? PLUGIN_ACTIVATION_TIMEOUT_MS;
  }

  async start(
    pluginRoot: string,
    manifest: DohcPluginManifest,
  ): Promise<void> {
    // The manifest name is the plugin's identity — one identity, so state
    // and attribution can never drift from what the manifest declares.
    const pluginId = manifest.name;
    if (this.plugins.has(pluginId) || this.pendingStarts.has(pluginId)) {
      throw new Error(`Plugin "${pluginId}" is already running.`);
    }

    this.pendingStarts.add(pluginId);
    try {
      const localState = await readPluginLocalState(
        this.options.stateDir,
        this.options.workspaceRoot,
      );
      if (this.abortedStarts.delete(pluginId)) return;
      if (!localState.ok) {
        throw new Error(
          `Plugin "${pluginId}" was not started. ${localState.warning}`,
        );
      }
      if (localState.state.plugins[pluginId]?.disabled === true) {
        throw new Error(
          `Plugin "${pluginId}" is disabled. Re-enabling it is not yet available in the app.`,
        );
      }

      const record: PluginRecord = {
        pluginId,
        pluginRoot,
        manifest,
        status: "starting",
        stderr: [],
      };
      this.plugins.set(pluginId, record);
      this.spawn(record);
    } finally {
      this.pendingStarts.delete(pluginId);
      this.abortedStarts.delete(pluginId);
    }
  }

  async stop(pluginId: string): Promise<void> {
    if (this.pendingStarts.has(pluginId)) {
      this.abortedStarts.add(pluginId);
      return;
    }
    const record = this.plugins.get(pluginId);
    if (!record) return;
    const spawn = record.current;
    if (!spawn?.transport) {
      this.plugins.delete(pluginId);
      return;
    }
    if (spawn.shutdown) {
      await spawn.shutdown;
      return;
    }

    spawn.shutdown = this.shutdown(record, spawn, spawn.transport);
    await spawn.shutdown;
  }

  async stopAll(): Promise<void> {
    const pendingPluginIds = [...this.pendingStarts];
    for (const pluginId of pendingPluginIds) this.abortedStarts.add(pluginId);
    await Promise.allSettled([...this.plugins.keys()].map((id) => this.stop(id)));
  }

  /** Runs a command the plugin registered during activation and returns its result. */
  async invokeCommand(pluginId: string, commandId: string): Promise<unknown> {
    const spawn = this.plugins.get(pluginId)?.current;
    if (!spawn?.transport) {
      throw new Error(`Plugin "${pluginId}" is not running.`);
    }
    if (spawn.stopping) {
      throw new Error(`Plugin "${pluginId}" is stopping.`);
    }
    return spawn.transport.request(PLUGIN_HOST_METHODS.invokeCommand, {
      commandId,
    } satisfies PluginInvokeCommandParams);
  }

  private async shutdown(
    record: PluginRecord,
    spawn: PluginSpawn,
    transport: PluginTransport,
  ): Promise<void> {
    spawn.stopping = true;
    await raceWithTimeout(
      transport.request(PLUGIN_HOST_METHODS.deactivate, {}),
      DEACTIVATION_TIMEOUT_MS,
      `Plugin "${record.pluginId}" did not deactivate within ${DEACTIVATION_TIMEOUT_MS} ms.`,
    ).catch(() => undefined);

    try {
      await transport.dispose();
    } finally {
      if (this.plugins.get(record.pluginId) === record) {
        this.plugins.delete(record.pluginId);
      }
    }
  }

  getStatus(pluginId: string): PluginRuntimeStatus | undefined {
    return this.plugins.get(pluginId)?.status;
  }

  getStderrLog(pluginId: string): string[] {
    return [...(this.plugins.get(pluginId)?.stderr ?? [])];
  }

  getRegisteredCommands(pluginId: string): string[] | undefined {
    const commands = this.plugins.get(pluginId)?.commands;
    return commands ? [...commands] : undefined;
  }

  bumpGeneration(): void {
    this.currentGeneration += 1;
  }

  private spawn(record: PluginRecord): void {
    const spawn: PluginSpawn = {
      spawnId: randomUUID(),
      generation: this.currentGeneration,
      spawnedAt: this.now(),
      stopping: false,
      failureHandled: false,
    };
    record.current = spawn;
    record.commands = undefined;
    this.setStatus(record, "starting");

    try {
      spawn.transport = this.options.spawnTransport({
        pluginId: record.pluginId,
        pluginRoot: record.pluginRoot,
        onStderr: (line) => this.appendLog(record, line),
        onRequest: (method, params) =>
          this.handleRequest(record.pluginId, spawn.spawnId, method, params),
        onNotification: (method, params) =>
          this.handleNotification(record, method, params),
        onExit: () => this.handleExit(record, spawn),
      });

      const activation = spawn.transport.request<unknown>(
        PLUGIN_HOST_METHODS.activate,
        {
          pluginId: record.pluginId,
          pluginRoot: record.pluginRoot,
          workspaceRoot: this.options.workspaceRoot,
          manifest: record.manifest,
        } satisfies PluginActivateParams,
      );
      void raceWithTimeout(
        activation,
        this.activationTimeoutMs,
        `Plugin "${record.pluginId}" activation exceeded ${this.activationTimeoutMs} ms.`,
      ).then(
        (result) => this.handleActivationSuccess(record, spawn, result),
        (error: unknown) => this.handleActivationFailure(record, spawn, error),
      );
    } catch (error) {
      void this.handleActivationFailure(record, spawn, error);
    }
  }

  private handleActivationSuccess(
    record: PluginRecord,
    spawn: PluginSpawn,
    result: unknown,
  ): void {
    if (!this.isLive(record, spawn)) {
      void spawn.transport?.dispose().catch(() => undefined);
      return;
    }
    if (!isPluginActivateResult(result)) {
      void this.handleActivationFailure(
        record,
        spawn,
        new Error(
          'Plugin activation returned an invalid result: "commands" must be an array of non-empty strings.',
        ),
      );
      return;
    }
    record.commands = [...result.commands];
    this.setStatus(record, "ready");
  }

  private async handleActivationFailure(
    record: PluginRecord,
    spawn: PluginSpawn,
    error: unknown,
  ): Promise<void> {
    if (!this.isLive(record, spawn)) {
      void spawn.transport?.dispose().catch(() => undefined);
      return;
    }
    spawn.failureHandled = true;
    this.appendLog(record, `Activation failed: ${this.errorMessage(error)}`);
    this.setStatus(record, "failed");
    await spawn.transport?.dispose().catch((disposeError: unknown) => {
      this.appendLog(record, `Dispose failed: ${this.errorMessage(disposeError)}`);
    });
    await this.accountForFailure(record, spawn);
  }

  private handleExit(record: PluginRecord, spawn: PluginSpawn): void {
    if (!this.isLive(record, spawn)) {
      return;
    }
    spawn.failureHandled = true;
    this.setStatus(record, "crashed");
    void this.accountForFailure(record, spawn);
  }

  private async accountForFailure(
    record: PluginRecord,
    spawn: PluginSpawn,
  ): Promise<void> {
    if (!this.isCurrent(record, spawn)) return;

    const age = this.now() - spawn.spawnedAt;
    let failures = 0;
    if (age <= PLUGIN_FAST_FAILURE_WINDOW_MS) {
      failures = (this.consecutiveFastFailures.get(record.pluginId) ?? 0) + 1;
    }
    // Reaching ready does not clear this counter. Only a failure from a spawn
    // older than the fast-failure window starts a new failure sequence.
    this.consecutiveFastFailures.set(record.pluginId, failures);

    if (failures >= PLUGIN_CRASH_LOOP_THRESHOLD) {
      try {
        await setPluginDisabled(
          this.options.stateDir,
          this.options.workspaceRoot,
          record.pluginId,
          true,
        );
      } catch (error) {
        this.appendLog(
          record,
          `Could not save disabled state: ${this.errorMessage(error)}`,
        );
        return;
      }
      if (!this.isCurrent(record, spawn)) return;
      record.current = undefined;
      record.commands = undefined;
      this.setStatus(record, "disabled");
      return;
    }

    // Re-check stopping here, not just isCurrent: a synchronous
    // onStatusChange listener can call stop() from inside handleExit's own
    // setStatus call, in the same tick. A stop that arrived mid-accounting
    // must win over a respawn.
    if (this.isCurrent(record, spawn) && !spawn.stopping) this.spawn(record);
  }

  private isCurrent(record: PluginRecord, spawn: PluginSpawn): boolean {
    return (
      this.currentGeneration === spawn.generation &&
      this.plugins.get(record.pluginId) === record &&
      record.current === spawn
    );
  }

  private isLive(record: PluginRecord, spawn: PluginSpawn): boolean {
    return (
      this.isCurrent(record, spawn) &&
      !spawn.stopping &&
      !spawn.failureHandled
    );
  }

  private handleRequest(
    pluginId: string,
    spawnId: string,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    if (method !== PLUGIN_HOST_METHODS.sdkRequest) {
      throw new Error(`Method not found: ${method}`);
    }
    if (!isSdkRequestParams(params)) {
      throw new Error(
        "Malformed sdk.request params: method must be a non-empty string.",
      );
    }
    const request = params;
    return this.options.routeSdkRequest(
      pluginId,
      request.method,
      request.params,
      spawnId,
    );
  }

  private handleNotification(
    record: PluginRecord,
    method: string,
    params: unknown,
  ): void {
    if (method !== PLUGIN_HOST_METHODS.log) return;
    if (!isPluginLogParams(params)) {
      let renderedParams = "[unserializable params]";
      try {
        renderedParams = JSON.stringify(params) ?? String(params);
      } catch {
        // Keep the fallback diagnostic.
      }
      this.appendLog(
        record,
        `Malformed plugin.log notification: ${renderedParams}`,
      );
      return;
    }
    const log = params;
    this.appendLog(record, `[${log.level}] ${log.message}`);
  }

  private appendLog(record: PluginRecord, line: string): void {
    record.stderr.push(line);
    if (record.stderr.length > STDERR_LOG_LIMIT) record.stderr.shift();
  }

  private setStatus(record: PluginRecord, status: PluginRuntimeStatus): void {
    record.status = status;
    const onStatusChange = this.options.onStatusChange;
    if (!onStatusChange) return;
    const pluginId = record.pluginId;
    // Deferred, always — never synchronous. A listener that reacts to a
    // status change by calling back into this host (stop, invokeCommand,
    // another start) must never be able to reenter mid-operation, the way a
    // synchronous callback could. This is what makes that whole class of
    // race impossible, not a fix for one more instance of it.
    queueMicrotask(() => onStatusChange(pluginId, status));
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
