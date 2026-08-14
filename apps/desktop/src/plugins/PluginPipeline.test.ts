import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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
import { buildPluginBundle, resolvePluginEsbuildBinary } from "./pluginBuildRunner";
import {
  mutatePluginRecord,
  readPluginLocalState,
  workspaceStateKey,
} from "./pluginLocalState";
import { snapshotPluginSource } from "./pluginSourceSnapshot";
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
function pluginsDataRoot(
  fixture: { stateDir: string; workspaceRoot: string },
): string {
  return join(
    fixture.stateDir,
    "plugin-data",
    workspaceStateKey(fixture.workspaceRoot),
    "plugins",
  );
}

function liveBundlePath(
  fixture: { stateDir: string; workspaceRoot: string },
  pluginId: string,
): string {
  return join(pluginsDataRoot(fixture), pluginId, "bundle.mjs");
}

/** The published source tree — what a panel serves and a brokered child runs. */
function liveSnapshotRoot(
  fixture: { stateDir: string; workspaceRoot: string },
  pluginId: string,
): string {
  return join(pluginsDataRoot(fixture), pluginId, "snapshot");
}

async function expectNoLiveSnapshot(
  fixture: { stateDir: string; workspaceRoot: string },
  pluginId: string,
): Promise<void> {
  await expect(lstat(liveSnapshotRoot(fixture, pluginId)))
    .rejects.toMatchObject({ code: "ENOENT" });
}

/** Staged source trees are siblings of the live root, so this finds any left. */
async function stagingLeftovers(
  fixture: { stateDir: string; workspaceRoot: string },
  pluginId: string,
): Promise<string[]> {
  const names = await readdir(pluginsDataRoot(fixture)).catch(() => [] as string[]);
  return names.filter((name) => name.startsWith(`${pluginId}.snap-staging-`));
}

/** Every file under `root`, by relative path, with its sha256 — the evidence
 * that a failed build left the live root byte-identical. */
