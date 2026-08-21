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
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stop } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ListPluginsResult,
  PluginActionResult,
  PluginStatusChangedEvent,
  PluginStatusRecord,
} from "../ipc/bridgeContract";
import { PluginHost, type PluginHostOptions } from "./PluginHost";
import { PLUGIN_HOST_METHODS } from "./pluginHostProtocol";
import {
  discoverInstalledPlugins,
  type InstalledPluginRecord,
} from "./pluginDiscovery";
import { PluginPipeline, type PluginPipelineStatusEvent } from "./PluginPipeline";
import {
  installPluginDependencies,
  type PluginInstallForkOptions,
  type PluginInstallProcessHandle,
} from "./pluginInstallRunner";
import { buildPluginBundle, resolvePluginEsbuildBinary } from "./pluginBuildRunner";
import {
  mutatePluginRecord,
  pluginDataDir,
  readPluginLocalState,
  workspaceStateKey,
} from "./pluginLocalState";
import {
  pluginLifecycleKey,
  startPluginForPanel,
} from "./pluginPanelRegistration";
import { invokeRegisteredPluginCommand } from "./pluginCommandInvocation";
import type { PluginSettingDeclaration } from "./pluginManifestSchema";
import { pluginStateRoot, snapshotPluginSource } from "./pluginSourceSnapshot";
import {
  pluginBaselineManifestPath,
  pluginUninstallPreflight,
} from "./pluginUninstallPreflight";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

const roots: string[] = [];
let resourcesParent: string;
let resourcesBasePath: string;
// The production install forks this file, and so does every install here:
// Node runs its TypeScript source directly.
const pnpmRunnerEntry = join(import.meta.dirname, "pluginPnpmRunnerProcess.ts");

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

/**
 * Pass a function for any message that reads live state: a template string
 * argument is built before the wait starts, so it reports the state the
 * pipeline was in on the way in rather than the one it timed out in.
 */
