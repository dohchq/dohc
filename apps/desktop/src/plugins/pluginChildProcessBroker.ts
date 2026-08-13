import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  PLUGIN_CHILD_PROCESS_METHODS,
  type PluginChildProcessExit,
  type PluginChildProcessOutput,
  type PluginChildProcessStream,
} from "@dohc/sdk/node";
import { pluginIdToSafePath } from "./pluginSourceSnapshot";
import { PLUGIN_PROCESS_LOG_LIMIT } from "./pluginHostProtocol";

const CHILD_PROCESS_STOP_GRACE_MS = 2_000;
const CHILD_PROCESS_EXIT_WAIT_MS = 5_000;
const MAX_CHILD_ARGS = 256;
const MAX_CHILD_ARG_LENGTH = 16_384;
const MAX_CHILD_ENV_ENTRIES = 512;
const MAX_CHILD_ENV_KEY_LENGTH = 256;
const MAX_CHILD_ENV_VALUE_LENGTH = 32_768;
const MAX_CHILD_ENV_BYTES = 65_536;
// This worktree's healthy desktop environment measured 86 entries and 5,559
// UTF-16 code units on 2026-08-14. The configured limit leaves more than 11x
// headroom while preventing an unbounded caller-controlled environment block.
const MAX_MERGED_CHILD_ENV_CODE_UNITS = 65_536;

export type {
  PluginChildProcessExit,
  PluginChildProcessOutput,
  PluginChildProcessStream,
} from "@dohc/sdk/node";

export interface PluginChildProcessForkOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  serviceName: string;
  stdio: ["ignore", "pipe", "pipe"];
}

export interface PluginChildProcessHandle {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  postMessage(message: unknown): void;
  kill(): boolean;
  once(event: "exit", listener: (code: number) => void): this;
  once(
    event: "error",
    listener: (type: string, location: string, report: string) => void,
  ): this;
}

export interface PluginChildProcessBrokerOptions {
  /** The app's userData-resident plugin-data root for this workspace
   * (PluginPipeline's dohcDir) — never a workspace-relative path (CERT779).
   * A brokered child's cwd/modulePath must resolve inside
   * <dohcDir>/plugins/<safeId>. */
  dohcDir: string;
  forkProcess?: (
    modulePath: string,
    args: string[],
    options: PluginChildProcessForkOptions,
  ) => Promise<PluginChildProcessHandle> | PluginChildProcessHandle;
  platform?: NodeJS.Platform;
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  killWindowsTree?: (pid: number) => Promise<boolean>;
  stopGraceMs?: number;
  exitWaitMs?: number;
}

export interface PluginChildProcessBrokerContext {
  pluginId: string;
  spawnId: string;
  signal: AbortSignal;
  emitEvent: (subscriptionId: string, event: string, data: unknown) => void;
}

interface SpawnRequest {
  modulePath: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
}

interface SpawnRecord {
  readonly pluginId: string;
  readonly spawnId: string;
  readonly childId: string;
  readonly child: PluginChildProcessHandle;
  readonly logs: PluginChildProcessOutput[];
  readonly exit: Promise<PluginChildProcessExit>;
  sequence: number;
  exited: boolean;
  terminating: boolean;
  exitResult?: PluginChildProcessExit;
  resolveExit(result: PluginChildProcessExit): void;
}

interface SubscriptionRecord {
  pluginId: string;
  spawnId: string;
  childId: string;
  emitEvent: PluginChildProcessBrokerContext["emitEvent"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInside(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent))
  );
}

function assertRelativePluginPath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    isAbsolute(value)
  ) {
    throw new Error(
      `${label} must be a non-empty path relative to the plugin's built directory.`,
    );
  }
  return value;
}

