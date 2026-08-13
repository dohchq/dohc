import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  PLUGIN_INSTALL_TIMEOUT_MS,
  type PluginPnpmPaths,
} from "./pluginSourceSnapshot";

const MAX_LOG_ENTRIES = 500;
const PLUGIN_INSTALL_SERVICE_NAME = "dohc.plugin.install";

export const PLUGIN_INSTALL_ARGS = [
  "install",
  "--ignore-scripts",
  "--ignore-workspace",
  "--frozen-lockfile",
  "--node-linker=isolated",
] as const;

export type PluginInstallLogStream = "stdout" | "stderr" | "system";

export interface PluginInstallLogEntry {
  stream: PluginInstallLogStream;
  text: string;
  at: number;
}

export interface PluginInstallForkOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  serviceName: string;
  stdio: ["ignore", "pipe", "pipe"];
}

export interface PluginInstallProcessHandle {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  onExit(listener: (code: number) => void): void;
  onError(listener: (message: string) => void): void;
  terminate(): void;
}

export type PluginInstallFork = (
  modulePath: string,
  args: string[],
  options: PluginInstallForkOptions,
) => PluginInstallProcessHandle | Promise<PluginInstallProcessHandle>;

export type PluginInstallFailureCode =
  | "missing-lockfile"
  | "unreadable-lockfile"
  | "lockfile-mismatch"
  | "pnpm-exit"
  | "timeout"
  | "aborted"
  | "spawn-failed";

export interface PluginInstallFailure {
  code: PluginInstallFailureCode;
  message: string;
  exitCode: number | null;
  timeoutMs: number;
  logs: PluginInstallLogEntry[];
}

export type PluginInstallResult =
  | {
    ok: true;
    exitCode: 0;
    logs: PluginInstallLogEntry[];
  }
  | {
    ok: false;
    error: PluginInstallFailure;
  };

export interface InstallPluginDependenciesInput {
  workspaceRoot: string;
  pluginId: string;
  snapshotRoot: string;
  pnpmPaths: PluginPnpmPaths;
  resourcesBasePath?: string;
  /**
   * Built path to pluginPnpmRunnerProcess's own output (dist/main/pnpm-runner.js
   * in this repo's build). Required for the real Electron fork path — see
   * that module's header comment: Electron's utilityProcess does not exit on
   * its own when a forked script's work is done (electron/electron#47228),
   * so pnpm's own bin/pnpm.mjs, which never calls process.exit() on success,
   * hangs forever if forked directly. The wrapper imports pnpm in-process and
   * calls process.exit() itself once that import settles. Not required when
   * a test supplies its own `forkProcess` (bypassing the default entirely).
   */
  pnpmRunnerEntry?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  forkProcess?: PluginInstallFork;
}

const installQueues = new Map<string, Promise<void>>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pushLog(
  logs: PluginInstallLogEntry[],
  stream: PluginInstallLogStream,
  text: string,
): void {
  const at = Date.now();
  for (const chunk of text.split(/\r?\n/)) {
    if (chunk.length === 0) continue;
    logs.push({ stream, text: chunk, at });
  }
  if (logs.length > MAX_LOG_ENTRIES) {
    logs.splice(0, logs.length - MAX_LOG_ENTRIES);
  }
}

function failure(
  code: PluginInstallFailureCode,
  message: string,
  timeoutMs: number,
  logs: PluginInstallLogEntry[],
  exitCode: number | null = null,
): PluginInstallResult {
  return {
    ok: false,
    error: {
      code,
      message,
      exitCode,
      timeoutMs,
      logs: [...logs],
    },
  };
}

