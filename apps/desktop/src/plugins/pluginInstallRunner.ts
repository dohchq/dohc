import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { killProcessTreePosix } from "../process/posixSpawn";
import { killProcessTreeWin32 } from "../process/windowsSpawn";
import {
  PINNED_PLUGIN_PACKAGE_MANAGER,
  PLUGIN_INSTALL_TIMEOUT_MS,
  type PluginPnpmPaths,
} from "./pluginSourceSnapshot";
import { delay, errorMessage, isInside } from "./pluginShared";

const MAX_LOG_ENTRIES = 500;
const PLUGIN_INSTALL_SERVICE_NAME = "dohc.plugin.install";
// Bounded fallback when terminate() itself reports it never sent the
// request (CodeRabbit #779 R20) — short because this only fires on that
// abnormal path, not the normal exit-gated resolution every other job
// takes.
export const TERMINATE_FAILURE_GRACE_MS = 5_000;
// How long a signalled install tree has to exit before the force round, the
// same grace the plugin child-process broker gives its own children.
export const INSTALL_TREE_STOP_GRACE_MS = 2_000;
// A job reports teardown complete only after the force round ran, so a
// caller-supplied kill that never returns must not hold the job open
// forever: the grace, plus the same budget again for the kill itself.
export const INSTALL_TREE_TEARDOWN_CAP_MS = INSTALL_TREE_STOP_GRACE_MS + 2_000;

// CodeRabbit #779 R18 (Critical): this install's cwd is a copy of
// plugin-authored source, whose pnpm-lock.yaml/.npmrc the plugin author
// controls. Forwarding this app's full process.env let a plugin-supplied
// .npmrc interpolate any ambient credential (auth tokens, cloud creds) into
// a request to a registry the plugin itself points at — npm-family config
// resolution reads `${VAR}` references straight out of the environment.
// Only inherit what pnpm and the tools it shells out to (git, tar) actually
// need to run; everything else — including HOME/USERPROFILE, so this
// machine's real ~/.npmrc is never read — is pinned to a plugin-scoped
// location below instead of inherited.
const INHERITED_ENV_KEYS = [
  "PATH",
  "Path",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SystemRoot",
  "windir",
  "ComSpec",
] as const;

function buildPluginInstallEnv(pnpmPaths: PluginPnpmPaths): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // A definitely-absent file: pnpm treats a missing user config file as "no
  // additional config" rather than an error, so this reliably disables it
  // without depending on what this machine happens to have.
  const disabledConfigFile = join(pnpmPaths.homeDir, ".npmrc-disabled");
  env.HOME = pnpmPaths.homeDir;
  env.USERPROFILE = pnpmPaths.homeDir;
  env.PNPM_CONFIG_USERCONFIG = disabledConfigFile;
  // PNPM_CONFIG_*, not npm_config_*: the pinned pnpm reads only its own
  // prefix, so the npm_config_registry pin this used to carry set nothing at
  // all and a plugin-supplied .npmrc chose the registry. Measured against the
  // staged pnpm@11.20.0: with a snapshot .npmrc naming its own registry,
  // npm_config_registry lost and pnpm fetched every dependency from it;
  // PNPM_CONFIG_REGISTRY wins, because env outranks a project .npmrc
  // (#779 round 8 D1).
  env.PNPM_CONFIG_REGISTRY = "https://registry.npmjs.org/";
  env.PNPM_CONFIG_STORE_DIR = pnpmPaths.storeDir;
  env.PNPM_CONFIG_CACHE_DIR = pnpmPaths.cacheDir;
  env.PNPM_CONFIG_STATE_DIR = pnpmPaths.stateDir;
  env.PNPM_CONFIG_UPDATE_NOTIFIER = "false";
  return env;
}

