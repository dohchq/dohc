import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import {
  PLUGIN_CHILD_PROCESS_METHODS,
  type PluginChildProcessExit,
  type PluginChildProcessOutput,
  type PluginChildProcessStream,
} from "@dohc/sdk/node";
import { killProcessTreePosix } from "../process/posixSpawn";
import { resolveSpawnCommand } from "../process/windowsSpawn";
import { isInside } from "../security/pathContainment";
import { errorMessage } from "./pluginShared";
import { pluginIdToSafePath } from "./pluginSourceSnapshot";
import { PLUGIN_PROCESS_LOG_LIMIT } from "./pluginHostProtocol";

const CHILD_PROCESS_STOP_GRACE_MS = 2_000;
const CHILD_PROCESS_EXIT_WAIT_MS = 5_000;
// finishExit keeps an exited child's record around (its logs and exit
// result stay readable by design — a plugin may call logs()/wait() after a
// child exits), so nothing removes it until the whole spawn is disposed.
// A plugin that spawns many short-lived children within one still-open
// spawn would otherwise accumulate unbounded records (CodeRabbit #779 R9).
// This caps that at the same order of magnitude as PLUGIN_PROCESS_LOG_LIMIT
// (200): once a spawn's exited-and-still-retained children pass the cap,
// the oldest are dropped — a plugin reading their logs immediately after
// exit, as the API is meant to be used, never hits this.
export const EXITED_CHILD_RETENTION_LIMIT = 200;
const MAX_CHILD_ARGS = 256;
const MAX_CHILD_ARG_LENGTH = 16_384;
const MAX_CHILD_ENV_ENTRIES = 512;
const MAX_CHILD_ENV_KEY_LENGTH = 256;
const MAX_CHILD_ENV_VALUE_LENGTH = 32_768;
export const MAX_CHILD_ENV_BYTES = 65_536;
// Measured healthy environments, and the platform ceilings they sit under,
// are recorded in
// the measurement suite in pluginSourceSnapshot.test.ts. The
// largest healthy inherited environment measured 5,052 UTF-16 code units,
// and Windows caps a process environment block at 32,767 characters. This
// limit clears that ceiling plus a plugin's whole MAX_CHILD_ENV_BYTES budget
// with room to spare, so it only rejects an environment no healthy caller
// builds.
export const MAX_MERGED_CHILD_ENV_CODE_UNITS = 262_144;

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

export interface PluginCommandSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The name the plugin asked for, before Windows shim resolution. Failures
   * report this, because it is the name the plugin's agent has to correct. */
  requestedCommand: string;
  windowsVerbatimArguments?: boolean;
}

/** What a module child (`utilityProcess.fork`) and a command child (an
 * executable) both give the broker. Two members differ by kind, because the
 * two child kinds carry input over different channels: a module child has the
 * utility-process message channel, a command child has a stdin pipe. The
 * broker refuses the wrong one by name rather than dropping a write. */
export interface PluginChildProcessHandle {
  readonly pid?: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  /** Module children only. */
  postMessage?(message: unknown): void;
  /** Command children only. */
  readonly stdin?: NodeJS.WritableStream | null;
  kill(): boolean;
}

/**
 * The exit and error listeners a spawn implementation must attach in the same
 * turn it starts the child. The broker receives its handle one await later,
 * so a listener it attached itself would miss a child that exited first —
 * the record would then never finish, `wait()` would time out, and the
 * retained handle would never be cleaned up (#779 round 10 B4).
 *
 * `code` is null for a child a signal ended, which is how a POSIX command
 * child reports being killed.
 */
export interface PluginChildProcessLifecycle {
  onExit(code: number | null): void;
  onError(message: string): void;
}

