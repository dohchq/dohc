import { accessSync, chmodSync, closeSync, constants, fchmodSync, mkdirSync, openSync, statSync, writeFileSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { killChildTreeWin32, resolveSpawnCommand } from "../process/windowsSpawn";
import { agentProfileArguments, type AgentLaunchProfile } from "./agentToolCatalog";

export const RUNNER_KILL_GRACE_MS = 10_000;

export const APP_QUIT_KILL_GRACE_MS = 1_500;

export interface RunnerProcess {
  readonly pid: number | undefined;
  readonly rawChild?: ChildProcess;
  // Deliver the prompt. It rides stdin rather than argv because it carries
  // the rendered thread — unbounded in length and content — and a cmd.exe
  // command line can carry neither (~8191 characters, and no safe
  // representation for a double quote).
  writeStdin(text: string): void;
  hasExited(): boolean;
  onExit(listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface RunnerSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: boolean;
  stdio: ["pipe", number, number];
  windowsHide: true;
  windowsVerbatimArguments?: boolean;
}

export type SpawnRunner = (
  command: string,
  args: string[],
  options: RunnerSpawnOptions,
) => RunnerProcess;

function defaultSpawnRunner(
  command: string,
  args: string[],
  options: RunnerSpawnOptions,
): RunnerProcess {
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    stdio: options.stdio,
    windowsHide: options.windowsHide,
    ...(options.windowsVerbatimArguments
      ? { windowsVerbatimArguments: true }
      : {}),
  };
  const child = spawn(command, args, spawnOptions);
  return {
    get pid() {
      return child.pid;
    },
    rawChild: child,
    writeStdin: (text) => {
      // A runner that exits before reading its prompt breaks this pipe. That
      // is the runner's outcome, reported through its exit code and log, not
      // a dispatch-time crash.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(text);
    },
    hasExited: () => child.exitCode !== null || child.signalCode !== null,
    onExit: (listener) => {
      child.once("exit", listener);
    },
    onError: (listener) => {
      child.once("error", listener);
    },
  };
}

function validPid(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isSafeInteger(pid) && pid > 0;
}

// The runner starts in the workspace folder, so an empty or relative PATH
// entry would let a program the workspace carries run in place of a real one.
// Windows allows a quoted entry, such as "C:\Program Files\x"; keep it
// unquoted. Elsewhere a quote is part of the name, so the entry is relative.
function runnerSearchPath(
  prefix: string,
  current: string | undefined,
  platform: NodeJS.Platform,
): string {
  const entries = (current ?? "")
    .split(delimiter)
    .map((entry) => (platform === "win32" ? entry.replace(/^"(.*)"$/u, "$1") : entry))
    .filter((entry) => isAbsolute(entry));
  return [prefix, ...entries].join(delimiter);
}

function runnerNodeAvailable(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const extensions = platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim()).filter(Boolean)
    : [""];
  const searchPath = platform === "win32" ? env.Path ?? env.PATH : env.PATH;
  return (searchPath ?? "").split(delimiter).filter((entry) => isAbsolute(entry)).some((directory) =>
    extensions.some((extension) => {
      const candidate = join(directory, `node${extension}`);
      try {
        if (!statSync(candidate).isFile()) return false;
        accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }));
}

// Keep the launch environment's lookup beside its log, so an owed notice can
// use the same fact after restart. Older runs have no recorded lookup.
export async function readRunnerNodeAvailable(logPath: string): Promise<boolean | undefined> {
  try {
    const saved = await readFile(`${logPath}.node`, "utf8");
    return saved === "true\n" ? true : saved === "false\n" ? false : undefined;
  } catch {
    return undefined;
  }
}

export function resolveDohcCliBinDirectory(input: {
  appRoot: string;
  isPackaged: boolean;
  resourcesPath?: string;
}): string {
  if (!input.isPackaged) {
    return resolve(input.appRoot, "node_modules", ".bin");
  }
  return resolve(input.resourcesPath ?? dirname(process.execPath), "cli-bin");
}

export function tokenizeRunnerCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let inDoubleQuotes = false;
  let tokenStarted = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === '"') {
      inDoubleQuotes = !inDoubleQuotes;
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      const next = command[index + 1];
      if (next === '"' || next === "\\") {
        token += next;
        tokenStarted = true;
        index += 1;
        continue;
      }
    }
    if (/\s/u.test(character) && !inDoubleQuotes) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }
    token += character;
    tokenStarted = true;
  }
  if (inDoubleQuotes) {
    throw new Error("Runner command has an unterminated double quote.");
  }
  if (tokenStarted) tokens.push(token);
  if (tokens.length === 0 || !tokens[0]) {
    throw new Error("Configure a runner command before dispatching.");
  }
  return tokens;
}