// Two pnpm behaviors this command does not control, read from pnpm/pnpm at
// ebc48abdc5510fa9bf9c0d3bc3be93ae2580d13c (subtree `pnpm11/`) and recorded
// so a later change does not have to rediscover them (CERT779H):
//
// A lockfile that points a package at an attacker's tarball URL is stopped
// upstream, not here: pnpm re-fetches the registry's packument and rejects
// any entry whose `tarball` disagrees with it, with
// ERR_PNPM_TARBALL_URL_MISMATCH
// (resolving/npm-resolver/src/createNpmResolutionVerifier.ts:230-233,401-428).
// dohc adds nothing to that check, and `trust-lockfile` — the one setting
// that skips it (installing/deps-installer/src/install/index.ts:437) — is
// readable only from pnpm-workspace.yaml, which --ignore-workspace ignores
// and the snapshot rejects outright.
//
// `pnpm patch` application is NOT gated by --ignore-scripts: patches are
// applied and only the postinstall hooks after them are skipped
// (building/during-install/src/index.ts:241-250). It is unreachable today
// because patchedDependencies lives in pnpm-workspace.yaml only
// (config/reader/src/getOptionsFromRootManifest.ts:62-68). Anything that
// makes that file readable again makes patches reachable again.
export const PLUGIN_INSTALL_ARGS = [
  "install",
  "--ignore-scripts",
  // --ignore-scripts only blocks package.json lifecycle scripts
  // (postinstall, etc.) — a .pnpmfile.cjs hook (readPackage/afterAllResolved)
  // is a completely separate pnpm mechanism that runs arbitrary Node code
  // during resolution regardless of --ignore-scripts (#779 round 3
  // finding 6, security-grade).
  "--ignore-pnpmfile",
  "--ignore-workspace",
  "--frozen-lockfile",
  "--node-linker=isolated",
  // pnpm's own defaults, restated where nothing can outrank them: a CLI flag
  // beats every config layer. The pinned pnpm@11.20.0 takes these two
  // settings from pnpm-workspace.yaml and pnpm 10 took them from a project
  // .npmrc — both files are plugin-authored, and this install runs before any
  // approval gate. Measured against the staged pnpm: with a malicious
  // pnpm-workspace.yaml, either these flags or --ignore-workspace alone keeps
  // the tree inside the snapshot, and removing both lets it out
  // (#779 round 8 D1).
  "--modules-dir=node_modules",
  "--virtual-store-dir=node_modules/.pnpm",
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
  /** The install child's own pid, when it has one. Teardown signals its
   * descendants too: pnpm shells out to git and tar, and killing only the
   * pnpm process leaves those writing into the snapshot while the failed
   * install's artifacts are being removed (#779 round 7 B3). */
  readonly pid: number | undefined;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  onExit(listener: (code: number) => void): void;
  onError(listener: (message: string) => void): void;
  /** True once the termination request was actually sent (Electron's
   * utilityProcess.kill() can return false, e.g. before the child has a
   * PID) — false here means no exit event may ever follow, so the caller
   * must not wait for one unbounded (CodeRabbit #779 R20). */
  terminate(): boolean;
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
  | "escaped-snapshot"
  | "install-not-materialized"
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
   * Path to pluginPnpmRunnerProcess — the app's built dist/main/pnpm-runner.js,
   * or that module's own source, which Node runs directly. This is always the
   * forked entry, including when a test supplies its own `forkProcess`: pnpm's
   * bin cannot be forked on its own here (see that module's header), and a
   * test seam that forks something else than production does proves nothing
   * about production.
   */
  pnpmRunnerEntry: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  forkProcess?: PluginInstallFork;
  platform?: NodeJS.Platform;
  /** Signals the pid, `alsoSignal`, and every descendant of them; returns the
   * pids it signalled. See posixSpawn.ts's killProcessTreePosix. */
  killProcessTreePosix?: (
    pid: number,
    signal: NodeJS.Signals,
    alsoSignal: readonly number[],
  ) => Promise<readonly number[]> | readonly number[];
  killWindowsTree?: (pid: number) => Promise<boolean>;
}

const installQueues = new Map<string, Promise<void>>();

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

// A raw stream "data" chunk boundary can land mid-line — pushLog alone
// would then record each half as its own log entry, and lockfileMismatch's
// later re-join with "\n" inserts a newline exactly where the token was
// split, breaking substring matches like "ERR_PNPM_OUTDATED_LOCKFILE"
// (CodeRabbit #779 R17). This buffers each stream's own partial trailing
// line across chunks instead of assuming one chunk is one or more whole
// lines.
function createStreamLineBuffer(
  logs: PluginInstallLogEntry[],
  stream: PluginInstallLogStream,
): { onData: (chunk: unknown) => void; flush: () => void } {
  let pending = "";
  return {
    onData(chunk: unknown) {
      pending += String(chunk);
      const lastNewline = pending.lastIndexOf("\n");
      if (lastNewline === -1) return;
      pushLog(logs, stream, pending.slice(0, lastNewline));
      pending = pending.slice(lastNewline + 1);
    },
    flush() {
      if (pending.length === 0) return;
      pushLog(logs, stream, pending);
      pending = "";
    },
  };
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

/**
 * Stops the install child and everything it started. Enumerating descendants
 * has to happen while the root is still alive — once it exits, its children
 * are reparented and no ppid walk can find them — so this runs before the
 * utility process itself is terminated. The POSIX force round reuses the pids
 * round one captured, the same captured-set semantics the plugin
 * child-process broker uses.
 *
 * `forceRound` is that second round. The caller must await it before it
 * reports teardown complete: a SIGTERM-ignoring descendant is still alive and
 * still writing until the SIGKILL lands, and the pipeline discards the
 * staging tree the moment this install returns (#779 round 10 B2).
 */
async function signalInstallTree(
  pid: number | undefined,
  platform: NodeJS.Platform,
  killPosix: NonNullable<InstallPluginDependenciesInput["killProcessTreePosix"]>,
  killWindows: NonNullable<InstallPluginDependenciesInput["killWindowsTree"]>,
): Promise<{ forceRound: Promise<void> }> {
  const noForceRound = { forceRound: Promise.resolve() };
  if (pid === undefined) return noForceRound;
  if (platform === "win32") {
    await killWindows(pid);
    return noForceRound;
  }
  const captured = await killPosix(pid, "SIGTERM", []);
  return {
    forceRound: delay(INSTALL_TREE_STOP_GRACE_MS)
      .then(async () => {
        await killPosix(pid, "SIGKILL", captured);
      }),
  };
}

async function forkElectronUtilityProcess(
  modulePath: string,
  args: string[],
  options: PluginInstallForkOptions,
): Promise<PluginInstallProcessHandle> {
  const { utilityProcess } = await import("electron");
  const child = utilityProcess.fork(modulePath, args, options);
  return {
    get pid() {
      return child.pid;
    },
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
    terminate: () => child.kill(),
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

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
] as const;

/**
 * How many dependencies the snapshot's package.json declares. The snapshot
 * gate already read and validated that file
 * (pluginSourceSnapshot's readAndValidatePackageJson), so an unreadable one
 * here means there was nothing to install, not a new error to report.
 */
async function declaredDependencyCount(snapshotRoot: string): Promise<number> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(snapshotRoot, "package.json"), "utf8"));
  } catch {
    return 0;
  }
  if (typeof manifest !== "object" || manifest === null) return 0;
  let declared = 0;
  for (const field of DEPENDENCY_FIELDS) {
    const value = (manifest as Record<string, unknown>)[field];
    if (typeof value === "object" && value !== null) {
      declared += Object.keys(value).length;
    }
  }
  return declared;
}