export interface PluginChildProcessBrokerOptions {
  /** The app's userData-resident plugin-data root for this workspace
   * (PluginPipeline's dohcDir) — never a workspace-relative path (CERT779).
   * A brokered child's cwd/modulePath must resolve inside
   * <dohcDir>/plugins/<safeId>. */
  dohcDir: string;
  /** The workspace root this broker serves. The one tree a spawn may run in
   * outside the plugin's built root, and only through the explicit
   * `{ workspaceRoot: true }` request form — never a bare path string, which
   * always means the plugin's own root. */
  workspaceRoot: string;
  forkProcess?: (
    modulePath: string,
    args: string[],
    options: PluginChildProcessForkOptions,
    lifecycle: PluginChildProcessLifecycle,
  ) => Promise<PluginChildProcessHandle> | PluginChildProcessHandle;
  spawnCommandProcess?: (
    command: string,
    args: string[],
    options: PluginCommandSpawnOptions,
    lifecycle: PluginChildProcessLifecycle,
  ) => Promise<PluginChildProcessHandle> | PluginChildProcessHandle;
  platform?: NodeJS.Platform;
  /** Signals the pid, `alsoSignal`, and every descendant of them; returns the
   * pids it signalled. See posixSpawn.ts's killProcessTreePosix. */
  killProcessTreePosix?: (
    pid: number,
    signal: NodeJS.Signals,
    alsoSignal: readonly number[],
  ) => Promise<readonly number[]> | readonly number[];
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

/** The workspace root, or one directory inside it. */
interface WorkspaceCwd {
  workspaceRoot: true;
  path?: string;
}

interface CommonSpawnRequest {
  args: string[];
  cwd?: string | WorkspaceCwd;
  env: Record<string, string>;
}

interface SpawnRequest extends CommonSpawnRequest {
  modulePath: string;
}

interface CommandSpawnRequest extends CommonSpawnRequest {
  command: string;
}

/** A module child runs a JavaScript file inside the plugin's built root. A
 * command child runs any executable the machine has. */
type ChildKind = "module" | "command";

interface SpawnRecord {
  readonly kind: ChildKind;
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

// `{ workspaceRoot: true }`, optionally naming one directory inside it. Shape
// only: whether a `path` is a usable relative path is decided by the same
// check a plugin-relative cwd gets, so a bad path is reported as a bad path
// rather than as the wrong request form.
function isWorkspaceCwd(value: unknown): value is { workspaceRoot: true; path?: unknown } {
  if (!isRecord(value) || value.workspaceRoot !== true) return false;
  const keys = Object.keys(value);
  return keys.length === 1 || (keys.length === 2 && "path" in value);
}

function assertRelativePath(value: unknown, label: string, root: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    isAbsolute(value)
  ) {
    throw new Error(`${label} must be a non-empty path relative to the ${root}.`);
  }
  return value;
}

function parseSpawnCwd(
  value: unknown,
  method: string,
): string | WorkspaceCwd | undefined {
  if (value === undefined) return undefined;
  if (isWorkspaceCwd(value)) {
    if (value.path === undefined) return { workspaceRoot: true };
    return {
      workspaceRoot: true,
      path: assertRelativePath(value.path, `${method} cwd path`, "workspace root"),
    };
  }
  if (isRecord(value)) {
    throw new Error(
      `${method} cwd object form must be { workspaceRoot: true } for the workspace root, or { workspaceRoot: true, path } for a relative directory inside it.`,
    );
  }
  return assertRelativePath(value, `${method} cwd`, "plugin's built directory");
}

/**
 * The executable a command child runs.
 *
 * FULL TRUST, BY DECISION: dohc runs whatever executable an installed plugin
 * names. There is no approval prompt and no allowlist, because a plugin runs
 * as trusted code in this app's own process tree and could spawn the same
 * program unsupervised. The broker is a leash, not a wall — its value is that
 * dohc owns the resulting process tree and can always kill it.
 *
 * What IS enforced is the shape: an argv array, never a command line. The
 * plugin names a file, dohc runs that file, and every argument stays one argv
 * entry no shell ever reads. A name with a path separator is refused so it
 * cannot silently mean "relative to the cwd"; an absolute path runs as given
 * and a bare name is looked up on the child environment's PATH, which is
 * where harness CLIs live.
 */
function assertCommandName(value: unknown, method: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CHILD_ARG_LENGTH ||
    value.includes("\0")
  ) {
    throw new Error(
      `${method} command must be a string of 1-${MAX_CHILD_ARG_LENGTH} characters with no null character.`,
    );
  }
  if (!isAbsolute(value) && (value.includes("/") || value.includes("\\"))) {
    throw new Error(
      `${method} command "${value}" must be an absolute path to an executable, or a name with no path separator. dohc looks a bare name up on the child environment's PATH and never runs a command through a shell.`,
    );
  }
  return value;
}

