import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stop } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PluginHost, type PluginHostOptions } from "./PluginHost";
import { discoverInstalledPlugins } from "./pluginDiscovery";
import { PluginPipeline } from "./PluginPipeline";
import {
  installPluginDependencies,
  type PluginInstallForkOptions,
  type PluginInstallProcessHandle,
} from "./pluginInstallRunner";
import { resolvePluginEsbuildBinary } from "./pluginBuildRunner";
import { workspaceStateKey } from "./pluginLocalState";
import { pluginUninstallPreflight } from "./pluginUninstallPreflight";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

const roots: string[] = [];
let resourcesParent: string;
let resourcesBasePath: string;

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  return {
    promise: new Promise<void>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve: () => resolvePromise?.(),
  };
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
    terminate: () => child.kill(),
  };
}

async function stagePluginTools(): Promise<void> {
  resourcesParent = await mkdtemp(join(tmpdir(), "dohc-pipeline-tools-"));
  resourcesBasePath = join(resourcesParent, "resources");
  const requireFromTest = createRequire(import.meta.url);

  const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
  await cp(
    join(desktopRoot, "node_modules", "pnpm"),
    join(resourcesBasePath, "plugin-tools", "pnpm"),
    { recursive: true },
  );

  const platformKey = `${process.platform}-${process.arch}`;
  const esbuildPackageJson = requireFromTest.resolve("esbuild/package.json");
  const requireFromEsbuild = createRequire(esbuildPackageJson);
  const platformPackageJson = requireFromEsbuild.resolve(
    `@esbuild/${platformKey}/package.json`,
  );
  const sourceBinary = process.platform === "win32"
    ? join(dirname(platformPackageJson), "esbuild.exe")
    : join(dirname(platformPackageJson), "bin", "esbuild");
  const destinationBinary = resolvePluginEsbuildBinary(resourcesBasePath);
  await mkdir(dirname(destinationBinary), { recursive: true });
  await copyFile(sourceBinary, destinationBinary);
  if (process.platform !== "win32") await chmod(destinationBinary, 0o755);
}