function parseSpawnRequest(value: unknown): SpawnRequest {
  if (!isRecord(value)) {
    throw new Error("childProcesses.spawn input must be an object.");
  }
  const modulePath = assertRelativePluginPath(
    value.modulePath,
    "childProcesses.spawn modulePath",
  );
  const args = value.args ?? [];
  if (
    !Array.isArray(args) ||
    args.length > MAX_CHILD_ARGS ||
    !args.every(
      (argument) =>
        typeof argument === "string" && argument.length <= MAX_CHILD_ARG_LENGTH,
    )
  ) {
    throw new Error(
      `childProcesses.spawn args must contain at most ${MAX_CHILD_ARGS} strings of ${MAX_CHILD_ARG_LENGTH} characters or fewer.`,
    );
  }
  const cwd = value.cwd === undefined
    ? undefined
    : assertRelativePluginPath(value.cwd, "childProcesses.spawn cwd");
  const envValue = value.env ?? {};
  if (!isRecord(envValue)) {
    throw new Error("childProcesses.spawn env must be an object of strings.");
  }
  const entries = Object.entries(envValue);
  if (entries.length > MAX_CHILD_ENV_ENTRIES) {
    throw new Error(
      `childProcesses.spawn env has ${entries.length} entries; the configured limit is ${MAX_CHILD_ENV_ENTRIES} entries.`,
    );
  }
  let envBytes = 0;
  const env: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (
      key.length === 0 ||
      key.length > MAX_CHILD_ENV_KEY_LENGTH ||
      key.includes("=") ||
      key.includes("\0")
    ) {
      throw new Error(
        `childProcesses.spawn env key must contain 1-${MAX_CHILD_ENV_KEY_LENGTH} characters with no equals sign or null character.`,
      );
    }
    if (
      typeof entry !== "string" ||
      entry.length > MAX_CHILD_ENV_VALUE_LENGTH ||
      entry.includes("\0")
    ) {
      throw new Error(
        `childProcesses.spawn env value for "${key}" must be a string of ${MAX_CHILD_ENV_VALUE_LENGTH} characters or fewer with no null character.`,
      );
    }
    envBytes += Buffer.byteLength(key) + Buffer.byteLength(entry) + 2;
    env[key] = entry;
  }
  if (envBytes > MAX_CHILD_ENV_BYTES) {
    throw new Error(
      `childProcesses.spawn env uses ${envBytes} bytes; the configured limit is ${MAX_CHILD_ENV_BYTES} bytes.`,
    );
  }
  return { modulePath, args: [...args], cwd, env };
}

function childIdFromParams(params: unknown, method: string): string {
  if (
    !isRecord(params) ||
    typeof params.childId !== "string" ||
    params.childId.length === 0
  ) {
    throw new Error(`${method} childId must be a non-empty string.`);
  }
  return params.childId;
}

async function forkElectronUtilityProcess(
  modulePath: string,
  args: string[],
  options: PluginChildProcessForkOptions,
): Promise<PluginChildProcessHandle> {
  const { utilityProcess } = await import("electron");
  return utilityProcess.fork(modulePath, args, options);
}

function killWindowsTree(pid: number): Promise<boolean> {
  return new Promise((resolveKill) => {
    execFile(
      "taskkill",
      ["/pid", String(pid), "/T", "/F"],
      { windowsHide: true },
      (error) => resolveKill(!error),
    );
  });
}

function waitForExit(
  signal: AbortSignal,
  exit: Promise<PluginChildProcessExit>,
): Promise<PluginChildProcessExit> {
  return new Promise((resolveExit, reject) => {
    let settled = false;
    const finish = (
      result: { value: PluginChildProcessExit } | { error: unknown },
    ): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", rejectAbort);
      if ("error" in result) reject(result.error);
      else resolveExit(result.value);
    };
    const rejectAbort = (): void => {
      finish({
        error: new Error(
          "The plugin spawn ended before the broker operation completed.",
        ),
      });
    };
    signal.addEventListener("abort", rejectAbort, { once: true });
    if (signal.aborted) rejectAbort();
    exit.then(
      (value) => finish({ value }),
      (error: unknown) => finish({ error }),
    );
  });
}

export class PluginChildProcessBroker {
  private readonly children = new Map<string, SpawnRecord>();
  private readonly childrenBySpawn = new Map<string, Set<string>>();
  private readonly subscriptions = new Map<string, SubscriptionRecord>();
  private readonly spawnSignals = new Map<string, AbortSignal>();
  private readonly spawnTeardowns = new Map<string, Promise<void>>();
  private readonly forkProcess: NonNullable<PluginChildProcessBrokerOptions["forkProcess"]>;
  private readonly platform: NodeJS.Platform;
  private readonly killProcessGroup: NonNullable<PluginChildProcessBrokerOptions["killProcessGroup"]>;
  private readonly killWindowsTree: NonNullable<PluginChildProcessBrokerOptions["killWindowsTree"]>;
  private readonly stopGraceMs: number;
  private readonly exitWaitMs: number;