function parseCommandSpawnRequest(value: unknown): CommandSpawnRequest {
  const method = PLUGIN_CHILD_PROCESS_METHODS.spawnCommand;
  if (!isRecord(value)) {
    throw new Error(`${method} input must be an object.`);
  }
  return {
    command: assertCommandName(value.command, method),
    ...parseCommonSpawnFields(value, method),
  };
}

function parseSpawnRequest(value: unknown): SpawnRequest {
  const method = PLUGIN_CHILD_PROCESS_METHODS.spawn;
  if (!isRecord(value)) {
    throw new Error(`${method} input must be an object.`);
  }
  return {
    modulePath: assertRelativePath(
      value.modulePath,
      `${method} modulePath`,
      "plugin's built directory",
    ),
    ...parseCommonSpawnFields(value, method),
  };
}

function parseCommonSpawnFields(
  value: Record<string, unknown>,
  method: string,
): CommonSpawnRequest {
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
      `${method} args must contain at most ${MAX_CHILD_ARGS} strings of ${MAX_CHILD_ARG_LENGTH} characters or fewer.`,
    );
  }
  const cwd = parseSpawnCwd(value.cwd, method);
  const envValue = value.env ?? {};
  if (!isRecord(envValue)) {
    throw new Error(`${method} env must be an object of strings.`);
  }
  const entries = Object.entries(envValue);
  if (entries.length > MAX_CHILD_ENV_ENTRIES) {
    throw new Error(
      `${method} env has ${entries.length} entries; the configured limit is ${MAX_CHILD_ENV_ENTRIES} entries.`,
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
        `${method} env key must contain 1-${MAX_CHILD_ENV_KEY_LENGTH} characters with no equals sign or null character.`,
      );
    }
    if (
      typeof entry !== "string" ||
      entry.length > MAX_CHILD_ENV_VALUE_LENGTH ||
      entry.includes("\0")
    ) {
      throw new Error(
        `${method} env value for "${key}" must be a string of ${MAX_CHILD_ENV_VALUE_LENGTH} characters or fewer with no null character.`,
      );
    }
    envBytes += Buffer.byteLength(key) + Buffer.byteLength(entry) + 2;
    env[key] = entry;
  }
  if (envBytes > MAX_CHILD_ENV_BYTES) {
    throw new Error(
      `${method} env uses ${envBytes} bytes; the configured limit is ${MAX_CHILD_ENV_BYTES} bytes.`,
    );
  }
  return { args: [...args], cwd, env };
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

export async function forkElectronUtilityProcess(
  modulePath: string,
  args: string[],
  options: PluginChildProcessForkOptions,
  lifecycle: PluginChildProcessLifecycle,
): Promise<PluginChildProcessHandle> {
  const { utilityProcess } = await import("electron");
  const child = utilityProcess.fork(modulePath, args, options);
  child.once("exit", (code) => lifecycle.onExit(code));
  child.once("error", (type, location, report) =>
    lifecycle.onError(`Utility process error ${type} at ${location}: ${report}`));
  // Electron leaves `pid` undefined until the child spawns, so returning here
  // hands every caller a live child with no pid: this broker's Windows tree
  // kill skips it, and a plugin that records the pid to recognise its own
  // orphan later records nothing. Wait for the spawn, or for the end that
  // means no pid is coming — the caller's spawn request has its own timeout.
  await new Promise<void>((settle) => {
    child.once("spawn", () => settle());
    child.once("exit", () => settle());
    child.once("error", () => settle());
  });
  return child;
}

function environmentPath(env: NodeJS.ProcessEnv): string | undefined {
  return env.Path ?? env.PATH;
}

/**
 * Runs an executable as a supervised child, with the same contract a module
 * child has: the lifecycle listeners attach in this turn, and the call
 * settles only once the child spawned or ended.
 *
 * `shell` is never set. The plugin hands over an argv array and this runs that
 * file, so no command line exists for a shell to reinterpret. Windows is the
 * one place a command line is unavoidable — an npm-installed CLI there is a
 * .cmd shim that only cmd.exe can start — and `resolveSpawnCommand` builds
 * that single line itself under its own quoting rules, which refuse any
 * argument cmd.exe could reparse.
 */