function lockfileMismatch(logs: PluginInstallLogEntry[]): boolean {
  const output = logs.map((entry) => entry.text).join("\n");
  return (
    /ERR_PNPM_(?:OUTDATED_LOCKFILE|NO_LOCKFILE)/i.test(output) ||
    /frozen-lockfile[^\n]*(?:out[- ]of[- ]date|not up to date|mismatch)/i.test(output) ||
    /lockfile[^\n]*(?:out[- ]of[- ]date|not up to date|doesn't match)/i.test(output)
  );
}

async function forkElectronUtilityProcess(
  modulePath: string,
  args: string[],
  options: PluginInstallForkOptions,
): Promise<PluginInstallProcessHandle> {
  const { utilityProcess } = await import("electron");
  const child = utilityProcess.fork(modulePath, args, options);
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    onExit: (listener) => {
      child.once("exit", listener);
    },
    onError: (listener) => {
      child.once("error", (type, location, report) => {
        listener(
          `Electron utility process error ${type} at ${location}: ${report}`,
        );
      });
    },
    terminate: () => {
      child.kill();
    },
  };
}

async function inspectLockfile(
  input: InstallPluginDependenciesInput,
  timeoutMs: number,
): Promise<PluginInstallResult | null> {
  const lockfilePath = join(input.snapshotRoot, "pnpm-lock.yaml");
  try {
    await access(lockfilePath, constants.R_OK);
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return failure(
        "missing-lockfile",
        `pnpm-lock.yaml is missing at ${lockfilePath}. ` +
          `Add the lockfile for plugin "${input.pluginId}" and retry.`,
        timeoutMs,
        [],
      );
    }
    return failure(
      "unreadable-lockfile",
      `pnpm-lock.yaml at ${lockfilePath} could not be read: ${errorMessage(error)}`,
      timeoutMs,
      [],
    );
  }
}

function abortedBeforeSpawn(
  input: InstallPluginDependenciesInput,
  timeoutMs: number,
): PluginInstallResult {
  return failure(
    "aborted",
    `Plugin "${input.pluginId}" dependency install was cancelled before pnpm started.`,
    timeoutMs,
    [],
  );
}

