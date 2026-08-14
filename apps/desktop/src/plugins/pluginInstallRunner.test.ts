import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { killProcessTreePosix } from "../process/posixSpawn";
import {
  INSTALL_TREE_STOP_GRACE_MS,
  installPluginDependencies,
  PLUGIN_INSTALL_ARGS,
  resolvePluginPnpmEntry,
  TERMINATE_FAILURE_GRACE_MS,
  type InstallPluginDependenciesInput,
  type PluginInstallFork,
  type PluginInstallForkOptions,
  type PluginInstallProcessHandle,
  type PluginInstallResult,
} from "./pluginInstallRunner";
import {
  PINNED_PLUGIN_PNPM_VERSION,
  PLUGIN_INSTALL_TIMEOUT_MS,
} from "./pluginSourceSnapshot";

interface InstallFixture {
  root: string;
  workspaceRoot: string;
  snapshotRoot: string;
  resourcesBasePath: string;
  input: InstallPluginDependenciesInput;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

const roots: string[] = [];

class FakeInstallProcess implements PluginInstallProcessHandle {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly terminate = vi.fn(() => true);
  private readonly exitListeners: Array<(code: number) => void> = [];

  constructor(readonly pid: number | undefined = 4_242) {}

  private readonly errorListeners: Array<(message: string) => void> = [];
  private exitedCode: number | undefined;

  onExit(listener: (code: number) => void): void {
    if (this.exitedCode !== undefined) {
      queueMicrotask(() => listener(this.exitedCode ?? 1));
      return;
    }
    this.exitListeners.push(listener);
  }

  onError(listener: (message: string) => void): void {
    this.errorListeners.push(listener);
  }

  exit(code: number): void {
    this.exitedCode = code;
    for (const listener of this.exitListeners) listener(code);
  }

  error(message: string): void {
    for (const listener of this.errorListeners) listener(message);
  }
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolveValue) => {
    resolvePromise = resolveValue;
  });
  return {
    promise,
    resolve: (value) => {
      if (!resolvePromise) throw new Error("Deferred promise was not initialized.");
      resolvePromise(value);
    },
  };
}