async function createPluginWorkspace(): Promise<{
  root: string;
  workspaceRoot: string;
  pluginRoot: string;
  entryPath: string;
  stateDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "dohc-plugin-pipeline-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const pluginRoot = join(workspaceRoot, "plugins", "example-plugin");
  const entryPath = join(pluginRoot, "src", "index.ts");
  const stateDir = join(root, "state");
  await Promise.all([
    mkdir(dirname(entryPath), { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(pluginRoot, "dohc-plugin.json"), `${JSON.stringify({
      version: 1,
      name: "example-plugin",
      displayName: "Example plugin",
      entry: "src/index.ts",
    }, null, 2)}\n`),
    writeFile(join(pluginRoot, "package.json"), `${JSON.stringify({
      name: "example-plugin",
      version: "1.0.0",
      private: true,
      type: "module",
      packageManager: "pnpm@11.20.0",
    }, null, 2)}\n`),
    writeFile(join(pluginRoot, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "importers:",
      "  .: {}",
      "",
    ].join("\n")),
    writeFile(entryPath, [
      'export const marker = "one";',
      "export default { activate() {} };",
      "",
    ].join("\n")),
  ]);
  return { root, workspaceRoot, pluginRoot, entryPath, stateDir };
}

async function createNamedPluginWorkspace(directoryName: string, pluginId: string): Promise<{
  root: string;
  workspaceRoot: string;
  pluginRoot: string;
  entryPath: string;
  stateDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "dohc-plugin-pipeline-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const pluginRoot = join(workspaceRoot, "plugins", directoryName);
  const entryPath = join(pluginRoot, "src", "index.ts");
  const stateDir = join(root, "state");
  await Promise.all([
    mkdir(dirname(entryPath), { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(pluginRoot, "dohc-plugin.json"), `${JSON.stringify({
      version: 1,
      name: pluginId,
      displayName: pluginId,
      entry: "src/index.ts",
    }, null, 2)}\n`),
    writeFile(join(pluginRoot, "package.json"), `${JSON.stringify({
      name: pluginId,
      version: "1.0.0",
      private: true,
      type: "module",
      packageManager: "pnpm@11.20.0",
    }, null, 2)}\n`),
    writeFile(join(pluginRoot, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "importers:",
      "  .: {}",
      "",
    ].join("\n")),
    writeFile(entryPath, [
      'export const marker = "one";',
      "export default { activate() {} };",
      "",
    ].join("\n")),
  ]);
  return { root, workspaceRoot, pluginRoot, entryPath, stateDir };
}

// Matches PluginPipeline's own dohcDir computation exactly: derived plugin
// artifacts live under <stateDir>/plugin-data/<workspaceStateKey>, never
// inside the workspace folder (CERT779).
function liveBundlePath(
  fixture: { stateDir: string; workspaceRoot: string },
  pluginId: string,
): string {
  return join(
    fixture.stateDir,
    "plugin-data",
    workspaceStateKey(fixture.workspaceRoot),
    "plugins",
    pluginId,
    "bundle.mjs",
  );
}

async function waitFor(
  condition: () => boolean,
  message: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function fakeSpawnTransport(): PluginHostOptions["spawnTransport"] {
  return vi.fn<PluginHostOptions["spawnTransport"]>(() => ({
    request: async <T = unknown>(method: string): Promise<T> => (
      method === "plugin.activate" ? { commands: [] } : {}
    ) as T,
    notify: () => undefined,
    dispose: async () => undefined,
  }));
}

beforeAll(stagePluginTools);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

afterAll(async () => {
  // R7 fix: real builds above spawn esbuild's shared service process from
  // the staged binary under resourcesParent, which holds the executable
  // open until stopped — that blocks deleting it on Windows.
  await stop();
  await rm(resourcesParent, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

describe("PluginPipeline real filesystem lifecycle", () => {
  it("installs, hot reloads with one coalesced follow-up, disables, enables, approves, and uninstalls", async () => {
    const fixture = await createPluginWorkspace();
    const installGate = deferred();
    let installCalls = 0;
    let pipeline: PluginPipeline;
    const spawnTransport = fakeSpawnTransport();
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport,
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      pluginHost: host,
      resourcesBasePath,
      operations: {
        install: async (input) => {
          installCalls += 1;
          if (installCalls === 2) await installGate.promise;
          return installPluginDependencies({
            ...input,
            forkProcess: nodeForkProcess,
          });
        },
      },
    });

    try {
      await pipeline.start();
      expect(pipeline.list()[0]?.status).toBe("discovered");
      // A5: a door-written write's absolute path must resolve to the plugin
      // that owns it, so main.ts can route it into
      // handleDoorWrittenSourceChange instead of only the watcher path.
      expect(pipeline.pluginIdForPath(fixture.entryPath)).toBe("example-plugin");
      expect(pipeline.pluginIdForPath(fixture.pluginRoot)).toBe("example-plugin");
      expect(pipeline.pluginIdForPath(join(fixture.workspaceRoot, "notes.md")))
        .toBeNull();

      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const firstHash = pipeline.list()[0]?.approvedHash;
      expect(firstHash).toMatch(/^[0-9a-f]{64}$/);
      expect(await readFile(
        liveBundlePath(fixture, "example-plugin"),
        "utf8",
      )).toContain("one");

      await writeFile(fixture.entryPath, [
        'export const marker = "two";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      pipeline.handleDoorWrittenSourceChange("example-plugin");
      await waitFor(() => installCalls === 2, "Hot reload did not reach install.");

      await writeFile(fixture.entryPath, [
        'export const marker = "three";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      pipeline.handleDoorWrittenSourceChange("example-plugin");
      pipeline.handleDoorWrittenSourceChange("example-plugin");
      pipeline.handleDoorWrittenSourceChange("example-plugin");
      installGate.resolve();

      await waitFor(
        () => installCalls === 3 && pipeline.list()[0]?.status === "ready",
        "The coalesced hot-reload follow-up did not finish.",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(installCalls).toBe(3);
      expect(pipeline.list()[0]?.approvedHash).not.toBe(firstHash);
      expect(await readFile(
        liveBundlePath(fixture, "example-plugin"),
        "utf8",
      )).toContain("three");

      expect((await pipeline.disable("example-plugin")).ok).toBe(true);
      expect(pipeline.list()[0]?.status).toBe("disabled");
      expect((await pipeline.enable("example-plugin")).ok).toBe(true);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after enable.",
      );

      await writeFile(fixture.entryPath, [
        'export const marker = "four";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/index.ts",
        operation: "update",
      }]);
      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        "Watcher edit did not enter disabled-pending-approval.",
      );
      expect((await pipeline.approve("example-plugin")).ok).toBe(true);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after approval.",
      );

      // CERT779 A4 PoC: renaming an approved plugin's manifest identity must
      // not carry its approval forward. "renamed-plugin" is an identity this
      // pipeline has never approved, even though "example-plugin" at the
      // same root was fully approved and running a moment ago.
      await writeFile(join(fixture.pluginRoot, "dohc-plugin.json"), `${JSON.stringify({
        version: 1,
        name: "renamed-plugin",
        displayName: "Renamed plugin",
        entry: "src/index.ts",
      }, null, 2)}\n`);
      pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/dohc-plugin.json",
        operation: "update",
      }]);
      await waitFor(
        () => pipeline.list().some((plugin) =>
          plugin.id === "renamed-plugin" && plugin.status === "discovered"
        ),
        "Manifest identity change did not land as an unapproved discovery.",
      );
      expect(pipeline.list().some((plugin) => plugin.id === "example-plugin")).toBe(false);
      expect(
        pipeline.list().find((plugin) => plugin.id === "renamed-plugin")?.approvedHash,
      ).toBeNull();
      await expect(lstat(join(
        fixture.stateDir,
        "plugin-data",
        workspaceStateKey(fixture.workspaceRoot),
        "plugins",
        "example-plugin",
      ))).rejects.toMatchObject({ code: "ENOENT" });

      const renamedInstall = await pipeline.install("renamed-plugin");
      if (!renamedInstall.ok) {
        throw new Error(
          `${renamedInstall.error.stage}/${renamedInstall.error.code}: ${renamedInstall.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list().some((plugin) =>
          plugin.id === "renamed-plugin" && plugin.status === "ready"
        ),
        "Renamed identity did not reach ready after its own fresh install.",
      );

      const preflight = await pipeline.uninstallPreflight("renamed-plugin");
      if (!preflight.ok) throw new Error(preflight.error.message);
      expect(preflight.preflight.warning).toBeNull();
      const uninstalled = await pipeline.uninstall(
        "renamed-plugin",
        preflight.confirmationToken,
      );
      expect(uninstalled.ok).toBe(true);
      await expect(lstat(fixture.pluginRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(pipeline.list()).toEqual([]);
      expect(spawnTransport).toHaveBeenCalledTimes(6);
    } finally {
      installGate.resolve();
      await pipeline.dispose();
    }
  }, 120_000);

  it("refuses to start a bundle tampered after the build, even though its source hash is unchanged (CERT779 PoC)", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    const spawnTransport = fakeSpawnTransport();
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport,
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      pluginHost: host,
      resourcesBasePath,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const approvedHashBeforeTamper = pipeline.list()[0]?.approvedHash;

      // The exact CERT779 attack: tamper bundle.mjs directly on disk. The
      // plugin's source under plugins/ is never touched, so its hash — and
      // therefore approvedHash — does not change either.
      const bundlePath = liveBundlePath(fixture, "example-plugin");
      const builtBundle = await readFile(bundlePath, "utf8");
      expect(builtBundle).toContain("one");
      await writeFile(bundlePath, builtBundle.replaceAll("one", "TAMPERED-PAYLOAD"));

      // Stop the running (legitimate) instance and ask the pipeline to start
      // it again — ensureStarted()'s fast path, the exact call #777's panel
      // surface makes every time a panel opens, and the path this pipeline
      // takes on every app restart for an already-approved plugin whose host
      // isn't running yet.
      await host.stop("example-plugin");
      const result = await pipeline.ensureStarted("example-plugin");

      expect(result.ok).toBe(true);
      // Source was still approved, so the pipeline self-heals with a fresh,
      // trustworthy rebuild rather than refusing outright — but it must
      // never start, or leave live, the tampered bytes.
      const liveBundleAfter = await readFile(bundlePath, "utf8");
      expect(liveBundleAfter).not.toContain("TAMPERED-PAYLOAD");
      expect(liveBundleAfter).toContain("one");
      expect(pipeline.list()[0]?.approvedHash).toBe(approvedHashBeforeTamper);
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("preserves a valid plugin's own validity in a failure recorded after its discovery entry disappeared (CodeRabbit #779 R23)", async () => {
    const fixture = await createPluginWorkspace();
    const installGate = deferred();
    let pipeline: PluginPipeline;
    let discoverCalls = 0;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      pluginHost: host,
      resourcesBasePath,
      operations: {
        // Real discovery once (to seed a real, valid status), then empty —
        // simulating the plugin's directory disappearing while its own
        // install is still in flight below.
        discover: async (workspaceRoot) => {
          discoverCalls += 1;
          return discoverCalls === 1
            ? await discoverInstalledPlugins(workspaceRoot)
            : [];
        },
        install: async () => {
          await installGate.promise;
          throw new Error("synthetic install failure (R23 PoC)");
        },
      },
    });

    try {
      await pipeline.start();
      expect(pipeline.list()[0]).toMatchObject({ id: "example-plugin", valid: true });

      const installPromise = pipeline.install("example-plugin");
      // The watcher observes the plugin's directory vanishing WHILE the
      // install above is still in flight — discovery.find(id) inside
      // failure() (below) will miss by the time the install rejects.
      pipeline.handleWatcherEvents([
        { path: "plugins/example-plugin", operation: "delete" },
      ]);
      await waitFor(() => discoverCalls >= 2, "Watcher-driven rediscovery did not run.");
      installGate.resolve();

      const result = await installPromise;
      expect(result.ok).toBe(false);
      expect(result.plugin).toMatchObject({ id: "example-plugin", valid: true });
    } finally {
      installGate.resolve();
      await pipeline.dispose();
    }
  });

  it("restores the running status after a watcher reconcile that finds no real change (fixround Section B item 12)", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      pluginHost: host,
      resourcesBasePath,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      // Rewriting the exact same bytes touches mtime but never the source
      // hash — a real no-op from the pipeline's own point of view, exactly
      // what a watcher can observe from an editor's save-with-no-changes
      // or a sync tool settling.
      const originalSource = await readFile(fixture.entryPath, "utf8");
      await writeFile(fixture.entryPath, originalSource);
      pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/index.ts",
        operation: "update",
      }]);

      // The reconcile briefly visits "snapshotting" — wait past that window,
      // then assert it settled back to "ready" rather than staying stuck.
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        `No-op reconcile left status at "${pipeline.list()[0]?.status}" instead of restoring "ready".`,
      );
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("keeps an explicitly disabled plugin disabled after approving an out-of-band change (#779 round 3 finding 5)", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      pluginHost: host,
      resourcesBasePath,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      // The user explicitly disables it — their own, standalone choice.
      expect((await pipeline.disable("example-plugin")).ok).toBe(true);
      expect(pipeline.list()[0]).toMatchObject({ status: "disabled", disabledReason: "user" });

      // An out-of-band (watcher-observed) source change arrives while it
      // sits disabled — unrelated to the user's disable decision.
      await writeFile(fixture.entryPath, [
        'export const marker = "out-of-band";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/index.ts",
        operation: "update",
      }]);
      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        "Watcher edit on a disabled plugin did not enter disabled-pending-approval.",
      );

      const approved = await pipeline.approve("example-plugin");
      expect(approved.ok).toBe(true);
      // The new content is now trusted (a future enable() will work cleanly
      // from it), but the user's own explicit disable must still hold.
      expect(pipeline.list()[0]).toMatchObject({
        status: "disabled",
        disabledReason: "user",
        runtimeStatus: null,
      });
      expect(host.getStatus("example-plugin")).toBeUndefined();
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("never runs a plugin-authored .pnpmfile.cjs hook during install (#779 round 3 finding 6)", async () => {
    const fixture = await createPluginWorkspace();
    const canaryPath = join(
      fixture.stateDir,
      "plugin-data",
      workspaceStateKey(fixture.workspaceRoot),
      "plugins",
      "example-plugin",
      "snapshot",
      "PNPMFILE_CANARY.txt",
    );
    // --ignore-scripts alone does not stop this: .pnpmfile.cjs hooks
    // (readPackage/afterAllResolved) are a separate pnpm mechanism that runs
    // arbitrary Node code during dependency resolution.
    await writeFile(
      join(fixture.pluginRoot, ".pnpmfile.cjs"),
      [
        'const fs = require("fs");',
        'const path = require("path");',
        "module.exports = {",
        "  hooks: {",
        "    readPackage(pkg) {",
        '      fs.writeFileSync(path.join(__dirname, "PNPMFILE_CANARY.txt"), "ran\\n");',
        "      return pkg;",
        "    },",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      pluginHost: host,
      resourcesBasePath,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");

      // Whichever way the install resolves — a plugin-authored .pnpmfile.cjs
      // becoming active is itself a red flag, whether pnpm ran the hook and
      // succeeded or the now-active pnpmfile disrupted --frozen-lockfile —
      // the canary must never exist either way.
      await expect(lstat(canaryPath)).rejects.toMatchObject({ code: "ENOENT" });
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("refuses to delete when source changed after the last check, immediately before the delete (#779 round 3 finding 3)", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    // Real pluginUninstallPreflight, with liveHash forced to change starting
    // on its 3rd call — the one this fix adds, running right before the
    // actual delete, after pluginHost.stop()'s own real await window. Calls
    // 1 and 2 (the uninstallPreflight() action, then uninstall()'s existing
    // pre-stop check) see the real, unchanged hash, so the confirmation
    // token itself is genuinely valid at issuance.
    let preflightCalls = 0;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      pluginHost: host,
      resourcesBasePath,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        uninstallPreflight: async (input) => {
          preflightCalls += 1;
          const real = await pluginUninstallPreflight(input);
          if (preflightCalls <= 2) return real;
          return { ...real, liveHash: "f".repeat(64) };
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      const preflight = await pipeline.uninstallPreflight("example-plugin");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const result = await pipeline.uninstall(
        "example-plugin",
        preflight.confirmationToken,
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toMatchObject({
        stage: "uninstall",
        code: "confirmation-stale",
      });
      // Refused, not deleted.
      await expect(lstat(fixture.pluginRoot)).resolves.toBeDefined();
      expect(preflightCalls).toBe(3);
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("never lets a same-batch identity vacate and get reclaimed carry its approval across (#779 round 3 finding 2)", async () => {
    // Two identities change in the SAME watcher batch: "temp"@aaa-renamed
    // (sorts first, lexically, so it's processed first) renames to "bar",
    // landing on the exact id "bar"@zzz-original is simultaneously
    // vacating. Processing "temp"'s replacement (the new "bar") before
    // "bar"@zzz-original's own departure is fully applied would let the
    // replacement read the departing identity's still-present, about-to-
    // be-deleted approvedHash under the very id it's claiming.
    const fixture = await createNamedPluginWorkspace("zzz-original", "bar");
    const renamedRoot = join(fixture.workspaceRoot, "plugins", "aaa-renamed");
    await mkdir(join(renamedRoot, "src"), { recursive: true });
    await writeFile(join(renamedRoot, "dohc-plugin.json"), `${JSON.stringify({
      version: 1, name: "temp", displayName: "temp", entry: "src/index.ts",
    }, null, 2)}\n`);
    await writeFile(join(renamedRoot, "package.json"), `${JSON.stringify({
      name: "temp", version: "1.0.0", private: true, type: "module",
      packageManager: "pnpm@11.20.0",
    }, null, 2)}\n`);
    await writeFile(join(renamedRoot, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "importers:",
      "  .: {}",
      "",
    ].join("\n"));
    await writeFile(join(renamedRoot, "src", "index.ts"), [
      'export const marker = "one";',
      "export default { activate() {} };",
      "",
    ].join("\n"));

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      pluginHost: host,
      resourcesBasePath,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      // Approve "bar" for real, at its original root.
      const installed = await pipeline.install("bar");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list().find((p) => p.id === "bar")?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      // Stop the live host directly (not disable(), which would also flip
      // the persisted approval's disabled bit) — approved but not currently
      // running, so a hash-match at reconcile time falls through to
      // runFullBuild's real "start it" branch instead of the unrelated
      // already-running no-op shortcut.
      await pipeline.host.stop("bar");
      // Discover "temp" too, so it's a tracked candidate before the batch.
      pipeline.handleWatcherEvents([{ path: "plugins/aaa-renamed", operation: "create" }]);
      await waitFor(
        () => pipeline.list().some((p) => p.id === "temp"),
        "temp was never discovered.",
      );

      // Now, in one batch: "aaa-renamed" renames from "temp" to "bar" with
      // content byte-identical to what "bar" already had approved, while
      // the ORIGINAL "bar"@zzz-original is deleted outright.
      await writeFile(join(renamedRoot, "dohc-plugin.json"), `${JSON.stringify({
        version: 1, name: "bar", displayName: "bar", entry: "src/index.ts",
      }, null, 2)}\n`);
      await writeFile(join(renamedRoot, "package.json"), `${JSON.stringify({
        name: "bar", version: "1.0.0", private: true, type: "module",
        packageManager: "pnpm@11.20.0",
      }, null, 2)}\n`);
      await rm(fixture.pluginRoot, { recursive: true, force: true });
      pipeline.handleWatcherEvents([
        { path: "plugins/aaa-renamed", operation: "update" },
        { path: "plugins/zzz-original", operation: "delete" },
      ]);

      await waitFor(
        () => pipeline.list().some((p) => p.id === "bar" && p.rootPath === renamedRoot),
        "The renamed identity was never rediscovered at its new root.",
      );
      // Give any (buggy) auto-approval a real chance to happen before
      // asserting it didn't.
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      const moved = pipeline.list().find((p) => p.id === "bar" && p.rootPath === renamedRoot);
      expect(moved).toMatchObject({ status: "discovered", approvedHash: null });
      expect(host.getStatus("bar")).toBeUndefined();
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("holds for approval instead of auto-approving a disk-only change that lands while a door write's own refresh is queued (#779 round 3 finding 1)", async () => {
    const fixture = await createPluginWorkspace();
    const installGate = deferred();
    let installCalls = 0;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      pluginHost: host,
      resourcesBasePath,
      operations: {
        install: async (input) => {
          installCalls += 1;
          // The 2nd overall install call is approve()'s — it occupies this
          // plugin's job queue so the door-write refresh queued below has
          // to wait behind it, giving the disk-only mutation a real window.
          if (installCalls === 2) await installGate.promise;
          return installPluginDependencies({ ...input, forkProcess: nodeForkProcess });
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      // approve() runs unconditionally and blocks on the gated 2nd install
      // call, occupying the queue — standing in for "some other job is
      // already running when the door write arrives" (installCalls === 2
      // is deliberately generic: any job ahead in the queue creates the
      // same delay).
      const approvePromise = pipeline.approve("example-plugin");
      await waitFor(() => installCalls === 2, "approve() never reached the gated install.");

      // The door write itself: authored content lands on disk, then the
      // owning plugin is told about it immediately, exactly like
      // main.ts's writeAuthoredText -> handleDoorWrittenSourceChange call.
      await writeFile(fixture.entryPath, [
        'export const marker = "door-written";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      pipeline.handleDoorWrittenSourceChange("example-plugin");
      // Let the door-write hash capture actually read the file before the
      // interloper below overwrites it — the capture itself is a real,
      // unsynchronized filesystem read, not a snapshot; the property this
      // fix defends is that it happens well before the queued refresh gets
      // its turn (job Z is still blocked on the install gate), which a
      // short pause here reflects without racing the capture itself.
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      // Before that refresh gets a turn (it is still queued behind
      // approve()'s blocked install), an unrelated, non-door-authored actor
      // mutates the same file on disk.
      await writeFile(fixture.entryPath, [
        'export const marker = "disk-only-interloper";',
        "export default { activate() {} };",
        "",
      ].join("\n"));

      installGate.resolve();
      const approved = await approvePromise;
      expect(approved.ok).toBe(true);

      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        `The disk-only change was not held for approval; status is `
          + `"${pipeline.list()[0]?.status}".`,
      );
      expect(pipeline.list()[0]).toMatchObject({
        status: "disabled-pending-approval",
        disabledReason: "approval",
      });
      // The interloper's content never ran.
      expect(await readFile(
        liveBundlePath(fixture, "example-plugin"),
        "utf8",
      )).not.toContain("disk-only-interloper");
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("leaves a failed uninstall in an actionable, retryable state instead of a stuck spinner (#779 round 4 finding 2)", async () => {
    const fixture = await createPluginWorkspace();
    let removeCalls = 0;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      pluginHost: host,
      resourcesBasePath,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        removePath: async (path, options) => {
          removeCalls += 1;
          // The very first delete attempt fails (a locked file, a permission
          // error) — everything after must still be recoverable.
          if (removeCalls === 1) {
            throw new Error("simulated: target is busy");
          }
          return rm(path, options);
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      const preflight = await pipeline.uninstallPreflight("example-plugin");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const failed = await pipeline.uninstall(
        "example-plugin",
        preflight.confirmationToken,
      );

      expect(failed.ok).toBe(false);
      if (failed.ok) throw new Error("unreachable");
      expect(failed.error).toMatchObject({ stage: "uninstall", code: "delete-failed" });
      // Actionable, not a stuck "uninstalling" spinner — and no orphan: the
      // source directory is still exactly where it was.
      expect(pipeline.list()[0]).toMatchObject({
        status: "disabled-pending-repair",
        disabledReason: "repair",
      });
      expect(pipeline.list()[0]?.error).not.toBeNull();
      await expect(lstat(fixture.pluginRoot)).resolves.toBeDefined();

      // The record survived, so a fresh preflight + retry succeeds once the
      // underlying problem (here, the mocked one-shot failure) is gone.
      const retryPreflight = await pipeline.uninstallPreflight("example-plugin");
      if (!retryPreflight.ok) throw new Error(retryPreflight.error.message);
      const retried = await pipeline.uninstall(
        "example-plugin",
        retryPreflight.confirmationToken,
      );
      expect(retried.ok).toBe(true);
      await expect(lstat(fixture.pluginRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("builds from the manifest in the snapshot, not the stale copy discovery cached (#779 round 4 finding 5)", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      pluginHost: host,
      resourcesBasePath,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      // A second entry file, and dohc-plugin.json repointed at it directly
      // on disk — with no watcher event fired for either, so discovery's
      // in-memory candidate.manifest is never refreshed and stays pinned to
      // the original "src/index.ts" entry.
      await writeFile(join(fixture.pluginRoot, "src", "v2-entry.ts"), [
        'export const marker = "v2-entry";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await writeFile(join(fixture.pluginRoot, "dohc-plugin.json"), `${JSON.stringify({
        version: 1,
        name: "example-plugin",
        displayName: "Example plugin",
        entry: "src/v2-entry.ts",
      }, null, 2)}\n`);

      // approve() rebuilds unconditionally without any prior discovery
      // rescan, so this exercises the stale in-memory manifest directly.
      const approved = await pipeline.approve("example-plugin");
      expect(approved.ok).toBe(true);

      const bundle = await readFile(liveBundlePath(fixture, "example-plugin"), "utf8");
      // The snapshot taken for this very build already contains
      // dohc-plugin.json's real, current entry ("src/v2-entry.ts") — the
      // build must read that, not discovery's stale cached manifest, which
      // still says "src/index.ts" (whose content has no "v2-entry" marker
      // at all).
      expect(bundle).toContain("v2-entry");
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);
});