async function waitFor(
  condition: () => boolean,
  message: string | (() => string),
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(typeof message === "string" ? message : message());
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Writes authored text and reports it door-written, exactly like main.ts's
 * writeAuthoredText -> handleDoorWrittenSourceChange call: the path and the
 * bytes that landed are the attributed delta.
 */
async function doorWrite(
  pipeline: PluginPipeline,
  pluginId: string,
  absolutePath: string,
  text: string,
): Promise<void> {
  await writeFile(absolutePath, text);
  pipeline.handleDoorWrittenSourceChange(pluginId, { absolutePath, text });
}

function fakeSpawnTransport(
  registeredCommands: () => string[] = () => [],
  beforeRequest?: (method: string) => Promise<void> | void,
): PluginHostOptions["spawnTransport"] {
  return vi.fn<PluginHostOptions["spawnTransport"]>(() => ({
    request: async <T = unknown>(method: string): Promise<T> => {
      await beforeRequest?.(method);
      return (method === PLUGIN_HOST_METHODS.activate
        ? { commands: registeredCommands(), drivers: [] }
        : {}) as T;
    },
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
      pnpmRunnerEntry,
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
      // A ".." that is not a whole segment is still inside the root: prefix
      // containment left a "..cache/" write unattributed, and the plugin
      // later held for its own door write (#779 round 14 A3, round 10 B5).
      expect(pipeline.pluginIdForPath(join(fixture.pluginRoot, "..cache", "x.ts")))
        .toBe("example-plugin");
      expect(pipeline.pluginIdForPath(join(fixture.workspaceRoot, "notes.md")))
        .toBeNull();
      expect(pipeline.pluginIdForPath(
        join(fixture.workspaceRoot, "plugins", "example-plugin-sibling", "x.ts"),
      )).toBeNull();

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

      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "two";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await waitFor(() => installCalls === 2, "Hot reload did not reach install.");

      const thirdText = [
        'export const marker = "three";',
        "export default { activate() {} };",
        "",
      ].join("\n");
      await writeFile(fixture.entryPath, thirdText);
      const thirdWrite = { absolutePath: fixture.entryPath, text: thirdText };
      pipeline.handleDoorWrittenSourceChange("example-plugin", thirdWrite);
      pipeline.handleDoorWrittenSourceChange("example-plugin", thirdWrite);
      pipeline.handleDoorWrittenSourceChange("example-plugin", thirdWrite);
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

      // Durable plugin state (what a wrapper like t3 stores): the preflight
      // must name it as permanently deleted, and uninstall must delete it.
      const stateRoot = pluginStateRoot(
        pluginDataDir(fixture.stateDir, fixture.workspaceRoot),
        "renamed-plugin",
      );
      await mkdir(join(stateRoot, "t3"), { recursive: true });
      await writeFile(join(stateRoot, "t3", "state.sqlite"), "session-bytes");

      const preflight = await pipeline.uninstallPreflight("renamed-plugin");
      if (!preflight.ok) throw new Error(preflight.error.message);
      expect(preflight.preflight.warning?.kind).toBe("plugin-state");
      expect(preflight.preflight.stateData).toMatchObject({
        path: stateRoot,
        fileCount: 1,
      });
      const uninstalled = await pipeline.uninstall(
        "renamed-plugin",
        preflight.confirmationToken,
      );
      expect(uninstalled.ok).toBe(true);
      await expect(lstat(fixture.pluginRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
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
      pnpmRunnerEntry,
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
      pnpmRunnerEntry,
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
      pnpmRunnerEntry,
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
    let snapshotCalls = 0;
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
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        snapshot: (input) => {
          snapshotCalls += 1;
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

      // Rewriting the exact same bytes touches mtime but never the source
      // hash — a real no-op from the pipeline's own point of view, exactly
      // what a watcher can observe from an editor's save-with-no-changes
      // or a sync tool settling.
      const originalSource = await readFile(fixture.entryPath, "utf8");
      await writeFile(fixture.entryPath, originalSource);
      const snapshotsBefore = snapshotCalls;
      await pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/index.ts",
        operation: "update",
      }]);

      // The pipeline sets "snapshotting" on its way into the source check, so
      // its snapshot call is the moment the plugin is inside that busy window.
      // Reaching "ready" from there is the restore under test, not the status
      // the plugin already carried.
      await waitFor(
        () => snapshotCalls > snapshotsBefore,
        "The no-op watcher reconcile never checked the source.",
      );
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        () =>
          `No-op reconcile left status at "${pipeline.list()[0]?.status}" ` +
          `instead of restoring "ready".`,
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
      pnpmRunnerEntry,
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
      pnpmRunnerEntry,
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
      pnpmRunnerEntry,
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
      pnpmRunnerEntry,
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
      pnpmRunnerEntry,
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
      pnpmRunnerEntry,
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
      // owning plugin is told about it immediately — path and bytes —
      // exactly like main.ts's writeAuthoredText ->
      // handleDoorWrittenSourceChange call.
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "door-written";',
        "export default { activate() {} };",
        "",
      ].join("\n"));

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

  it("names the source change that raced a fresh install, and tells that hold apart from a plain post-install edit (#803)", async () => {
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
      pnpmRunnerEntry,
      operations: {
        install: async (input) => {
          installCalls += 1;
          // The first install is the fresh one. Holding it open stands in
          // for the real cold run: the dependency install takes minutes,
          // and the tree it was told to trust was hashed before it started.
          if (installCalls === 1) await installGate.promise;
          return installPluginDependencies({ ...input, forkProcess: nodeForkProcess });
        },
      },
    });

    try {
      await pipeline.start();
      const installPromise = pipeline.install("example-plugin");
      await waitFor(
        () => installCalls === 1,
        "install() never reached the gated dependency install.",
      );

      // The write that races: it lands after the install's snapshot hashed
      // the tree and before the install finishes, so the hash the install
      // is about to record already describes bytes that are gone.
      await writeFile(fixture.entryPath, [
        'export const marker = "raced-the-install";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/index.ts",
        operation: "update",
      }]);

      installGate.resolve();
      const installed = await installPromise;
      expect(installed.ok).toBe(true);

      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        `The raced change was not held for approval; status is `
          + `"${pipeline.list()[0]?.status}".`,
      );
      // The hold itself is the invariant and stays: nothing auto-approved
      // the raced bytes.
      expect(pipeline.list()[0]).toMatchObject({
        status: "disabled-pending-approval",
        disabledReason: "approval",
      });
      expect(await readFile(
        liveBundlePath(fixture, "example-plugin"),
        "utf8",
      )).not.toContain("raced-the-install");
      // What #803 adds: the plugin no longer switches itself off in silence.
      expect(pipeline.list()[0]?.error).toMatchObject({
        stage: "snapshot",
        code: "source-changed-during-install",
      });
      expect(pipeline.list()[0]?.error?.message)
        .toContain("changed while dohc was installing it");

      // The named recovery: approving installs the NEW bytes through the
      // normal flow, which is the only thing that ever approves them.
      const approved = await pipeline.approve("example-plugin");
      expect(approved.ok).toBe(true);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "The raced bytes never installed after approval.",
      );
      expect(pipeline.list()[0]?.error).toBe(null);
      expect(await readFile(
        liveBundlePath(fixture, "example-plugin"),
        "utf8",
      )).toContain("raced-the-install");

      // The contrast that keeps the name honest: with no install in flight,
      // the same hold reports the edit the user actually made.
      await writeFile(fixture.entryPath, [
        'export const marker = "edited-later";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/index.ts",
        operation: "update",
      }]);
      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        "The later edit was not held for approval.",
      );
      expect(pipeline.list()[0]?.error).toMatchObject({
        stage: "snapshot",
        code: "source-changed-after-install",
      });
      expect(pipeline.list()[0]?.error?.message)
        .toContain("changed after dohc installed it");
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
      pnpmRunnerEntry,
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
      pnpmRunnerEntry,
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
      pnpmRunnerEntry,
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
        pnpmRunnerEntry,
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
      pnpmRunnerEntry,
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
      pnpmRunnerEntry,
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
      pnpmRunnerEntry,
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
      pnpmRunnerEntry,
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
    let armedSnapshotCalls = 0;
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
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        // The window itself: the refresh's first snapshot passed the door
        // predicate, and this fires as the build takes its own second,
        // fresh snapshot.
        snapshot: async (input) => {
          if (interloperArmed && ++armedSnapshotCalls === 2) {
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

      interloperArmed = true;
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "door-written";',
        "export default { activate() {} };",
        "",
      ].join("\n"));

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
        pnpmRunnerEntry,
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
        pnpmRunnerEntry,
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
      // holds an approval or an installation of its own. Each keeps its own
      // directory-derived id — one id per row — and its duplicate
      // diagnostics stay reachable on that row (#779 round 14 A4).
      const listed = pipeline.list();
      expect(new Set(listed.map((plugin) => plugin.id)).size).toBe(listed.length);
      for (const directoryName of ["alpha", "zzz"]) {
        const row = listed.find((plugin) => plugin.directoryName === directoryName);
        expect(row).toMatchObject({
          id: directoryName,
          valid: false,
          status: "invalid",
          approvedHash: null,
        });
        expect(row?.diagnostics.join(" "))
          .toContain('duplicate plugin id "shared-id"');
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
        pnpmRunnerEntry,
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
      pnpmRunnerEntry,
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
      pnpmRunnerEntry,
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
      pnpmRunnerEntry,
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
      pipeline.handleDoorWrittenSourceChange("example-plugin", {
        absolutePath: fixture.entryPath,
        text: await readFile(fixture.entryPath, "utf8"),
      });

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

  describe("established plugin rebuild recovery", () => {
    async function setupEstablishedPlugin(options: {
      commands?: { id: string; title: string }[];
      settings?: PluginSettingDeclaration[];
    } = {}) {
      const fixture = await createPluginWorkspace();
      const manifestPath = join(fixture.pluginRoot, "dohc-plugin.json");
      const manifestText = (
        commands: { id: string; title: string }[],
        settings: PluginSettingDeclaration[] = options.settings ?? [],
      ) =>
        `${JSON.stringify({
          version: 1,
          name: "example-plugin",
          displayName: "Example plugin",
          entry: "src/index.ts",
          commands,
          settings,
        }, null, 2)}\n`;
      if (options.commands || options.settings) {
        await writeFile(manifestPath, manifestText(options.commands ?? []));
      }
      let mismatchNextSnapshot = false;
      let failNextDiscard = false;
      let failPublish = false;
      let failRecordWrite = false;
      let failBuild = false;
      let nextStopGate: { entered: Deferred; release: Deferred } | null = null;
      let nextBuildGate: { entered: Deferred; release: Deferred } | null = null;
      let buildCalls = 0;
      let registeredCommands = (options.commands ?? [])
        .map((command) => command.id);
      const statuses: string[] = [];
      let pipeline: PluginPipeline;
      const host = new PluginHost({
        stateDir: fixture.stateDir,
        workspaceRoot: fixture.workspaceRoot,
        spawnTransport: fakeSpawnTransport(
          () => [...registeredCommands],
          async (method) => {
            const gate = nextStopGate;
            if (method !== PLUGIN_HOST_METHODS.deactivate || !gate) return;
            nextStopGate = null;
            gate.entered.resolve();
            await gate.release.promise;
          },
        ),
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
        pnpmRunnerEntry,
        onStatusChange: (event) => {
          if (event.kind === "changed") statuses.push(event.plugin.status);
        },
        operations: {
          install: (input) =>
            installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
          mutateRecord: async (stateDir, workspaceRoot, pluginId, mutate) => {
            if (failRecordWrite) {
              failRecordWrite = false;
              throw new Error("simulated approval record write failure");
            }
            return mutatePluginRecord(stateDir, workspaceRoot, pluginId, mutate);
          },
          snapshot: async (input) => {
            const result = await snapshotPluginSource(input);
            if (!result.ok || !mismatchNextSnapshot) return result;
            mismatchNextSnapshot = false;
            return {
              ...result,
              sourceHash: "0".repeat(64),
              discard: async () => {
                if (failNextDiscard) {
                  failNextDiscard = false;
                  throw new Error("simulated: staged tree is busy");
                }
                await result.discard();
              },
            };
          },
          build: async (input) => {
            buildCalls += 1;
            const gate = nextBuildGate;
            if (gate) {
              nextBuildGate = null;
              gate.entered.resolve();
              await gate.release.promise;
            }
            if (failBuild) {
              failBuild = false;
              throw new Error("simulated build failure before the approval record write");
            }
            const result = await buildPluginBundle(input);
            if (!result.ok || !failPublish) return result;
            failPublish = false;
            return {
              ...result,
              publish: () => Promise.reject(new Error("simulated publish failure")),
            };
          },
        },
      });

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

      return {
        pipeline,
        fixture,
        entryPath: fixture.entryPath,
        manifestPath,
        manifestText,
        statuses,
        buildCalls: () => buildCalls,
        failNextBuildPublish: () => {
          failPublish = true;
        },
        failNextRecordWrite: () => {
          failRecordWrite = true;
        },
        failNextBuild: () => {
          failBuild = true;
        },
        gateNextStop: () => {
          const gate = { entered: deferred(), release: deferred() };
          nextStopGate = gate;
          return gate;
        },
        gateNextBuild: () => {
          const gate = { entered: deferred(), release: deferred() };
          nextBuildGate = gate;
          return gate;
        },
        setRegisteredCommands: (commands: string[]) => {
          registeredCommands = [...commands];
        },
        failEstablishedBuild: async () => {
          mismatchNextSnapshot = true;
          failNextDiscard = true;
          pipeline.handleDoorWrittenSourceChange("example-plugin", {
            absolutePath: fixture.entryPath,
            text: await readFile(fixture.entryPath, "utf8"),
          });
          await waitFor(
            () => pipeline.list()[0]?.status === "failed",
            "The established plugin rebuild did not fail.",
          );
        },
      };
    }

    it("retries against the durable approval after a later publish failure", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        const oldApprovedHash = setup.pipeline.list()[0]?.approvedHash;
        await writeFile(setup.entryPath, [
          'export const marker = "durably approved before publish";',
          "export default { activate() {} };",
          "",
        ].join("\n"));
        setup.failNextBuildPublish();

        const approved = await setup.pipeline.approve("example-plugin");

        expect(approved.ok).toBe(false);
        expect(setup.pipeline.list()[0]).toMatchObject({
          status: "failed",
          approvedHash: oldApprovedHash,
        });
        const durableState = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!durableState.ok) throw new Error(durableState.warning);
        const durableApprovedHash =
          durableState.state.plugins["example-plugin"]?.approvedHash;
        expect(durableApprovedHash).toMatch(/^[0-9a-f]{64}$/);
        expect(durableApprovedHash).not.toBe(oldApprovedHash);

        const rebuilt = await setup.pipeline.rebuild("example-plugin");

        expect(rebuilt).toMatchObject({
          ok: true,
          plugin: {
            status: "starting",
            approvedHash: durableApprovedHash,
          },
        });
        await waitFor(
          () => setup.pipeline.list()[0]?.status === "ready",
          "Plugin did not reach ready after retrying its durably approved build.",
        );
        expect(setup.pipeline.list()[0]).toMatchObject({
          status: "ready",
          sourceHash: durableApprovedHash,
          approvedHash: durableApprovedHash,
        });
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("retries unchanged bytes after an approved build fails before the record write", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        const oldApprovedHash = setup.pipeline.list()[0]?.approvedHash;
        await writeFile(setup.entryPath, [
          'export const marker = "approved before a transient build failure";',
          "export default { activate() {} };",
          "",
        ].join("\n"));
        setup.failNextBuild();

        const approved = await setup.pipeline.approve("example-plugin");

        expect(approved.ok).toBe(false);
        const durableState = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!durableState.ok) throw new Error(durableState.warning);
        expect(durableState.state.plugins["example-plugin"]?.approvedHash)
          .toBe(oldApprovedHash);

        const rebuilt = await setup.pipeline.rebuild("example-plugin");

        expect(rebuilt).toMatchObject({
          ok: true,
          plugin: { status: "starting" },
        });
        await waitFor(
          () => setup.pipeline.list()[0]?.status === "ready",
          "Plugin did not reach ready after retrying unchanged approved bytes.",
        );
        expect(setup.pipeline.list()[0]?.status)
          .not.toBe("disabled-pending-approval");
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("retries a failed build for an established plugin", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await setup.failEstablishedBuild();

        const rebuilt = await setup.pipeline.rebuild("example-plugin");

        expect(rebuilt.ok).toBe(true);
        await waitFor(
          () => setup.pipeline.list()[0]?.status === "ready",
          "Plugin did not reach ready after retrying its build.",
        );
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("tears down web apps only after the old runtime stops", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await setup.failEstablishedBuild();
        const stopGate = setup.gateNextStop();
        let callbackCalled = false;
        let lateStart: Promise<unknown> | undefined;

        const rebuilding = setup.pipeline.rebuild("example-plugin", {
          onOldRuntimeStopped: () => {
            callbackCalled = true;
            lateStart = setup.pipeline.host.startWebApp(
              "example-plugin",
              "old-app",
              null,
            );
            void lateStart.catch(() => undefined);
          },
        });

        await stopGate.entered.promise;
        expect(callbackCalled).toBe(false);
        stopGate.release.resolve();
        const rebuilt = await rebuilding;

        expect(rebuilt.ok).toBe(true);
        expect(callbackCalled).toBe(true);
        if (!lateStart) throw new Error("The old-runtime stop callback did not run.");
        await expect(lateStart).rejects.toThrow(
          'Plugin "example-plugin" is not running.',
        );
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps the running build's commands after a pre-stop failure", async () => {
      const oldCommands = [{ id: "old.cmd", title: "Old Command" }];
      const newCommands = [{ id: "new.cmd", title: "New Command" }];
      const setup = await setupEstablishedPlugin({ commands: oldCommands });
      try {
        setup.failNextRecordWrite();
        setup.setRegisteredCommands(newCommands.map((command) => command.id));
        await writeFile(
          setup.manifestPath,
          setup.manifestText(newCommands),
        );
        // Refresh discovery without reconciling this plugin. The attempted
        // approval below must see the edited manifest while the old runtime
        // remains up until the build reaches its stop step.
        await setup.pipeline.handleWatcherEvents([{
          path: "plugins/unrelated-plugin/dohc-plugin.json",
          operation: "update",
        }]);
        expect(
          setup.pipeline.pluginRegistration("example-plugin")?.manifest.commands,
        ).toEqual(newCommands);

        const failed = await setup.pipeline.approve("example-plugin");

        expect(failed).toMatchObject({
          ok: false,
          plugin: { commands: oldCommands },
        });
        await waitFor(
          () => setup.pipeline.list()[0]?.status === "failed",
          "The pre-stop record write failure did not reach failed status.",
        );

        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");
        expect(setup.pipeline.host.getRegisteredCommands("example-plugin"))
          .toEqual(["old.cmd"]);
        expect(setup.pipeline.list()[0]?.commands).toEqual(oldCommands);
        expect(
          setup.pipeline.pluginRegistration("example-plugin")?.manifest.commands,
        ).toEqual(oldCommands);
        setup.pipeline.noteRuntimeStatus("example-plugin", "crashed");
        setup.pipeline.noteRuntimeStatus("example-plugin", "starting");
        setup.pipeline.noteRuntimeStatus("example-plugin", "ready");
        expect(setup.pipeline.list()[0]?.commands).toEqual(oldCommands);
        expect(
          setup.pipeline.pluginRegistration("example-plugin")?.manifest.commands,
        ).toEqual(oldCommands);
        const recoveredRegistration =
          setup.pipeline.pluginRegistration("example-plugin");
        expect(recoveredRegistration).not.toBeNull();
        if (!recoveredRegistration) {
          throw new Error("The recovered plugin registration is missing.");
        }
        const invoked = await invokeRegisteredPluginCommand({
          input: {
            workspaceId: "workspace-1",
            pluginId: "example-plugin",
            commandId: "old.cmd",
          },
          plugin: recoveredRegistration,
          ensureStarted: async () => setup.pipeline.host,
        });
        expect(invoked.status).toBe("ok");

        const approved = await setup.pipeline.approve("example-plugin");

        expect(approved.ok).toBe(true);
        await waitFor(
          () => setup.pipeline.list()[0]?.status === "ready",
          "Plugin did not reach ready after approving the replacement build.",
        );
        expect(setup.pipeline.list()[0]?.commands).toEqual(newCommands);
        expect(setup.pipeline.host.getRegisteredCommands("example-plugin"))
          .toEqual(["new.cmd"]);
        expect(
          setup.pipeline.pluginRegistration("example-plugin")?.manifest.commands,
        ).toEqual(newCommands);
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps recovered commands authoritative throughout a pre-stop retry", async () => {
      const oldCommands = [{ id: "old.cmd", title: "Old Command" }];
      const newCommands = [{ id: "new.cmd", title: "New Command" }];
      const setup = await setupEstablishedPlugin({ commands: oldCommands });
      try {
        setup.failNextRecordWrite();
        await writeFile(setup.manifestPath, setup.manifestText(newCommands));
        await setup.pipeline.handleWatcherEvents([{
          path: "plugins/unrelated-plugin/dohc-plugin.json",
          operation: "update",
        }]);
        expect((await setup.pipeline.approve("example-plugin")).ok).toBe(false);
        expect(setup.pipeline.list()[0]?.commands).toEqual(oldCommands);

        const buildGate = setup.gateNextBuild();
        setup.failNextBuild();
        const retry = setup.pipeline.approve("example-plugin");
        await buildGate.entered.promise;

        try {
          expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");
          expect(setup.pipeline.list()[0]?.commands).toEqual(oldCommands);
          expect(
            setup.pipeline.pluginRegistration("example-plugin")?.manifest.commands,
          ).toEqual(oldCommands);
        } finally {
          buildGate.release.resolve();
        }
        expect((await retry).ok).toBe(false);
        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");
        expect(setup.pipeline.list()[0]?.commands).toEqual(oldCommands);
        expect(
          setup.pipeline.pluginRegistration("example-plugin")?.manifest.commands,
        ).toEqual(oldCommands);
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps the running build's settings and validation after a pre-stop failure", async () => {
      const oldSettings: PluginSettingDeclaration[] = [{
        key: "greeting",
        type: "string",
        label: "Greeting",
        description: "What the plugin says.",
        default: "Hello",
      }];
      const newSettings: PluginSettingDeclaration[] = [{
        key: "repeat",
        type: "number",
        label: "Repeat",
        description: "How many times the plugin repeats itself.",
        default: 1,
      }];
      const setup = await setupEstablishedPlugin({ settings: oldSettings });
      try {
        setup.failNextRecordWrite();
        await writeFile(
          setup.manifestPath,
          setup.manifestText([], newSettings),
        );
        await setup.pipeline.handleWatcherEvents([{
          path: "plugins/unrelated-plugin/dohc-plugin.json",
          operation: "update",
        }]);

        expect((await setup.pipeline.approve("example-plugin")).ok).toBe(false);
        expect(setup.pipeline.list()[0]?.settings).toEqual(oldSettings);
        await expect(
          setup.pipeline.setPluginSettings("example-plugin", { greeting: "Hi" }),
        ).resolves.toEqual({ greeting: "Hi" });
        await expect(
          setup.pipeline.setPluginSettings("example-plugin", { repeat: 2 }),
        ).rejects.toThrow('does not declare a setting named "repeat"');

        expect((await setup.pipeline.approve("example-plugin")).ok).toBe(true);
        await waitFor(
          () => setup.pipeline.list()[0]?.status === "ready",
          "Plugin did not reach ready after replacing its settings declaration.",
        );
        expect(setup.pipeline.list()[0]?.settings).toEqual(newSettings);
        await expect(
          setup.pipeline.setPluginSettings("example-plugin", { repeat: 2 }),
        ).resolves.toEqual({ repeat: 2 });
        await expect(
          setup.pipeline.setPluginSettings("example-plugin", { greeting: "Hi" }),
        ).rejects.toThrow('does not declare a setting named "greeting"');
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("notifies when rebuild stops an old runtime to hold changed source", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await setup.failEstablishedBuild();
        await writeFile(setup.entryPath, [
          'export const marker = "changed before retry";',
          "export default { activate() {} };",
          "",
        ].join("\n"));
        let callbackCalled = false;

        const rebuilt = await setup.pipeline.rebuild("example-plugin", {
          onOldRuntimeStopped: () => {
            callbackCalled = true;
          },
        });

        expect(rebuilt).toMatchObject({
          ok: true,
          plugin: { status: "disabled-pending-approval" },
        });
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeUndefined();
        expect(callbackCalled).toBe(true);
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("survives a throwing old-runtime-stopped notification and still publishes the replacement", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        setup.failNextRecordWrite();
        expect((await setup.pipeline.approve("example-plugin")).ok).toBe(false);
        expect(setup.pipeline.list()[0]?.status).toBe("failed");
        // The old runtime never stopped for this failure — it failed at the
        // durable write, before the stop step. The retry below reuses the
        // same, unchanged, durably-approved source, so it takes the ordinary
        // success path (not approval-hold) and reaches its own stop, where
        // the notification below throws.
        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");

        const rebuilt = await setup.pipeline.rebuild("example-plugin", {
          onOldRuntimeStopped: () => {
            throw new Error("simulated notification failure");
          },
        });

        expect(rebuilt).toMatchObject({
          ok: true,
          plugin: { status: "starting" },
        });
        await waitFor(
          () => setup.pipeline.list()[0]?.status === "ready",
          "Plugin did not reach ready after a throwing stop notification.",
        );
        expect(setup.pipeline.list()[0]?.status).toBe("ready");
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("holds changed source for approval instead of approving it on rebuild", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await setup.failEstablishedBuild();
        const approvedHash = setup.pipeline.list()[0]?.approvedHash;
        await writeFile(setup.entryPath, [
          'export const marker = "changed before retry";',
          "export default { activate() {} };",
          "",
        ].join("\n"));

        const rebuilt = await setup.pipeline.rebuild("example-plugin");

        expect(rebuilt).toMatchObject({
          ok: true,
          plugin: {
            status: "disabled-pending-approval",
            approvedHash,
          },
        });
        expect(setup.pipeline.list()[0]).toMatchObject({
          status: "disabled-pending-approval",
          approvedHash,
        });
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeUndefined();
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps the approved build recoverable when its rebuild fails again", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await setup.failEstablishedBuild();
        const approvedHash = setup.pipeline.list()[0]?.approvedHash;
        setup.failNextBuildPublish();

        const rebuilt = await setup.pipeline.rebuild("example-plugin");

        expect(rebuilt.ok).toBe(false);
        expect(setup.pipeline.list()[0]).toMatchObject({
          status: "failed",
          approvedHash,
        });
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("rejects rebuild when the plugin has no failed approved build", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        const buildsBefore = setup.buildCalls();
        const statusesBefore = setup.statuses.length;

        const rebuilt = await setup.pipeline.rebuild("example-plugin");
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(rebuilt).toMatchObject({
          ok: false,
          error: {
            stage: "state",
            code: "no-failed-build",
            message: 'Plugin "example-plugin" has no failed build to retry.',
          },
        });
        expect(setup.buildCalls()).toBe(buildsBefore);
        expect(setup.statuses.slice(statusesBefore)).not.toContain("installing");
        expect(setup.statuses.slice(statusesBefore)).not.toContain("scanning");
        expect(setup.statuses.slice(statusesBefore)).not.toContain("building");
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);
  });

  it("opens a surface only once the host finished activating (#798)", async () => {
    const fixture = await createPluginWorkspace();
    let pipeline: PluginPipeline;
    let activationGate = deferred();
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: vi.fn<PluginHostOptions["spawnTransport"]>(() => ({
        request: async <T = unknown>(method: string): Promise<T> => {
          if (method !== "plugin.activate") return {} as T;
          await activationGate.promise;
          return { commands: [], drivers: [] } as T;
        },
        notify: () => undefined,
        dispose: async () => undefined,
      })),
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
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    // What main.ts wires behind every panel and web-app open.
    const panelStartedHosts = new Set<string>();
    const open = () => {
      let opened = false;
      const settled = startPluginForPanel({
        panelStartedHosts,
        workspaceId: "workspace-1",
        pluginId: "example-plugin",
        hostActivation: () => host.activationOf("example-plugin"),
        ensureStarted: () => pipeline.ensureStarted("example-plugin"),
      }).then(() => {
        opened = true;
      });
      return { settled, isOpen: () => opened };
    };
    const settleQueuedWork = () =>
      new Promise((resolve) => setTimeout(resolve, 50));

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }

      // The workspace's own install spawned the host and returned. The plugin
      // is still activating, which is the window a cold open lands in.
      expect(host.getStatus("example-plugin")).toBe("starting");

      const rode = open();
      await settleQueuedWork();
      expect(rode.isOpen()).toBe(false);
      // The call the surface makes next is refused for as long as this lasts.
      await expect(
        host.invokeCommand("example-plugin", "example.command"),
      ).rejects.toThrow('Plugin "example-plugin" is still starting.');

      activationGate.resolve();
      await rode.settled;
      expect(host.getStatus("example-plugin")).toBe("ready");
      await host.invokeCommand("example-plugin", "example.command");
      // It rode along on a host the install started, so it does not own it.
      expect(panelStartedHosts.size).toBe(0);

      // The cold path: this open starts the host itself and must wait the
      // same way.
      await host.stop("example-plugin");
      activationGate = deferred();
      const cold = open();
      await waitFor(
        () => host.getStatus("example-plugin") === "starting",
        "The open did not start the host.",
      );
      await settleQueuedWork();
      expect(cold.isOpen()).toBe(false);

      activationGate.resolve();
      await cold.settled;
      expect(host.getStatus("example-plugin")).toBe("ready");
      await host.invokeCommand("example-plugin", "example.command");
      expect([...panelStartedHosts]).toEqual([
        pluginLifecycleKey("workspace-1", "example-plugin"),
      ]);
    } finally {
      activationGate.resolve();
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
      pnpmRunnerEntry,
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
      pnpmRunnerEntry,
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
      pnpmRunnerEntry,
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

  it("holds a change that lands between reconcile's verify pass and the build's own snapshot (#779 round 13 A1)", async () => {
    const fixture = await createPluginWorkspace();
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

    // Session 1: a normal install records the approval.
    pipeline = new PluginPipeline({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      pluginHost: newHost(),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });
    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
    } finally {
      await pipeline.dispose();
    }
    const approvedState = await readPluginLocalState(
      fixture.stateDir,
      fixture.workspaceRoot,
    );
    if (!approvedState.ok) throw new Error(approvedState.warning);
    const approvedHash = approvedState.state.plugins["example-plugin"]?.approvedHash;
    expect(approvedHash).toEqual(expect.any(String));

    // Session 2: the startup reconcile verifies the approved source
    // (snapshot 1) and then rebuilds it (snapshot 2). The interloper lands
    // exactly between the two.
    let snapshotCalls = 0;
    pipeline = new PluginPipeline({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      pluginHost: newHost(),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        snapshot: async (input) => {
          snapshotCalls += 1;
          if (snapshotCalls === 2) {
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
      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        "The change inside reconcile's build window was not held for approval.",
      );
      // The interloper was neither recorded as approved nor executed.
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["example-plugin"]?.approvedHash).toBe(approvedHash);
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .not.toContain("window-interloper");
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

  it("holds a change that lands between enable's verify pass and the rebuild's own snapshot (#779 round 13 A1)", async () => {
    const fixture = await createPluginWorkspace();
    let armed = false;
    let armedSnapshots = 0;
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
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        snapshot: async (input) => {
          if (armed) {
            armedSnapshots += 1;
            // Call 1 is enable's verify pass; call 2 is the rebuild's own
            // snapshot. The interloper lands exactly between.
            if (armedSnapshots === 2) {
              await writeFile(fixture.entryPath, [
                'export const marker = "window-interloper";',
                "export default { activate() {} };",
                "",
              ].join("\n"));
            }
          }
          return snapshotPluginSource(input);
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const approvedState = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!approvedState.ok) throw new Error(approvedState.warning);
      const approvedHash =
        approvedState.state.plugins["example-plugin"]?.approvedHash;

      const disabledResult = await pipeline.disable("example-plugin");
      expect(disabledResult.ok).toBe(true);
      // The built bundle is tampered while the plugin is off, so enable's
      // bundle check fails and it has to rebuild from the verified source.
      await writeFile(
        liveBundlePath(fixture, "example-plugin"),
        "globalThis.tampered = true;\n",
      );

      armed = true;
      const enabled = await pipeline.enable("example-plugin");
      expect(enabled.ok).toBe(true);
      expect(pipeline.list()[0]).toMatchObject({
        status: "disabled-pending-approval",
        disabledReason: "approval",
      });
      // The interloper was neither recorded as approved nor built.
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["example-plugin"]?.approvedHash).toBe(approvedHash);
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .toBe("globalThis.tampered = true;\n");
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

  it("bounds a noisy candidate's diagnostics so the plugin list and its status events stay inside the IPC schema (#779 round 13 A2)", async () => {
    const fixture = await createPluginWorkspace();
    const noisy: InstalledPluginRecord = {
      id: "noisy-plugin",
      directoryName: "noisy-plugin",
      rootPath: join(fixture.workspaceRoot, "plugins", "noisy-plugin"),
      manifest: null,
      iconPath: null,
      valid: false,
      diagnostics: Array.from(
        { length: 400 },
        (_, index) => `manifest problem ${index}: ${"x".repeat(40)}`,
      ),
    };
    // An installed record for the noisy candidate, so its seeded status —
    // the payload the status emit crosses IPC with — carries the error too.
    await mutatePluginRecord(
      fixture.stateDir,
      fixture.workspaceRoot,
      "noisy-plugin",
      () => ({
        disabled: false,
        approvedHash: "ab".repeat(32),
        installedBaselineHash: "ab".repeat(32),
        directoryName: "noisy-plugin",
      }),
    );
    const events: PluginPipelineStatusEvent[] = [];
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
      pnpmRunnerEntry,
      onStatusChange: (event) => events.push(event),
      operations: {
        discover: async () => [noisy],
      },
    });

    try {
      await pipeline.start();
      // Status events emit through queueMicrotask; let them drain.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const row = pipeline.list().find((entry) => entry.id === "noisy-plugin");
      expect(row?.error?.message).toContain("characters elided");
      expect(row?.error?.message).toContain(
        "this message is capped at 8000 characters.",
      );
      expect(row?.error?.message.length ?? 0).toBeLessThanOrEqual(8_000);
      // The production oracle: the bridge schema every listed record and
      // every status event must pass to cross IPC at all.
      const parsedRow = PluginStatusRecord.safeParse(row);
      expect(parsedRow.success, parsedRow.error?.message).toBe(true);
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        const parsed = PluginStatusChangedEvent.safeParse({
          workspaceId: "workspace-a",
          ...event,
        });
        expect(parsed.success, parsed.error?.message).toBe(true);
      }
    } finally {
      await pipeline.dispose();
    }
  });

  it("compares the newest door write's hash when a second write lands while the refresh is queued (#779 round 13 A3)", async () => {
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
      pnpmRunnerEntry,
      operations: {
        install: async (input) => {
          installCalls += 1;
          // approve()'s install call blocks, occupying this plugin's job
          // queue so both door writes land while the refresh is queued.
          if (installCalls === 2) await installGate.promise;
          return installPluginDependencies({ ...input, forkProcess: nodeForkProcess });
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const originalHash = pipeline.list()[0]?.approvedHash;

      const approvePromise = pipeline.approve("example-plugin");
      await waitFor(() => installCalls === 2, "approve() never reached the gated install.");

      // A routine multi-file agent edit: two door writes in quick
      // succession. The dedup drops the second notification's queue entry,
      // and the surviving refresh must still see the newest recorded delta
      // — the tree that contains BOTH writes.
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "door-one";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "door-two";',
        "export default { activate() {} };",
        "",
      ].join("\n"));

      installGate.resolve();
      const approved = await approvePromise;
      expect(approved.ok).toBe(true);

      // Every byte arrived through the door, so the single surviving
      // refresh auto-approves the combined tree and the plugin runs.
      await waitFor(
        () => {
          const row = pipeline.list()[0];
          return row?.status === "ready" && row.approvedHash !== originalHash;
        },
        "The combined door-written tree was not auto-approved.",
        60_000,
      );
      expect(pipeline.list()[0]?.disabledReason).toBeNull();
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .toContain("door-two");
    } finally {
      await pipeline.dispose();
    }
  }, 180_000);

  it("brings a plugin back from an approval hold without a user-disable label once its door writes settle (#779 round 13 A3)", async () => {
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
      pnpmRunnerEntry,
      operations: {
        install: async (input) => {
          installCalls += 1;
          if (installCalls === 2) await installGate.promise;
          return installPluginDependencies({ ...input, forkProcess: nodeForkProcess });
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      // First: a door write raced by a disk-only interloper, so the refresh
      // holds for approval (the round-3 finding-1 behavior).
      const approvePromise = pipeline.approve("example-plugin");
      await waitFor(() => installCalls === 2, "approve() never reached the gated install.");
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "door-held";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
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
        "The interloper was not held for approval.",
        60_000,
      );
      expect(pipeline.list()[0]?.disabledReason).toBe("approval");

      // Then: the agent's next door write matches the live tree exactly.
      // The hold's disabled bit came from the approval path, not the user,
      // so the plugin must come back running — not stay stopped under a
      // "user" label the user never chose.
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "door-fixed";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        `The settled door write did not bring the plugin back; status is ` +
          `"${pipeline.list()[0]?.status}" ` +
          `(disabledReason "${pipeline.list()[0]?.disabledReason}").`,
        60_000,
      );
      expect(pipeline.list()[0]?.disabledReason).toBeNull();
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["example-plugin"]?.disabled).toBe(false);
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .toContain("door-fixed");
    } finally {
      await pipeline.dispose();
    }
  }, 180_000);

  it("holds ambient bytes already on disk when a door write lands, instead of folding them into its approval (#779 round 14 A1)", async () => {
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
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const approvedHash = pipeline.list()[0]?.approvedHash;

      // A watcher-class change — a git checkout, a mirror delivery — that
      // is already on disk when the door write arrives. Nothing raced: the
      // door write is simply not the author of these bytes.
      await writeFile(fixture.entryPath, [
        'export const marker = "ambient-interloper";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await doorWrite(
        pipeline,
        "example-plugin",
        join(fixture.pluginRoot, "src", "extra.ts"),
        'export const doorAuthored = true;\n',
      );

      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        `The ambient bytes were not held for approval; status is ` +
          `"${pipeline.list()[0]?.status}".`,
        60_000,
      );
      // The interloper's bytes were never approved, recorded, or built.
      expect(pipeline.list()[0]?.approvedHash).toBe(approvedHash);
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["example-plugin"]?.approvedHash).toBe(approvedHash);
      expect(state.state.plugins["example-plugin"]?.installedBaselineHash)
        .toBe(approvedHash);
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .not.toContain("ambient-interloper");
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

  it("keeps holding while an interloper file survives door writes, and releases once the tree is baseline plus door deltas (#779 round 14 A1)", async () => {
    const fixture = await createPluginWorkspace();
    let snapshotCalls = 0;
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
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        snapshot: async (input) => {
          snapshotCalls += 1;
          return snapshotPluginSource(input);
        },
      },
    });
    const interloperPath = join(fixture.pluginRoot, "src", "evil.ts");

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      // An interloper FILE lands out of band and the watcher holds it.
      await writeFile(interloperPath, "globalThis.evil = true;\n");
      pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/evil.ts",
        operation: "create",
      }]);
      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        "The interloper file was not held for approval.",
        60_000,
      );

      // A later door write that does NOT remove the interloper. The door
      // cannot delete (the SDK write surface has no delete), so the
      // interloper file survives — and it must keep the hold: under the
      // whole-tree door hash it rode this write straight to approval.
      const refreshesBefore = snapshotCalls;
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "door-progress";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await waitFor(
        () => snapshotCalls > refreshesBefore,
        "The door write's refresh never ran.",
        60_000,
      );
      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        `The surviving interloper did not keep the hold; status is ` +
          `"${pipeline.list()[0]?.status}".`,
        60_000,
      );
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .not.toContain("door-progress");

      // The interloper is removed out of band; the tree now equals the
      // approved baseline plus the accumulated door deltas, so the next
      // door write's refresh releases the hold and the plugin runs.
      await rm(interloperPath);
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "door-final";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        `The restored tree did not release the hold; status is ` +
          `"${pipeline.list()[0]?.status}" ` +
          `(disabledReason "${pipeline.list()[0]?.disabledReason}").`,
        60_000,
      );
      expect(pipeline.list()[0]?.disabledReason).toBeNull();
      const bundle = await readFile(
        liveBundlePath(fixture, "example-plugin"),
        "utf8",
      );
      expect(bundle).toContain("door-final");
      expect(bundle).not.toContain("evil");

      // Finally: an interloper overwrites a file and a door write restores
      // its exact approved bytes. The live tree then equals the approved
      // hash itself, and the hold — written by the approval path, never
      // the user — releases through the same predicate.
      const approvedText = [
        'export const marker = "door-final";',
        "export default { activate() {} };",
        "",
      ].join("\n");
      await writeFile(fixture.entryPath, [
        'export const marker = "second-interloper";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/index.ts",
        operation: "update",
      }]);
      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        "The second interloper was not held for approval.",
        60_000,
      );
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, approvedText);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        `The door-restored approved bytes did not release the hold; status ` +
          `is "${pipeline.list()[0]?.status}" ` +
          `(disabledReason "${pipeline.list()[0]?.disabledReason}").`,
        60_000,
      );
      expect(pipeline.list()[0]?.disabledReason).toBeNull();
    } finally {
      await pipeline.dispose();
    }
  }, 180_000);

  it("builds a door-write sequence whose second refresh was deduped behind a queued watcher reconcile (#779 round 14 A2)", async () => {
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
      pnpmRunnerEntry,
      operations: {
        install: async (input) => {
          installCalls += 1;
          // The FIRST door write's own rebuild blocks here, occupying the
          // queue while the watcher reconcile and the second door write
          // arrive.
          if (installCalls === 2) await installGate.promise;
          return installPluginDependencies({ ...input, forkProcess: nodeForkProcess });
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      // Door write 1: its refresh starts building and blocks at install.
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "door-one";',
        "export default { activate() {} };",
        "",
      ].join("\n"));
      await waitFor(() => installCalls === 2, "The first door rebuild never started.");

      // The watcher observes door write 1's own disk change and queues a
      // reconcile behind the running job. Awaiting the batch is what makes
      // the dedup below the thing under test: the reconcile holds the one
      // refresh slot before door write 2 asks for it.
      await pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/index.ts",
        operation: "update",
      }]);

      // Door write 2: its refresh notification is dropped by the dedup —
      // the watcher reconcile already holds the queue slot. The surviving
      // reconcile must still take the door path: every deviation from the
      // baseline arrived through the door.
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, [
        'export const marker = "door-two";',
        "export default { activate() {} };",
        "",
      ].join("\n"));

      installGate.resolve();
      // Door write 1's own rebuild publishes its door-one tree first, and the
      // plugin passes back through "ready" there while the surviving
      // reconcile is still queued. The sequence has settled only once that
      // reconcile's own rebuild — the third install — has finished.
      await waitFor(
        () => {
          const row = pipeline.list()[0];
          return installCalls === 3 && row?.status === "ready" &&
            row.disabledReason === null;
        },
        () =>
          `The deduped door sequence did not end ready; status is ` +
          `"${pipeline.list()[0]?.status}" ` +
          `(disabledReason "${pipeline.list()[0]?.disabledReason}") ` +
          `after ${installCalls} installs.`,
        120_000,
      );
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .toContain("door-two");
    } finally {
      await pipeline.dispose();
    }
  }, 180_000);

  it("bounds a drifted snapshot manifest's diagnostics so the failure crosses the bridge schema (#779 round 14 C1)", async () => {
    const fixture = await createPluginWorkspace();
    // Every field bound is respected — 100 panels is the declared maximum —
    // yet each empty panel entry yields several parse issues, so the joined
    // diagnostics far exceed the bridge's 10,000-character message cap.
    const noisyManifest = `${JSON.stringify({
      version: 1,
      name: "example-plugin",
      entry: "src/index.ts",
      panels: Array.from({ length: 100 }, () => ({})),
    })}\n`;
    let corruptNextSnapshot = false;
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
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        // The manifest drifts inside the snapshot window — the same window
        // an agent's partial write hits routinely.
        snapshot: async (input) => {
          const result = await snapshotPluginSource(input);
          if (result.ok && corruptNextSnapshot) {
            corruptNextSnapshot = false;
            await writeFile(
              join(result.snapshotRoot, "dohc-plugin.json"),
              noisyManifest,
            );
          }
          return result;
        },
      },
    });

    try {
      await pipeline.start();
      corruptNextSnapshot = true;
      const installed = await pipeline.install("example-plugin");
      expect(installed.ok).toBe(false);
      if (installed.ok) throw new Error("unreachable");
      expect(installed.error.code).toBe("invalid-manifest");
      expect(installed.error.message.length).toBeLessThanOrEqual(8_000);
      expect(installed.error.message).toContain("characters elided");
      expect(installed.error.message).toContain(
        "this message is capped at 8000 characters.",
      );
      // The production oracles: the bridge schemas the action result and
      // every listed row must pass to cross IPC at all.
      const parsedAction = PluginActionResult.safeParse(installed);
      expect(parsedAction.success, parsedAction.error?.message).toBe(true);
      for (const row of pipeline.list()) {
        const parsedRow = PluginStatusRecord.safeParse(row);
        expect(parsedRow.success, parsedRow.error?.message).toBe(true);
      }
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

  it("reconciles a scoped plugin in a differently named directory when its manifest returns (#779 round 13 D2)", async () => {
    const fixture = await createNamedPluginWorkspace("foo", "@scope/bar");
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
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("@scope/bar");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const manifestPath = join(fixture.pluginRoot, "dohc-plugin.json");
      const manifestText = await readFile(manifestPath, "utf8");

      await writeFile(manifestPath, "{ half written\n");
      pipeline.handleWatcherEvents([{
        path: "plugins/foo/dohc-plugin.json",
        operation: "update",
      }]);
      await waitFor(
        () => pipeline.list()[0]?.status === "invalid",
        "The broken manifest never landed as an invalid row.",
      );

      // While the manifest was broken, discovery knew this root only by its
      // fallback id "foo" — not "@scope/bar". Restoring the manifest has to
      // reconcile through the root the two identities share, or the plugin
      // never returns to running.
      await writeFile(manifestPath, manifestText);
      pipeline.handleWatcherEvents([{
        path: "plugins/foo/dohc-plugin.json",
        operation: "update",
      }]);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "The restored manifest did not return the scoped plugin to ready.",
        60_000,
      );
      expect(pipeline.list()[0]).toMatchObject({
        id: "@scope/bar",
        directoryName: "foo",
        valid: true,
      });
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

  it("refuses uninstall preflight when the source root cannot be inspected (#779 round 13 D3)", async () => {
    const fixture = await createPluginWorkspace();
    let epermArmed = false;
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
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        inspectPath: (async (path: string | Buffer | URL) => {
          // A locked plugin root on Windows: lstat fails with EPERM, which
          // is not "the tree is gone".
          if (epermArmed && resolve(String(path)) === resolve(fixture.pluginRoot)) {
            const error = new Error(
              "EPERM: operation not permitted, lstat",
            ) as NodeJS.ErrnoException;
            error.code = "EPERM";
            throw error;
          }
          return lstat(path);
        }) as typeof lstat,
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      epermArmed = true;
      const preflight = await pipeline.uninstallPreflight("example-plugin");
      expect(preflight.ok).toBe(false);
      if (preflight.ok) throw new Error("unreachable");
      expect(preflight.error.message).toContain("could not be inspected");
      // Nothing was decided, so nothing was dropped: the record, the source
      // tree, and the plugin data are all still there.
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["example-plugin"]?.approvedHash).toEqual(
        expect.any(String),
      );
      await expect(lstat(fixture.pluginRoot)).resolves.toBeDefined();

      // Once the root is inspectable again, the same uninstall proceeds.
      epermArmed = false;
      const retry = await pipeline.uninstallPreflight("example-plugin");
      expect(retry.ok).toBe(true);
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

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
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        snapshot: async (input) => {
          const snapshot = await snapshotPluginSource(input);
          if (!snapshot.ok) return snapshot;
          return {
            ...snapshot,
            publish: async () => {
              // The live source tree is as reachable by a running plugin as
              // the bundle is, so the stop has to precede THIS publish too,
              // not just the bundle's (#779 round 13 D4).
              order.push("snapshot-publish");
              return snapshot.publish();
            },
          };
        },
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

      // Nothing may run out of the live root while it is being replaced:
      // the stop precedes BOTH publishes (#779 round 13 D4 — recording only
      // the bundle publish let the stop slide between the two).
      expect(order).toEqual(["stop", "snapshot-publish", "publish"]);
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

  it("keeps a crash-loop disabled plugin disabled through a watcher event that changes nothing (#779 round 15 A1)", async () => {
    const fixture = await createPluginWorkspace();
    let snapshotCalls = 0;
    let installCalls = 0;
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      // Every activation fails immediately, so the host's own crash-loop
      // accounting reaches its threshold and writes the real disabled record.
      spawnTransport: vi.fn<PluginHostOptions["spawnTransport"]>(() => ({
        request: async <T = unknown>(method: string): Promise<T> => {
          if (method === "plugin.activate") {
            throw new Error("plugin activation failed");
          }
          return {} as T;
        },
        notify: () => undefined,
        dispose: async () => undefined,
      })),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    const resetCrashAccounting = vi.spyOn(host, "resetCrashAccounting");
    pipeline = new PluginPipeline({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      pluginHost: host,
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) => {
          installCalls += 1;
          return installPluginDependencies({ ...input, forkProcess: nodeForkProcess });
        },
        snapshot: async (input) => {
          snapshotCalls += 1;
          return snapshotPluginSource(input);
        },
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.disabledReason === "crash-loop",
        `The plugin never crash-loop disabled; status is ` +
          `"${pipeline.list()[0]?.status}".`,
        60_000,
      );
      const disabledState = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      expect(disabledState.ok && disabledState.state.plugins["example-plugin"]?.disabled)
        .toBe(true);

      const snapshotsBefore = snapshotCalls;
      const installsBefore = installCalls;
      resetCrashAccounting.mockClear();

      // Churn under the plugin root that leaves the source hash exactly where
      // it was — a metadata touch, a node_modules write. Nothing about the
      // crash loop is fixed, so nothing may rebuild, restart, or forgive the
      // failures already counted.
      pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/index.ts",
        operation: "update",
      }]);
      await waitFor(
        () => snapshotCalls > snapshotsBefore,
        "The watcher reconcile never ran.",
        60_000,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      const row = pipeline.list()[0];
      expect(row?.status).toBe("disabled");
      expect(row?.disabledReason).toBe("crash-loop");
      // A rebuild would take its own second snapshot and install again.
      expect(snapshotCalls).toBe(snapshotsBefore + 1);
      expect(installCalls).toBe(installsBefore);
      expect(resetCrashAccounting).not.toHaveBeenCalled();
      const afterState = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      expect(afterState.ok && afterState.state.plugins["example-plugin"]?.disabled)
        .toBe(true);
    } finally {
      await pipeline.dispose();
    }
  }, 180_000);

  it("carries every declared contribution across the bridge, so a plugin's views and web apps reach the renderer", async () => {
    const fixture = await createPluginWorkspace();
    await writeFile(join(fixture.pluginRoot, "dohc-plugin.json"), `${JSON.stringify({
      version: 1,
      name: "example-plugin",
      entry: "src/index.ts",
      panels: [
        { id: "main", title: "Main", entry: "panel/index.html" },
        {
          id: "sites",
          title: "Sites",
          entry: "panel/sites.html",
          placement: "view",
          icon: "icon.svg",
        },
      ],
      webApps: [{ id: "preview", title: "Preview", instanced: true }],
    }, null, 2)}\n`);
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
      pnpmRunnerEntry,
    });

    try {
      await pipeline.start();
      const listed = pipeline.list();

      // The production oracle: main.ts's listPlugins handler parses exactly
      // this. A contribution the pipeline drops fails the whole list here,
      // taking every plugin's row down with it.
      const parsed = ListPluginsResult.safeParse({ ok: true, plugins: listed });
      expect(parsed.success, parsed.error?.message).toBe(true);

      expect(listed[0]?.panels).toEqual([
        { id: "main", title: "Main", placement: "editor", icon: null },
        { id: "sites", title: "Sites", placement: "view", icon: "icon.svg" },
      ]);
      expect(listed[0]?.webApps).toEqual([
        { id: "preview", title: "Preview", instanced: true },
      ]);
    } finally {
      await pipeline.dispose();
    }
  });

  it("bounds an enormous manifest diagnostic so the whole plugin list still crosses the bridge (#779 round 15 A2)", async () => {
    const fixture = await createPluginWorkspace();
    // A hostile dohc-plugin.json: every declared field is valid and the file
    // is far under the manifest reader's 256 KiB cap, but one unrecognized
    // key carries its whole name into the strict-object diagnostic.
    await writeFile(join(fixture.pluginRoot, "dohc-plugin.json"), `${JSON.stringify({
      version: 1,
      name: "example-plugin",
      entry: "src/index.ts",
      [`k${"x".repeat(10_100)}`]: 1,
    })}\n`);
    const seededRoot = join(fixture.workspaceRoot, "plugins", "seeded-plugin");
    await mkdir(join(seededRoot, "src"), { recursive: true });
    await writeFile(join(seededRoot, "dohc-plugin.json"), `${JSON.stringify({
      version: 1,
      name: "seeded-plugin",
      entry: "src/index.ts",
      [`k${"x".repeat(30_000)}`]: 1,
    })}\n`);
    // An installed record for the second root, so its status is seeded and
    // emitted rather than listed straight from the discovery candidate: both
    // ways a diagnostic reaches a status record are covered.
    await mutatePluginRecord(
      fixture.stateDir,
      fixture.workspaceRoot,
      "seeded-plugin",
      () => ({
        disabled: false,
        approvedHash: "ab".repeat(32),
        installedBaselineHash: "ab".repeat(32),
        directoryName: "seeded-plugin",
      }),
    );
    const events: PluginPipelineStatusEvent[] = [];
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
      pnpmRunnerEntry,
      onStatusChange: (event) => events.push(event),
    });

    try {
      await pipeline.start();
      // Status events emit through queueMicrotask; let them drain.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const listed = pipeline.list();
      expect(listed).toHaveLength(2);
      for (const row of listed) {
        expect(row.diagnostics.some((line) => line.includes("characters elided")))
          .toBe(true);
        for (const line of row.diagnostics) {
          expect(line.length).toBeLessThanOrEqual(8_000);
        }
      }
      // The production oracle: main.ts's listPlugins handler parses exactly
      // this, and one over-cap entry denied the whole Plugins section —
      // including every other plugin's Disable and Uninstall.
      const parsed = ListPluginsResult.safeParse({ ok: true, plugins: listed });
      expect(parsed.success, parsed.error?.message).toBe(true);
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        const parsedEvent = PluginStatusChangedEvent.safeParse({
          workspaceId: "workspace-a",
          ...event,
        });
        expect(parsedEvent.success, parsedEvent.error?.message).toBe(true);
      }
    } finally {
      await pipeline.dispose();
    }
  });

  it("bounds an enormous lifecycle warning so the plugin list still crosses the bridge (#779 round 15 A2)", async () => {
    const fixture = await createPluginWorkspace();
    // A package version is free text. This one is valid semver build
    // metadata, so the pinned pnpm installs it, and 20,000 characters long,
    // so the scan's allowed-hook warning line carries all of it.
    await writeFile(join(fixture.pluginRoot, "package.json"), `${JSON.stringify({
      name: "example-plugin",
      version: `1.0.0+${"x".repeat(20_000)}`,
      private: true,
      type: "module",
      packageManager: "pnpm@11.20.0",
      scripts: { postinstall: "node --version" },
    }, null, 2)}\n`);
    await writeFile(join(fixture.pluginRoot, "dohc-plugin.json"), `${JSON.stringify({
      version: 1,
      name: "example-plugin",
      displayName: "Example plugin",
      entry: "src/index.ts",
      allowSkippedScripts: ["example-plugin"],
    }, null, 2)}\n`);
    const events: PluginPipelineStatusEvent[] = [];
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
      pnpmRunnerEntry,
      onStatusChange: (event) => events.push(event),
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      const row = pipeline.list()[0];
      expect(row?.warnings.some((line) => line.includes("characters elided")))
        .toBe(true);
      for (const line of row?.warnings ?? []) {
        expect(line.length).toBeLessThanOrEqual(8_000);
      }
      const parsed = ListPluginsResult.safeParse({
        ok: true,
        plugins: pipeline.list(),
      });
      expect(parsed.success, parsed.error?.message).toBe(true);
      for (const event of events) {
        const parsedEvent = PluginStatusChangedEvent.safeParse({
          workspaceId: "workspace-a",
          ...event,
        });
        expect(parsedEvent.success, parsedEvent.error?.message).toBe(true);
      }
    } finally {
      await pipeline.dispose();
    }
  }, 180_000);

  it("never auto-approves a door write against a baseline it cannot prove (#779 round 15 A4)", async () => {
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
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });
    const baselinePath = pluginBaselineManifestPath(
      pluginDataDir(fixture.stateDir, fixture.workspaceRoot),
      "example-plugin",
    );
    const source = (marker: string): string =>
      [
        `export const marker = "${marker}";`,
        "export default { activate() {} };",
        "",
      ].join("\n");
    /** One door write against the current baseline; it must hold, not run. */
    const expectHold = async (marker: string): Promise<void> => {
      await doorWrite(pipeline, "example-plugin", fixture.entryPath, source(marker));
      await waitFor(
        () => pipeline.list()[0]?.status === "disabled-pending-approval",
        `The door write auto-approved against an unprovable baseline; status ` +
          `is "${pipeline.list()[0]?.status}".`,
        60_000,
      );
      expect(await readFile(liveBundlePath(fixture, "example-plugin"), "utf8"))
        .not.toContain(marker);
    };
    const approveAndRun = async (): Promise<void> => {
      const approved = await pipeline.approve("example-plugin");
      if (!approved.ok) throw new Error(approved.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "The approved plugin did not come back.",
        60_000,
      );
    };

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      // The baseline of the first approved tree, kept for probe 2.
      const firstBaseline = await readFile(baselinePath, "utf8");

      // Probe 1: no baseline at all. Nothing describes the approved tree, so
      // there is no overlay to compare a door write against.
      await rm(baselinePath);
      await expectHold("probe-one");
      await approveAndRun();

      // Probe 2: a self-consistent baseline that describes an older approved
      // tree. It proves nothing about the hash recorded now.
      await writeFile(baselinePath, firstBaseline);
      await expectHold("probe-two");
      await approveAndRun();

      // Probe 3: a baseline whose file list was forged. Its own sourceHash no
      // longer re-derives from the files it claims.
      const forged = JSON.parse(await readFile(baselinePath, "utf8")) as {
        sourceHash: string;
        files: { relPath: string; sha256: string }[];
      };
      forged.files.push({ relPath: "src/ghost.ts", sha256: "cd".repeat(32) });
      await writeFile(baselinePath, `${JSON.stringify(forged, null, 2)}\n`);
      await expectHold("probe-three");
    } finally {
      await pipeline.dispose();
    }
  }, 240_000);

  it("carries the manifest's metadata through the pipeline into the IPC contract", async () => {
    const fixture = await createPluginWorkspace();
    await writeFile(
      join(fixture.pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "example-plugin",
        displayName: "Example plugin",
        description: "Does one example thing on this workspace.",
        publisher: "dohc",
        pluginVersion: "0.0.33",
        repository: "https://github.com/pingdotgg/t3code",
        issues: "https://github.com/pingdotgg/t3code/issues",
        license: "MIT",
        icon: "icon.svg",
        entry: "src/index.ts",
      }, null, 2)}\n`,
    );
    await writeFile(join(fixture.pluginRoot, "icon.svg"), "<svg/>");

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
      pnpmRunnerEntry,
    });

    try {
      await pipeline.start();
      const listed = pipeline.list();

      expect(listed[0]).toMatchObject({
        id: "example-plugin",
        displayName: "Example plugin",
        description: "Does one example thing on this workspace.",
        publisher: "dohc",
        pluginVersion: "0.0.33",
        repository: "https://github.com/pingdotgg/t3code",
        issues: "https://github.com/pingdotgg/t3code/issues",
        license: "MIT",
        icon: "icon.svg",
      });
      // The renderer only ever sees what survives this parse, so the
      // contract's bounds are part of the plumbing, not a separate check.
      const parsed = ListPluginsResult.safeParse({ ok: true, plugins: listed });
      if (!parsed.success) throw new Error(parsed.error.message);
      expect(parsed.data.ok && parsed.data.plugins[0]?.publisher).toBe("dohc");
      expect(parsed.data.ok && parsed.data.plugins[0]?.pluginVersion)
        .toBe("0.0.33");
      expect(parsed.data.ok && parsed.data.plugins[0]?.repository)
        .toBe("https://github.com/pingdotgg/t3code");
      expect(parsed.data.ok && parsed.data.plugins[0]?.license).toBe("MIT");
    } finally {
      await pipeline.dispose();
    }
  });

  it("saves a setting and tells the plugin's host what its settings became", async () => {
    const fixture = await createPluginWorkspace();
    await writeFile(
      join(fixture.pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "example-plugin",
        entry: "src/index.ts",
        settings: [
          {
            key: "greeting",
            type: "string",
            label: "Greeting",
            default: "Hello",
          },
          { key: "shout", type: "boolean", label: "Shout", default: false },
        ],
      }, null, 2)}\n`,
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
    const told = vi.spyOn(host, "notifySettingsChanged");
    pipeline = new PluginPipeline({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      pluginHost: host,
      resourcesBasePath,
      pnpmRunnerEntry,
    });

    try {
      await pipeline.start();

      const values = await pipeline.setPluginSettings("example-plugin", {
        greeting: "Hei",
      });

      // Every declared setting under the one answer the user changed: a
      // plugin hears what its settings ARE, never the patch.
      expect(values).toEqual({ greeting: "Hei", shout: false });
      expect(told).toHaveBeenCalledWith("example-plugin", values);
      // Saved, not only announced.
      expect(await pipeline.getPluginSettings("example-plugin")).toEqual(values);
    } finally {
      await pipeline.dispose();
    }
  });

  it("advertises no icon, and says why, when the declared file is missing", async () => {
    const fixture = await createPluginWorkspace();
    await writeFile(
      join(fixture.pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "example-plugin",
        icon: "icon.svg",
        entry: "src/index.ts",
      }, null, 2)}\n`,
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
      pnpmRunnerEntry,
    });

    try {
      await pipeline.start();
      const listed = pipeline.list();

      expect(listed[0]?.icon).toBeNull();
      expect(listed[0]?.diagnostics.join(" ")).toContain("could not be read");
      // A broken icon is not a broken plugin.
      expect(listed[0]?.valid).toBe(true);
      expect(listed[0]?.status).toBe("discovered");
    } finally {
      await pipeline.dispose();
    }
  });
});