async function fileHashes(
  root: string,
  base = root,
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      Object.assign(hashes, await fileHashes(path, base));
      continue;
    }
    hashes[relative(base, path).replaceAll("\\", "/")] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }
  return hashes;
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

  it("leaves no staging residue and the live root byte-identical when the new build's approval cannot be persisted (#779 round 6 F5, round 7 A2)", async () => {
    const fixture = await createPluginWorkspace();
    let failRecordWrite = false;
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
        mutateRecord: async (stateDir, workspaceRoot, pluginId, mutate) => {
          if (failRecordWrite) throw new Error("approval record write failed");
          return mutatePluginRecord(stateDir, workspaceRoot, pluginId, mutate);
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      expect(installed.ok).toBe(true);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const bundlePath = liveBundlePath(fixture, "example-plugin");
      expect(await readFile(bundlePath, "utf8")).toContain("one");
      const approvedHashBefore = pipeline.list()[0]?.approvedHash;
      const dataRoot = pluginsDataRoot(fixture);
      const liveRoot = join(dataRoot, "example-plugin");
      // The installed snapshot is the working copy the next install and build
      // run in, and snapshotPluginSource refreshes it before either — so it
      // is the published build output, not the whole live root, that a failed
      // attempt has to leave untouched.
      const publishedOutputs = (hashes: Record<string, string>) =>
        Object.fromEntries(
          Object.entries(hashes).filter(([path]) => !path.startsWith("snapshot/")),
        );
      const liveBefore = publishedOutputs(await fileHashes(liveRoot));
      expect(Object.keys(liveBefore).sort()).toEqual([
        "baseline-manifest.json",
        "bundle.mjs",
        "bundle.mjs.map",
        "dohc-plugin.generated.json",
        "meta.json",
      ]);

      await writeFile(fixture.entryPath, [
        'export const marker = "two";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      failRecordWrite = true;
      const rebuilt = await pipeline.install("example-plugin");

      expect(rebuilt.ok).toBe(false);
      // The new bundle was built but never published, so the bytes on disk
      // are still the ones whose approval is durably recorded.
      const liveBundle = await readFile(bundlePath, "utf8");
      expect(liveBundle).toContain("one");
      expect(liveBundle).not.toContain("two");
      expect(pipeline.list()[0]?.approvedHash).toBe(approvedHashBefore);
      // The failure path's discard() ran: nothing staged or set aside
      // survives beside the live root, and the live root itself is exactly
      // the tree the approved build left (#779 round 7 A2).
      expect(await readdir(dataRoot)).toEqual(["example-plugin"]);
      const liveAfter = await fileHashes(liveRoot);
      expect(publishedOutputs(liveAfter)).toEqual(liveBefore);
      expect(Object.keys(liveAfter)).toEqual(
        expect.arrayContaining(["snapshot/src/index.ts"]),
      );
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
        discover: async (workspaceRoot, installedDirectoryNames) => {
          discoverCalls += 1;
          return discoverCalls === 1
            ? await discoverInstalledPlugins(workspaceRoot, installedDirectoryNames)
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

      // The hook never gets the chance to run: the snapshot refuses to stage
      // package-manager configuration at all, so pnpm's cwd never contains a
      // .pnpmfile.cjs (CERT779H). --ignore-pnpmfile stays as depth behind it.
      await expect(lstat(canaryPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(installed).toMatchObject({
        ok: false,
        error: { stage: "snapshot", code: "unsupported-package-manager-config" },
      });
      await expectNoLiveSnapshot(fixture, "example-plugin");
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
      // And not a stuck "uninstalling" spinner: the status set on the way in
      // is restored to an actionable one the user can retry from (#779 round
      // 7 B6).
      expect(pipeline.list()[0]).toMatchObject({
        status: "disabled",
        disabledReason: "user",
        runtimeStatus: null,
      });
      expect(pipeline.list()[0]?.error).toMatchObject({
        code: "confirmation-stale",
      });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("refuses to delete when the source could not be fingerprinted (#779 round 11 A2)", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    // Preflight cannot hash the tree (a symlink or an unreadable entry), so
    // every call records liveHash: null. Comparing null against null says
    // "unchanged" while proving nothing — and the delete is irreversible.
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
        uninstallPreflight: async (input) => ({
          ...await pluginUninstallPreflight(input),
          liveHash: null,
        }),
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
      expect(result.error.message).toContain(
        "could not be read to confirm what uninstall would delete",
      );
      await expect(lstat(fixture.pluginRoot)).resolves.toBeDefined();
      await expect(lstat(join(fixture.pluginRoot, "dohc-plugin.json")))
        .resolves.toBeDefined();
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

  it("uninstall removes a build left staged beside the live root (#779 round 7 A1)", async () => {
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

      // What a build killed between its own renames leaves behind. It holds
      // built plugin bytes, and it is outside the live root, so uninstall's
      // recursive delete of the live root alone would walk straight past it.
      const dataRoot = pluginsDataRoot(fixture);
      const orphanedStaging = join(
        dataRoot,
        `example-plugin.staging-${randomUUID()}`,
      );
      await mkdir(orphanedStaging, { recursive: true });
      await writeFile(join(orphanedStaging, "bundle.mjs"), "orphaned bytes\n");
      // npm names allow dots, so this is another installed plugin's own live
      // root — not an artifact of this one, and never uninstall's to delete
      // (#779 round 10 B1).
      const neighbourRoot = join(dataRoot, "example-plugin.bar");
      await mkdir(join(neighbourRoot, "snapshot"), { recursive: true });
      await writeFile(join(neighbourRoot, "bundle.mjs"), "neighbour bytes\n");

      const preflight = await pipeline.uninstallPreflight("example-plugin");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const uninstalled = await pipeline.uninstall(
        "example-plugin",
        preflight.confirmationToken,
      );

      expect(uninstalled.ok).toBe(true);
      expect(await readdir(dataRoot)).toEqual(["example-plugin.bar"]);
      expect(await readFile(join(neighbourRoot, "bundle.mjs"), "utf8"))
        .toBe("neighbour bytes\n");
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("keeps uninstall available for an installed plugin whose manifest later broke (#779 round 8 D2)", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    const newHost = () => {
      const created = new PluginHost({
        stateDir: fixture.stateDir,
        workspaceRoot: fixture.workspaceRoot,
        spawnTransport: fakeSpawnTransport(),
        routeSdkRequest: async () => ({}),
        onStatusChange: (pluginId, status) => {
          pipeline.noteRuntimeStatus(pluginId, status);
        },
      });
      return created;
    };
    const newPipeline = (host: PluginHost) =>
      new PluginPipeline({
        workspaceRoot: fixture.workspaceRoot,
        stateDir: fixture.stateDir,
        pluginHost: host,
        resourcesBasePath,
        operations: {
          install: (input) =>
            installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        },
      });

    pipeline = newPipeline(newHost());
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
    } finally {
      await pipeline.dispose();
    }

    // The manifest breaks while dohc is not running, so no watcher event ever
    // observes the transition — the next launch simply discovers an invalid
    // candidate whose installed artifacts are all still on disk.
    await writeFile(
      join(fixture.pluginRoot, "dohc-plugin.json"),
      "{ this is not valid JSON\n",
    );

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      const row = pipeline.list()[0];
      expect(row).toMatchObject({
        id: "example-plugin",
        valid: false,
        status: "invalid",
      });
      // The installation identity is what Settings reads to offer Uninstall.
      expect(row?.approvedHash).not.toBeNull();
      expect(row?.error?.code).toBe("invalid-plugin");

      const preflight = await pipeline.uninstallPreflight("example-plugin");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const uninstalled = await pipeline.uninstall(
        "example-plugin",
        preflight.confirmationToken,
      );
      expect(uninstalled.ok).toBe(true);

      // Every trace uninstall owns: the workspace source, the userData live
      // root, and the local-state record.
      await expect(lstat(fixture.pluginRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(pluginsDataRoot(fixture))).toEqual([]);
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["example-plugin"]).toBeUndefined();
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("rebuilds instead of starting stale bytes after a failed publish (#779 round 7 A3)", async () => {
    const fixture = await createPluginWorkspace();
    let failPublish = false;
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
        build: async (input) => {
          const result = await buildPluginBundle(input);
          if (!result.ok || !failPublish) return result;
          // Stands for any IO failure inside publish's rename swap. The
          // approval record for these exact bytes is written before publish
          // runs, so the record ends up naming a bundle the disk never got.
          return {
            ...result,
            publish: () => Promise.reject(new Error("simulated publish failure")),
          };
        },
      },
    });

    const bundleHashOnDisk = async (): Promise<string> =>
      createHash("sha256")
        .update(await readFile(liveBundlePath(fixture, "example-plugin")))
        .digest("hex");
    const recordedBundleHash = async (): Promise<string | undefined> => {
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      return state.state.plugins["example-plugin"]?.approvedBundleHash;
    };

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

      await writeFile(fixture.entryPath, [
        'export const marker = "two";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      failPublish = true;
      const failed = await pipeline.install("example-plugin");

      expect(failed.ok).toBe(false);
      if (failed.ok) throw new Error("unreachable");
      expect(failed.error).toMatchObject({
        stage: "build",
        code: "publish-failed",
      });
      // The recorded approval names the new build; the disk still holds the
      // old bundle. That disagreement is the whole point of the pin.
      const staleBundle = await readFile(
        liveBundlePath(fixture, "example-plugin"),
        "utf8",
      );
      expect(staleBundle).toContain("one");
      expect(staleBundle).not.toContain("two");
      expect(await recordedBundleHash()).not.toBe(await bundleHashOnDisk());

      // Fail closed: the next start must not run those stale bytes. It
      // rebuilds from the still-approved source instead.
      failPublish = false;
      await host.stop("example-plugin");
      const restarted = await pipeline.ensureStarted("example-plugin");

      expect(restarted.ok).toBe(true);
      const republished = await readFile(
        liveBundlePath(fixture, "example-plugin"),
        "utf8",
      );
      expect(republished).toContain("two");
      expect(await recordedBundleHash()).toBe(await bundleHashOnDisk());
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("persists a failed fresh install as an actionable repair state (#779 round 7 A3)", async () => {
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
        install: () => Promise.reject(new Error("synthetic install failure")),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");

      expect(installed.ok).toBe(false);
      expect(pipeline.list()[0]).toMatchObject({
        status: "disabled-pending-repair",
        disabledReason: "repair",
        runtimeStatus: null,
      });
      expect(pipeline.list()[0]?.error).not.toBeNull();
      // Persisted, not just displayed: a plugin whose first install died
      // half-way must not come back enabled on the next launch, and it must
      // not carry an approval it never earned.
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["example-plugin"]).toMatchObject({
        disabled: true,
      });
      expect(state.state.plugins["example-plugin"]?.approvedHash).toBeUndefined();
      expect(host.getStatus("example-plugin")).toBeUndefined();
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("leaves a failed source check actionable instead of stuck at snapshotting (#779 round 7 B5)", async () => {
    const fixture = await createPluginWorkspace();
    let failSnapshot = false;
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
        snapshot: async (input) => {
          const real = await snapshotPluginSource(input);
          if (!failSnapshot) return real;
          return {
            ok: false,
            error: {
              code: "snapshot-io",
              message: "simulated snapshot failure",
              path: null,
            },
            pnpmPaths: real.pnpmPaths,
          };
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
      expect((await pipeline.disable("example-plugin")).ok).toBe(true);

      failSnapshot = true;
      const enabled = await pipeline.enable("example-plugin");

      expect(enabled.ok).toBe(false);
      // "snapshotting" is a busy status: it disables every action for this
      // plugin, and nothing else restores it (#779 round 7 B5).
      expect(pipeline.list()[0]?.status).not.toBe("snapshotting");
      expect(pipeline.list()[0]).toMatchObject({ status: "failed" });
      expect(pipeline.list()[0]?.error).toMatchObject({
        stage: "snapshot",
        code: "snapshot-io",
      });

      // Actionable means the next attempt really works.
      failSnapshot = false;
      expect((await pipeline.enable("example-plugin")).ok).toBe(true);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not recover after the snapshot failure cleared.",
      );
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("leaves the live snapshot serving approved bytes while a change waits for approval (#779 round 9 B1)", async () => {
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

    const liveEntry = join(
      liveSnapshotRoot(fixture, "example-plugin"),
      "src",
      "index.ts",
    );
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
      expect(await readFile(liveEntry, "utf8")).toContain('marker = "one"');

      // An out-of-band change nobody has approved.
      await writeFile(fixture.entryPath, [
        'export const marker = "unapproved";',
        "export default { activate() {} };",
        "",
      ].join("\n"));

      const held = await pipeline.enable("example-plugin");

      expect(held.ok).toBe(true);
      expect(pipeline.list()[0]).toMatchObject({
        status: "disabled-pending-approval",
      });
      // startPluginPanel serves this directory, and the child-process broker
      // spawns snapshot/server.mjs out of it. Publishing on sight put the
      // unapproved bytes there before anything had approved them.
      expect(await readFile(liveEntry, "utf8")).toContain('marker = "one"');
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .not.toContain("unapproved");
      // The discarded staging leaves nothing behind.
      expect(await stagingLeftovers(fixture, "example-plugin")).toEqual([]);

      const approved = await pipeline.approve("example-plugin");
      expect(approved.ok).toBe(true);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after approval.",
      );

      expect(await readFile(liveEntry, "utf8")).toContain('marker = "unapproved"');
      expect(await stagingLeftovers(fixture, "example-plugin")).toEqual([]);
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("holds a change that lands between a door write's check and the build's own snapshot (#779 round 9 B2)", async () => {
    const fixture = await createPluginWorkspace();
    let interloperArmed = false;
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
        // The window itself: the door write's equality check has already
        // passed, and this fires as the build takes its own fresh snapshot.
        snapshot: async (input) => {
          if (interloperArmed) {
            interloperArmed = false;
            await writeFile(fixture.entryPath, [
              'export const marker = "window-interloper";',
              "export default { activate() {} };",
              "",
            ].join("\n"));
          }
          return snapshotPluginSource(input);
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

      await writeFile(fixture.entryPath, [
        'export const marker = "door-written";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      interloperArmed = true;
      pipeline.handleDoorWrittenSourceChange("example-plugin");

      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        "The change inside the build window was not held for approval; status is "
          + `"${pipeline.list()[0]?.status}".`,
      );
      // Neither the door-written content nor the interloper was approved,
      // and the interloper never ran.
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .not.toContain("window-interloper");
      expect(await readFile(
        join(liveSnapshotRoot(fixture, "example-plugin"), "src", "index.ts"),
        "utf8",
      )).toContain('marker = "one"');
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("keeps uninstall available for a scoped plugin in a differently named directory whose manifest broke (#779 round 9 B3)", async () => {
    const fixture = await createNamedPluginWorkspace("foo", "@scope/bar");
    let pipeline: PluginPipeline;
    const newHost = () =>
      new PluginHost({
        stateDir: fixture.stateDir,
        workspaceRoot: fixture.workspaceRoot,
        spawnTransport: fakeSpawnTransport(),
        routeSdkRequest: async () => ({}),
        onStatusChange: (pluginId, status) => {
          pipeline.noteRuntimeStatus(pluginId, status);
        },
      });
    const newPipeline = (host: PluginHost) =>
      new PluginPipeline({
        workspaceRoot: fixture.workspaceRoot,
        stateDir: fixture.stateDir,
        pluginHost: host,
        resourcesBasePath,
        operations: {
          install: (input) =>
            installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        },
      });

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      const installed = await pipeline.install("@scope/bar");
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

    await writeFile(
      join(fixture.pluginRoot, "dohc-plugin.json"),
      "{ this is not valid JSON\n",
    );

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      // Discovery falls back to the directory name "foo", which is not the
      // key this installation's record is stored under. Joining on the
      // recorded directory is what keeps the installation visible.
      const row = pipeline.list()[0];
      expect(row).toMatchObject({
        id: "@scope/bar",
        directoryName: "foo",
        valid: false,
        status: "invalid",
      });
      expect(row?.approvedHash).not.toBeNull();

      const preflight = await pipeline.uninstallPreflight("@scope/bar");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const uninstalled = await pipeline.uninstall(
        "@scope/bar",
        preflight.confirmationToken,
      );
      expect(uninstalled.ok).toBe(true);

      await expect(lstat(fixture.pluginRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(pluginsDataRoot(fixture))).toEqual([]);
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["@scope/bar"]).toBeUndefined();
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("keeps an installation with its own directory when a second root claims its id (#779 round 11 A4)", async () => {
    const fixture = await createNamedPluginWorkspace("zeta", "shared-id");
    let pipeline: PluginPipeline;
    const newHost = () =>
      new PluginHost({
        stateDir: fixture.stateDir,
        workspaceRoot: fixture.workspaceRoot,
        spawnTransport: fakeSpawnTransport(),
        routeSdkRequest: async () => ({}),
        onStatusChange: (pluginId, status) => {
          pipeline.noteRuntimeStatus(pluginId, status);
        },
      });
    const newPipeline = (host: PluginHost) =>
      new PluginPipeline({
        workspaceRoot: fixture.workspaceRoot,
        stateDir: fixture.stateDir,
        pluginHost: host,
        resourcesBasePath,
        operations: {
          install: (input) =>
            installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        },
      });

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      const installed = await pipeline.install("shared-id");
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

    // Two more directories now declare the same manifest id, one on each side
    // of "zeta" lexically. The earlier one used to take the id outright, and
    // with it the approval, the uninstall paths, and the identity of an
    // installation it has nothing to do with; the later one used to overwrite
    // the installation's own status by joining its record.
    const earlierRoot = join(fixture.workspaceRoot, "plugins", "alpha");
    const laterRoot = join(fixture.workspaceRoot, "plugins", "zzz");
    await cp(fixture.pluginRoot, earlierRoot, { recursive: true });
    await cp(fixture.pluginRoot, laterRoot, { recursive: true });

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      const installedRow = () =>
        pipeline.list().find((plugin) => plugin.directoryName === "zeta");
      await waitFor(
        () => installedRow()?.status === "ready",
        "The installed plugin did not keep its identity after reopening.",
      );
      expect(installedRow()).toMatchObject({
        id: "shared-id",
        rootPath: fixture.pluginRoot,
        valid: true,
        approvedHash: expect.any(String),
      });
      // Both interlopers are listed, but only as invalid duplicates: neither
      // holds an approval or an installation of its own.
      for (const directoryName of ["alpha", "zzz"]) {
        expect(pipeline.list().find((plugin) =>
          plugin.directoryName === directoryName
        )).toMatchObject({ valid: false, status: "invalid", approvedHash: null });
      }

      const preflight = await pipeline.uninstallPreflight("shared-id");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const uninstalled = await pipeline.uninstall(
        "shared-id",
        preflight.confirmationToken,
      );
      expect(uninstalled.ok).toBe(true);
      // Uninstall deleted the directory the record names, not the one that
      // sorted first.
      await expect(lstat(fixture.pluginRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(join(earlierRoot, "dohc-plugin.json")))
        .resolves.toBeDefined();
      await expect(lstat(join(laterRoot, "dohc-plugin.json")))
        .resolves.toBeDefined();
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

  it("keeps an installation when its directory is renamed (#779 round 11 A4)", async () => {
    const fixture = await createNamedPluginWorkspace("zeta", "shared-id");
    let pipeline: PluginPipeline;
    const newHost = () =>
      new PluginHost({
        stateDir: fixture.stateDir,
        workspaceRoot: fixture.workspaceRoot,
        spawnTransport: fakeSpawnTransport(),
        routeSdkRequest: async () => ({}),
        onStatusChange: (pluginId, status) => {
          pipeline.noteRuntimeStatus(pluginId, status);
        },
      });
    const newPipeline = (host: PluginHost) =>
      new PluginPipeline({
        workspaceRoot: fixture.workspaceRoot,
        stateDir: fixture.stateDir,
        pluginHost: host,
        resourcesBasePath,
        operations: {
          install: (input) =>
            installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        },
      });

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      const installed = await pipeline.install("shared-id");
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

    // The manifest is intact, so the id is unchanged: this is the same
    // installation in a renamed folder, and it keeps its record.
    const renamedRoot = join(fixture.workspaceRoot, "plugins", "beta");
    await rename(fixture.pluginRoot, renamedRoot);

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      const row = pipeline.list()[0];
      expect(row).toMatchObject({
        id: "shared-id",
        directoryName: "beta",
        rootPath: renamedRoot,
        valid: true,
      });
      expect(row?.approvedHash).not.toBeNull();

      const preflight = await pipeline.uninstallPreflight("shared-id");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const uninstalled = await pipeline.uninstall(
        "shared-id",
        preflight.confirmationToken,
      );
      expect(uninstalled.ok).toBe(true);
      await expect(lstat(renamedRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

  it("leaves a dotted neighbour's data alone when an identity is renamed (#779 round 10 B1)", async () => {
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

      // The same sweep uninstall uses also runs on any identity change, so a
      // plugin named "example-plugin.bar" loses its live root there too.
      const dataRoot = pluginsDataRoot(fixture);
      const neighbourRoot = join(dataRoot, "example-plugin.bar");
      await mkdir(join(neighbourRoot, "snapshot"), { recursive: true });
      await writeFile(join(neighbourRoot, "bundle.mjs"), "neighbour bytes\n");

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
        () => pipeline.list().some((plugin) => plugin.id === "renamed-plugin"),
        "Manifest identity change did not land as a new discovery.",
      );

      expect(await readdir(dataRoot)).toEqual(["example-plugin.bar"]);
      expect(await readFile(join(neighbourRoot, "bundle.mjs"), "utf8"))
        .toBe("neighbour bytes\n");
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("retries a staged tree's cleanup when the first discard rejects (#779 round 10 A5)", async () => {
    const fixture = await createPluginWorkspace();
    let failNextDiscard = false;
    const discards: string[] = [];
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
        snapshot: async (input) => {
          const result = await snapshotPluginSource(input);
          if (!result.ok) return result;
          return {
            ...result,
            discard: async () => {
              discards.push(result.snapshotRoot);
              // The first removal rejects and leaves the tree where it was —
              // a locked file, a scanner, a permission error.
              if (failNextDiscard) {
                failNextDiscard = false;
                throw new Error("simulated: staged tree is busy");
              }
              await result.discard();
            },
          };
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

      // Source no longer matches the approved hash, so ensureStarted stages a
      // tree and then has to drop it again.
      await writeFile(fixture.entryPath, [
        'export const marker = "unapproved";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      failNextDiscard = true;
      const started = await pipeline.ensureStarted("example-plugin");

      // Fail-closed, and no staged bytes left beside the live root: the
      // rejected discard is retried by the same job's cleanup (#779 round
      // 10 A5).
      expect(started.ok).toBe(false);
      expect(discards).toHaveLength(2);
      expect(await stagingLeftovers(fixture, "example-plugin")).toEqual([]);
      expect(await readFile(
        join(liveSnapshotRoot(fixture, "example-plugin"), "src", "index.ts"),
        "utf8",
      )).toContain('marker = "one"');
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("retries the build's own discard when the source moved under a door write (CERT779J B3.3)", async () => {
    const fixture = await createPluginWorkspace();
    let mismatchNextSnapshot = false;
    let failNextDiscard = false;
    const discards: string[] = [];
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
        snapshot: async (input) => {
          const result = await snapshotPluginSource(input);
          if (!result.ok || !mismatchNextSnapshot) return result;
          mismatchNextSnapshot = false;
          return {
            ...result,
            // A disk-only change landed between the door write's hash check
            // and this snapshot, so the build must drop the staged tree and
            // hold for approval instead of building it (#779 round 9 B2).
            sourceHash: "0".repeat(64),
            discard: async () => {
              discards.push(result.snapshotRoot);
              if (failNextDiscard) {
                failNextDiscard = false;
                throw new Error("simulated: staged tree is busy");
              }
              await result.discard();
            },
          };
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

      mismatchNextSnapshot = true;
      failNextDiscard = true;
      pipeline.handleDoorWrittenSourceChange("example-plugin");

      // The rejected discard is retried by the same job's cleanup, which runs
      // before the job reports its failure, so no staged bytes are left
      // beside the live root.
      await waitFor(
        () => pipeline.list()[0]?.status === "failed",
        "The build never reported the rejected discard.",
      );
      expect(discards).toHaveLength(2);
      expect(await stagingLeftovers(fixture, "example-plugin")).toEqual([]);
      expect(await readFile(
        join(liveSnapshotRoot(fixture, "example-plugin"), "src", "index.ts"),
        "utf8",
      )).toContain('marker = "one"');
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("hands panel ownership only to the call that started the host (#779 round 10 B3)", async () => {
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
      // The install is the workspace starting the host, exactly as a queued
      // reconciliation would during workspace startup.
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

      // A panel's own ensureStarted now succeeds on an already-running host.
      // It did not perform the zero-to-running transition, so closing that
      // panel must not stop an enabled plugin's background work.
      const followed = await pipeline.ensureStarted("example-plugin");
      expect(followed.ok).toBe(true);
      expect(followed.ok && followed.startedHost).toBe(false);

      await host.stop("example-plugin");
      const cold = await pipeline.ensureStarted("example-plugin");
      expect(cold.ok).toBe(true);
      expect(cold.ok && cold.startedHost).toBe(true);
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("keeps an installation whose manifest breaks while it is watched, and recovers it when the manifest returns (#779 round 12 A1)", async () => {
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
      const manifestPath = join(fixture.pluginRoot, "dohc-plugin.json");
      const manifestText = await readFile(manifestPath, "utf8");
      const liveRoot = join(pluginsDataRoot(fixture), "example-plugin");
      const liveBefore = await fileHashes(liveRoot);

      // A half-written manifest is an ordinary state while a user's agent
      // edits the plugin. The root never left; only its manifest did.
      await writeFile(manifestPath, "{ half written\n");
      pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/dohc-plugin.json",
        operation: "update",
      }]);
      await waitFor(
        () => pipeline.list()[0]?.status === "invalid",
        "The broken manifest never landed as an invalid row.",
      );

      // Still installed: the record, the approval, the built bundle, and the
      // published snapshot all survive, and Settings still offers Uninstall.
      expect(pipeline.list()[0]).toMatchObject({
        id: "example-plugin",
        valid: false,
        status: "invalid",
      });
      expect(pipeline.list()[0]?.approvedHash).not.toBeNull();
      const broken = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!broken.ok) throw new Error(broken.warning);
      expect(broken.state.plugins["example-plugin"]?.approvedHash).toEqual(
        expect.any(String),
      );
      expect(await fileHashes(liveRoot)).toEqual(liveBefore);

      // Restoring the same bytes restores the installation on its own
      // approval — no new approval prompt, no reinstall.
      await writeFile(manifestPath, manifestText);
      pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/dohc-plugin.json",
        operation: "update",
      }]);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "The restored manifest did not return the plugin to ready.",
      );
      expect(pipeline.list()[0]).toMatchObject({
        id: "example-plugin",
        valid: true,
        approvedHash: broken.state.plugins["example-plugin"]?.approvedHash,
      });
      // The built bundle is the same one: recovery verified the approved
      // source and started it, it did not rebuild. (The published source
      // snapshot beside it is re-copied by any reconcile whose install
      // rewrote the lockfile, which is not what this test is about.)
      expect((await fileHashes(liveRoot))["bundle.mjs"])
        .toBe(liveBefore["bundle.mjs"]);
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("finishes an uninstall whose source delete succeeded and whose data delete failed (#779 round 12 A2)", async () => {
    const fixture = await createPluginWorkspace();
    let failDataRemoval = false;
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
          if (
            failDataRemoval &&
            String(path).startsWith(pluginsDataRoot(fixture))
          ) {
            throw new Error("plugin data delete failed");
          }
          await rm(path, options);
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

      failDataRemoval = true;
      const firstPreflight = await pipeline.uninstallPreflight("example-plugin");
      if (!firstPreflight.ok) throw new Error(firstPreflight.error.message);
      const failed = await pipeline.uninstall(
        "example-plugin",
        firstPreflight.confirmationToken,
      );
      expect(failed.ok).toBe(false);
      if (failed.ok) throw new Error("unreachable");
      expect(failed.error).toMatchObject({
        stage: "uninstall",
        code: "delete-failed",
      });
      // The source is gone; the plugin data and the record are not.
      await expect(lstat(fixture.pluginRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(pluginsDataRoot(fixture))).toEqual([
        "example-plugin",
      ]);
      expect(pipeline.list()[0]).toMatchObject({
        id: "example-plugin",
        status: "disabled-pending-repair",
        approvedHash: expect.any(String),
      });

      // The watcher then observes the deleted root and sweeps the identity,
      // which drops the record and fails on the same plugin data. Discovery
      // now has no candidate at all, and the row is the only thing left that
      // names the installation.
      pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin",
        operation: "delete",
      }]);
      await waitFor(
        () => pipeline.list()[0]?.error?.code === "identity-cleanup-failed",
        "The watcher sweep never reported its failed cleanup.",
      );
      const swept = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!swept.ok) throw new Error(swept.warning);
      expect(swept.state.plugins["example-plugin"]).toBeUndefined();
      expect(await readdir(pluginsDataRoot(fixture))).toEqual([
        "example-plugin",
      ]);
      expect(pipeline.list()[0]).toMatchObject({
        id: "example-plugin",
        approvedHash: expect.any(String),
      });

      // The retry is the same action from the same row, and it finishes.
      failDataRemoval = false;
      const retryPreflight = await pipeline.uninstallPreflight("example-plugin");
      if (!retryPreflight.ok) throw new Error(retryPreflight.error.message);
      expect(retryPreflight.preflight.liveHash).toBeNull();
      const finished = await pipeline.uninstall(
        "example-plugin",
        retryPreflight.confirmationToken,
      );
      expect(finished.ok).toBe(true);

      expect(await readdir(pluginsDataRoot(fixture))).toEqual([]);
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["example-plugin"]).toBeUndefined();
      expect(pipeline.list()).toEqual([]);
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("stops the old runtime before it publishes, and refuses a bundle swapped after publication (#779 round 12 A3)", async () => {
    const fixture = await createPluginWorkspace();
    let tamperOnPublish = false;
    const order: string[] = [];
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
    const realStop = host.stop.bind(host);
    vi.spyOn(host, "stop").mockImplementation(async (pluginId: string) => {
      order.push("stop");
      await realStop(pluginId);
    });
    const startSpy = vi.spyOn(host, "start");
    pipeline = new PluginPipeline({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      pluginHost: host,
      resourcesBasePath,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        build: async (input) => {
          const built = await buildPluginBundle(input);
          if (!built.ok) return built;
          return {
            ...built,
            publish: async () => {
              const published = await built.publish();
              order.push("publish");
              // The still-running full-trust host knows its own live root, so
              // this is the window it could overwrite the published bundle in.
              if (tamperOnPublish) {
                await writeFile(
                  join(built.liveRoot, "bundle.mjs"),
                  "globalThis.unapproved = true;\n",
                );
              }
              return published;
            },
          };
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
      const startsAfterInstall = startSpy.mock.calls.length;

      order.length = 0;
      tamperOnPublish = true;
      const rebuilt = await pipeline.install("example-plugin");

      // Nothing may run out of the live root while it is being replaced.
      expect(order).toEqual(["stop", "publish"]);
      // The published bytes are not the bytes the record just approved, so
      // the start is refused and they never execute.
      expect(rebuilt.ok).toBe(false);
      if (rebuilt.ok) throw new Error("unreachable");
      expect(rebuilt.error).toMatchObject({
        stage: "build",
        code: "bundle-changed",
      });
      expect(startSpy.mock.calls.length).toBe(startsAfterInstall);
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .toBe("globalThis.unapproved = true;\n");
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);
});
