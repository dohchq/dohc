import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installPluginDependencies,
  PLUGIN_INSTALL_ARGS,
  resolvePluginPnpmEntry,
  type InstallPluginDependenciesInput,
  type PluginInstallFork,
  type PluginInstallForkOptions,
  type PluginInstallProcessHandle,
  type PluginInstallResult,
} from "./pluginInstallRunner";
import { PLUGIN_INSTALL_TIMEOUT_MS } from "./pluginSourceSnapshot";

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
  readonly terminate = vi.fn(() => undefined);
  private readonly exitListeners: Array<(code: number) => void> = [];
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
    pnpmPaths: {
      storeDir: join(workspaceRoot, ".dohc", "pnpm", "store"),
      cacheDir: join(workspaceRoot, ".dohc", "pnpm", "cache"),
      stateDir: join(workspaceRoot, ".dohc", "pnpm", "state"),
      homeDir: join(workspaceRoot, ".dohc", "pnpm", "home"),
    },
  };
  return { root, workspaceRoot, snapshotRoot, resourcesBasePath, input };
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
    stdout: child.stdout,
    stderr: child.stderr,
    onExit: (listener) => {
      child.once("exit", (code) => listener(code ?? 1));
    },
    onError: (listener) => {
      child.once("error", (error) => listener(error.message));
    },
    terminate: () => {
      child.kill();
    },
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
          npm_config_userconfig: join(homeDir, ".npmrc-disabled"),
          npm_config_globalconfig: join(homeDir, ".npmrc-disabled"),
          npm_config_registry: "https://registry.npmjs.org/",
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
    // pnpm/npm's own config-location overrides all point inside the
    // plugin-scoped pnpmPaths.homeDir instead.
    expect(observedEnv?.HOME).toBe(fixture.input.pnpmPaths.homeDir);
    expect(observedEnv?.USERPROFILE).toBe(fixture.input.pnpmPaths.homeDir);
    expect(observedEnv?.npm_config_userconfig).toBe(
      join(fixture.input.pnpmPaths.homeDir, ".npmrc-disabled"),
    );
    expect(observedEnv?.npm_config_registry).toBe("https://registry.npmjs.org/");
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
    await Promise.resolve();

    expect(child.terminate).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    child.exit(143);

    const failure = requireFailure(await install);
    expect(failure.error).toMatchObject({ code: "aborted", exitCode: 143 });
    expect(failure.error.logs.at(-1)?.text).toBe("Install cancelled by the caller.");
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

const stagedResources = resolve(import.meta.dirname, "../../resources");
const stagedPnpmEntry = resolvePluginPnpmEntry(stagedResources);
const measuredFixture = resolve(
  import.meta.dirname,
  "../../../../.agent-artifacts/references/measure-lockfiles/small",
);
const realInstallAvailable =
  existsSync(stagedPnpmEntry) &&
  existsSync(join(measuredFixture, "package.json")) &&
  existsSync(join(measuredFixture, "pnpm-lock.yaml"));

it.skipIf(!realInstallAvailable)(
  "runs actual staged pnpm and rejects a mutated stale lockfile",
  async () => {
    const fixture = await createInstallFixture({ pluginId: "integration-plugin" });
    await Promise.all([
      copyFile(
        join(measuredFixture, "package.json"),
        join(fixture.snapshotRoot, "package.json"),
      ),
      copyFile(
        join(measuredFixture, "pnpm-lock.yaml"),
        join(fixture.snapshotRoot, "pnpm-lock.yaml"),
      ),
    ]);
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