  constructor(private readonly options: PluginChildProcessBrokerOptions) {
    this.forkProcess = options.forkProcess ?? forkElectronUtilityProcess;
    this.platform = options.platform ?? process.platform;
    this.killProcessGroup = options.killProcessGroup ?? ((pid, signal) => {
      process.kill(-pid, signal);
    });
    this.killWindowsTree = options.killWindowsTree ?? killWindowsTree;
    this.stopGraceMs = options.stopGraceMs ?? CHILD_PROCESS_STOP_GRACE_MS;
    this.exitWaitMs = options.exitWaitMs ?? CHILD_PROCESS_EXIT_WAIT_MS;
  }

  async invoke(
    context: PluginChildProcessBrokerContext,
    method: string,
    params?: unknown,
  ): Promise<unknown> {
    this.trackSpawn(context);
    if (context.signal.aborted) throw new Error("The plugin spawn has ended.");

    switch (method) {
      case PLUGIN_CHILD_PROCESS_METHODS.spawn:
        return this.spawn(context, parseSpawnRequest(params));
      case PLUGIN_CHILD_PROCESS_METHODS.subscribeOutput:
        return this.subscribe(context, childIdFromParams(params, method));
      case PLUGIN_CHILD_PROCESS_METHODS.send: {
        const child = this.ownedChild(
          context,
          childIdFromParams(params, method),
        );
        if (!isRecord(params) || !("message" in params)) {
          throw new Error(`${method} message is required.`);
        }
        this.assertLive(context, child);
        child.child.postMessage(params.message);
        return {};
      }
      case PLUGIN_CHILD_PROCESS_METHODS.logs:
        return [...this.ownedChild(context, childIdFromParams(params, method)).logs];
      case PLUGIN_CHILD_PROCESS_METHODS.wait: {
        const child = this.ownedChild(context, childIdFromParams(params, method));
        return waitForExit(context.signal, child.exit);
      }
      case PLUGIN_CHILD_PROCESS_METHODS.terminate: {
        const child = this.ownedChild(context, childIdFromParams(params, method));
        await this.stopChild(child);
        return child.exitResult ?? { code: null, reason: "terminated" };
      }
      case PLUGIN_CHILD_PROCESS_METHODS.unsubscribe:
        return this.unsubscribe(context, params);
      default:
        throw new Error(`Unsupported child-process broker method: ${method}`);
    }
  }

  async disposeSpawn(pluginId: string, spawnId: string): Promise<void> {
    const key = this.spawnKey(pluginId, spawnId);
    const existing = this.spawnTeardowns.get(key);
    if (existing) return existing;
    const teardown = this.disposeSpawnInternal(pluginId, spawnId, key);
    this.spawnTeardowns.set(key, teardown);
    return teardown;
  }

  async dispose(): Promise<void> {
    const owners = new Map<string, { pluginId: string; spawnId: string }>();
    for (const child of this.children.values()) {
      owners.set(this.spawnKey(child.pluginId, child.spawnId), {
        pluginId: child.pluginId,
        spawnId: child.spawnId,
      });
    }
    const results = await Promise.allSettled(
      [...owners.values()].map(({ pluginId, spawnId }) =>
        this.disposeSpawn(pluginId, spawnId),
      ),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [errorMessage(result.reason)] : [],
    );
    if (failures.length > 0) {
      throw new Error(
        `Plugin child-process broker disposal failed: ${failures.join("; ")}`,
      );
    }
  }