export interface ChatRunnerProcessOptions {
  stateDir(): string;
  appRoot(): string;
  isPackaged(): boolean;
  resourcesPath?: () => string | undefined;
  spawnRunner?: SpawnRunner;
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  platform?: NodeJS.Platform;
}

export function createChatRunnerProcess(
  options: ChatRunnerProcessOptions,
  reportError: (error: unknown) => void,
) {
  const spawnRunner = options.spawnRunner ?? defaultSpawnRunner;
  const platform = options.platform ?? process.platform;

  function prepareLog(logPath: string): number {
    const directory = dirname(logPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const fd = openSync(logPath, "a", 0o600);
    try {
      fchmodSync(fd, 0o600);
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  function runnerEnvironment(input: {
    threadId?: string;
    runId: string;
  }): NodeJS.ProcessEnv {
    const cliBin = resolveDohcCliBinDirectory({
      appRoot: options.appRoot(),
      isPackaged: options.isPackaged(),
      resourcesPath: options.resourcesPath?.(),
    });
    return {
      ...process.env,
      DOHC_CHAT_THREAD: input.threadId,
      DOHC_CHAT_ACTOR: "agent",
      DOHC_RUN_ID: input.runId,
      DOHC_STATE_DIR: options.stateDir(),
      PATH: runnerSearchPath(cliBin, process.env.PATH, platform),
      ...(process.env.Path
        ? { Path: runnerSearchPath(cliBin, process.env.Path, platform) }
        : {}),
      // cmd.exe looks in the current directory before PATH, so an npm shim's
      // bare `node` would run a node.cmd at the workspace root. This turns
      // that search off for the shim and for anything the agent starts.
      ...(platform === "win32" ? { NoDefaultCurrentDirectoryInExePath: "1" } : {}),
    };
  }

  function spawnConfiguredRunner(input: {
    rootPath: string;
    threadId?: string;
    runId: string;
    logPath: string;
    command: string;
    profile?: AgentLaunchProfile;
    prompt: string;
    // Throws unless the runner may still start, such as when the workspace
    // lost its trust. Nothing awaits between it and spawn.
    assertMayStart: () => void;
  }): RunnerProcess {
    const logFd = prepareLog(input.logPath);
    try {
      return startRunner(input, logFd);
    } catch (error) {
      // The run's log says why too. A failed write must not hide the reason.
      try {
        writeSync(logFd, `${error instanceof Error ? error.message : String(error)}\n`);
      } catch {}
      throw error;
    } finally {
      closeSync(logFd);
    }
  }

  function startRunner(
    input: Parameters<typeof spawnConfiguredRunner>[0],
    logFd: number,
  ): RunnerProcess {
    const commandParts = input.profile
      ? [input.profile.executable, ...agentProfileArguments(input.profile)]
      : tokenizeRunnerCommand(input.command);
    const executable = commandParts[0]!;
    // The prompt is DATA and rides stdin, never argv. It carries the rendered
    // thread, so it is unbounded in both length and content, and a command
    // line can carry neither safely:
    //   - Length. A .cmd/.bat runner (the npm -g layout on Windows) must run
    //     behind cmd.exe, which hard-fails past ~8191 characters with "The
    //     command line is too long." Any thread of real size exceeds that, so
    //     no amount of quoting would have made argv work.
    //   - Content. quoteForCmd refuses a double quote outright, and the
    //     dispatch prompt always contains one (`--as-agent "<report>"`), so
    //     every dispatch through a shimmed runner threw before it spawned.
    // stdin has neither limit and needs no escaping at all.
    const args = commandParts.slice(1);
    const env = runnerEnvironment({
      threadId: input.threadId,
      runId: input.runId,
    });
    const resolved = resolveSpawnCommand(executable, args, {
      env,
      platform,
      cwd: input.rootPath,
    });
    // libuv searches the child's cwd for a bare name before PATH, and only
    // the parent's environment can turn that off. Refuse instead.
    if (platform === "win32" && !win32.isAbsolute(resolved.command)) {
      throw new Error(
        resolved.windowsVerbatimArguments
          ? "Windows' command interpreter (ComSpec) isn't set to a full path. Set ComSpec to the full path of cmd.exe, then restart dohc."
          : /[\\/]/u.test(executable)
            ? `${executable} doesn't exist. Use its full path in the runner command.`
            : `Couldn't find ${executable} on PATH. Use its full path in the runner command.`,
      );
    }
    try {
      writeFileSync(`${input.logPath}.node`, `${runnerNodeAvailable(env, platform)}\n`, { mode: 0o600 });
    } catch {}
    input.assertMayStart();
    const child = spawnRunner(resolved.command, resolved.args, {
      cwd: input.rootPath,
      env,
      // Detached cmd.exe shims can leave their child waiting for stdin on Windows.
      // Windows cleanup uses taskkill; only POSIX needs a separate process group.
      detached: platform !== "win32",
      stdio: ["pipe", logFd, logFd],
      windowsHide: true,
      ...(resolved.windowsVerbatimArguments
        ? { windowsVerbatimArguments: true }
        : {}),
    });
    child.writeStdin(input.prompt);
    return child;
  }

  function signalOwnedProcess(
    processHandle: RunnerProcess,
    signal: NodeJS.Signals,
  ): void {
    if (processHandle.hasExited() || !validPid(processHandle.pid)) return;
    if (platform === "win32" && processHandle.rawChild) {
      void killChildTreeWin32(processHandle.rawChild).catch(() => undefined);
      return;
    }
    try {
      (options.killProcessGroup ?? ((pid, nextSignal) => process.kill(pid, nextSignal)))(
        -processHandle.pid,
        signal,
      );
    } catch (error) {
      reportError(error);
    }
  }

  function terminateWithEscalation(
    processHandle: RunnerProcess,
    existing: ReturnType<typeof setTimeout> | null,
  ): ReturnType<typeof setTimeout> | null {
    if (existing || processHandle.hasExited()) return existing;
    signalOwnedProcess(processHandle, "SIGTERM");
    return setTimeout(() => {
      if (!processHandle.hasExited()) signalOwnedProcess(processHandle, "SIGKILL");
    }, RUNNER_KILL_GRACE_MS);
  }

  function terminateForAppQuit(processHandle: RunnerProcess): Promise<void> {
    if (processHandle.hasExited()) return Promise.resolve();
    signalOwnedProcess(processHandle, "SIGTERM");
    return new Promise<void>((resolveTermination) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(escalation);
        resolveTermination();
      };
      const escalation = setTimeout(() => {
        if (!processHandle.hasExited()) {
          signalOwnedProcess(processHandle, "SIGKILL");
        }
        finish();
      }, APP_QUIT_KILL_GRACE_MS);
      processHandle.onExit(() => finish());
    });
  }

  return { spawnConfiguredRunner, terminateWithEscalation, terminateForAppQuit };
}