/**
 * The backstop for a success pnpm reported: confirm the tree is really inside
 * the snapshot, and that it exists at all.
 *
 * A redirected install leaves the snapshot with no node_modules, which the
 * lifecycle scan cannot tell apart from a healthy zero-dependency install —
 * so this check, not that one, makes the redirect visible (#779 round 8 D1).
 * A truncated install leaves the same absence, and pnpm writes
 * node_modules/.modules.yaml only once an install completes — so a snapshot
 * that declares dependencies and has no .modules.yaml did not install, no
 * matter what exit code arrived.
 */
async function verifyInstallOutput(
  input: InstallPluginDependenciesInput,
  timeoutMs: number,
  logs: PluginInstallLogEntry[],
): Promise<PluginInstallResult | null> {
  const snapshotRoot = resolve(input.snapshotRoot);
  const modulesPath = join(snapshotRoot, "node_modules");
  let realModulesPath: string | null = null;
  try {
    realModulesPath = await realpath(modulesPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (realModulesPath !== null) {
    const realSnapshotRoot = await realpath(snapshotRoot);
    if (!isInside(realSnapshotRoot, realModulesPath)) {
      return failure(
        "escaped-snapshot",
        `Plugin "${input.pluginId}" dependency install must keep node_modules ` +
          `inside the snapshot at ${snapshotRoot}; ${modulesPath} resolves to ` +
          `${realModulesPath}.`,
        timeoutMs,
        logs,
        0,
      );
    }
  }
  const declared = await declaredDependencyCount(snapshotRoot);
  if (declared === 0) return null;
  if (realModulesPath !== null && await pathExists(join(modulesPath, ".modules.yaml"))) {
    return null;
  }
  return failure(
    "install-not-materialized",
    `Plugin "${input.pluginId}" dependency install reported success but wrote ` +
      `no ${join("node_modules", ".modules.yaml")} in ${snapshotRoot}. pnpm ` +
      `writes that file when an install completes; declared dependencies: ` +
      `${declared}. Retry the install.`,
    timeoutMs,
    logs,
    0,
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
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
  const platform = input.platform ?? process.platform;
  const killPosix = input.killProcessTreePosix ??
    ((pid, signal, alsoSignal) => killProcessTreePosix(pid, signal, { alsoSignal }));
  const killWindows = input.killWindowsTree ??
    ((pid: number) => killProcessTreeWin32(pid, () => false));
  const pnpmEntry = resolvePluginPnpmEntry(input.resourcesBasePath);
  const env = buildPluginInstallEnv(input.pnpmPaths);
  // Every caller forks the same entry: the runner wrapper, with pnpm's own
  // entry as its first argument. A test seam chooses how the child is
  // spawned, never what runs inside it.
  const forkProcess = input.forkProcess ?? forkElectronUtilityProcess;
  const modulePath = input.pnpmRunnerEntry;
  let child: PluginInstallProcessHandle;
  try {
    child = await forkProcess(modulePath, [pnpmEntry, ...PLUGIN_INSTALL_ARGS], {
      cwd: input.snapshotRoot,
      env,
      serviceName: PLUGIN_INSTALL_SERVICE_NAME,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // modulePath is the file that was actually forked (the pnpm-runner
    // wrapper on the production path, pnpmEntry only on the test-supplied
    // forkProcess path) — name what really failed to start, not always
    // pnpmEntry (CodeRabbit #779 R19).
    return failure(
      "spawn-failed",
      `pnpm could not start from ${modulePath}: ${errorMessage(error)}`,
      timeoutMs,
      logs,
    );
  }

  const stdoutBuffer = createStreamLineBuffer(logs, "stdout");
  const stderrBuffer = createStreamLineBuffer(logs, "stderr");
  child.stdout?.on("data", stdoutBuffer.onData);
  child.stderr?.on("data", stderrBuffer.onData);

  return await new Promise<PluginInstallResult>((resolveResult) => {
    let timer: NodeJS.Timeout | undefined;
    let termination: "timeout" | "aborted" | null = null;
    let processError: string | null = null;
    let settled = false;
    // Resolves when the whole stop sequence has run, force round included.
    let teardown: Promise<void> = Promise.resolve();

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", abortInstall);
    };

    const terminate = (reason: "timeout" | "aborted"): void => {
      if (settled || termination !== null) return;
      termination = reason;
      if (reason === "timeout") {
        pushLog(logs, "system", `Install timed out after ${timeoutMs} ms.`);
      } else {
        pushLog(logs, "system", "Install cancelled by the caller.");
      }
      teardown = (async () => {
        const stop = await signalInstallTree(
          child.pid,
          platform,
          killPosix,
          killWindows,
        ).catch(() => ({ forceRound: Promise.resolve() }));
        const sent = child.terminate();
        if (!sent) {
          // terminate() reports it never sent the request (e.g. the child
          // has no PID yet) — no exit event may ever follow, so this cannot
          // wait for one unbounded (CodeRabbit #779 R20).
          pushLog(
            logs,
            "system",
            `Termination request was not sent. Forcing a result after ` +
              `${TERMINATE_FAILURE_GRACE_MS} ms if the process never exits.`,
          );
          setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            stdoutBuffer.flush();
            stderrBuffer.flush();
            resolveResult(failure(
              "spawn-failed",
              `Plugin "${input.pluginId}" dependency install could not be ` +
                `terminated (${reason}) and did not exit within ` +
                `${TERMINATE_FAILURE_GRACE_MS} ms afterward.`,
              timeoutMs,
              logs,
            ));
          }, TERMINATE_FAILURE_GRACE_MS);
        }
        await stop.forceRound.catch(() => undefined);
      })();
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
      void finishExit(exitCode);
    });

    async function finishExit(exitCode: number): Promise<void> {
      // The root process exited, but a SIGTERM-ignoring descendant it left
      // behind is alive until the force round kills it, and the pipeline
      // discards the staging tree as soon as this job returns (#779 round 10
      // B2). The cap keeps a kill seam that never returns from holding the
      // job open forever.
      await Promise.race([teardown, delay(INSTALL_TREE_TEARDOWN_CAP_MS)]);
      cleanup();
      stdoutBuffer.flush();
      stderrBuffer.flush();

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
        void verifyInstallOutput(input, timeoutMs, logs).then(
          (escaped) =>
            resolveResult(escaped ?? { ok: true, exitCode: 0, logs: [...logs] }),
          (error: unknown) =>
            resolveResult(failure(
              "escaped-snapshot",
              `Plugin "${input.pluginId}" dependency install could not be ` +
                `confirmed inside the snapshot at ${resolve(input.snapshotRoot)}: ` +
                errorMessage(error),
              timeoutMs,
              logs,
              exitCode,
            )),
        );
        return;
      }
      if (lockfileMismatch(logs)) {
        resolveResult(failure(
          "lockfile-mismatch",
          `pnpm rejected pnpm-lock.yaml for plugin "${input.pluginId}" ` +
            `under --frozen-lockfile with exit code ${exitCode}. ` +
            `Regenerate the lockfile with ${PINNED_PLUGIN_PACKAGE_MANAGER} and retry.`,
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
    }

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