async function createInstallFixture(
  options: { lockfile?: boolean; pluginId?: string } = {},
): Promise<InstallFixture> {
  const root = await mkdtemp(join(tmpdir(), "dohc-plugin-install-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const snapshotRoot = join(root, "snapshot");
  const resourcesBasePath = join(root, "resources");
  await Promise.all([
    mkdir(workspaceRoot),
    mkdir(snapshotRoot),
    mkdir(resourcesBasePath),
  ]);
  if (options.lockfile !== false) {
    await writeFile(join(snapshotRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  }
  const input: InstallPluginDependenciesInput = {
    workspaceRoot,
    pluginId: options.pluginId ?? "example-plugin",
    snapshotRoot,
    resourcesBasePath,
    // Fake-driven tests must never signal a real process table entry for
    // FakeInstallProcess's made-up pid. The descendant-teardown test below
    // supplies its own tree walker instead.
    platform: "linux",
    killProcessTreePosix: (pid, _signal, alsoSignal) => [pid, ...alsoSignal],
    pnpmPaths: {
      storeDir: join(workspaceRoot, ".dohc", "pnpm", "store"),
      cacheDir: join(workspaceRoot, ".dohc", "pnpm", "cache"),
      stateDir: join(workspaceRoot, ".dohc", "pnpm", "state"),
      homeDir: join(workspaceRoot, ".dohc", "pnpm", "home"),
    },
  };
  return { root, workspaceRoot, snapshotRoot, resourcesBasePath, input };
}

/** Teardown signals the process tree before terminating the child, so the
 * terminate call lands a few microtasks after the abort. */
async function flushMicrotasks(times = 5): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

function requireFailure(
  result: PluginInstallResult,
): Extract<PluginInstallResult, { ok: false }> {
  if (result.ok) throw new Error("Expected the plugin install to fail.");
  return result;
}

function nodeForkProcess(
  modulePath: string,
  args: string[],
  options: PluginInstallForkOptions,
): PluginInstallProcessHandle {
  const child = spawn(process.execPath, [modulePath, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio,
  });
  return {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    onExit: (listener) => {
      child.once("exit", (code) => listener(code ?? 1));
    },
    onError: (listener) => {
      child.once("error", (error) => listener(error.message));
    },
    terminate: () => child.kill(),
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("installPluginDependencies", () => {
  it("constructs the exact utility-process command, environment, and cwd", async () => {
    const fixture = await createInstallFixture();
    const child = new FakeInstallProcess();
    const forkProcess = vi.fn<PluginInstallFork>(() => {
      queueMicrotask(() => child.exit(0));
      return child;
    });

    const result = await installPluginDependencies({
      ...fixture.input,
      forkProcess,
    });

    expect(result.ok).toBe(true);
    expect(forkProcess).toHaveBeenCalledTimes(1);
    const homeDir = fixture.input.pnpmPaths.homeDir;
    expect(forkProcess).toHaveBeenCalledWith(
      resolvePluginPnpmEntry(fixture.resourcesBasePath),
      [...PLUGIN_INSTALL_ARGS],
      {
        cwd: fixture.snapshotRoot,
        // R18 (CodeRabbit #779): an explicit allowlist, never a full
        // process.env spread — see the canary/user-.npmrc pins below for
        // why.
        env: {
          ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
          ...(process.env.Path !== undefined ? { Path: process.env.Path } : {}),
          ...(process.env.TEMP !== undefined ? { TEMP: process.env.TEMP } : {}),
          ...(process.env.TMP !== undefined ? { TMP: process.env.TMP } : {}),
          ...(process.env.TMPDIR !== undefined ? { TMPDIR: process.env.TMPDIR } : {}),
          ...(process.env.SystemRoot !== undefined
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
          ...(process.env.windir !== undefined ? { windir: process.env.windir } : {}),
          ...(process.env.ComSpec !== undefined ? { ComSpec: process.env.ComSpec } : {}),
          HOME: homeDir,
          USERPROFILE: homeDir,
          PNPM_CONFIG_USERCONFIG: join(homeDir, ".npmrc-disabled"),
          PNPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
          PNPM_CONFIG_STORE_DIR: fixture.input.pnpmPaths.storeDir,
          PNPM_CONFIG_CACHE_DIR: fixture.input.pnpmPaths.cacheDir,
          PNPM_CONFIG_STATE_DIR: fixture.input.pnpmPaths.stateDir,
          PNPM_CONFIG_UPDATE_NOTIFIER: "false",
        },
        serviceName: "dohc.plugin.install",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  });

  it("never forwards the parent process's ambient env, only the pinned allowlist (CodeRabbit #779 R18 PoC)", async () => {
    const fixture = await createInstallFixture();
    const child = new FakeInstallProcess();
    const forkProcess = vi.fn<PluginInstallFork>(() => {
      queueMicrotask(() => child.exit(0));
      return child;
    });
    const canaryKey = "DOHC_TEST_CANARY_SECRET";
    process.env[canaryKey] = "leak-me-if-this-test-is-red";
    try {
      await installPluginDependencies({ ...fixture.input, forkProcess });
    } finally {
      delete process.env[canaryKey];
    }

    const observedEnv = forkProcess.mock.calls[0]?.[2].env;
    expect(observedEnv).toBeDefined();
    expect(observedEnv?.[canaryKey]).toBeUndefined();
    // A real ~/.npmrc on this machine (if any) must never be read: HOME and
    // pnpm's own config-location override all point inside the plugin-scoped
    // pnpmPaths.homeDir instead.
    expect(observedEnv?.HOME).toBe(fixture.input.pnpmPaths.homeDir);
    expect(observedEnv?.USERPROFILE).toBe(fixture.input.pnpmPaths.homeDir);
    expect(observedEnv?.PNPM_CONFIG_USERCONFIG).toBe(
      join(fixture.input.pnpmPaths.homeDir, ".npmrc-disabled"),
    );
    // The pinned pnpm reads only its own PNPM_CONFIG_ prefix; an npm_config_
    // name here would be config this install never applies (#779 round 8 D1).
    expect(observedEnv?.PNPM_CONFIG_REGISTRY).toBe("https://registry.npmjs.org/");
    expect(
      Object.keys(observedEnv ?? {}).filter((key) => key.startsWith("npm_config_")),
    ).toEqual([]);
  });

  it("fails closed when the installed tree resolves outside the snapshot (#779 round 8 D1)", async () => {
    const fixture = await createInstallFixture();
    // Whatever put it there — a redirecting pnpm setting this runner did not
    // pin, or a node_modules link the plugin shipped in its own source — the
    // dependency tree this install produced is not inside the snapshot, and
    // nothing downstream may treat it as installed.
    const outside = join(fixture.root, "outside-modules");
    await mkdir(outside, { recursive: true });
    await symlink(
      outside,
      join(fixture.snapshotRoot, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const child = new FakeInstallProcess();
    const forkProcess = vi.fn<PluginInstallFork>(() => {
      queueMicrotask(() => child.exit(0));
      return child;
    });

    const escaped = requireFailure(await installPluginDependencies({
      ...fixture.input,
      forkProcess,
    }));

    expect(escaped.error.code).toBe("escaped-snapshot");
    // Names the constraint and the observed path, so the agent reading this
    // error can see what it hit.
    expect(escaped.error.message).toContain(fixture.snapshotRoot);
    expect(escaped.error.message).toContain("node_modules");
  });

  it("classifies a lockfile mismatch even when its marker token is split across stream chunks (CodeRabbit #779 R17)", async () => {
    const fixture = await createInstallFixture();
    const child = new FakeInstallProcess();
    const started = deferred<void>();
    const forkProcess = vi.fn<PluginInstallFork>(() => {
      started.resolve();
      return child;
    });

    const install = installPluginDependencies({ ...fixture.input, forkProcess });
    await started.promise;
    // Both listeners are attached synchronously right after forkProcess
    // returns, above — these writes land as two separate "data" events,
    // the exact marker token split mid-word across an OS pipe-buffer
    // boundary that real pnpm output can produce. The surrounding text is
    // deliberately neutral (no "not up to date"/"mismatch" phrasing of its
    // own) so only the ERR_PNPM_ token match can make this pass.
    child.stdout.write("pnpm reported ERR_PNPM_OUTDATED_LOCK");
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.stdout.write("FILE while installing.\n");
    child.exit(1);

    const failure = requireFailure(await install);

    expect(failure.error.code).toBe("lockfile-mismatch");
  });

  it("names the real forked module (the runner entry, not pnpmEntry) on the default production fork path (CodeRabbit #779 R19)", async () => {
    const fixture = await createInstallFixture();
    const pnpmRunnerEntry = join(fixture.root, "pnpm-runner.js");
    // No forkProcess override: this exercises usingDefaultFork === true,
    // previously untested. The real forkElectronUtilityProcess dynamically
    // imports "electron" and calls utilityProcess.fork — outside a real
    // Electron process that fails immediately, which is exactly the
    // spawn-failed path this test pins the message for.
    const failure = requireFailure(
      await installPluginDependencies({ ...fixture.input, pnpmRunnerEntry }),
    );

    expect(failure.error.code).toBe("spawn-failed");
    expect(failure.error.message).toContain(pnpmRunnerEntry);
    expect(failure.error.message).not.toContain(
      resolvePluginPnpmEntry(fixture.resourcesBasePath),
    );
  });

  it("returns a structured missing-lockfile failure without spawning pnpm", async () => {
    const fixture = await createInstallFixture({ lockfile: false });
    const forkProcess = vi.fn<PluginInstallFork>();

    const failure = requireFailure(await installPluginDependencies({
      ...fixture.input,
      forkProcess,
    }));

    expect(failure.error).toMatchObject({
      code: "missing-lockfile",
      exitCode: null,
      timeoutMs: PLUGIN_INSTALL_TIMEOUT_MS,
    });
    expect(failure.error.message).toContain(join(fixture.snapshotRoot, "pnpm-lock.yaml"));
    expect(forkProcess).not.toHaveBeenCalled();
  });

  it("terminates on abort and waits for the process exit", async () => {
    const fixture = await createInstallFixture();
    const child = new FakeInstallProcess();
    const started = deferred<void>();
    const controller = new AbortController();
    const forkProcess = vi.fn<PluginInstallFork>(() => {
      started.resolve();
      return child;
    });

    let settled = false;
    const install = installPluginDependencies({
      ...fixture.input,
      forkProcess,
      signal: controller.signal,
    }).then((result) => {
      settled = true;
      return result;
    });
    await started.promise;
    controller.abort();
    await flushMicrotasks();

    expect(child.terminate).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    child.exit(143);

    const failure = requireFailure(await install);
    expect(failure.error).toMatchObject({ code: "aborted", exitCode: 143 });
    expect(failure.error.logs.at(-1)?.text).toBe("Install cancelled by the caller.");
  });

  it("signals the install child's descendants, not just the child (#779 round 7 B3)", async () => {
    vi.useFakeTimers();
    const fixture = await createInstallFixture();
    const child = new FakeInstallProcess(4_242);
    const started = deferred<void>();
    const controller = new AbortController();
    const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    // pnpm (4242) shelled out to git (4243), which shelled out to its own
    // helper (4244). 4242 is the only pid this runner was ever told about.
    const liveTable = [" 4242     1", " 4243  4242", " 4244  4243", " 5000     1", ""]
      .join("\n");
    // By the force round the root is gone and its descendants are reparented
    // to init, so no ppid walk from 4242 can find them any more.
    const orphanedTable = [" 4243     1", " 4244     1", " 5000     1", ""].join("\n");
    let tableReads = 0;

    const install = installPluginDependencies({
      ...fixture.input,
      forkProcess: () => {
        started.resolve();
        return child;
      },
      signal: controller.signal,
      killProcessTreePosix: (pid, signal, alsoSignal) =>
        killProcessTreePosix(pid, signal, {
          alsoSignal,
          readProcessTable: () => {
            tableReads += 1;
            return Promise.resolve(tableReads === 1 ? liveTable : orphanedTable);
          },
          sendSignal: (targetPid, targetSignal) => {
            signalled.push({ pid: targetPid, signal: targetSignal });
          },
        }),
    });
    await started.promise;
    controller.abort();
    await flushMicrotasks();

    // Children before parents, so a signalled parent cannot leave a child
    // behind — and the whole tree is reached before the child is terminated.
    expect(signalled).toEqual([
      { pid: 4_244, signal: "SIGTERM" },
      { pid: 4_243, signal: "SIGTERM" },
      { pid: 4_242, signal: "SIGTERM" },
    ]);
    expect(child.terminate).toHaveBeenCalledTimes(1);

    // The force round reuses the pids the first round captured, so the now
    // orphaned git and tar processes are still reached.
    await vi.advanceTimersByTimeAsync(INSTALL_TREE_STOP_GRACE_MS);
    expect(signalled.filter((entry) => entry.signal === "SIGKILL").map((entry) =>
      entry.pid
    ).sort()).toEqual([4_242, 4_243, 4_244]);

    child.exit(143);
    expect(requireFailure(await install).error.code).toBe("aborted");
  });

  it("resolves within a bounded grace period when terminate() reports it never sent the request (CodeRabbit #779 R20)", async () => {
    vi.useFakeTimers();
    const fixture = await createInstallFixture();
    const child = new FakeInstallProcess();
    child.terminate.mockReturnValue(false);
    const started = deferred<void>();
    const controller = new AbortController();
    const forkProcess = vi.fn<PluginInstallFork>(() => {
      started.resolve();
      return child;
    });

    let settled = false;
    const install = installPluginDependencies({
      ...fixture.input,
      forkProcess,
      signal: controller.signal,
    }).then((result) => {
      settled = true;
      return result;
    });
    await started.promise;
    controller.abort();
    await flushMicrotasks();

    expect(child.terminate).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    // The child never exits — terminate() never actually reached it.
    await vi.advanceTimersByTimeAsync(TERMINATE_FAILURE_GRACE_MS);

    const failure = requireFailure(await install);
    expect(failure.error.code).toBe("spawn-failed");
    expect(failure.error.message).toContain(`${TERMINATE_FAILURE_GRACE_MS} ms`);
  });

  it("terminates on timeout and reports the measured limit after exit", async () => {
    vi.useFakeTimers();
    const fixture = await createInstallFixture();
    const child = new FakeInstallProcess();
    const started = deferred<void>();
    const forkProcess = vi.fn<PluginInstallFork>(() => {
      started.resolve();
      return child;
    });

    let settled = false;
    const install = installPluginDependencies({
      ...fixture.input,
      forkProcess,
    }).then((result) => {
      settled = true;
      return result;
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(PLUGIN_INSTALL_TIMEOUT_MS);

    expect(child.terminate).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    child.exit(143);

    const failure = requireFailure(await install);
    expect(failure.error).toMatchObject({
      code: "timeout",
      exitCode: 143,
      timeoutMs: PLUGIN_INSTALL_TIMEOUT_MS,
    });
    expect(failure.error.message).toContain(`${PLUGIN_INSTALL_TIMEOUT_MS} ms timeout`);
  });

  it("retains only the last 500 log lines", async () => {
    const fixture = await createInstallFixture();
    const child = new FakeInstallProcess();
    const forkProcess = vi.fn<PluginInstallFork>(() => {
      setImmediate(() => {
        child.stdout.write(
          `${Array.from({ length: 510 }, (_value, index) => `line-${index}`).join("\n")}\n`,
        );
        child.exit(2);
      });
      return child;
    });

    const failure = requireFailure(await installPluginDependencies({
      ...fixture.input,
      forkProcess,
    }));

    expect(failure.error.code).toBe("pnpm-exit");
    expect(failure.error.logs).toHaveLength(500);
    expect(failure.error.logs[0]?.text).toBe("line-10");
    expect(failure.error.logs.at(-1)?.text).toBe("line-509");
  });

  it("serializes installs for the same workspace and plugin", async () => {
    const fixture = await createInstallFixture();
    const firstChild = new FakeInstallProcess();
    const secondChild = new FakeInstallProcess();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const forkProcess = vi.fn<PluginInstallFork>(() => {
      if (forkProcess.mock.calls.length === 1) {
        firstStarted.resolve();
        return firstChild;
      }
      secondStarted.resolve();
      return secondChild;
    });

    const first = installPluginDependencies({ ...fixture.input, forkProcess });
    const second = installPluginDependencies({ ...fixture.input, forkProcess });
    await firstStarted.promise;
    expect(forkProcess).toHaveBeenCalledTimes(1);

    firstChild.exit(0);
    await expect(first).resolves.toMatchObject({ ok: true });
    await secondStarted.promise;
    expect(forkProcess).toHaveBeenCalledTimes(2);
    secondChild.exit(0);
    await expect(second).resolves.toMatchObject({ ok: true });
  });
});

// These three tests are the only measured evidence behind every install pin
// above, and they used to gate on two paths that exist in no fresh checkout:
// apps/desktop/resources/plugin-tools (a build output) and a gitignored
// reference fixture. Both were absent, so all three skipped green — the
// pins looked proven and nothing had run them (#779 round 9 A2).
//
// Now the only precondition is the pinned pnpm this repo already installs as
// a devDependency, which the setup below stages the same way
// PluginPipeline.test.ts does, and the fixture is right here in the file.
export const REQUIRE_PLUGIN_INSTALL_E2E_ENV_VAR = "DOHC_REQUIRE_PLUGIN_INSTALL_E2E";

const desktopRoot = resolve(import.meta.dirname, "../..");
const pnpmPackageRoot = join(desktopRoot, "node_modules", "pnpm");
const realInstallAvailable = existsSync(join(pnpmPackageRoot, "bin", "pnpm.mjs"));

if (!realInstallAvailable && process.env[REQUIRE_PLUGIN_INSTALL_E2E_ENV_VAR] === "1") {
  throw new Error(
    `The pinned pnpm was not found at ${pnpmPackageRoot}. Run pnpm install in ` +
      `apps/desktop. ${REQUIRE_PLUGIN_INSTALL_E2E_ENV_VAR}=1 makes this a ` +
      "failure rather than a skip.",
  );
}

// The measured "small" reference fixture, in the file so a fresh checkout has
// it. pnpm@11.20.0 resolved this lockfile; one dependency keeps the proofs
// fast while still exercising a real registry fetch.
const FIXTURE_PACKAGE_JSON = `${JSON.stringify({
  name: "pr2-lock-small",
  private: true,
  version: "1.0.0",
  dependencies: { zod: "4.4.3" },
}, null, 2)}\n`;

const FIXTURE_LOCKFILE = [
  "lockfileVersion: '9.0'",
  "",
  "settings:",
  "  autoInstallPeers: true",
  "  excludeLinksFromLockfile: false",
  "",
  "importers:",
  "",
  "  .:",
  "    dependencies:",
  "      zod:",
  "        specifier: 4.4.3",
  "        version: 4.4.3",
  "",
  "packages:",
  "",
  "  zod@4.4.3:",
  "    resolution: {integrity: sha512-ytENFjIJFl2UwYglde2jchW2Hwm4GJFLDiSXWdTrJQBIN9Fcyp7n4DhxJEiWNAJMV1/BqWfW/kkg71UDcHJyTQ==}",
  "",
  "snapshots:",
  "",
  "  zod@4.4.3: {}",
  "",
].join("\n");

let stagedResources = "";
let stagedResourcesParent = "";

async function writeFixtureProject(snapshotRoot: string): Promise<void> {
  await Promise.all([
    writeFile(join(snapshotRoot, "package.json"), FIXTURE_PACKAGE_JSON),
    writeFile(join(snapshotRoot, "pnpm-lock.yaml"), FIXTURE_LOCKFILE),
  ]);
}

beforeAll(async () => {
  if (!realInstallAvailable) return;
  stagedResourcesParent = await mkdtemp(join(tmpdir(), "dohc-install-tools-"));
  stagedResources = join(stagedResourcesParent, "resources");
  await cp(
    pnpmPackageRoot,
    join(stagedResources, "plugin-tools", "pnpm"),
    { recursive: true },
  );
  const staged = JSON.parse(
    await readFile(join(pnpmPackageRoot, "package.json"), "utf8"),
  ) as { version?: string };
  // The pins these proofs measure are pins on one pnpm release.
  expect(staged.version).toBe(PINNED_PLUGIN_PNPM_VERSION);
  expect(existsSync(resolvePluginPnpmEntry(stagedResources))).toBe(true);
}, 120_000);

afterAll(async () => {
  if (!stagedResourcesParent) return;
  await rm(stagedResourcesParent, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

it.skipIf(!realInstallAvailable)(
  "runs actual staged pnpm and ignores a plugin-authored .npmrc registry (#779 round 8 D1)",
  async () => {
    const fixture = await createInstallFixture({ pluginId: "npmrc-plugin" });
    await writeFixtureProject(fixture.snapshotRoot);
    // The snapshot now rejects this file outright (#779 round 9 A1), so it
    // can only reach pnpm's cwd if that rejection is ever removed. This is
    // the depth behind it: even then, the pinned registry wins.
    await writeFile(
      join(fixture.snapshotRoot, ".npmrc"),
      "registry=http://127.0.0.1:9/\n",
    );
    const pnpmRoot = join(fixture.root, "pnpm");

    const installed = await installPluginDependencies({
      ...fixture.input,
      resourcesBasePath: stagedResources,
      pnpmPaths: {
        storeDir: join(pnpmRoot, "store"),
        cacheDir: join(pnpmRoot, "cache"),
        stateDir: join(pnpmRoot, "state"),
        homeDir: join(pnpmRoot, "home"),
      },
      forkProcess: nodeForkProcess,
    });

    // Resolved and fetched from the pinned registry: the unroutable one the
    // plugin asked for would have failed the install outright.
    expect(installed).toMatchObject({ ok: true, exitCode: 0 });
    expect(existsSync(join(fixture.snapshotRoot, "node_modules", ".modules.yaml")))
      .toBe(true);
  },
  180_000,
);

it.skipIf(!realInstallAvailable)(
  "runs actual staged pnpm and keeps the tree inside the snapshot despite plugin-authored path settings (#779 round 8 D1)",
  async () => {
    const fixture = await createInstallFixture({ pluginId: "path-settings-plugin" });
    const outside = join(fixture.root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFixtureProject(fixture.snapshotRoot);
    const pnpmRoot = join(fixture.root, "pnpm");
    const input: InstallPluginDependenciesInput = {
      ...fixture.input,
      resourcesBasePath: stagedResources,
      pnpmPaths: {
        storeDir: join(pnpmRoot, "store"),
        cacheDir: join(pnpmRoot, "cache"),
        stateDir: join(pnpmRoot, "state"),
        homeDir: join(pnpmRoot, "home"),
      },
      forkProcess: nodeForkProcess,
    };
    // Both files the plugin author controls, in both path forms. .npmrc is
    // where pnpm 10 read these settings; pnpm-workspace.yaml is where the
    // pinned pnpm 11 reads them.
    const relativeForm = "../outside";
    const absoluteForm = outside.replaceAll("\\", "/");

    for (const form of [relativeForm, absoluteForm]) {
      await rm(join(fixture.snapshotRoot, "node_modules"), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
      await Promise.all([
        writeFile(
          join(fixture.snapshotRoot, ".npmrc"),
          `modules-dir=${form}\nvirtual-store-dir=${form}/.pnpm\n`,
        ),
        writeFile(
          join(fixture.snapshotRoot, "pnpm-workspace.yaml"),
          `modulesDir: ${form}\nvirtualStoreDir: ${form}/.pnpm\n`,
        ),
      ]);

      const installed = await installPluginDependencies(input);

      expect(installed).toMatchObject({ ok: true, exitCode: 0 });
      expect(existsSync(join(fixture.snapshotRoot, "node_modules", ".modules.yaml")))
        .toBe(true);
      // Nothing at all reached the directory the plugin aimed at.
      expect(await readdir(outside)).toEqual([]);
    }
  },
  180_000,
);

it.skipIf(!realInstallAvailable)(
  "runs actual staged pnpm and rejects a mutated stale lockfile",
  async () => {
    const fixture = await createInstallFixture({ pluginId: "integration-plugin" });
    await writeFixtureProject(fixture.snapshotRoot);
    const pnpmRoot = join(fixture.root, "pnpm");
    const input: InstallPluginDependenciesInput = {
      ...fixture.input,
      resourcesBasePath: stagedResources,
      pnpmPaths: {
        storeDir: join(pnpmRoot, "store"),
        cacheDir: join(pnpmRoot, "cache"),
        stateDir: join(pnpmRoot, "state"),
        homeDir: join(pnpmRoot, "home"),
      },
      forkProcess: nodeForkProcess,
    };

    const installed = await installPluginDependencies(input);
    expect(installed).toMatchObject({ ok: true, exitCode: 0 });
    expect(existsSync(join(fixture.snapshotRoot, "node_modules", ".modules.yaml")))
      .toBe(true);

    await writeFile(
      join(fixture.snapshotRoot, "package.json"),
      `${JSON.stringify({
        name: "pr2-lock-small",
        private: true,
        version: "1.0.0",
        dependencies: { zod: "4.4.2" },
      }, null, 2)}\n`,
    );
    const stale = requireFailure(await installPluginDependencies(input));

    expect(stale.error).toMatchObject({
      code: "lockfile-mismatch",
      exitCode: 1,
      timeoutMs: PLUGIN_INSTALL_TIMEOUT_MS,
    });
    expect(stale.error.logs.map((entry) => entry.text).join("\n"))
      .toMatch(/ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile/i);
  },
  60_000,
);
