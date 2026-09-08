import { chmodSync, closeSync, fchmodSync, mkdirSync, openSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { killChildTreeWin32, resolveSpawnCommand } from "../process/windowsSpawn";

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
  detached: true;
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

function appendPathPrefix(prefix: string, current: string | undefined): string {
  return current ? `${prefix}${delimiter}${current}` : prefix;
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
    threadId: string;
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
      PATH: appendPathPrefix(cliBin, process.env.PATH),
      ...(process.env.Path
        ? { Path: appendPathPrefix(cliBin, process.env.Path) }
        : {}),
    };
  }

  function spawnConfiguredRunner(input: {
    rootPath: string;
    threadId: string;
    runId: string;
    logPath: string;
    command: string;
    prompt: string;
  }): RunnerProcess {
    const commandParts = tokenizeRunnerCommand(input.command);
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
    const logFd = prepareLog(input.logPath);
    try {
      // Resolve inside the try so an invalid command fails this dispatch
      // and the log descriptor closes in finally.
      const resolved = resolveSpawnCommand(executable, args, {
        env,
        cwd: input.rootPath,
      });
      const child = spawnRunner(resolved.command, resolved.args, {
        cwd: input.rootPath,
        env,
        detached: true,
        stdio: ["pipe", logFd, logFd],
        windowsHide: true,
        ...(resolved.windowsVerbatimArguments
          ? { windowsVerbatimArguments: true }
          : {}),
      });
      child.writeStdin(input.prompt);
      return child;
    } finally {
      closeSync(logFd);
    }
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