async function runInstallJob(
  input: InstallPluginDependenciesInput,
): Promise<PluginInstallResult> {
  const timeoutMs = input.timeoutMs ?? PLUGIN_INSTALL_TIMEOUT_MS;
  if (input.signal?.aborted) return abortedBeforeSpawn(input, timeoutMs);

  const lockfileFailure = await inspectLockfile(input, timeoutMs);
  if (lockfileFailure) return lockfileFailure;
  if (input.signal?.aborted) return abortedBeforeSpawn(input, timeoutMs);

  const logs: PluginInstallLogEntry[] = [];
  const pnpmEntry = resolvePluginPnpmEntry(input.resourcesBasePath);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PNPM_CONFIG_STORE_DIR: input.pnpmPaths.storeDir,
    PNPM_CONFIG_CACHE_DIR: input.pnpmPaths.cacheDir,
    PNPM_CONFIG_STATE_DIR: input.pnpmPaths.stateDir,
    PNPM_CONFIG_UPDATE_NOTIFIER: "false",
  };
  // A supplied forkProcess (tests) runs pnpm directly — a plain Node
  // child process exits normally on its own. The default Electron path goes
  // through the wrapper instead; see InstallPluginDependenciesInput.pnpmRunnerEntry.
  const usingDefaultFork = input.forkProcess === undefined;
  const forkProcess = input.forkProcess ?? forkElectronUtilityProcess;
  const modulePath = usingDefaultFork
    ? requirePnpmRunnerEntry(input.pnpmRunnerEntry)
    : pnpmEntry;
  const forkArgs = usingDefaultFork
    ? [pnpmEntry, ...PLUGIN_INSTALL_ARGS]
    : [...PLUGIN_INSTALL_ARGS];
  let child: PluginInstallProcessHandle;
  try {
    child = await forkProcess(modulePath, forkArgs, {
      cwd: input.snapshotRoot,
      env,
      serviceName: PLUGIN_INSTALL_SERVICE_NAME,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return failure(
      "spawn-failed",
      `pnpm could not start from ${pnpmEntry}: ${errorMessage(error)}`,
      timeoutMs,
      logs,
    );
  }

  child.stdout?.on("data", (chunk: unknown) => {
    pushLog(logs, "stdout", String(chunk));
  });
  child.stderr?.on("data", (chunk: unknown) => {
    pushLog(logs, "stderr", String(chunk));
  });

  return await new Promise<PluginInstallResult>((resolveResult) => {
    let timer: NodeJS.Timeout | undefined;
    let termination: "timeout" | "aborted" | null = null;
    let processError: string | null = null;
    let settled = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", abortInstall);
    };

    const terminate = (reason: "timeout" | "aborted") => {
      if (settled || termination !== null) return;
      termination = reason;
      if (reason === "timeout") {
        pushLog(logs, "system", `Install timed out after ${timeoutMs} ms.`);
      } else {
        pushLog(logs, "system", "Install cancelled by the caller.");
      }
      child.terminate();
    };

    function abortInstall(): void {
      terminate("aborted");
    }

    child.onError((message) => {
      processError = message;
      pushLog(logs, "system", message);
      // Electron documents that an exit event follows an error event. Wait
      // for that event so this job never returns while its process is alive.
    });
    child.onExit((exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (termination === "timeout") {
        resolveResult(failure(
          "timeout",
          `Plugin "${input.pluginId}" dependency install exceeded the ` +
            `${timeoutMs} ms timeout. pnpm exited before this job returned.`,
          timeoutMs,
          logs,
          exitCode,
        ));
        return;
      }
      if (termination === "aborted") {
        resolveResult(failure(
          "aborted",
          `Plugin "${input.pluginId}" dependency install was cancelled. ` +
            "pnpm exited before this job returned.",
          timeoutMs,
          logs,
          exitCode,
        ));
        return;
      }
      if (processError !== null) {
        resolveResult(failure(
          "spawn-failed",
          `pnpm failed for plugin "${input.pluginId}": ${processError}`,
          timeoutMs,
          logs,
          exitCode,
        ));
        return;
      }
      if (exitCode === 0) {
        resolveResult({ ok: true, exitCode: 0, logs: [...logs] });
        return;
      }
      if (lockfileMismatch(logs)) {
        resolveResult(failure(
          "lockfile-mismatch",
          `pnpm rejected pnpm-lock.yaml for plugin "${input.pluginId}" ` +
            `under --frozen-lockfile with exit code ${exitCode}. ` +
            "Regenerate the lockfile with pnpm@11.20.0 and retry.",
          timeoutMs,
          logs,
          exitCode,
        ));
        return;
      }
      resolveResult(failure(
        "pnpm-exit",
        `pnpm exited with code ${exitCode} for plugin "${input.pluginId}". ` +
          "Review the bounded pnpm log and retry.",
        timeoutMs,
        logs,
        exitCode,
      ));
    });

    timer = setTimeout(() => terminate("timeout"), timeoutMs);
    if (input.signal?.aborted) abortInstall();
    else input.signal?.addEventListener("abort", abortInstall, { once: true });
  });
}

export function resolvePluginPnpmEntry(
  resourcesBasePath = process.resourcesPath,
): string {
  return join(resolve(resourcesBasePath), "plugin-tools", "pnpm", "bin", "pnpm.mjs");
}

function requirePnpmRunnerEntry(pnpmRunnerEntry: string | undefined): string {
  if (!pnpmRunnerEntry) {
    throw new Error(
      "installPluginDependencies needs pnpmRunnerEntry to fork pnpm through " +
        "the real Electron utility-process path (no forkProcess override " +
        "was supplied).",
    );
  }
  return pnpmRunnerEntry;
}

export function installPluginDependencies(
  input: InstallPluginDependenciesInput,
): Promise<PluginInstallResult> {
  const key = `${resolve(input.workspaceRoot)}\0${input.pluginId}`;
  const previous = installQueues.get(key) ?? Promise.resolve();
  const job = previous.then(
    () => runInstallJob(input),
    () => runInstallJob(input),
  );
  const tail = job.then(
    () => undefined,
    () => undefined,
  );
  installQueues.set(key, tail);
  void tail.finally(() => {
    if (installQueues.get(key) === tail) installQueues.delete(key);
  });
  return job;
}