export async function spawnCommandChildProcess(
  command: string,
  args: string[],
  options: PluginCommandSpawnOptions,
  lifecycle: PluginChildProcessLifecycle,
): Promise<PluginChildProcessHandle> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let startFailure: unknown;
  child.once("exit", (code) => lifecycle.onExit(code));
  child.once("error", (error) => {
    lifecycle.onError(`Command child process error: ${errorMessage(error)}`);
  });
  await new Promise<void>((settle) => {
    child.once("spawn", () => settle());
    child.once("exit", () => settle());
    child.once("error", (error) => {
      startFailure = error;
      settle();
    });
  });
  // A child that never started has no pid, no streams to read, and no exit to
  // wait for, so the plugin gets the failure as its spawn call's error rather
  // than as a record it would have to poll to discover was born dead.
  if (startFailure !== undefined && child.pid === undefined) {
    const requested = options.requestedCommand;
    throw new Error(
      `${PLUGIN_CHILD_PROCESS_METHODS.spawnCommand} could not start "${requested}". ` +
        (isAbsolute(requested)
          ? "No executable exists at that path."
          : `It was looked up on the child environment's PATH (${environmentPath(options.env) ?? "unset"}).`) +
        ` ${errorMessage(startFailure)}`,
    );
  }
  return child;
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
  private readonly evictedExitedChildren = new Map<string, number>();
  private readonly forkProcess: NonNullable<PluginChildProcessBrokerOptions["forkProcess"]>;
  private readonly spawnCommandProcess: NonNullable<PluginChildProcessBrokerOptions["spawnCommandProcess"]>;
  private readonly platform: NodeJS.Platform;
  private readonly killProcessTreePosix: NonNullable<PluginChildProcessBrokerOptions["killProcessTreePosix"]>;
  private readonly killWindowsTree: NonNullable<PluginChildProcessBrokerOptions["killWindowsTree"]>;
  private readonly stopGraceMs: number;
  private readonly exitWaitMs: number;

  constructor(private readonly options: PluginChildProcessBrokerOptions) {
    this.forkProcess = options.forkProcess ?? forkElectronUtilityProcess;
    this.spawnCommandProcess =
      options.spawnCommandProcess ?? spawnCommandChildProcess;
    this.platform = options.platform ?? process.platform;
    // Signals the child's own pid and every descendant pid read from the
    // process table, never the negated "-pid" process-group form (CodeRabbit
    // #779 R10): utilityProcess.fork never makes the child its own group
    // leader (no `detached` option exists on that API), so it inherits this
    // process's group — `-pid` there is at best an ESRCH no-op and at worst
    // signals an unrelated group. Enumerating descendants is what stops a
    // brokered child's own servers and workers from surviving teardown.
    this.killProcessTreePosix = options.killProcessTreePosix ??
      ((pid, signal, alsoSignal) =>
        killProcessTreePosix(pid, signal, { alsoSignal }));
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
      case PLUGIN_CHILD_PROCESS_METHODS.spawnCommand:
        return this.spawnCommand(context, parseCommandSpawnRequest(params));
      case PLUGIN_CHILD_PROCESS_METHODS.subscribeOutput:
        return this.subscribe(context, childIdFromParams(params, method));
      case PLUGIN_CHILD_PROCESS_METHODS.send: {
        const record = this.ownedChild(
          context,
          childIdFromParams(params, method),
        );
        if (!isRecord(params) || !("message" in params)) {
          throw new Error(`${method} message is required.`);
        }
        this.assertLive(context, record);
        const child = record.child;
        if (record.kind !== "module" || typeof child.postMessage !== "function") {
          throw new Error(
            `${method} needs a module child. Child process "${record.childId}" runs a command and has no message channel; write to its standard input with ${PLUGIN_CHILD_PROCESS_METHODS.write}.`,
          );
        }
        child.postMessage(params.message);
        return {};
      }
      case PLUGIN_CHILD_PROCESS_METHODS.write: {
        const record = this.ownedChild(
          context,
          childIdFromParams(params, method),
        );
        if (!isRecord(params) || typeof params.data !== "string") {
          throw new Error(`${method} data must be a string.`);
        }
        this.assertLive(context, record);
        this.childInput(record, method).write(params.data);
        return {};
      }
      case PLUGIN_CHILD_PROCESS_METHODS.endInput: {
        const record = this.ownedChild(
          context,
          childIdFromParams(params, method),
        );
        this.assertLive(context, record);
        this.childInput(record, method).end();
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
    // The entry exists to join concurrent teardowns of one spawn, not to be
    // a permanent record: spawn keys are unique per spawn, so keeping every
    // fulfilled teardown grew the map without bound across plugin restarts
    // (#779 round 13 A4). The failure paths delete their own entries; only
    // the entry that IS this settled promise may be removed here, so a
    // replacement teardown registered after a failure is left alone.
    teardown.then(
      () => {
        if (this.spawnTeardowns.get(key) === teardown) {
          this.spawnTeardowns.delete(key);
        }
      },
      () => undefined,
    );
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
  ): Promise<{ childId: string; pid: number | null }> {
    const method = PLUGIN_CHILD_PROCESS_METHODS.spawn;
    const pluginRoot = await this.pluginRoot(context.pluginId);
    const modulePath = await this.containedFile(
      pluginRoot,
      request.modulePath,
      "modulePath",
      method,
    );
    const cwd = await this.spawnCwd(pluginRoot, request.cwd, method);
    if (context.signal.aborted) throw new Error("The plugin spawn has ended.");

    return this.startChild(context, "module", request.env, (env, lifecycle) =>
      this.forkProcess(
        modulePath,
        request.args,
        {
          cwd,
          env,
          serviceName: `dohc.plugin.${context.pluginId}.child`,
          stdio: ["ignore", "pipe", "pipe"],
        },
        lifecycle,
      ),
    );
  }

  /**
   * Runs an executable under the same supervision a module child gets: the
   * same cwd containment, the same pid and exit contract, the same tree kill
   * on teardown. The executable itself is not contained — a command child
   * exists to run the tools a machine already has, and the plugin naming one
   * is trusted code (see assertCommandName).
   */
  private async spawnCommand(
    context: PluginChildProcessBrokerContext,
    request: CommandSpawnRequest,
  ): Promise<{ childId: string; pid: number | null }> {
    const method = PLUGIN_CHILD_PROCESS_METHODS.spawnCommand;
    const pluginRoot = await this.pluginRoot(context.pluginId);
    const cwd = await this.spawnCwd(pluginRoot, request.cwd, method);
    if (context.signal.aborted) throw new Error("The plugin spawn has ended.");

    return this.startChild(context, "command", request.env, (env, lifecycle) => {
      const resolved = resolveSpawnCommand(request.command, request.args, {
        env,
        cwd,
        platform: this.platform,
      });
      return this.spawnCommandProcess(
        resolved.command,
        resolved.args,
        {
          cwd,
          env,
          requestedCommand: request.command,
          windowsVerbatimArguments: resolved.windowsVerbatimArguments,
        },
        lifecycle,
      );
    });
  }

  /** The cwd both spawn kinds share: inside the plugin's built root, or inside
   * the workspace through the one explicit request form. A workspace path is
   * contained the same way a plugin path is, so the directory a child runs in
   * is always one of those two trees. */
  private async spawnCwd(
    pluginRoot: string,
    requested: string | WorkspaceCwd | undefined,
    method: string,
  ): Promise<string> {
    if (!isWorkspaceCwd(requested)) {
      return this.containedDirectory(
        pluginRoot,
        requested ?? ".",
        "cwd",
        method,
        "plugin directory",
      );
    }
    const workspaceRoot = await this.canonicalWorkspaceRoot(method);
    if (requested.path === undefined) return workspaceRoot;
    return this.containedDirectory(
      workspaceRoot,
      requested.path,
      "cwd",
      method,
      "workspace",
    );
  }

  /**
   * Everything a started child needs regardless of what it runs: the merged
   * environment, the record, the output capture, and the abort race.
   *
   * The child inherits this app's whole environment with the plugin's string
   * overrides merged on top. That is deliberate and it is what makes a
   * harness CLI usable: it finds its own stored login through HOME/USERPROFILE
   * and its own installation through PATH, exactly as it would in the user's
   * terminal. dohc adds no credential of its own here.
   */
  private async startChild(
    context: PluginChildProcessBrokerContext,
    kind: ChildKind,
    requestEnv: Record<string, string>,
    launch: (
      env: NodeJS.ProcessEnv,
      lifecycle: PluginChildProcessLifecycle,
    ) => Promise<PluginChildProcessHandle> | PluginChildProcessHandle,
  ): Promise<{ childId: string; pid: number | null }> {
    const childId = randomUUID();
    const env = { ...process.env, ...requestEnv };
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
    // The launcher attaches these in the same turn it starts the child, so an
    // exit or error that lands before the record exists is buffered here
    // rather than lost (#779 round 10 B4).
    let record: SpawnRecord | null = null;
    let exitedWith: number | null | undefined;
    const pendingErrors: string[] = [];
    const child = await launch(env, {
      onExit: (code) => {
        if (record) this.finishExit(record, code);
        else exitedWith = code;
      },
      onError: (message) => {
        if (record) this.appendOutput(record, "stderr", message);
        else pendingErrors.push(message);
      },
    });
    let resolveExit: (result: PluginChildProcessExit) => void = () => undefined;
    const exit = new Promise<PluginChildProcessExit>((resolveResult) => {
      resolveExit = resolveResult;
    });
    record = {
      kind,
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
    // A child that closes its own standard input turns the next write into an
    // EPIPE the plugin never asked for. Report it as the child's output
    // instead of letting it reach this process as an unhandled stream error.
    const input = child.stdin;
    if (input) {
      const inputRecord = record;
      input.on("error", (error: unknown) => {
        this.appendOutput(
          inputRecord,
          "stderr",
          `Child standard input failed: ${errorMessage(error)}`,
        );
      });
    }
    for (const text of pendingErrors) this.appendOutput(record, "stderr", text);
    if (exitedWith !== undefined) this.finishExit(record, exitedWith);

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
    return { childId, pid: child.pid ?? null };
  }

  /** The canonical (realpath) workspace root, resolved per spawn so a root
   * that is currently unavailable fails the spawn with its own error. */
  private async canonicalWorkspaceRoot(method: string): Promise<string> {
    const root = resolve(this.options.workspaceRoot);
    const canonical = await realpath(root).catch((error: unknown) => {
      throw new Error(
        `${method} cwd workspace root is unavailable at ${root}: ${errorMessage(error)}`,
      );
    });
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error(
        `${method} cwd workspace root is not a directory: ${canonical}`,
      );
    }
    return canonical;
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
    if (!child) {
      // A handle can go missing because retention evicted it, which is a
      // configured limit the calling plugin's agent has to be able to read
      // off the error itself.
      const evicted = this.evictedExitedChildren.get(
        this.spawnKey(context.pluginId, context.spawnId),
      ) ?? 0;
      if (evicted > 0) {
        throw new Error(
          `Child process "${childId}" was not found. This spawn discarded ` +
            `${evicted} exited ${evicted === 1 ? "child" : "children"}: the ` +
            "broker retains at most " +
            `${EXITED_CHILD_RETENTION_LIMIT} exited children per spawn and ` +
            "discards the oldest first. Read a child's logs and exit result " +
            "before spawning more.",
        );
      }
      throw new Error(`Child process "${childId}" was not found.`);
    }
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

  /** The write half of a command child's stdio. Long-lived harness CLIs speak
   * a protocol over it, so the broker keeps it open until the plugin ends it
   * or the child goes. */
  private childInput(record: SpawnRecord, method: string): NodeJS.WritableStream {
    if (record.kind !== "command") {
      throw new Error(
        `${method} needs a command child. Child process "${record.childId}" runs a module and has no standard input; post it a message with ${PLUGIN_CHILD_PROCESS_METHODS.send}.`,
      );
    }
    const input = record.child.stdin;
    if (!input || !input.writable) {
      throw new Error(
        `Child process "${record.childId}" standard input is closed.`,
      );
    }
    return input;
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

  private finishExit(record: SpawnRecord, code: number | null): void {
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
    this.evictOldExitedChildren(this.spawnKey(record.pluginId, record.spawnId));
  }

  private evictOldExitedChildren(key: string): void {
    const owned = this.childrenBySpawn.get(key);
    if (!owned) return;
    const exitedIds = [...owned].filter((id) => this.children.get(id)?.exited === true);
    const excess = exitedIds.length - EXITED_CHILD_RETENTION_LIMIT;
    if (excess <= 0) return;
    for (const childId of exitedIds.slice(0, excess)) {
      const child = this.children.get(childId);
      if (child) this.removeChild(child);
    }
    this.evictedExitedChildren.set(
      key,
      (this.evictedExitedChildren.get(key) ?? 0) + excess,
    );
  }

  private async stopChild(record: SpawnRecord): Promise<void> {
    if (record.exited) return;
    record.terminating = true;
    const pid = record.child.pid;
    if (this.platform === "win32") {
      if (pid !== undefined) await this.killWindowsTree(pid);
      if (!record.exited) record.child.kill();
    } else {
      const captured = await this.signalPosix(record, "SIGTERM", []);
      let graceTimer: NodeJS.Timeout | undefined;
      const grace = new Promise<void>((resolveGrace) => {
        graceTimer = setTimeout(resolveGrace, this.stopGraceMs);
        graceTimer.unref?.();
      });
      // The root exiting ends the grace period early, but never cancels the
      // force round: a descendant that ignored SIGTERM outlives its parent,
      // and a root whose SIGTERM handler forks before exiting would otherwise
      // leave that fork running. The round re-enumerates from the captured
      // pids as well as the root, so a descendant already reparented to init
      // is still reached.
      //
      // Residual: a process forked after this capture, whose whole ancestor
      // chain exits before the force round, is reparented to init and no ppid
      // walk can find it. Closing that needs a process group this app owns,
      // and these children cannot have one — utilityProcess.fork has no
      // `detached` option (#779 R10), and packaged builds fuse `runAsNode`
      // off and ship no system node, so no detached group-leader node process
      // can exist to wrap them.
      await Promise.race([record.exit.then(() => undefined), grace]);
      if (graceTimer) clearTimeout(graceTimer);
      await this.signalPosix(record, "SIGKILL", captured);
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

  /** Returns the pids this round signalled, for the next round to reuse. */
  private async signalPosix(
    record: SpawnRecord,
    signal: NodeJS.Signals,
    alsoSignal: readonly number[],
  ): Promise<readonly number[]> {
    const pid = record.child.pid;
    if (pid === undefined) {
      record.child.kill();
      return alsoSignal;
    }
    try {
      return await this.killProcessTreePosix(pid, signal, alsoSignal);
    } catch {
      if (!record.exited) record.child.kill();
      return alsoSignal;
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
      this.evictedExitedChildren.delete(key);
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
    root: string,
    requested: string,
    label: string,
    method: string,
    rootLabel: string,
  ): Promise<string> {
    const contained = await this.containedPath(
      root,
      requested,
      label,
      method,
      rootLabel,
    );
    if (!(await stat(contained)).isDirectory()) {
      throw new Error(`${method} ${label} "${requested}" is not a directory.`);
    }
    return contained;
  }

  private async containedFile(
    pluginRoot: string,
    requested: string,
    label: string,
    method: string,
  ): Promise<string> {
    const contained = await this.containedPath(
      pluginRoot,
      requested,
      label,
      method,
      "plugin directory",
    );
    if (!(await stat(contained)).isFile()) {
      throw new Error(`${method} ${label} "${requested}" is not a file.`);
    }
    return contained;
  }

  private async containedPath(
    root: string,
    requested: string,
    label: string,
    method: string,
    rootLabel: string,
  ): Promise<string> {
    const candidate = resolve(root, requested);
    const contained = await realpath(candidate).catch((error: unknown) => {
      throw new Error(
        `${method} ${label} "${requested}" is unavailable: ${errorMessage(error)}`,
      );
    });
    if (!isInside(root, contained)) {
      const normalizedRequested = normalize(requested);
      const lexicalEscape = normalizedRequested === ".." ||
        normalizedRequested.startsWith(`..${sep}`);
      throw new Error(
        lexicalEscape
          ? `${method} ${label} "${requested}" escapes ${rootLabel} "${root}".`
          : `${method} ${label} "${requested}" resolves outside ${rootLabel} "${root}" to "${contained}".`,
      );
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