  private trackSpawn(context: PluginChildProcessBrokerContext): void {
    const key = this.spawnKey(context.pluginId, context.spawnId);
    const existingSignal = this.spawnSignals.get(key);
    if (existingSignal && existingSignal !== context.signal) {
      throw new Error(
        `Plugin spawn "${context.spawnId}" was reused with a different cancellation signal.`,
      );
    }
    if (existingSignal) return;
    this.spawnSignals.set(key, context.signal);
    const onAbort = (): void => {
      void this.disposeSpawn(context.pluginId, context.spawnId).catch(
        () => undefined,
      );
    };
    context.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal.aborted) onAbort();
  }

  private async spawn(
    context: PluginChildProcessBrokerContext,
    request: SpawnRequest,
  ): Promise<{ childId: string }> {
    const pluginRoot = await this.pluginRoot(context.pluginId);
    const modulePath = await this.containedFile(
      pluginRoot,
      request.modulePath,
      "modulePath",
    );
    const cwd = await this.containedDirectory(
      pluginRoot,
      request.cwd ?? ".",
      "cwd",
    );
    if (context.signal.aborted) throw new Error("The plugin spawn has ended.");

    const childId = randomUUID();
    const env = { ...process.env, ...request.env };
    const envCodeUnits = Object.entries(env).reduce(
      (total, [key, value]) =>
        value === undefined ? total : total + key.length + value.length + 2,
      1,
    );
    if (envCodeUnits > MAX_MERGED_CHILD_ENV_CODE_UNITS) {
      throw new Error(
        `childProcesses.spawn merged env uses ${envCodeUnits} UTF-16 code units; the configured limit is ${MAX_MERGED_CHILD_ENV_CODE_UNITS} UTF-16 code units.`,
      );
    }
    const child = await this.forkProcess(modulePath, request.args, {
      cwd,
      env,
      serviceName: `dohc.plugin.${context.pluginId}.child`,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let resolveExit: (result: PluginChildProcessExit) => void = () => undefined;
    const exit = new Promise<PluginChildProcessExit>((resolveResult) => {
      resolveExit = resolveResult;
    });
    const record: SpawnRecord = {
      pluginId: context.pluginId,
      spawnId: context.spawnId,
      childId,
      child,
      logs: [],
      exit,
      sequence: 0,
      exited: false,
      terminating: false,
      resolveExit,
    };
    this.children.set(childId, record);
    const key = this.spawnKey(context.pluginId, context.spawnId);
    const owned = this.childrenBySpawn.get(key) ?? new Set<string>();
    owned.add(childId);
    this.childrenBySpawn.set(key, owned);

    this.captureStream(record, "stdout", child.stdout);
    this.captureStream(record, "stderr", child.stderr);
    child.once("error", (type, location, report) => {
      this.appendOutput(
        record,
        "stderr",
        `Utility process error ${type} at ${location}: ${report}`,
      );
    });
    child.once("exit", (code) => this.finishExit(record, code));

    if (context.signal.aborted) {
      try {
        await this.stopChild(record);
        this.removeChild(record);
      } catch (error) {
        this.spawnTeardowns.delete(key);
        throw error;
      }
      throw new Error("The plugin spawn ended before its child was registered.");
    }
    return { childId };
  }

  private subscribe(
    context: PluginChildProcessBrokerContext,
    childId: string,
  ): { subscriptionId: string } {
    const child = this.ownedChild(context, childId);
    this.assertLive(context, child);
    const subscriptionId = randomUUID();
    this.subscriptions.set(subscriptionId, {
      pluginId: context.pluginId,
      spawnId: context.spawnId,
      childId,
      emitEvent: context.emitEvent,
    });
    for (const output of child.logs) {
      queueMicrotask(() => {
        if (!this.subscriptions.has(subscriptionId)) return;
        context.emitEvent(subscriptionId, output.stream, output);
      });
    }
    return { subscriptionId };
  }

  private unsubscribe(
    context: PluginChildProcessBrokerContext,
    params: unknown,
  ): Record<string, never> {
    if (
      !isRecord(params) ||
      typeof params.subscriptionId !== "string" ||
      params.subscriptionId.length === 0
    ) {
      throw new Error("subscriptions.unsubscribe subscriptionId must be a non-empty string.");
    }
    const subscription = this.subscriptions.get(params.subscriptionId);
    if (!subscription) return {};
    if (
      subscription.pluginId !== context.pluginId ||
      subscription.spawnId !== context.spawnId
    ) {
      throw new Error(
        `Plugin "${context.pluginId}" cannot control subscription "${params.subscriptionId}" because another plugin spawn owns it.`,
      );
    }
    this.subscriptions.delete(params.subscriptionId);
    return {};
  }

  private ownedChild(
    context: PluginChildProcessBrokerContext,
    childId: string,
  ): SpawnRecord {
    const child = this.children.get(childId);
    if (!child) throw new Error(`Child process "${childId}" was not found.`);
    if (
      child.pluginId !== context.pluginId ||
      child.spawnId !== context.spawnId
    ) {
      throw new Error(
        `Plugin "${context.pluginId}" spawn "${context.spawnId}" cannot control child process "${childId}" because another plugin spawn owns it.`,
      );
    }
    return child;
  }

  private assertLive(
    context: PluginChildProcessBrokerContext,
    child: SpawnRecord,
  ): void {
    if (context.signal.aborted) throw new Error("The plugin spawn has ended.");
    if (child.exited) {
      throw new Error(`Child process "${child.childId}" has exited.`);
    }
  }

  private captureStream(
    record: SpawnRecord,
    stream: PluginChildProcessStream,
    readable: NodeJS.ReadableStream | null,
  ): void {
    readable?.on("data", (chunk: unknown) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      if (text.length > 0) this.appendOutput(record, stream, text);
    });
  }

  private appendOutput(
    record: SpawnRecord,
    stream: PluginChildProcessStream,
    text: string,
  ): void {
    const output: PluginChildProcessOutput = {
      sequence: ++record.sequence,
      stream,
      text,
    };
    record.logs.push(output);
    if (record.logs.length > PLUGIN_PROCESS_LOG_LIMIT) record.logs.shift();
    for (const [subscriptionId, subscription] of this.subscriptions) {
      if (
        subscription.pluginId === record.pluginId &&
        subscription.spawnId === record.spawnId &&
        subscription.childId === record.childId
      ) {
        subscription.emitEvent(subscriptionId, stream, output);
      }
    }
  }

  private finishExit(record: SpawnRecord, code: number): void {
    if (record.exited) return;
    record.exited = true;
    record.exitResult = {
      code,
      reason: record.terminating ? "terminated" : "exited",
    };
    record.resolveExit(record.exitResult);
    for (const [subscriptionId, subscription] of this.subscriptions) {
      if (subscription.childId !== record.childId) continue;
      subscription.emitEvent(subscriptionId, "exit", record.exitResult);
      this.subscriptions.delete(subscriptionId);
    }
  }

  private async stopChild(record: SpawnRecord): Promise<void> {
    if (record.exited) return;
    record.terminating = true;
    const pid = record.child.pid;
    if (this.platform === "win32") {
      if (pid !== undefined) await this.killWindowsTree(pid);
      if (!record.exited) record.child.kill();
    } else {
      this.signalPosix(record, "SIGTERM");
      let forceTimer: NodeJS.Timeout | undefined;
      const force = new Promise<void>((resolveForce) => {
        forceTimer = setTimeout(() => {
          if (!record.exited) this.signalPosix(record, "SIGKILL");
          resolveForce();
        }, this.stopGraceMs);
        forceTimer.unref?.();
      });
      await Promise.race([record.exit.then(() => undefined), force]);
      if (forceTimer) clearTimeout(forceTimer);
    }

    let waitTimer: NodeJS.Timeout | undefined;
    const waitCap = new Promise<void>((resolveWait) => {
      waitTimer = setTimeout(resolveWait, this.exitWaitMs);
      waitTimer.unref?.();
    });
    try {
      await Promise.race([record.exit.then(() => undefined), waitCap]);
    } finally {
      if (waitTimer) clearTimeout(waitTimer);
    }
    if (!record.exitResult) {
      throw new Error(
        `Child process "${record.childId}" did not exit within the configured ${this.exitWaitMs} ms teardown limit.`,
      );
    }
  }

  private signalPosix(record: SpawnRecord, signal: NodeJS.Signals): void {
    const pid = record.child.pid;
    try {
      if (pid !== undefined) this.killProcessGroup(pid, signal);
      else record.child.kill();
    } catch {
      if (!record.exited) record.child.kill();
    }
  }

  private async disposeSpawnInternal(
    pluginId: string,
    spawnId: string,
    key: string,
  ): Promise<void> {
    const childIds = [...(this.childrenBySpawn.get(key) ?? [])];
    const results = await Promise.allSettled(
      childIds.map((childId) => {
        const child = this.children.get(childId);
        return child ? this.stopChild(child) : Promise.resolve();
      }),
    );
    const failures: string[] = [];
    for (let index = 0; index < childIds.length; index += 1) {
      const childId = childIds[index];
      const result = results[index];
      if (!childId || !result) continue;
      if (result.status === "fulfilled") {
        const child = this.children.get(childId);
        if (child) this.removeChild(child);
      } else {
        failures.push(`${childId}: ${errorMessage(result.reason)}`);
      }
    }
    if ((this.childrenBySpawn.get(key)?.size ?? 0) === 0) {
      this.childrenBySpawn.delete(key);
      this.spawnSignals.delete(key);
    }
    for (const [subscriptionId, subscription] of this.subscriptions) {
      if (
        subscription.pluginId === pluginId &&
        subscription.spawnId === spawnId
      ) {
        this.subscriptions.delete(subscriptionId);
      }
    }
    if (failures.length > 0) {
      this.spawnTeardowns.delete(key);
      throw new Error(
        `Plugin "${pluginId}" spawn "${spawnId}" child teardown failed: ${failures.join("; ")}`,
      );
    }
  }

  private removeChild(record: SpawnRecord): void {
    this.children.delete(record.childId);
    const key = this.spawnKey(record.pluginId, record.spawnId);
    const owned = this.childrenBySpawn.get(key);
    owned?.delete(record.childId);
    if (owned?.size === 0) this.childrenBySpawn.delete(key);
  }

  private async pluginRoot(pluginId: string): Promise<string> {
    const pluginsParent = resolve(
      this.options.dohcDir,
      "plugins",
    );
    const realPluginsParent = await realpath(pluginsParent).catch(
      (error: unknown) => {
        throw new Error(
          `Plugin build directory is unavailable at ${pluginsParent}: ${errorMessage(error)}`,
        );
      },
    );
    const expected = resolve(
      pluginsParent,
      pluginIdToSafePath(pluginId),
    );
    const root = await realpath(expected).catch((error: unknown) => {
      throw new Error(
        `Plugin "${pluginId}" built directory is unavailable at ${expected}: ${errorMessage(error)}`,
      );
    });
    const info = await stat(root);
    if (!info.isDirectory()) {
      throw new Error(`Plugin "${pluginId}" built path is not a directory: ${root}`);
    }
    if (!isInside(realPluginsParent, root)) {
      throw new Error(
        `Plugin "${pluginId}" built directory resolves outside "${realPluginsParent}" to "${root}".`,
      );
    }
    return root;
  }

  private async containedDirectory(
    pluginRoot: string,
    requested: string,
    label: string,
  ): Promise<string> {
    const candidate = resolve(pluginRoot, requested);
    if (!isInside(pluginRoot, candidate)) {
      throw new Error(
        `childProcesses.spawn ${label} "${requested}" escapes plugin directory "${pluginRoot}".`,
      );
    }
    const contained = await realpath(candidate).catch((error: unknown) => {
      throw new Error(
        `childProcesses.spawn ${label} "${requested}" is unavailable: ${errorMessage(error)}`,
      );
    });
    if (!isInside(pluginRoot, contained)) {
      throw new Error(
        `childProcesses.spawn ${label} "${requested}" resolves outside plugin directory "${pluginRoot}" to "${contained}".`,
      );
    }
    if (!(await stat(contained)).isDirectory()) {
      throw new Error(`childProcesses.spawn ${label} "${requested}" is not a directory.`);
    }
    return contained;
  }

  private async containedFile(
    pluginRoot: string,
    requested: string,
    label: string,
  ): Promise<string> {
    const candidate = resolve(pluginRoot, requested);
    if (!isInside(pluginRoot, candidate)) {
      throw new Error(
        `childProcesses.spawn ${label} "${requested}" escapes plugin directory "${pluginRoot}".`,
      );
    }
    const contained = await realpath(candidate).catch((error: unknown) => {
      throw new Error(
        `childProcesses.spawn ${label} "${requested}" is unavailable: ${errorMessage(error)}`,
      );
    });
    if (!isInside(pluginRoot, contained)) {
      throw new Error(
        `childProcesses.spawn ${label} "${requested}" resolves outside plugin directory "${pluginRoot}" to "${contained}".`,
      );
    }
    if (!(await stat(contained)).isFile()) {
      throw new Error(`childProcesses.spawn ${label} "${requested}" is not a file.`);
    }
    return contained;
  }

  private spawnKey(pluginId: string, spawnId: string): string {
    return `${pluginId}\0${spawnId}`;
  }
}

export function isPluginChildProcessMethod(method: string): boolean {
  return (
    method.startsWith("childProcesses.") ||
    method === PLUGIN_CHILD_PROCESS_METHODS.unsubscribe
  );
}
