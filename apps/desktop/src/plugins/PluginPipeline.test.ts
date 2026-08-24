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
import { createPluginAuthoredTextWriter } from "./pluginAuthoredWrite";
import { PLUGIN_HOST_METHODS } from "./pluginHostProtocol";
import {
  discoverInstalledPlugins,
  type InstalledPluginRecord,
} from "./pluginDiscovery";
import {
  type DoorWrittenDelta,
  overlayDoorWrittenSourceDeltas,
  PluginPipeline,
  type PluginPipelineRuntimeStopHooks,
  type PluginPipelineStatusEvent,
} from "./PluginPipeline";
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
  OfferedPluginAddError,
  addOfferedPlugin,
  listOfferedPlugins,
  removeAddedOfferedPlugin,
} from "./pluginOffers";
import { readPluginSettingsFile } from "./pluginSettingsFile";
import {
  HOST_CHANGE_REFUSED_ERROR_CODE,
  invokeRegisteredPluginCommand,
} from "./pluginCommandInvocation";
import { PluginHostOwnership } from "./pluginHostOwnership";
import type { PluginSettingDeclaration } from "./pluginManifestSchema";
import {
  hashPluginSourceFiles,
  pluginStateRoot,
  snapshotPluginSource,
} from "./pluginSourceSnapshot";
import {
  pluginBaselineManifestPath,
  pluginUninstallPreflight,
} from "./pluginUninstallPreflight";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

interface TestUninstallQueueClaim {
  readonly ready: Promise<void>;
  decide(decision: "stop" | "cancel"): void;
  release(): void;
  readonly stopOutcome: Promise<
    | { ok: true }
    | { ok: false; error: unknown }
  >;
  readonly outcome: Promise<
    | { ok: true }
    | { ok: false; error: unknown }
  >;
}

interface PluginPipelineQueueInternals {
  enqueueActionValue<T>(pluginId: string, run: () => Promise<T>): Promise<T>;
  claimUninstallCleanupQueues(
    cleanupIds: ReadonlyArray<string>,
    primaryPluginId: string,
    reservations: ReadonlyMap<string, unknown>,
    hooks: PluginPipelineRuntimeStopHooks,
  ): TestUninstallQueueClaim[];
}

type DoorWrittenDeltas = Map<
  string,
  Map<string, DoorWrittenDelta>
>;

function doorWrittenDeltasOf(pipeline: PluginPipeline): DoorWrittenDeltas {
  return (pipeline as unknown as { doorWrittenDeltas: DoorWrittenDeltas })
    .doorWrittenDeltas;
}

function transientStateOf(pipeline: PluginPipeline): {
  statuses: Map<string, unknown>;
  lastApprovedAttemptHash: Map<string, string>;
} {
  return pipeline as unknown as {
    statuses: Map<string, unknown>;
    lastApprovedAttemptHash: Map<string, string>;
  };
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

async function settleWithin<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 10_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function ensureFromCommand(
  pipeline: PluginPipeline,
  pluginId: string,
): Promise<{
  result: Awaited<ReturnType<PluginPipeline["ensureStarted"]>>["value"];
  exact: Awaited<ReturnType<PluginPipeline["ensureStarted"]>>;
}> {
  let exact: Awaited<ReturnType<PluginPipeline["ensureStarted"]>> | undefined;
  const command = await pipeline.hostOwnership.runCommand(
    pluginId,
    async (authority) => authority.start(async () => {
      exact = await pipeline.ensureStarted(pluginId, authority);
      return exact;
    }),
  );
  if (command.kind !== "completed" || command.value.kind !== "admitted") {
    throw new Error(`Plugin "${pluginId}" start was refused.`);
  }
  if (!exact) throw new Error(`Plugin "${pluginId}" returned no start result.`);
  return { result: command.value.value, exact };
}

async function ensureFromSurface(
  pipeline: PluginPipeline,
  pluginId: string,
): Promise<{
  result: Awaited<ReturnType<PluginPipeline["ensureStarted"]>>["value"];
  exact: Awaited<ReturnType<PluginPipeline["ensureStarted"]>>;
  release: () => Promise<void>;
}> {
  const lease = pipeline.hostOwnership.acquireSurface(pluginId);
  if ("kind" in lease) throw new Error(`Plugin "${pluginId}" surface was refused.`);
  let exact: Awaited<ReturnType<PluginPipeline["ensureStarted"]>> | undefined;
  const started = await lease.start(async (authority) => {
    exact = await pipeline.ensureStarted(pluginId, authority);
    return exact;
  });
  if (started.kind !== "admitted") {
    await lease.release();
    throw new Error(`Plugin "${pluginId}" start was refused.`);
  }
  if (!exact) {
    await lease.release();
    throw new Error(`Plugin "${pluginId}" returned no start result.`);
  }
  return { result: started.value, exact, release: () => lease.release() };
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

async function authoredDoorWrite(
  pipeline: PluginPipeline,
  workspaceRoot: string,
  path: string,
  text: string,
): Promise<void> {
  const write = createPluginAuthoredTextWriter({
    signal: undefined,
    requireWritableCapture: async () => ({
      workspaceRoot,
      capture: {
        writeAuthoredTextFile: async (absolutePath, writtenText) => {
          await writeFile(absolutePath, writtenText);
          return { resolvedAbsolutePath: absolutePath };
        },
      },
    }),
    pipeline: () => pipeline,
  });
  await write(path, text, {
    overwrite: true,
    author: {
      kind: "agent",
      agentId: "plugin:example-plugin",
      onBehalfOf: "local",
      agentRunId: "spawn-1",
    },
  });
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

async function createAliasUninstallFixture(options: {
  drainTimeoutMs?: number;
  onRuntimeStopped?: (pluginId: string) => void | Promise<void>;
} = {}): Promise<{
  fixture: Awaited<ReturnType<typeof createNamedPluginWorkspace>>;
  host: PluginHost;
  hostOwnership: PluginHostOwnership<PluginHost>;
  pipeline: PluginPipeline;
}> {
  const fixture = await createNamedPluginWorkspace("shared-dir", "runtime-id");
  await mutatePluginRecord(
    fixture.stateDir,
    fixture.workspaceRoot,
    "original-id",
    () => ({ directoryName: "shared-dir" }),
  );
  await mutatePluginRecord(
    fixture.stateDir,
    fixture.workspaceRoot,
    "runtime-id",
    () => ({ directoryName: "shared-dir" }),
  );
  let pipeline!: PluginPipeline;
  const host = new PluginHost({
    stateDir: fixture.stateDir,
    workspaceRoot: fixture.workspaceRoot,
    spawnTransport: fakeSpawnTransport(),
    routeSdkRequest: async () => ({}),
    onStatusChange: (pluginId, status) => {
      pipeline.noteRuntimeStatus(pluginId, status);
    },
  });
  const hostOwnership = new PluginHostOwnership(host, {
    drainTimeoutMs: options.drainTimeoutMs,
  });
  pipeline = new PluginPipeline({
    workspaceRoot: fixture.workspaceRoot,
    stateDir: fixture.stateDir,
    hostOwnership,
    resourcesBasePath,
    pnpmRunnerEntry,
    onRuntimeStopped: options.onRuntimeStopped,
    operations: {
      install: (input) =>
        installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
    },
  });
  await pipeline.start();
  return { fixture, host, hostOwnership, pipeline };
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

describe("overlayDoorWrittenSourceDeltas", () => {
  it("replaces and adds files by exact relative path", () => {
    const files = overlayDoorWrittenSourceDeltas(
      [{ relPath: "src/index.ts", sha256: "aaa" }],
      new Map([
        ["src/index.ts", { sha256: "bbb", seq: 1 }],
        ["src/new.ts", { sha256: "ccc", seq: 2 }],
      ]),
    );

    expect(files).toEqual([
      { relPath: "src/index.ts", sha256: "bbb" },
      { relPath: "src/new.ts", sha256: "ccc" },
    ]);
  });

  it("matches only provisional case drift to a baseline spelling", () => {
    const files = overlayDoorWrittenSourceDeltas(
      [{ relPath: "src/index.ts", sha256: "aaa" }],
      new Map([
        ["SRC/index.ts", { sha256: "bbb", seq: 1, provisional: true }],
        ["SRC/final.ts", { sha256: "ccc", seq: 2 }],
      ]),
      "darwin",
    );

    expect(files).toEqual([
      { relPath: "src/index.ts", sha256: "bbb" },
      { relPath: "SRC/final.ts", sha256: "ccc" },
    ]);
  });

  it("overlays a provisional delta onto its own exact baseline key, not a fold match", () => {
    const files = overlayDoorWrittenSourceDeltas(
      [
        { relPath: "SRC/a.ts", sha256: "upper" },
        { relPath: "src/a.ts", sha256: "lower" },
      ],
      new Map([["SRC/a.ts", {
        sha256: "written",
        seq: 1,
        provisional: true,
      }]]),
      "darwin",
    );

    expect(files).toEqual([
      { relPath: "SRC/a.ts", sha256: "written" },
      { relPath: "src/a.ts", sha256: "lower" },
    ]);
  });

  it("keeps baseline-absent provisional case variants distinct until recovery confirms one", () => {
    const files = overlayDoorWrittenSourceDeltas(
      [],
      new Map([
        ["SRC/new.ts", { sha256: "first", seq: 1, provisional: true }],
        ["src/new.ts", { sha256: "latest", seq: 2, provisional: true }],
      ]),
      "darwin",
    );

    expect(files).toEqual([
      { relPath: "SRC/new.ts", sha256: "first" },
      { relPath: "src/new.ts", sha256: "latest" },
    ]);
  });

  it("folds a provisional NFC path onto an NFD baseline spelling", () => {
    const nfdRelPath = "src/caf\u0065\u0301.ts";
    const nfcRelPath = "src/caf\u00e9.ts";
    const files = overlayDoorWrittenSourceDeltas(
      [{ relPath: nfdRelPath, sha256: "baseline" }],
      new Map([[nfcRelPath, {
        sha256: "delta",
        seq: 1,
        provisional: true,
      }]]),
      "darwin",
    );

    expect(files).toEqual([{ relPath: nfdRelPath, sha256: "delta" }]);
  });
});

describe("PluginPipeline real filesystem lifecycle", () => {
  // The following block is unique to feat/offer-builtin-driver-plugins
  // (offer/install, rename, and round-24 collision-disambiguation coverage),
  // grafted in whole during the merge with origin/main.

  it("discovers an added offer unapproved and installs it through the ordinary pipeline", async () => {
    const sourceFixture = await createPluginWorkspace();
    const builtinPluginsRoot = join(sourceFixture.root, "builtin-plugins");
    await cp(sourceFixture.pluginRoot, join(builtinPluginsRoot, "codex"), {
      recursive: true,
    });

    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-offer-pipeline-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    // A real workspace root always exists before any plugin operation runs —
    // dohc only opens an already-materialized folder — so this matches that
    // rather than leaving addOfferedPlugin's realpath() call to hit an
    // ENOENT this function was never meant to paper over.
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    await addOfferedPlugin({
      builtinPluginsRoot,
      workspaceRoot,
      directoryName: "codex",
      existingPluginIds: new Set(),
    });

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    const hostOwnership = new PluginHostOwnership(host);
    pipeline = new PluginPipeline({
      workspaceRoot,
      stateDir,
      hostOwnership,
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      expect(pipeline.list()).toEqual([
        expect.objectContaining({
          id: "example-plugin",
          directoryName: "codex",
          status: "discovered",
          valid: true,
          approvedHash: null,
        }),
      ]);

      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Added offered plugin did not reach ready after install.",
      );
      expect(pipeline.list()[0]).toMatchObject({
        id: "example-plugin",
        directoryName: "codex",
        status: "ready",
      });
      expect(pipeline.list()[0]?.approvedHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("refuses to add when discovery hasn't caught up with a same-id directory already on disk", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-offer-rescan-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const builtinPluginsRoot = join(targetRoot, "builtin-plugins");
    const builtinCodexRoot = join(builtinPluginsRoot, "codex");
    await mkdir(join(builtinCodexRoot, "src"), { recursive: true });
    await writeFile(
      join(builtinCodexRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "codex", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(join(builtinCodexRoot, "src", "main.ts"), "export default {};\n");

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    const hostOwnership = new PluginHostOwnership(host);
    pipeline = new PluginPipeline({
      workspaceRoot,
      stateDir,
      hostOwnership,
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      expect(pipeline.list()).toEqual([]);

      // Something other than this pipeline's own watcher — an agent, a
      // second client — created a directory claiming id "codex" under a
      // DIFFERENT name. The bytes are on disk, but this pipeline's own
      // discovery has not rescanned yet: pipeline.list() is stale.
      const renamedRoot = join(workspaceRoot, "plugins", "my-codex");
      await mkdir(join(renamedRoot, "src"), { recursive: true });
      await writeFile(
        join(renamedRoot, "dohc-plugin.json"),
        `${JSON.stringify({ version: 1, name: "codex", entry: "src/main.ts" }, null, 2)}\n`,
      );
      await writeFile(join(renamedRoot, "src", "main.ts"), "export default {};\n");
      expect(pipeline.list()).toEqual([]);

      // The fixed handler order: force the same rescan mechanism BEFORE
      // sampling ids, not only after the copy.
      await pipeline.handleWatcherEvents([{ operation: "update", path: "plugins" }]);
      const existingPluginIds = new Set(pipeline.list().map((entry) => entry.id));
      expect(existingPluginIds).toEqual(new Set(["codex"]));

      await expect(
        addOfferedPlugin({
          builtinPluginsRoot,
          workspaceRoot,
          directoryName: "codex",
          existingPluginIds,
        }),
      ).rejects.toBeInstanceOf(OfferedPluginAddError);

      // Nothing copied.
      await expect(
        lstat(join(workspaceRoot, "plugins", "codex")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("removes its own copy and leaves the concurrent plugin intact when a same-id directory appears mid-copy", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-offer-conflict-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const builtinPluginsRoot = join(targetRoot, "builtin-plugins");
    const builtinCodexRoot = join(builtinPluginsRoot, "codex");
    await mkdir(join(builtinCodexRoot, "src"), { recursive: true });
    await writeFile(
      join(builtinCodexRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "codex", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(join(builtinCodexRoot, "src", "main.ts"), "export default {};\n");

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      expect(pipeline.list()).toEqual([]);

      // The fixed handler's pre-copy rescan: nothing claims "codex" yet.
      await pipeline.handleWatcherEvents([{ operation: "update", path: "plugins" }]);
      const existingPluginIds = new Set(pipeline.list().map((entry) => entry.id));
      expect(existingPluginIds.size).toBe(0);

      const added = await addOfferedPlugin({
        builtinPluginsRoot,
        workspaceRoot,
        directoryName: "codex",
        existingPluginIds,
      });

      // Injected between the copy and the post-copy rescan — sorts before
      // "codex" lexically, so discovery's own tie-break hands the id to it
      // and demotes the copy this request just made.
      const concurrentRoot = join(workspaceRoot, "plugins", "aaa-codex");
      await mkdir(join(concurrentRoot, "src"), { recursive: true });
      await writeFile(
        join(concurrentRoot, "dohc-plugin.json"),
        `${JSON.stringify({ version: 1, name: "codex", entry: "src/main.ts" }, null, 2)}\n`,
      );
      await writeFile(join(concurrentRoot, "src", "main.ts"), "export default {};\n");

      // The fixed handler's post-copy rescan, then its OWN validity check:
      // the copy this request made lost the id it raced for.
      await pipeline.handleWatcherEvents([{ operation: "create", path: "plugins/codex" }]);
      const copied = pipeline.list().find((entry) => entry.directoryName === "codex");
      expect(copied?.valid).toBe(false);

      // The handler's cleanup on that conflict: remove what this request
      // wrote and rescan so the surviving side recovers.
      await removeAddedOfferedPlugin({
        workspaceRoot,
        directoryName: "codex",
        identity: added.identity,
        contentHash: added.contentHash,
      });
      await pipeline.handleWatcherEvents([{ operation: "update", path: "plugins" }]);

      await expect(
        lstat(join(workspaceRoot, "plugins", "codex")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const survivor = pipeline.list().find((entry) => entry.directoryName === "aaa-codex");
      expect(survivor).toMatchObject({ id: "codex", valid: true });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Round 8 finding 4: uninstallableCandidate() only fell back to a
  // discovery entry for a plugin that had SOME prior installation —
  // validCandidate() rejects an invalid manifest outright, so a copy added
  // by Add and never installed had no candidate at all, and Remove's
  // preflight dead-ended with "preflight-failed". A broken manifest must
  // not remove the only way back to delete it.

  // Round 8 finding 4: uninstallableCandidate() only fell back to a
  // discovery entry for a plugin that had SOME prior installation —
  // validCandidate() rejects an invalid manifest outright, so a copy added
  // by Add and never installed had no candidate at all, and Remove's
  // preflight dead-ended with "preflight-failed". A broken manifest must
  // not remove the only way back to delete it.
  it("lets Remove delete a discovered plugin whose manifest is invalid and was never installed", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-offer-remove-invalid-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const builtinPluginsRoot = join(targetRoot, "builtin-plugins");
    const builtinCodexRoot = join(builtinPluginsRoot, "codex");
    await mkdir(join(builtinCodexRoot, "src"), { recursive: true });
    await writeFile(
      join(builtinCodexRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "codex",
        displayName: "Codex",
        entry: "src/main.ts",
      }, null, 2)}\n`,
    );
    await writeFile(join(builtinCodexRoot, "src", "main.ts"), "export default {};\n");
    // listOfferedPlugins reads every built-in's manifest, not only codex's.
    const builtinClaudeCodeRoot = join(builtinPluginsRoot, "claude-code");
    await mkdir(join(builtinClaudeCodeRoot, "src"), { recursive: true });
    await writeFile(
      join(builtinClaudeCodeRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "claude-code",
        displayName: "Claude Code",
        entry: "src/main.ts",
      }, null, 2)}\n`,
    );
    await writeFile(join(builtinClaudeCodeRoot, "src", "main.ts"), "export default {};\n");

    await addOfferedPlugin({
      builtinPluginsRoot,
      workspaceRoot,
      directoryName: "codex",
      existingPluginIds: new Set(),
    });
    // Broken before the pipeline ever discovers it — the offer landed a
    // real copy, but it never becomes a valid, installable plugin.
    await writeFile(
      join(workspaceRoot, "plugins", "codex", "dohc-plugin.json"),
      "{ this is not valid JSON\n",
    );

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const row = pipeline.list()[0];
      expect(row).toMatchObject({
        directoryName: "codex",
        valid: false,
        status: "invalid",
        approvedHash: null,
      });
      const pluginId = row!.id;

      const preflight = await pipeline.uninstallPreflight(pluginId, pluginId);
      if (!preflight.ok) {
        throw new Error(`${preflight.error.stage}/${preflight.error.code}: ${preflight.error.message}`);
      }
      const removed = await pipeline.uninstall(pluginId, pluginId, preflight.confirmationToken);
      expect(removed.ok).toBe(true);

      await expect(
        lstat(join(workspaceRoot, "plugins", "codex")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(pipeline.list()).toEqual([]);

      // The offer is restored now that nothing occupies plugins/codex.
      const offers = await listOfferedPlugins(builtinPluginsRoot, workspaceRoot, new Set());
      expect(offers.map((offer) => offer.directoryName)).toContain("codex");
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Round 9 finding 3: a directory installed as "codex" whose install never
  // finished (no approvedHash) can still have left state and plugin data
  // filed under "codex" before its manifest broke. A broken manifest gives
  // discovery a directory-derived fallback id — "my-codex-copy" here, never
  // "codex" — and uninstall used to derive every cleanup path from THAT id
  // alone: it deleted the source correctly (the candidate's rootPath is
  // resolved by directory) but found nothing to delete under the fallback
  // key, silently stranding the real state and data under "codex" forever.

  // Round 9 finding 3: a directory installed as "codex" whose install never
  // finished (no approvedHash) can still have left state and plugin data
  // filed under "codex" before its manifest broke. A broken manifest gives
  // discovery a directory-derived fallback id — "my-codex-copy" here, never
  // "codex" — and uninstall used to derive every cleanup path from THAT id
  // alone: it deleted the source correctly (the candidate's rootPath is
  // resolved by directory) but found nothing to delete under the fallback
  // key, silently stranding the real state and data under "codex" forever.
  it("clears source AND the originally-keyed state when a never-approved install's manifest breaks under a different directory name", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-stranded-state-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const pluginRoot = join(workspaceRoot, "plugins", "my-codex-copy");
    await mkdir(join(pluginRoot, "src"), { recursive: true });
    await writeFile(
      join(pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "codex", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(join(pluginRoot, "src", "main.ts"), "export default {};\n");

    // A partial install left state under the manifest id "codex" —
    // directoryName is the join #779 round 9 B3 already relies on to find
    // it again once the manifest breaks — but approval never completed.
    await mutatePluginRecord(stateDir, workspaceRoot, "codex", () => ({
      directoryName: "my-codex-copy",
    }));
    const dohcDir = pluginDataDir(stateDir, workspaceRoot);
    const strandedStateRoot = pluginStateRoot(dohcDir, "codex");
    await mkdir(strandedStateRoot, { recursive: true });
    await writeFile(join(strandedStateRoot, "session.json"), "{}");

    // Broken before the pipeline ever discovers it — id falls back to the
    // directory name, which does not match the "codex" key above.
    await writeFile(join(pluginRoot, "dohc-plugin.json"), "{ this is not valid JSON\n");

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const row = pipeline.list()[0];
      expect(row).toMatchObject({
        directoryName: "my-codex-copy",
        id: "my-codex-copy",
        valid: false,
        approvedHash: null,
      });

      const preflight = await pipeline.uninstallPreflight(row!.id, row!.id);
      if (!preflight.ok) {
        throw new Error(`${preflight.error.stage}/${preflight.error.code}: ${preflight.error.message}`);
      }
      // Round 10 finding 1: cleanup deletes state under BOTH identities, so
      // the confirmation the user actually sees has to name that data
      // before they confirm — not only the fallback id's own (empty) state.
      expect(preflight.preflight.stateData).toMatchObject({ fileCount: 1 });
      expect(preflight.preflight.stateData?.path).toContain(strandedStateRoot);
      expect(
        preflight.preflight.warning?.details.some((detail) =>
          detail.includes("stored data")
        ),
      ).toBe(true);

      const removed = await pipeline.uninstall(row!.id, row!.id, preflight.confirmationToken);
      expect(removed.ok).toBe(true);

      // The source directory is gone.
      await expect(lstat(pluginRoot)).rejects.toMatchObject({ code: "ENOENT" });
      // The state stranded under the ORIGINAL "codex" key is gone too, not
      // silently left behind under a key nothing will ever visit again.
      await expect(lstat(strandedStateRoot)).rejects.toMatchObject({ code: "ENOENT" });
      const state = await readPluginLocalState(stateDir, workspaceRoot);
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["codex"]).toBeUndefined();
      expect(state.state.plugins["my-codex-copy"]).toBeUndefined();
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Round 11 finding 3: a discovered (never-installed) row's own id is only
  // ever a broken manifest's directory-derived fallback — a plain string
  // that can coincide with some OTHER, unrelated, VALID plugin's real
  // manifest id. classifyInstalledPlugins's own duplicate-id detection
  // never sees this collision at all: it only compares REAL, parsed
  // manifest ids against each other, and a broken manifest has none to
  // compare. Resolving by id first — id-matched candidates are never
  // ambiguous, discovery's duplicate handling already guarantees that
  // among valid manifests — used to hand this call the wrong plugin
  // entirely: the unrelated one whose id string happens to match, not the
  // one at the directory the caller actually named.

  // Round 11 finding 3: a discovered (never-installed) row's own id is only
  // ever a broken manifest's directory-derived fallback — a plain string
  // that can coincide with some OTHER, unrelated, VALID plugin's real
  // manifest id. classifyInstalledPlugins's own duplicate-id detection
  // never sees this collision at all: it only compares REAL, parsed
  // manifest ids against each other, and a broken manifest has none to
  // compare. Resolving by id first — id-matched candidates are never
  // ambiguous, discovery's duplicate handling already guarantees that
  // among valid manifests — used to hand this call the wrong plugin
  // entirely: the unrelated one whose id string happens to match, not the
  // one at the directory the caller actually named.
  it("resolves Remove by the exact directory named, even when an invalid row's fallback id collides with another plugin's real, INSTALLED id", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-id-collision-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    // The plugin genuinely installed and running under id "target-dir" —
    // in a directory named "other-dir", nothing to do with the row about
    // to be removed.
    const otherRoot = join(workspaceRoot, "plugins", "other-dir");
    await mkdir(join(otherRoot, "src"), { recursive: true });
    await writeFile(
      join(otherRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "target-dir", entry: "src/index.ts" }, null, 2)}\n`,
    );
    await writeFile(
      join(otherRoot, "package.json"),
      `${JSON.stringify({
        name: "target-dir",
        version: "1.0.0",
        private: true,
        type: "module",
        packageManager: "pnpm@11.20.0",
      }, null, 2)}\n`,
    );
    await writeFile(join(otherRoot, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "importers:",
      "  .: {}",
      "",
    ].join("\n"));
    await writeFile(
      join(otherRoot, "src", "index.ts"),
      'export default { activate() {} };\n',
    );

    let pipeline: PluginPipeline;
    // The dialog gathers the destructive inventory once. Execution then
    // re-resolves the same identity twice and probes only the source hash.
    const preflightStateRoots: (string | null)[] = [];
    const revalidatedSourceRoots: string[] = [];
    // #779-offers round 24 finding 4: the "removed" event this uninstall
    // emits must name the row that actually left — never the id alone,
    // which the still-installed survivor shares.
    const events: PluginPipelineStatusEvent[] = [];
    const newHost = () =>
      new PluginHost({
        stateDir,
        workspaceRoot,
        spawnTransport: fakeSpawnTransport(),
        routeSdkRequest: async () => ({}),
        onStatusChange: (pluginId, status) => {
          pipeline.noteRuntimeStatus(pluginId, status);
        },
      });
    const newPipeline = () =>
      new PluginPipeline({
        workspaceRoot,
        stateDir,
        hostOwnership: new PluginHostOwnership(newHost()),
        resourcesBasePath,
        pnpmRunnerEntry,
        onStatusChange: (event) => events.push(event),
        operations: {
          install: (input) =>
            installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
          uninstallPreflight: async (input) => {
            preflightStateRoots.push(input.stateRoot);
            return pluginUninstallPreflight(input);
          },
          hashSource: async (rootPath) => {
            revalidatedSourceRoots.push(rootPath);
            return hashPluginSourceFiles(rootPath);
          },
        },
      });

    pipeline = newPipeline();
    try {
      await pipeline.start();
      const installed = await pipeline.install("target-dir");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "The unrelated plugin did not reach ready.",
      );
    } finally {
      await pipeline.dispose();
    }

    // The unrelated plugin's own stored data, genuinely filed under the
    // id it was installed under — "target-dir" — the same key the invalid
    // row's own fallback id happens to collide with.
    const survivorStateRoot = pluginStateRoot(
      pluginDataDir(stateDir, workspaceRoot),
      "target-dir",
    );
    await mkdir(join(survivorStateRoot, "t3"), { recursive: true });
    await writeFile(join(survivorStateRoot, "t3", "session.sqlite"), "session-bytes");

    // The row the user actually clicks Remove on, added AFTER the other
    // plugin is already running: a broken manifest, so discovery names it
    // by its directory — "target-dir" — which is ALSO, coincidentally,
    // the real, installed manifest id the unrelated plugin above declares.
    const invalidRoot = join(workspaceRoot, "plugins", "target-dir");
    await mkdir(join(invalidRoot, "src"), { recursive: true });
    await writeFile(join(invalidRoot, "dohc-plugin.json"), "{ this is not valid JSON\n");
    await writeFile(join(invalidRoot, "src", "main.ts"), "export default {};\n");

    pipeline = newPipeline();
    try {
      await pipeline.start();
      await waitFor(
        () => pipeline.list().some((row) => row.directoryName === "other-dir" && row.status === "ready"),
        "The unrelated plugin was not running after reopening.",
      );
      const invalidRow = pipeline.list().find((row) => row.directoryName === "target-dir");
      const otherRow = pipeline.list().find((row) => row.directoryName === "other-dir");
      // The collision itself: both rows claim id "target-dir".
      expect(invalidRow).toMatchObject({ id: "target-dir", valid: false });
      expect(otherRow).toMatchObject({
        id: "target-dir",
        valid: true,
        approvedHash: expect.any(String),
      });

      // The user named the invalid row specifically — its own id AND its
      // own directory, exactly what the renderer sends for a discovered
      // row.
      const preflight = await pipeline.uninstallPreflight("target-dir", "target-dir");
      if (!preflight.ok) throw new Error(preflight.error.message);
      // Round 13: the dialog must not threaten data cleanup already
      // excludes. The survivor's real stored data planted above is not
      // named here at all — the invalid row genuinely has none of its
      // own — and the comparison never claims the invalid row's source
      // is "modified" against the survivor's own baseline; with no
      // baseline of its own, it honestly reads as unverifiable instead.
      expect(preflight.preflight.stateData).toBeNull();
      expect(preflight.preflight.warning?.summary ?? "").not.toContain("stored data");
      expect(preflight.preflight.verification).toBe("cannot-verify");
      expect(preflight.preflight.installedBaselineHash).toBeNull();

      events.length = 0;
      const removed = await pipeline.uninstall("target-dir", "target-dir", preflight.confirmationToken);
      expect(removed.ok).toBe(true);

      // Round 24 finding 4: the emitted event names the invalid row's OWN
      // directory — never "other-dir", the survivor this id also names.
      // main's forgetUninstalledPlugin relies on exactly this to apply the
      // standing trace-to-directory rule and never forget the survivor's
      // own registration.
      expect(events).toContainEqual({
        kind: "removed",
        pluginId: "target-dir",
        directoryName: "target-dir",
      });

      // Inventory and warning traversal belong only to the dialog. The two
      // execution checks fingerprint the exact source root without walking
      // the unrelated survivor's state.
      expect(preflightStateRoots).toEqual([null]);
      expect(revalidatedSourceRoots).toEqual([invalidRoot, invalidRoot]);

      // The invalid directory is gone...
      await expect(lstat(invalidRoot)).rejects.toMatchObject({ code: "ENOENT" });
      // ...and the unrelated, installed plugin is completely untouched:
      // its source, its build, its state, and its running process all
      // survive — not only its files.
      await expect(readFile(join(survivorStateRoot, "t3", "session.sqlite"), "utf8"))
        .resolves.toBe("session-bytes");
      await expect(readFile(join(otherRoot, "dohc-plugin.json"), "utf8"))
        .resolves.toContain('"name": "target-dir"');
      const survivor = pipeline.list().find((row) => row.directoryName === "other-dir");
      expect(survivor).toMatchObject({
        id: "target-dir",
        valid: true,
        status: "ready",
        approvedHash: expect.any(String),
      });
      expect(await readFile(liveBundlePath({ stateDir, workspaceRoot }, "target-dir"), "utf8"))
        .toContain("activate");
      const state = await readPluginLocalState(stateDir, workspaceRoot);
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["target-dir"]).toMatchObject({
        disabled: false,
        directoryName: "other-dir",
      });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Round 22 finding 4: two id-colliding rows can each have their own
  // Remove dialog open at once — one tab per row. Keying
  // uninstallConfirmations by pluginId alone let the SECOND row's
  // preflight silently overwrite the FIRST's still-open confirmation:
  // confirming the first dialog would fail on a token that no longer
  // matched, or resolve against whatever row the second preflight actually
  // named.

  // Round 22 finding 4: two id-colliding rows can each have their own
  // Remove dialog open at once — one tab per row. Keying
  // uninstallConfirmations by pluginId alone let the SECOND row's
  // preflight silently overwrite the FIRST's still-open confirmation:
  // confirming the first dialog would fail on a token that no longer
  // matched, or resolve against whatever row the second preflight actually
  // named.
  it("keeps two id-colliding rows' open uninstall confirmations apart", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-confirmation-collision-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    // The plugin genuinely installed and running under id "target-dir" —
    // in a directory named "other-dir", nothing to do with the row about
    // to be removed.
    const otherRoot = join(workspaceRoot, "plugins", "other-dir");
    await mkdir(join(otherRoot, "src"), { recursive: true });
    await writeFile(
      join(otherRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "target-dir", entry: "src/index.ts" }, null, 2)}\n`,
    );
    await writeFile(
      join(otherRoot, "package.json"),
      `${JSON.stringify({
        name: "target-dir",
        version: "1.0.0",
        private: true,
        type: "module",
        packageManager: "pnpm@11.20.0",
      }, null, 2)}\n`,
    );
    await writeFile(join(otherRoot, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "importers:",
      "  .: {}",
      "",
    ].join("\n"));
    await writeFile(
      join(otherRoot, "src", "index.ts"),
      'export default { activate() {} };\n',
    );

    let pipeline: PluginPipeline;
    const newHost = () =>
      new PluginHost({
        stateDir,
        workspaceRoot,
        spawnTransport: fakeSpawnTransport(),
        routeSdkRequest: async () => ({}),
        onStatusChange: (pluginId, status) => {
          pipeline.noteRuntimeStatus(pluginId, status);
        },
      });
    const newPipeline = () =>
      new PluginPipeline({
        workspaceRoot,
        stateDir,
        hostOwnership: new PluginHostOwnership(newHost()),
        resourcesBasePath,
        pnpmRunnerEntry,
        operations: {
          install: (input) =>
            installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        },
      });

    pipeline = newPipeline();
    try {
      await pipeline.start();
      const installed = await pipeline.install("target-dir");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "The unrelated plugin did not reach ready.",
      );
    } finally {
      await pipeline.dispose();
    }

    // A second row, added AFTER the other plugin is already running: a
    // broken manifest, so discovery names it by its directory —
    // "target-dir" — which is ALSO, coincidentally, the real, installed
    // manifest id the unrelated plugin above declares.
    const invalidRoot = join(workspaceRoot, "plugins", "target-dir");
    await mkdir(join(invalidRoot, "src"), { recursive: true });
    await writeFile(join(invalidRoot, "dohc-plugin.json"), "{ this is not valid JSON\n");
    await writeFile(join(invalidRoot, "src", "main.ts"), "export default {};\n");

    pipeline = newPipeline();
    try {
      await pipeline.start();
      await waitFor(
        () => pipeline.list().some((row) => row.directoryName === "other-dir" && row.status === "ready"),
        "The unrelated plugin was not running after reopening.",
      );
      // The collision itself: both rows claim id "target-dir".
      expect(pipeline.list().find((row) => row.directoryName === "target-dir"))
        .toMatchObject({ id: "target-dir", valid: false });
      expect(pipeline.list().find((row) => row.directoryName === "other-dir"))
        .toMatchObject({ id: "target-dir", valid: true, approvedHash: expect.any(String) });

      // Both tabs' own dialogs open their own preflight, one after the
      // other — the shape two open Remove dialogs on colliding rows take.
      const preflightInvalid = await pipeline.uninstallPreflight("target-dir", "target-dir");
      if (!preflightInvalid.ok) throw new Error(preflightInvalid.error.message);
      const preflightOther = await pipeline.uninstallPreflight("target-dir", "other-dir");
      if (!preflightOther.ok) throw new Error(preflightOther.error.message);
      expect(preflightInvalid.confirmationToken).not.toBe(preflightOther.confirmationToken);

      // The FIRST dialog's own token still confirms against the invalid
      // row specifically — the second preflight, for the SAME id at a
      // different directory, never silently replaced it.
      const removedInvalid = await pipeline.uninstall(
        "target-dir",
        "target-dir",
        preflightInvalid.confirmationToken,
      );
      expect(removedInvalid.ok).toBe(true);
      await expect(lstat(invalidRoot)).rejects.toMatchObject({ code: "ENOENT" });

      // The installed survivor is untouched by the first row's removal,
      // and its OWN dialog's token still confirms against it specifically.
      expect(pipeline.list().find((row) => row.directoryName === "other-dir"))
        .toMatchObject({ id: "target-dir", valid: true, status: "ready" });
      const removedOther = await pipeline.uninstall(
        "target-dir",
        "other-dir",
        preflightOther.confirmationToken,
      );
      expect(removedOther.ok).toBe(true);
      await expect(lstat(otherRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Round 14 finding 5: the row-resolution fix above protects a pair the
  // renderer would ACTUALLY send (a row's own id with its own directory,
  // even when that id happens to collide with an unrelated plugin's real
  // one). A pair that names two genuinely UNRELATED rows — this plugin's
  // real, installed id paired with some other directory it was never
  // installed at — must be refused outright, before uninstallRootPath or
  // any cleanup identity is even resolved from it.

  // Round 14 finding 5: the row-resolution fix above protects a pair the
  // renderer would ACTUALLY send (a row's own id with its own directory,
  // even when that id happens to collide with an unrelated plugin's real
  // one). A pair that names two genuinely UNRELATED rows — this plugin's
  // real, installed id paired with some other directory it was never
  // installed at — must be refused outright, before uninstallRootPath or
  // any cleanup identity is even resolved from it.
  it("refuses a pluginId/directoryName pair that names two unrelated rows, before anything is touched", async () => {
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
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    // A second, unrelated directory this "example-plugin" id was never
    // installed at — the arbitrary combination a buggy or hostile caller
    // could send.
    const unrelatedRoot = join(fixture.workspaceRoot, "plugins", "unrelated-dir");
    await mkdir(join(unrelatedRoot, "src"), { recursive: true });
    await writeFile(
      join(unrelatedRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "unrelated-id", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(join(unrelatedRoot, "src", "main.ts"), "export default {};\n");

    try {
      await pipeline.start();
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list().find((row) => row.directoryName === "example-plugin")?.status
          === "ready",
        "example-plugin did not reach ready.",
      );

      const preflight = await pipeline.uninstallPreflight("example-plugin", "unrelated-dir");
      expect(preflight.ok).toBe(false);
      if (preflight.ok) throw new Error("unreachable");
      expect(preflight.error.stage).toBe("uninstall");

      // Nothing touched: both directories survive, and no confirmation
      // token exists for uninstall() to act on.
      await expect(lstat(fixture.pluginRoot)).resolves.toBeDefined();
      await expect(lstat(unrelatedRoot)).resolves.toBeDefined();
      expect(pipeline.list().find((row) => row.directoryName === "example-plugin"))
        .toMatchObject({ status: "ready", approvedHash: expect.any(String) });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Round 15 finding 1: the pair check above only ever verified that
  // pluginId belongs to whatever candidate got resolved — never that the
  // resolved candidate is even the row this call was actually asked about.
  // A directory that vanishes between the click and this call makes
  // byDirectory fail, and uninstallableCandidate's own id-keyed fallback
  // can then resolve a completely different, genuinely installed plugin
  // whose real id only happens to collide with the vanished row's
  // directory-derived fallback id — pluginId === candidate.id trivially,
  // so the old check passed it straight through to a real confirmation
  // token for a plugin the dialog never named.

  // Round 15 finding 1: the pair check above only ever verified that
  // pluginId belongs to whatever candidate got resolved — never that the
  // resolved candidate is even the row this call was actually asked about.
  // A directory that vanishes between the click and this call makes
  // byDirectory fail, and uninstallableCandidate's own id-keyed fallback
  // can then resolve a completely different, genuinely installed plugin
  // whose real id only happens to collide with the vanished row's
  // directory-derived fallback id — pluginId === candidate.id trivially,
  // so the old check passed it straight through to a real confirmation
  // token for a plugin the dialog never named.
  it("refuses a directoryName that names no row, even when it collides with an unrelated installed plugin's id", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-vanished-directory-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    // Broken from the start: its fallback id is its own directory name,
    // "collide".
    const invalidRoot = join(workspaceRoot, "plugins", "collide");
    await mkdir(join(invalidRoot, "src"), { recursive: true });
    await writeFile(join(invalidRoot, "dohc-plugin.json"), "{ this is not valid JSON\n");
    await writeFile(join(invalidRoot, "src", "main.ts"), "export default {};\n");

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();

      // The invalid row is removed for real: its directory and discovery
      // entry both go away, exactly like the race this pins.
      const removePreflight = await pipeline.uninstallPreflight("collide", "collide");
      if (!removePreflight.ok) throw new Error(removePreflight.error.message);
      const removed = await pipeline.uninstall("collide", "collide", removePreflight.confirmationToken);
      expect(removed.ok).toBe(true);
      await expect(lstat(invalidRoot)).rejects.toMatchObject({ code: "ENOENT" });

      // A separate, genuinely installed plugin whose real manifest name
      // collides with the vanished row's old fallback id — at a completely
      // different directory.
      const installedRoot = join(workspaceRoot, "plugins", "installed-dir");
      await mkdir(join(installedRoot, "src"), { recursive: true });
      await writeFile(
        join(installedRoot, "dohc-plugin.json"),
        `${JSON.stringify({ version: 1, name: "collide", entry: "src/main.ts" }, null, 2)}\n`,
      );
      await writeFile(
        join(installedRoot, "package.json"),
        `${JSON.stringify({
          name: "collide",
          version: "1.0.0",
          private: true,
          type: "module",
          packageManager: "pnpm@11.20.0",
        }, null, 2)}\n`,
      );
      await writeFile(join(installedRoot, "pnpm-lock.yaml"), [
        "lockfileVersion: '9.0'",
        "settings:",
        "  autoInstallPeers: true",
        "  excludeLinksFromLockfile: false",
        "importers:",
        "  .: {}",
        "",
      ].join("\n"));
      await writeFile(join(installedRoot, "src", "main.ts"), "export default {};\n");
      await pipeline.handleWatcherEvents([{ operation: "update", path: "plugins" }]);
      const installed = await pipeline.install("collide");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list().find((row) => row.directoryName === "installed-dir")?.status
          === "ready",
        "installed-dir did not reach ready.",
      );

      // The stale directoryName from the vanished row — the exact request
      // a delayed retry or a leftover dialog would still send.
      const stalePreflight = await pipeline.uninstallPreflight("collide", "collide");
      expect(stalePreflight.ok).toBe(false);
      if (stalePreflight.ok) throw new Error("unreachable");
      expect(stalePreflight.error.stage).toBe("uninstall");

      // The installed plugin never entered the confirmation: it survives,
      // untouched, and uninstall() has no token to act on for it.
      await expect(lstat(installedRoot)).resolves.toBeDefined();
      expect(pipeline.list().find((row) => row.directoryName === "installed-dir"))
        .toMatchObject({ status: "ready", approvedHash: expect.any(String) });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Round 14 finding 6: additionalCleanupIds used to exclude candidate.id
  // from its own scan — meant to avoid double-adding it when it equals
  // pluginId, but pluginId and candidate.id can genuinely differ (a broken
  // manifest's fallback id vs. the ORIGINAL id its record is filed under,
  // #779 round 9 B3), and a SEPARATE, real record filed directly under
  // candidate.id's own key was silently skipped either way it happened to
  // sit. The cleanupIds Set already dedupes any overlap, so including
  // candidate.id unconditionally is never redundant work, only ever a
  // correctness gap when omitted.
  it("cleans up a record filed under candidate.id's own key, distinct from pluginId", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-candidate-id-edge-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const pluginRoot = join(workspaceRoot, "plugins", "mixed-dir");
    await mkdir(join(pluginRoot, "src"), { recursive: true });
    // Broken from the start: discovery never has a manifest to name this
    // directory by, so its id is always its own directory-derived
    // fallback — "mixed-dir".
    await writeFile(join(pluginRoot, "dohc-plugin.json"), "{ this is not valid JSON\n");
    await writeFile(join(pluginRoot, "src", "main.ts"), "export default {};\n");

    // Two SEPARATE persisted records both trace to "mixed-dir" by
    // directoryName: the ORIGINAL id this row was installed under (what
    // the renderer actually passes as pluginId), and a second, genuine
    // record filed directly under the id "mixed-dir" itself — candidate.id,
    // once discovery falls back to it.
    await mutatePluginRecord(stateDir, workspaceRoot, "original-id", () => ({
      directoryName: "mixed-dir",
    }));
    await mutatePluginRecord(stateDir, workspaceRoot, "mixed-dir", () => ({
      directoryName: "mixed-dir",
    }));
    const dohcDir = pluginDataDir(stateDir, workspaceRoot);
    const originalStateRoot = pluginStateRoot(dohcDir, "original-id");
    const candidateIdStateRoot = pluginStateRoot(dohcDir, "mixed-dir");
    await mkdir(originalStateRoot, { recursive: true });
    await writeFile(join(originalStateRoot, "session.json"), "{}");
    await mkdir(candidateIdStateRoot, { recursive: true });
    await writeFile(join(candidateIdStateRoot, "session.json"), "{}");

    let pipeline: PluginPipeline;
    const stoppedRuntimeIds: string[] = [];
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    const hostOwnership = new PluginHostOwnership(host);
    pipeline = new PluginPipeline({
      workspaceRoot,
      stateDir,
      hostOwnership,
      resourcesBasePath,
      pnpmRunnerEntry,
      onRuntimeStopped: (pluginId) => {
        stoppedRuntimeIds.push(pluginId);
      },
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const transient = transientStateOf(pipeline);
      const trackedStatus = pipeline.list().find((row) => row.directoryName === "mixed-dir");
      expect(trackedStatus).toBeDefined();
      transient.statuses.set("original-id", trackedStatus!);
      transient.statuses.set("mixed-dir", trackedStatus!);
      doorWrittenDeltasOf(pipeline).set("original-id", new Map());
      doorWrittenDeltasOf(pipeline).set("mixed-dir", new Map());
      transient.lastApprovedAttemptHash.set("original-id", "a".repeat(64));
      transient.lastApprovedAttemptHash.set("mixed-dir", "b".repeat(64));
      // "original-id" is a valid pair for "mixed-dir": its own record
      // positively names this directory (#779 round 9 B3's own preserved
      // case, restated in round 14 finding 5's mismatch gate).
      const preflight = await pipeline.uninstallPreflight("original-id", "mixed-dir");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const reserveChange = vi.spyOn(hostOwnership, "reserveChange");
      const revokedRuntimeIds: string[] = [];
      const removing = pipeline.uninstall(
        "original-id",
        "mixed-dir",
        preflight.confirmationToken,
        {
          onWillStopRuntime: (pluginId) => revokedRuntimeIds.push(pluginId),
        },
      );
      expect(reserveChange.mock.calls.map(([pluginId]) => pluginId)).toEqual([
        "original-id",
        "mixed-dir",
      ]);
      const removed = await removing;
      expect(removed.ok).toBe(true);
      expect(revokedRuntimeIds.toSorted()).toEqual([
        "mixed-dir",
        "original-id",
      ]);
      expect(stoppedRuntimeIds.toSorted()).toEqual([
        "mixed-dir",
        "original-id",
      ]);

      await expect(lstat(pluginRoot)).rejects.toMatchObject({ code: "ENOENT" });
      // Both identities' state are gone — not only pluginId's own.
      await expect(lstat(originalStateRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(candidateIdStateRoot)).rejects.toMatchObject({ code: "ENOENT" });
      const state = await readPluginLocalState(stateDir, workspaceRoot);
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["original-id"]).toBeUndefined();
      expect(state.state.plugins["mixed-dir"]).toBeUndefined();
      expect(transient.statuses.has("original-id")).toBe(false);
      expect(transient.statuses.has("mixed-dir")).toBe(false);
      expect(doorWrittenDeltasOf(pipeline).has("original-id")).toBe(false);
      expect(doorWrittenDeltasOf(pipeline).has("mixed-dir")).toBe(false);
      expect(transient.lastApprovedAttemptHash.has("original-id")).toBe(false);
      expect(transient.lastApprovedAttemptHash.has("mixed-dir")).toBe(false);
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("rejects a removed alias's confirmation after the same plugin is recreated", async () => {
    const setup = await createAliasUninstallFixture();
    const sourcePaths = [
      join(setup.fixture.pluginRoot, "dohc-plugin.json"),
      join(setup.fixture.pluginRoot, "package.json"),
      join(setup.fixture.pluginRoot, "pnpm-lock.yaml"),
      setup.fixture.entryPath,
    ];
    const source = await Promise.all(sourcePaths.map((path) => readFile(path)));
    try {
      const initialInstall = await setup.pipeline.install("runtime-id");
      if (!initialInstall.ok) throw new Error(initialInstall.error.message);
      await waitFor(
        () => setup.pipeline.list().some(
          (row) => row.directoryName === "shared-dir" && row.status === "ready",
        ),
        "The initial plugin did not reach ready.",
      );
      const installedState = await readPluginLocalState(
        setup.fixture.stateDir,
        setup.fixture.workspaceRoot,
      );
      if (!installedState.ok) throw new Error(installedState.warning);
      const originalRecord = installedState.state.plugins["original-id"];
      const aliasRecord = installedState.state.plugins["runtime-id"];
      if (!originalRecord || !aliasRecord) {
        throw new Error("The alias uninstall fixture has incomplete records.");
      }
      const staleAlias = await setup.pipeline.uninstallPreflight(
        "original-id",
        "shared-dir",
      );
      if (!staleAlias.ok) throw new Error(staleAlias.error.message);
      const primary = await setup.pipeline.uninstallPreflight(
        "runtime-id",
        "shared-dir",
      );
      if (!primary.ok) throw new Error(primary.error.message);

      const removed = await setup.pipeline.uninstall(
        "runtime-id",
        "shared-dir",
        primary.confirmationToken,
      );
      expect(removed.ok).toBe(true);

      await mkdir(dirname(setup.fixture.entryPath), { recursive: true });
      await Promise.all(
        sourcePaths.map((path, index) => writeFile(path, source[index]!)),
      );
      await setup.pipeline.handleWatcherEvents([
        { operation: "update", path: "plugins" },
      ]);
      const reinstalled = await setup.pipeline.install("runtime-id");
      if (!reinstalled.ok) throw new Error(reinstalled.error.message);
      await waitFor(
        () => setup.pipeline.list().some(
          (row) => row.directoryName === "shared-dir" && row.status === "ready",
        ),
        "The recreated plugin did not reach ready.",
      );
      await mutatePluginRecord(
        setup.fixture.stateDir,
        setup.fixture.workspaceRoot,
        "original-id",
        () => originalRecord,
      );
      await mutatePluginRecord(
        setup.fixture.stateDir,
        setup.fixture.workspaceRoot,
        "runtime-id",
        () => aliasRecord,
      );
      await setup.pipeline.handleWatcherEvents([
        { operation: "update", path: "plugins" },
      ]);

      const staleRemoval = await setup.pipeline.uninstall(
        "original-id",
        "shared-dir",
        staleAlias.confirmationToken,
      );
      await expect(lstat(setup.fixture.pluginRoot)).resolves.toBeDefined();
      expect(staleRemoval).toMatchObject({
        ok: false,
        error: { code: "confirmation-required" },
      });
      await expect(
        Promise.all(sourcePaths.map((path) => readFile(path))),
      ).resolves.toEqual(source);
      const preservedState = await readPluginLocalState(
        setup.fixture.stateDir,
        setup.fixture.workspaceRoot,
      );
      if (!preservedState.ok) throw new Error(preservedState.warning);
      expect(preservedState.state.plugins["original-id"]).toEqual(originalRecord);
      expect(preservedState.state.plugins["runtime-id"]).toEqual(aliasRecord);
      expect(setup.pipeline.list()).toContainEqual(
        expect.objectContaining({
          id: "runtime-id",
          directoryName: "shared-dir",
          status: "ready",
        }),
      );
    } finally {
      await setup.pipeline.dispose();
    }
  }, 60_000);

  it("rejects an uninstall when earlier alias work changes the confirmed target", async () => {
    const fixture = await createNamedPluginWorkspace("shared-dir", "runtime-id");
    await mutatePluginRecord(
      fixture.stateDir,
      fixture.workspaceRoot,
      "original-id",
      () => ({ directoryName: "shared-dir" }),
    );
    await mutatePluginRecord(
      fixture.stateDir,
      fixture.workspaceRoot,
      "runtime-id",
      () => ({ directoryName: "shared-dir" }),
    );
    const buildEntered = deferred();
    const releaseBuild = deferred();
    const revalidationEntered = deferred();
    const releaseRevalidation = deferred();
    let hashSourceCalls = 0;
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
    const hostOwnership = new PluginHostOwnership(host);
    pipeline = new PluginPipeline({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership,
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        hashSource: async (rootPath) => {
          hashSourceCalls += 1;
          if (hashSourceCalls === 1) {
            revalidationEntered.resolve();
            await releaseRevalidation.promise;
          }
          return hashPluginSourceFiles(rootPath);
        },
        build: async (input) => {
          buildEntered.resolve();
          await releaseBuild.promise;
          return buildPluginBundle(input);
        },
      },
    });

    let lease: Exclude<
      ReturnType<PluginHostOwnership<PluginHost>["acquireSurface"]>,
      { kind: "refused" }
    > | undefined;
    let starting: Promise<unknown> | undefined;
    try {
      await pipeline.start();
      const preflight = await pipeline.uninstallPreflight(
        "original-id",
        "shared-dir",
      );
      if (!preflight.ok) throw new Error(preflight.error.message);

      const acquired = hostOwnership.acquireSurface("runtime-id");
      if ("kind" in acquired) throw new Error("The alias surface was refused.");
      lease = acquired;
      starting = lease.start(async (authority) =>
        pipeline.ensureStarted("runtime-id", authority)
      );
      await buildEntered.promise;

      const pipelineInternals = pipeline as unknown as {
        enqueueActionValue: <T>(
          pluginId: string,
          run: () => Promise<T>,
        ) => Promise<T>;
      };
      const enqueueActionValue = vi.spyOn(
        pipelineInternals,
        "enqueueActionValue",
      );
      const removing = pipeline.uninstall(
        "original-id",
        "shared-dir",
        preflight.confirmationToken,
      );

      // The claim is synchronous with uninstall admission. It sits behind
      // the build already in runtime-id's queue and ahead of anything that
      // can arrive after the irreversible action was accepted. Exact target
      // validation waits for that earlier build to settle, then rejects its
      // durable-record drift before stopping either identity.
      expect(enqueueActionValue.mock.calls.map(([pluginId]) => pluginId))
        .toContain("runtime-id");

      releaseBuild.resolve();
      await starting;
      await revalidationEntered.promise;

      let lateAliasJobEntered = false;
      const lateAliasJob = pipelineInternals.enqueueActionValue(
        "runtime-id",
        async () => {
          lateAliasJobEntered = true;
        },
      );
      expect(lateAliasJobEntered).toBe(false);

      releaseRevalidation.resolve();
      const removed = await removing;
      await lateAliasJob;

      expect(removed).toMatchObject({
        ok: false,
        error: { code: "confirmation-stale" },
      });
      expect(lateAliasJobEntered).toBe(true);
      expect(host.currentRecord("runtime-id")).toBeDefined();
      await expect(lstat(fixture.pluginRoot)).resolves.toBeDefined();
      await expect(lstat(join(pluginsDataRoot(fixture), "runtime-id")))
        .resolves.toBeDefined();
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["original-id"]).toBeDefined();
      expect(state.state.plugins["runtime-id"]).toBeDefined();
    } finally {
      releaseBuild.resolve();
      releaseRevalidation.resolve();
      await starting?.catch(() => undefined);
      await lease?.release();
      await pipeline.dispose();
    }
  }, 60_000);

  it("enqueues crossed alias uninstall claims and actions in one turn", async () => {
    const setup = await createAliasUninstallFixture();
    try {
      const originalPreflight = await setup.pipeline.uninstallPreflight(
        "original-id",
        "shared-dir",
      );
      if (!originalPreflight.ok) throw new Error(originalPreflight.error.message);
      const runtimePreflight = await setup.pipeline.uninstallPreflight(
        "runtime-id",
        "shared-dir",
      );
      if (!runtimePreflight.ok) throw new Error(runtimePreflight.error.message);

      const internals = setup.pipeline as unknown as PluginPipelineQueueInternals;
      const enqueueActionValue = vi.spyOn(internals, "enqueueActionValue");
      const removeOriginal = setup.pipeline.uninstall(
        "original-id",
        "shared-dir",
        originalPreflight.confirmationToken,
      );
      const removeRuntime = setup.pipeline.uninstall(
        "runtime-id",
        "shared-dir",
        runtimePreflight.confirmationToken,
      );

      // Each call must synchronously park its secondary claim and its primary
      // action. If either call yields between them, these crossed claims can
      // both run ahead of the actions whose decisions they await.
      expect(enqueueActionValue.mock.calls.map(([pluginId]) => pluginId)).toEqual([
        "runtime-id",
        "original-id",
        "original-id",
        "runtime-id",
      ]);

      const [removedOriginal, removedRuntime] = await settleWithin(
        Promise.all([removeOriginal, removeRuntime]),
        "Crossed alias uninstalls did not settle",
      );
      expect(removedOriginal.ok).toBe(true);
      expect(removedRuntime).toMatchObject({
        ok: false,
        error: { code: "confirmation-required" },
      });
      await expect(lstat(setup.fixture.pluginRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await settleWithin(
        setup.pipeline.dispose(),
        "Pipeline disposal did not settle after crossed alias uninstalls",
      );
    }
  }, 60_000);

  it("awaits exact post-stop cleanup for a primary-and-live-alias uninstall", async () => {
    const cleanupAssimilated = deferred();
    const releaseCleanup = deferred();
    const observations: Array<{
      pluginId: string;
      record: ReturnType<PluginHost["currentRecord"]>;
    }> = [];
    const assimilatedPluginIds: string[] = [];
    let setup!: Awaited<ReturnType<typeof createAliasUninstallFixture>>;
    setup = await createAliasUninstallFixture({
      drainTimeoutMs: 0,
      onRuntimeStopped: (pluginId) => {
        observations.push({
          pluginId,
          record: setup.host.currentRecord(pluginId),
        });
        const thenable: PromiseLike<void> = {
          then: (onFulfilled, onRejected) => {
            assimilatedPluginIds.push(pluginId);
            if (assimilatedPluginIds.length === 2) {
              cleanupAssimilated.resolve();
            }
            return releaseCleanup.promise.then(onFulfilled, onRejected);
          },
        };
        return thenable as Promise<void>;
      },
    });
    let surface: Awaited<ReturnType<typeof ensureFromSurface>> | undefined;
    let removing: Promise<PluginActionResult> | undefined;
    let lateAliasJob: Promise<void> | undefined;
    try {
      surface = await ensureFromSurface(setup.pipeline, "runtime-id");
      expect(surface.result.ok).toBe(true);
      expect(setup.host.currentRecord("runtime-id")).toBeDefined();
      const preflight = await setup.pipeline.uninstallPreflight(
        "original-id",
        "shared-dir",
      );
      if (!preflight.ok) throw new Error(preflight.error.message);

      removing = setup.pipeline.uninstall(
        "original-id",
        "shared-dir",
        preflight.confirmationToken,
      );
      const internals = setup.pipeline as unknown as PluginPipelineQueueInternals;
      let lateAliasJobEntered = false;
      lateAliasJob = internals.enqueueActionValue("runtime-id", async () => {
        lateAliasJobEntered = true;
      });

      const boundary = await Promise.race([
        cleanupAssimilated.promise.then(() => "cleanup-assimilated" as const),
        removing.then(() => "uninstall-settled" as const),
      ]);
      expect(boundary).toBe("cleanup-assimilated");
      expect(observations.map(({ pluginId }) => pluginId).toSorted()).toEqual([
        "original-id",
        "runtime-id",
      ]);
      expect(assimilatedPluginIds.toSorted()).toEqual([
        "original-id",
        "runtime-id",
      ]);
      expect(observations.every(({ record }) => record === undefined)).toBe(true);
      expect(lateAliasJobEntered).toBe(false);

      releaseCleanup.resolve();
      const removed = await removing;
      await lateAliasJob;
      expect(removed.ok).toBe(true);
      expect(lateAliasJobEntered).toBe(true);
      await expect(lstat(setup.fixture.pluginRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      releaseCleanup.resolve();
      await removing?.catch(() => undefined);
      await lateAliasJob?.catch(() => undefined);
      await surface?.release();
      await setup.pipeline.dispose();
    }
  }, 60_000);

  it("preserves a live alias and releases its queue when pre-stop revocation fails", async () => {
    const stoppedRuntimeIds: string[] = [];
    const setup = await createAliasUninstallFixture({
      drainTimeoutMs: 0,
      onRuntimeStopped: (pluginId) => {
        stoppedRuntimeIds.push(pluginId);
      },
    });
    let surface: Awaited<ReturnType<typeof ensureFromSurface>> | undefined;
    let removing: Promise<PluginActionResult> | undefined;
    let lateAliasJob: Promise<void> | undefined;
    try {
      surface = await ensureFromSurface(setup.pipeline, "runtime-id");
      expect(surface.result.ok).toBe(true);
      const aliasRecord = setup.host.currentRecord("runtime-id");
      expect(aliasRecord).toBeDefined();
      const preflight = await setup.pipeline.uninstallPreflight(
        "original-id",
        "shared-dir",
      );
      if (!preflight.ok) throw new Error(preflight.error.message);

      const revokedRuntimeIds: string[] = [];
      removing = setup.pipeline.uninstall(
        "original-id",
        "shared-dir",
        preflight.confirmationToken,
        {
          onWillStopRuntime: (pluginId) => {
            revokedRuntimeIds.push(pluginId);
            if (pluginId === "runtime-id") {
              throw new Error("simulated alias revocation failure");
            }
          },
        },
      );
      const internals = setup.pipeline as unknown as PluginPipelineQueueInternals;
      let lateAliasJobEntered = false;
      lateAliasJob = internals.enqueueActionValue("runtime-id", async () => {
        lateAliasJobEntered = true;
      });
      expect(lateAliasJobEntered).toBe(false);

      const removed = await removing;
      await lateAliasJob;
      expect(removed).toMatchObject({
        ok: false,
        error: {
          code: "delete-failed",
          message: "simulated alias revocation failure",
        },
      });
      expect(revokedRuntimeIds).toContain("runtime-id");
      expect(stoppedRuntimeIds).not.toContain("runtime-id");
      expect(setup.host.currentRecord("runtime-id")).toBe(aliasRecord);
      await expect(lstat(setup.fixture.pluginRoot)).resolves.toBeDefined();
      expect(lateAliasJobEntered).toBe(true);
    } finally {
      await removing?.catch(() => undefined);
      await lateAliasJob?.catch(() => undefined);
      await surface?.release();
      await setup.pipeline.dispose();
    }
  }, 60_000);

  it("cancels alias claims when a newer confirmation replaces the admitted one", async () => {
    const setup = await createAliasUninstallFixture();
    const primaryQueueEntered = deferred();
    const releasePrimaryQueue = deferred();
    let surface: Awaited<ReturnType<typeof ensureFromSurface>> | undefined;
    let primaryBlocker: Promise<void> | undefined;
    let replacementPreflight: ReturnType<PluginPipeline["uninstallPreflight"]> | undefined;
    let removing: Promise<PluginActionResult> | undefined;
    let lateAliasJob: Promise<void> | undefined;
    try {
      const firstPreflight = await setup.pipeline.uninstallPreflight(
        "original-id",
        "shared-dir",
      );
      if (!firstPreflight.ok) throw new Error(firstPreflight.error.message);

      surface = await ensureFromSurface(setup.pipeline, "runtime-id");
      expect(surface.result.ok).toBe(true);
      const aliasRecord = setup.host.currentRecord("runtime-id");
      expect(aliasRecord).toBeDefined();
      const stop = vi.spyOn(setup.host, "stop");
      const internals = setup.pipeline as unknown as PluginPipelineQueueInternals;
      primaryBlocker = internals.enqueueActionValue("original-id", async () => {
        primaryQueueEntered.resolve();
        await releasePrimaryQueue.promise;
      });
      await primaryQueueEntered.promise;

      // Admission still sees the first token and claims runtime-id. The
      // queued preflight replaces it before the primary uninstall executes.
      replacementPreflight = setup.pipeline.uninstallPreflight(
        "original-id",
        "shared-dir",
      );
      const reserveChange = vi.spyOn(setup.hostOwnership, "reserveChange");
      removing = setup.pipeline.uninstall(
        "original-id",
        "shared-dir",
        firstPreflight.confirmationToken,
      );
      expect(reserveChange.mock.calls.map(([pluginId]) => pluginId)).toEqual([
        "original-id",
        "runtime-id",
      ]);

      let lateAliasJobEntered = false;
      lateAliasJob = internals.enqueueActionValue("runtime-id", async () => {
        lateAliasJobEntered = true;
      });
      expect(lateAliasJobEntered).toBe(false);

      releasePrimaryQueue.resolve();
      const newer = await replacementPreflight;
      if (!newer.ok) throw new Error(newer.error.message);
      const removed = await removing;
      await lateAliasJob;

      expect(removed).toMatchObject({
        ok: false,
        error: { code: "confirmation-required" },
      });
      expect(lateAliasJobEntered).toBe(true);
      expect(setup.host.currentRecord("runtime-id")).toBe(aliasRecord);
      expect(stop.mock.calls.some(([pluginId]) => pluginId === "runtime-id"))
        .toBe(false);
      await expect(
        setup.hostOwnership.runCommand("runtime-id", async () => "ready"),
      ).resolves.toEqual({ kind: "completed", value: "ready" });
    } finally {
      releasePrimaryQueue.resolve();
      await primaryBlocker?.catch(() => undefined);
      await replacementPreflight?.catch(() => undefined);
      await removing?.catch(() => undefined);
      await lateAliasJob?.catch(() => undefined);
      await surface?.release();
      await setup.pipeline.dispose();
    }
  }, 60_000);

  it("holds alias queues until every uninstall stop attempt settles", async () => {
    const setup = await createAliasUninstallFixture({ drainTimeoutMs: 0 });
    const aliasStopEntered = deferred();
    const primaryStopEntered = deferred();
    const releasePrimaryStop = deferred();
    let surface: Awaited<ReturnType<typeof ensureFromSurface>> | undefined;
    let removing: Promise<PluginActionResult> | undefined;
    let lateAliasJob: Promise<void> | undefined;
    try {
      surface = await ensureFromSurface(setup.pipeline, "runtime-id");
      expect(surface.result.ok).toBe(true);
      const aliasRecord = setup.host.currentRecord("runtime-id");
      expect(aliasRecord).toBeDefined();
      const preflight = await setup.pipeline.uninstallPreflight(
        "original-id",
        "shared-dir",
      );
      if (!preflight.ok) throw new Error(preflight.error.message);

      const internals = setup.pipeline as unknown as PluginPipelineQueueInternals;
      const claimCleanupQueues =
        internals.claimUninstallCleanupQueues.bind(internals);
      let primaryStopFinished = false;
      let claimReleasedBeforePrimaryStop = false;
      let claimReleaseCalls = 0;
      let lateAliasJobEntered = false;
      let lateAliasJobEnteredBeforeRelease = false;
      vi.spyOn(internals, "claimUninstallCleanupQueues").mockImplementation(
        (cleanupIds, primaryPluginId, reservations, hooks) =>
          claimCleanupQueues(cleanupIds, primaryPluginId, reservations, hooks).map((claim) => ({
            ...claim,
            release: () => {
              claimReleaseCalls += 1;
              if (!primaryStopFinished) claimReleasedBeforePrimaryStop = true;
              if (lateAliasJobEntered) lateAliasJobEnteredBeforeRelease = true;
              claim.release();
            },
          })),
      );

      const actualStop = setup.host.stop.bind(setup.host);
      let failedAliasStop = false;
      vi.spyOn(setup.host, "stop").mockImplementation(async (pluginId) => {
        if (pluginId === "runtime-id" && !failedAliasStop) {
          failedAliasStop = true;
          aliasStopEntered.resolve();
          throw new Error("simulated alias stop failure");
        }
        if (pluginId === "original-id") {
          primaryStopEntered.resolve();
          await releasePrimaryStop.promise;
          await actualStop(pluginId);
          primaryStopFinished = true;
          return;
        }
        await actualStop(pluginId);
      });

      removing = setup.pipeline.uninstall(
        "original-id",
        "shared-dir",
        preflight.confirmationToken,
      );
      lateAliasJob = internals.enqueueActionValue("runtime-id", async () => {
        lateAliasJobEntered = true;
      });

      await Promise.all([aliasStopEntered.promise, primaryStopEntered.promise]);
      releasePrimaryStop.resolve();
      const removed = await removing;
      await lateAliasJob;

      expect(removed).toMatchObject({
        ok: false,
        error: { code: "delete-failed" },
      });
      expect(primaryStopFinished).toBe(true);
      expect(claimReleasedBeforePrimaryStop).toBe(false);
      expect(lateAliasJobEnteredBeforeRelease).toBe(false);
      expect(claimReleaseCalls).toBe(1);
      expect(lateAliasJobEntered).toBe(true);
      expect(setup.host.currentRecord("runtime-id")).toBe(aliasRecord);
      await expect(lstat(setup.fixture.pluginRoot)).resolves.toBeDefined();
    } finally {
      releasePrimaryStop.resolve();
      await removing?.catch(() => undefined);
      await lateAliasJob?.catch(() => undefined);
      await surface?.release();
      await setup.pipeline.dispose();
    }
  }, 60_000);

  // Conflict detection has to be side-agnostic: !plugin.valid alone only
  // catches THIS request's copy losing the tie-break. When the copy sorts
  // first and WINS instead, its own record stays valid and reads as a
  // clean add — but the plugin it collided with is now the one carrying
  // discovery's "duplicate plugin id" diagnostic. Either side degrading
  // must roll the add back the same way.

  // Conflict detection has to be side-agnostic: !plugin.valid alone only
  // catches THIS request's copy losing the tie-break. When the copy sorts
  // first and WINS instead, its own record stays valid and reads as a
  // clean add — but the plugin it collided with is now the one carrying
  // discovery's "duplicate plugin id" diagnostic. Either side degrading
  // must roll the add back the same way.
  it("detects a conflict and rolls back even when its own copy wins the tie-break", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-offer-conflict-win-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const builtinPluginsRoot = join(targetRoot, "builtin-plugins");
    const builtinCodexRoot = join(builtinPluginsRoot, "codex");
    await mkdir(join(builtinCodexRoot, "src"), { recursive: true });
    await writeFile(
      join(builtinCodexRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "codex", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(join(builtinCodexRoot, "src", "main.ts"), "export default {};\n");

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      expect(pipeline.list()).toEqual([]);

      await pipeline.handleWatcherEvents([{ operation: "update", path: "plugins" }]);
      const existingPluginIds = new Set(pipeline.list().map((entry) => entry.id));

      const added = await addOfferedPlugin({
        builtinPluginsRoot,
        workspaceRoot,
        directoryName: "codex",
        existingPluginIds,
      });

      // Injected between the copy and the post-copy rescan — sorts AFTER
      // "codex" lexically this time, so discovery's tie-break hands the id
      // to the copy this request just made instead.
      const concurrentRoot = join(workspaceRoot, "plugins", "z-codex");
      await mkdir(join(concurrentRoot, "src"), { recursive: true });
      await writeFile(
        join(concurrentRoot, "dohc-plugin.json"),
        `${JSON.stringify({ version: 1, name: "codex", entry: "src/main.ts" }, null, 2)}\n`,
      );
      await writeFile(join(concurrentRoot, "src", "main.ts"), "export default {};\n");

      await pipeline.handleWatcherEvents([{ operation: "create", path: "plugins/codex" }]);
      const copied = pipeline.list().find((entry) => entry.directoryName === "codex");
      // This request's own copy won — its record alone would read as a
      // clean, successful add.
      expect(copied?.valid).toBe(true);

      // The fixed handler's side-agnostic detection: the structured
      // supersededPluginId marker, never diagnostic prose (that text is
      // bounded and re-worded for display, not a stable machine-checked
      // signal — #779-offers round 8 finding 5).
      const displaced = pipeline.findDirectorySupersededBy("codex");
      expect(displaced).toBe("z-codex");

      // The handler's cleanup fires on that signal alone, even though
      // copied.valid was true.
      await removeAddedOfferedPlugin({
        workspaceRoot,
        directoryName: "codex",
        identity: added.identity,
        contentHash: added.contentHash,
      });
      await pipeline.handleWatcherEvents([{ operation: "update", path: "plugins" }]);

      await expect(
        lstat(join(workspaceRoot, "plugins", "codex")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      // The departed identity's cleanup and the surviving replacement's own
      // reconciliation are both queued work, not synchronous with the
      // rescan settling — the same asynchronous reseed every other real-
      // lifecycle test in this file waits out.
      await waitFor(
        () => pipeline.list().some((entry) => entry.directoryName === "z-codex"),
        "z-codex did not recover the id after the conflicting copy was removed.",
      );
      const survivor = pipeline.list().find((entry) => entry.directoryName === "z-codex");
      expect(survivor).toMatchObject({ id: "codex", valid: true });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Round 15 finding 3, through the real conflict path this rollback
  // actually runs on: a slow rescan is exactly the window real work can
  // land in — an agent or a user editing the copy's README, say — before
  // the conflict this test sets up is even detected. The rollback's own
  // identity check passes regardless (a directory's inode does not change
  // when a file inside it is edited), so only a content check catches it.

  // Round 15 finding 3, through the real conflict path this rollback
  // actually runs on: a slow rescan is exactly the window real work can
  // land in — an agent or a user editing the copy's README, say — before
  // the conflict this test sets up is even detected. The rollback's own
  // identity check passes regardless (a directory's inode does not change
  // when a file inside it is edited), so only a content check catches it.
  it("preserves a post-publish edit instead of deleting it, when a conflict rolls the add back", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-offer-conflict-edit-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const builtinPluginsRoot = join(targetRoot, "builtin-plugins");
    const builtinCodexRoot = join(builtinPluginsRoot, "codex");
    await mkdir(join(builtinCodexRoot, "src"), { recursive: true });
    await writeFile(
      join(builtinCodexRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "codex", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(join(builtinCodexRoot, "src", "main.ts"), "export default {};\n");

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      await pipeline.handleWatcherEvents([{ operation: "update", path: "plugins" }]);
      const existingPluginIds = new Set(pipeline.list().map((entry) => entry.id));

      const added = await addOfferedPlugin({
        builtinPluginsRoot,
        workspaceRoot,
        directoryName: "codex",
        existingPluginIds,
      });

      // The conflict this rollback is about to act on.
      const concurrentRoot = join(workspaceRoot, "plugins", "z-codex");
      await mkdir(join(concurrentRoot, "src"), { recursive: true });
      await writeFile(
        join(concurrentRoot, "dohc-plugin.json"),
        `${JSON.stringify({ version: 1, name: "codex", entry: "src/main.ts" }, null, 2)}\n`,
      );
      await writeFile(join(concurrentRoot, "src", "main.ts"), "export default {};\n");

      // Real work landing in the copy's own directory before the conflict
      // is even detected — its identity is untouched by this.
      const target = join(workspaceRoot, "plugins", "codex");
      await writeFile(join(target, "NOTES.md"), "left before the conflict was seen");

      await pipeline.handleWatcherEvents([{ operation: "create", path: "plugins/codex" }]);
      expect(pipeline.findDirectorySupersededBy("codex")).toBe("z-codex");

      await expect(
        removeAddedOfferedPlugin({
          workspaceRoot,
          directoryName: "codex",
          identity: added.identity,
          contentHash: added.contentHash,
        }),
      ).rejects.toBeInstanceOf(OfferedPluginAddError);

      // Nothing deleted: the edit survives, restored right back where it
      // was made rather than lost to the rollback.
      await expect(
        readFile(join(target, "NOTES.md"), "utf8"),
      ).resolves.toBe("left before the conflict was seen");
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // handleWatcherEvents logs and swallows a rescan failure rather than
  // throwing (a transient fs error, say), so the copy this request just
  // made can be on disk with nothing in pipeline.list() to show for it.
  // The fixed handler's cleanup must remove it before reporting the
  // refusal — otherwise a retry finds "already exists" for a plugin the
  // user was just told never appeared.

  // handleWatcherEvents logs and swallows a rescan failure rather than
  // throwing (a transient fs error, say), so the copy this request just
  // made can be on disk with nothing in pipeline.list() to show for it.
  // The fixed handler's cleanup must remove it before reporting the
  // refusal — otherwise a retry finds "already exists" for a plugin the
  // user was just told never appeared.
  it("removes its copy instead of stranding it when the post-copy rescan finds nothing", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-offer-no-rescan-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const builtinPluginsRoot = join(targetRoot, "builtin-plugins");
    const builtinCodexRoot = join(builtinPluginsRoot, "codex");
    await mkdir(join(builtinCodexRoot, "src"), { recursive: true });
    await writeFile(
      join(builtinCodexRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "codex", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(join(builtinCodexRoot, "src", "main.ts"), "export default {};\n");

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      await pipeline.handleWatcherEvents([{ operation: "update", path: "plugins" }]);
      const existingPluginIds = new Set(pipeline.list().map((entry) => entry.id));

      const added = await addOfferedPlugin({
        builtinPluginsRoot,
        workspaceRoot,
        directoryName: "codex",
        existingPluginIds,
      });

      // Simulates the rescan finding nothing: skip it entirely, so
      // discovery never picks up the new directory the copy just wrote.
      const plugin = pipeline.list().find((entry) => entry.directoryName === "codex");
      expect(plugin).toBeUndefined();

      // The fixed handler's cleanup for exactly this case.
      await removeAddedOfferedPlugin({
        workspaceRoot,
        directoryName: "codex",
        identity: added.identity,
        contentHash: added.contentHash,
      });
      await pipeline.handleWatcherEvents([{ operation: "update", path: "plugins" }]);

      await expect(
        lstat(join(workspaceRoot, "plugins", "codex")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      // The offer's own existence check would pass again — a retry is
      // genuinely possible, not stuck behind a stranded copy.
      expect(pipeline.list()).toEqual([]);
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Round 23 finding 4: startup associates a renamed directory with its
  // persisted record by id alone (installedRecord's ordinary join) — it
  // never corrected the record's OWN stale directoryName field to match.
  // pluginIdTracesDirectory compares that stale field against the
  // candidate's real, current directoryName and reads the mismatch as
  // proof this id's own data belongs to some OTHER, unrelated
  // installation — disowning everything a Remove would otherwise clean
  // up, and leaving settings stranded under the vacated key the same way
  // a live watcher rename would without round 22 finding 1's fix.
  it("owns its data and carries its settings across an offline directory rename", async () => {
    const fixture = await createNamedPluginWorkspace("old-dir", "offline-rename-id");
    await writeFile(
      join(fixture.pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "offline-rename-id",
        displayName: "offline-rename-id",
        entry: "src/index.ts",
        settings: [
          { key: "greeting", type: "string", label: "Greeting", default: "Hello" },
        ],
      }, null, 2)}\n`,
    );
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
        hostOwnership: new PluginHostOwnership(host),
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
      const installed = await pipeline.install("offline-rename-id");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const saved = await pipeline.setPluginSettings("old-dir", "offline-rename-id", {
        greeting: "Howdy",
      });
      expect(saved).toEqual({ greeting: "Howdy" });
    } finally {
      await pipeline.dispose();
    }

    // The plugin's own stored data, genuinely filed under its id.
    const ownStateRoot = pluginStateRoot(
      pluginDataDir(fixture.stateDir, fixture.workspaceRoot),
      "offline-rename-id",
    );
    await mkdir(join(ownStateRoot, "t3"), { recursive: true });
    await writeFile(join(ownStateRoot, "t3", "session.sqlite"), "session-bytes");

    // The directory moves while dohc is closed — no watcher, no batch,
    // nothing but a fresh start() to notice it next.
    const renamedRoot = join(fixture.workspaceRoot, "plugins", "new-dir");
    await rename(fixture.pluginRoot, renamedRoot);

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      const row = pipeline.list()[0];
      expect(row).toMatchObject({
        id: "offline-rename-id",
        directoryName: "new-dir",
        rootPath: renamedRoot,
        valid: true,
      });
      expect(row?.approvedHash).not.toBeNull();

      // The record follows the plugin: its own persisted directoryName is
      // corrected, not left pointing at the vacated directory.
      const state = await readPluginLocalState(fixture.stateDir, fixture.workspaceRoot);
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["offline-rename-id"]).toMatchObject({
        directoryName: "new-dir",
      });

      // Settings carried through the same boundary as an online rename.
      expect(await pipeline.getPluginSettings("new-dir")).toEqual({
        greeting: "Howdy",
      });

      // Remove preflight/cleanup own this plugin's own stored data — the
      // stale directoryName no longer reads it as belonging to someone
      // else.
      const preflight = await pipeline.uninstallPreflight("offline-rename-id", "new-dir");
      if (!preflight.ok) throw new Error(preflight.error.message);
      expect(preflight.preflight.stateData).toMatchObject({
        path: ownStateRoot,
        fileCount: 1,
      });
      const uninstalled = await pipeline.uninstall(
        "offline-rename-id",
        "new-dir",
        preflight.confirmationToken,
      );
      expect(uninstalled.ok).toBe(true);
      await expect(lstat(renamedRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(ownStateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

  // Round 24 finding 2: startup has no discovery history the way
  // processWatcherBatch does, so an id-only mismatch alone cannot tell a
  // genuine offline rename apart from a coexisting duplicate directory
  // promoted into the vacated id because the original directory is simply
  // gone. Gated on content: a rename preserves bytes exactly, so only an
  // EQUAL live source hash may retarget the record and migrate settings.

  // Round 24 finding 2: startup has no discovery history the way
  // processWatcherBatch does, so an id-only mismatch alone cannot tell a
  // genuine offline rename apart from a coexisting duplicate directory
  // promoted into the vacated id because the original directory is simply
  // gone. Gated on content: a rename preserves bytes exactly, so only an
  // EQUAL live source hash may retarget the record and migrate settings.
  it("does not adopt a duplicate promoted while closed as an offline rename", async () => {
    const fixture = await createNamedPluginWorkspace("old-dir", "foo");
    await writeFile(
      join(fixture.pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "foo",
        displayName: "foo",
        entry: "src/index.ts",
        settings: [
          { key: "greeting", type: "string", label: "Greeting", default: "Hello" },
        ],
      }, null, 2)}\n`,
    );

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
        hostOwnership: new PluginHostOwnership(host),
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
      const installed = await pipeline.install("foo");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list().some((p) => p.directoryName === "old-dir" && p.status === "ready"),
        "The winner did not reach ready.",
      );
      const saved = await pipeline.setPluginSettings("old-dir", "foo", {
        greeting: "Howdy",
      });
      expect(saved).toEqual({ greeting: "Howdy" });
    } finally {
      await pipeline.dispose();
    }

    // A second, coexisting directory declaring the SAME manifest name
    // appears while "old-dir" is still the installed winner — demoted by
    // discovery's tie-break to its own directoryName as id, and DIFFERENT
    // content: a real rename could never produce this, only an unrelated
    // plugin that happens to share the name.
    const duplicateRoot = join(fixture.workspaceRoot, "plugins", "dup-dir");
    await mkdir(join(duplicateRoot, "src"), { recursive: true });
    await writeFile(
      join(duplicateRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "foo",
        displayName: "foo",
        entry: "src/index.ts",
        settings: [
          { key: "greeting", type: "string", label: "Greeting", default: "Hello" },
        ],
      }, null, 2)}\n`,
    );
    await writeFile(
      join(duplicateRoot, "src", "index.ts"),
      'export default { activate() { /* different bytes */ } };\n',
    );

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      // The tie-break still favours the known-installed directory.
      expect(pipeline.list().find((p) => p.directoryName === "old-dir"))
        .toMatchObject({ id: "foo", valid: true });
      expect(pipeline.list().find((p) => p.directoryName === "dup-dir"))
        .toMatchObject({ id: "dup-dir", valid: false });
    } finally {
      await pipeline.dispose();
    }

    // "old-dir" is deleted while dohc is closed — no watcher, no batch, no
    // discovery history. "dup-dir" is now the only directory declaring
    // "foo" and gets promoted to it on the next start().
    await rm(fixture.pluginRoot, { recursive: true, force: true });

    pipeline = newPipeline(newHost());
    try {
      await pipeline.start();
      const row = pipeline.list().find((p) => p.directoryName === "dup-dir");
      expect(row).toMatchObject({ id: "foo", valid: true });

      // The record was NOT retargeted: it still names the original,
      // missing directory, not the duplicate's.
      const state = await readPluginLocalState(fixture.stateDir, fixture.workspaceRoot);
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["foo"]).toMatchObject({
        directoryName: "old-dir",
      });

      // The promoted duplicate reads its own manifest's default — never
      // the departed winner's saved answer, which named a plugin whose
      // bytes never actually moved here.
      expect(await pipeline.getPluginSettings("dup-dir")).toEqual({
        greeting: "Hello",
      });
    } finally {
      await pipeline.dispose();
    }
  }, 120_000);

  // Round 22 finding 1: settings are keyed by directoryName. A genuine
  // rename — this exact id reappearing, in one watcher batch, at a new
  // directory — is the one case the pipeline itself can prove; without
  // this, the user's saved answers are filed under a key nothing reads
  // anymore and silently read back as the manifest's defaults.

  // Round 22 finding 1: settings are keyed by directoryName. A genuine
  // rename — this exact id reappearing, in one watcher batch, at a new
  // directory — is the one case the pipeline itself can prove; without
  // this, the user's saved answers are filed under a key nothing reads
  // anymore and silently read back as the manifest's defaults.
  it("carries a plugin's saved settings across a same-batch directory rename", async () => {
    const fixture = await createNamedPluginWorkspace("old-dir", "shared-id");
    await writeFile(
      join(fixture.pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "shared-id",
        displayName: "shared-id",
        entry: "src/index.ts",
        settings: [
          { key: "greeting", type: "string", label: "Greeting", default: "Hello" },
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
    pipeline = new PluginPipeline({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

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

      const saved = await pipeline.setPluginSettings("old-dir", "shared-id", {
        greeting: "Howdy",
      });
      expect(saved).toEqual({ greeting: "Howdy" });

      const renamedRoot = join(fixture.workspaceRoot, "plugins", "new-dir");
      await rename(fixture.pluginRoot, renamedRoot);
      // Both sides of the rename land in one batch, matching how a real
      // rename reaches processWatcherBatch when the watcher coalesces it.
      pipeline.handleWatcherEvents([
        { path: "plugins/old-dir", operation: "delete" },
        { path: "plugins/new-dir", operation: "create" },
      ]);

      await waitFor(
        () => pipeline.list().some(
          (p) => p.id === "shared-id" && p.directoryName === "new-dir",
        ),
        "The renamed identity was never rediscovered at its new directory.",
      );

      // The answer moved with the rename, not reset to the manifest's
      // default — and it moved, rather than merely being copied: nothing
      // is left behind under the vacated key.
      expect(await pipeline.getPluginSettings("new-dir")).toEqual({
        greeting: "Howdy",
      });
      const stored = await readPluginSettingsFile(fixture.workspaceRoot);
      expect(stored["old-dir"]).toBeUndefined();
      expect(stored["new-dir"]).toEqual({ greeting: "Howdy" });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Round 23 finding 1: sameId reappearing under a new directoryName is
  // only ever a rename when that directory is NEW to discovery this batch.
  // A duplicate that already existed — a second directory declaring the
  // SAME manifest name, demoted to its own directoryName as id by
  // discovery's tie-break — getting PROMOTED into the id its winner just
  // vacated is a completely different plugin taking over an id, never the
  // winner's own content arriving there. Settings must not follow.

  // Round 23 finding 1: sameId reappearing under a new directoryName is
  // only ever a rename when that directory is NEW to discovery this batch.
  // A duplicate that already existed — a second directory declaring the
  // SAME manifest name, demoted to its own directoryName as id by
  // discovery's tie-break — getting PROMOTED into the id its winner just
  // vacated is a completely different plugin taking over an id, never the
  // winner's own content arriving there. Settings must not follow.
  it("does not carry settings to a duplicate promoted by the installed winner's removal", async () => {
    const fixture = await createNamedPluginWorkspace("aaa-dir", "foo");
    await writeFile(
      join(fixture.pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "foo",
        displayName: "foo",
        entry: "src/index.ts",
        settings: [
          { key: "greeting", type: "string", label: "Greeting", default: "Hello" },
        ],
      }, null, 2)}\n`,
    );

    // A second directory declaring the SAME manifest name — lexically
    // AFTER "aaa-dir", so discovery's tie-break demotes it: it starts
    // life as an already-known, invalid duplicate under its own
    // directoryName as id, never "foo" itself, while "aaa-dir" is running.
    const duplicateRoot = join(fixture.workspaceRoot, "plugins", "zzz-dir");
    await mkdir(join(duplicateRoot, "src"), { recursive: true });
    await writeFile(
      join(duplicateRoot, "dohc-plugin.json"),
      `${JSON.stringify({
        version: 1,
        name: "foo",
        displayName: "foo",
        entry: "src/index.ts",
        settings: [
          { key: "greeting", type: "string", label: "Greeting", default: "Hello" },
        ],
      }, null, 2)}\n`,
    );
    await writeFile(join(duplicateRoot, "src", "index.ts"), "export default {};\n");

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
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("foo");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list().some((p) => p.directoryName === "aaa-dir" && p.status === "ready"),
        "The winner did not reach ready.",
      );
      // The collision itself, from the very start: both directories
      // declare "foo", and the duplicate is already known to discovery.
      expect(pipeline.list().find((p) => p.directoryName === "zzz-dir"))
        .toMatchObject({ id: "zzz-dir", valid: false });

      const saved = await pipeline.setPluginSettings("aaa-dir", "foo", {
        greeting: "Howdy",
      });
      expect(saved).toEqual({ greeting: "Howdy" });

      // The winner is deleted outright — freeing "foo" for the duplicate
      // discovery already knew about to be promoted into.
      await rm(fixture.pluginRoot, { recursive: true, force: true });
      pipeline.handleWatcherEvents([
        { path: "plugins/aaa-dir", operation: "delete" },
      ]);

      await waitFor(
        () => pipeline.list().some((p) => p.directoryName === "zzz-dir" && p.id === "foo"),
        "The duplicate was never promoted to the vacated id.",
      );

      // The promoted duplicate reads its own manifest's default — never
      // the departed winner's saved answer, which named a plugin that
      // never actually moved here.
      expect(await pipeline.getPluginSettings("zzz-dir")).toEqual({
        greeting: "Hello",
      });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Round 23 finding 3: an invalid, never-installed candidate (a broken
  // manifest, or none at all) gets no status entry — seedCandidateStatus
  // returns early with nothing to set — so its own arrival or departure
  // fires no "changed"/"removed" event either. Anything reading discovery
  // (offers, the plugin list) is stale until this fires.

  // Round 23 finding 3: an invalid, never-installed candidate (a broken
  // manifest, or none at all) gets no status entry — seedCandidateStatus
  // returns early with nothing to set — so its own arrival or departure
  // fires no "changed"/"removed" event either. Anything reading discovery
  // (offers, the plugin list) is stale until this fires.
  it("emits discovery-changed when an invalid, never-installed candidate's directory appears or disappears", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-plugin-discovery-changed-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const stateDir = join(root, "state");
    await mkdir(join(workspaceRoot, "plugins"), { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const events: PluginPipelineStatusEvent[] = [];
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      onStatusChange: (event) => events.push(event),
    });

    try {
      await pipeline.start();

      // A broken manifest lands at plugins/broken — invalid, never
      // installed, no status entry of its own.
      const brokenRoot = join(workspaceRoot, "plugins", "broken");
      await mkdir(join(brokenRoot, "src"), { recursive: true });
      await writeFile(join(brokenRoot, "dohc-plugin.json"), "{ not valid json\n");
      pipeline.handleWatcherEvents([{ path: "plugins/broken", operation: "create" }]);
      await waitFor(
        () => pipeline.list().some((p) => p.directoryName === "broken"),
        "The invalid candidate was never discovered.",
      );
      expect(events).toContainEqual({ kind: "discovery-changed" });

      events.length = 0;
      await rm(brokenRoot, { recursive: true, force: true });
      pipeline.handleWatcherEvents([{ path: "plugins/broken", operation: "delete" }]);
      await waitFor(
        () => !pipeline.list().some((p) => p.directoryName === "broken"),
        "The invalid candidate's departure was never discovered.",
      );
      expect(events).toContainEqual({ kind: "discovery-changed" });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Round 24 finding 3: comparing only the invalid set's directoryNames
  // misses a malformed manifest replaced by a DIFFERENTLY malformed one —
  // the directory NAME set never changes, but the row's own diagnostics
  // (what the Plugins view actually shows for it) did.

  // Round 24 finding 3: comparing only the invalid set's directoryNames
  // misses a malformed manifest replaced by a DIFFERENTLY malformed one —
  // the directory NAME set never changes, but the row's own diagnostics
  // (what the Plugins view actually shows for it) did.
  it("emits discovery-changed when an invalid candidate's own diagnostics change, even though its directory does not", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-plugin-discovery-changed-diagnostics-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const stateDir = join(root, "state");
    await mkdir(join(workspaceRoot, "plugins"), { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const events: PluginPipelineStatusEvent[] = [];
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      onStatusChange: (event) => events.push(event),
    });

    try {
      await pipeline.start();

      const brokenRoot = join(workspaceRoot, "plugins", "broken");
      await mkdir(join(brokenRoot, "src"), { recursive: true });
      await writeFile(join(brokenRoot, "dohc-plugin.json"), "{ not valid json\n");
      pipeline.handleWatcherEvents([{ path: "plugins/broken", operation: "create" }]);
      await waitFor(
        () => pipeline.list().some((p) => p.directoryName === "broken"),
        "The invalid candidate was never discovered.",
      );
      const firstDiagnostics = pipeline.list()
        .find((p) => p.directoryName === "broken")?.diagnostics;
      expect(firstDiagnostics).toBeDefined();

      events.length = 0;
      // Still invalid, still at "broken" — a DIFFERENT malformed manifest:
      // syntactically valid JSON this time, but missing what the schema
      // requires, so the parser reports a different diagnostic.
      await writeFile(
        join(brokenRoot, "dohc-plugin.json"),
        `${JSON.stringify({ notAVersionField: true }, null, 2)}\n`,
      );
      pipeline.handleWatcherEvents([{ path: "plugins/broken", operation: "update" }]);
      await waitFor(() => {
        const current = pipeline.list().find((p) => p.directoryName === "broken");
        return current !== undefined &&
          JSON.stringify(current.diagnostics) !== JSON.stringify(firstDiagnostics);
      }, "The invalid candidate's diagnostics never changed.");

      expect(events).toContainEqual({ kind: "discovery-changed" });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Round 10 finding 2: the sourceless retry (this same pattern, but for a
  // never-approved install whose manifest broke under a directory name
  // different from its record's key) used to resolve cleanup by pluginId
  // alone — the fallback id finishSourcelessUninstall's synthetic candidate
  // carries, never the ORIGINAL id a persisted record survives under. The
  // source delete from the first, partially-failed attempt already
  // succeeded; only the record-by-directory join can still find the
  // original id once discovery has nothing left to join by rootPath.
  it("clears the originally-keyed state on a sourceless retry after a partial delete", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-sourceless-retry-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const pluginRoot = join(workspaceRoot, "plugins", "my-codex-copy");
    await mkdir(join(pluginRoot, "src"), { recursive: true });
    await writeFile(
      join(pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "codex", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(join(pluginRoot, "src", "main.ts"), "export default {};\n");

    await mutatePluginRecord(stateDir, workspaceRoot, "codex", () => ({
      directoryName: "my-codex-copy",
    }));
    const dohcDir = pluginDataDir(stateDir, workspaceRoot);
    const strandedStateRoot = pluginStateRoot(dohcDir, "codex");
    await mkdir(strandedStateRoot, { recursive: true });
    await writeFile(join(strandedStateRoot, "session.json"), "{}");

    await writeFile(join(pluginRoot, "dohc-plugin.json"), "{ this is not valid JSON\n");

    let pipeline: PluginPipeline;
    let failCodexDataRemoval = false;
    const stoppedRuntimeIds: string[] = [];
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      onRuntimeStopped: (stoppedPluginId) => {
        stoppedRuntimeIds.push(stoppedPluginId);
      },
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        removePath: async (path, options) => {
          if (failCodexDataRemoval && String(path).startsWith(strandedStateRoot)) {
            throw new Error("simulated data delete failure");
          }
          await rm(path, options);
        },
      },
    });

    try {
      await pipeline.start();
      const pluginId = pipeline.list()[0]!.id;
      expect(pluginId).toBe("my-codex-copy");

      failCodexDataRemoval = true;
      const staleAliasPreflight = await pipeline.uninstallPreflight(
        "codex",
        pluginId,
      );
      if (!staleAliasPreflight.ok) {
        throw new Error(staleAliasPreflight.error.message);
      }
      const firstPreflight = await pipeline.uninstallPreflight(pluginId, pluginId);
      if (!firstPreflight.ok) throw new Error(firstPreflight.error.message);
      const failed = await pipeline.uninstall(pluginId, pluginId, firstPreflight.confirmationToken);
      expect(failed.ok).toBe(false);

      // The source is gone; the originally-keyed state and record survive
      // this partial failure, exactly as the delete failure left them.
      await expect(lstat(pluginRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(strandedStateRoot)).resolves.toBeDefined();
      const midState = await readPluginLocalState(stateDir, workspaceRoot);
      if (!midState.ok) throw new Error(midState.warning);
      expect(midState.state.plugins["codex"]).toBeDefined();

      // The watcher observes the deleted root: discovery has no candidate
      // left, and only the status row (and the record-by-directory join)
      // still name this installation.
      pipeline.handleWatcherEvents([{ path: "plugins/my-codex-copy", operation: "delete" }]);
      await waitFor(
        () => pipeline.list().length === 1,
        "The watcher sweep never reconciled the deleted root.",
      );

      // The retry is the same action from the same row, and it finishes —
      // clearing the ORIGINAL "codex" key's state and record too, not only
      // pluginId's own (which never had anything under it to begin with).
      failCodexDataRemoval = false;
      const retryPreflight = await pipeline.uninstallPreflight(pluginId, pluginId);
      if (!retryPreflight.ok) throw new Error(retryPreflight.error.message);
      // Round 11 finding 1: this retry's OWN preflight — the sourceless
      // path, with no discovery candidate left at all — must still name
      // the original "codex" key's data before the user confirms deleting
      // it, not only report on pluginId's own (empty) state.
      expect(retryPreflight.preflight.stateData).toMatchObject({ fileCount: 1 });
      expect(retryPreflight.preflight.stateData?.path).toContain(strandedStateRoot);
      const transient = transientStateOf(pipeline);
      const trackedStatus = pipeline.list()[0];
      expect(trackedStatus).toBeDefined();
      transient.statuses.set("codex", trackedStatus!);
      doorWrittenDeltasOf(pipeline).set(pluginId, new Map());
      doorWrittenDeltasOf(pipeline).set("codex", new Map());
      transient.lastApprovedAttemptHash.set(pluginId, "a".repeat(64));
      transient.lastApprovedAttemptHash.set("codex", "b".repeat(64));
      stoppedRuntimeIds.length = 0;
      const finished = await pipeline.uninstall(
        pluginId,
        pluginId,
        retryPreflight.confirmationToken,
      );
      expect(finished.ok).toBe(true);
      expect(stoppedRuntimeIds.toSorted()).toEqual(["codex", "my-codex-copy"]);

      await expect(lstat(strandedStateRoot)).rejects.toMatchObject({ code: "ENOENT" });
      const finalState = await readPluginLocalState(stateDir, workspaceRoot);
      if (!finalState.ok) throw new Error(finalState.warning);
      expect(finalState.state.plugins["codex"]).toBeUndefined();
      expect(finalState.state.plugins["my-codex-copy"]).toBeUndefined();
      expect(transient.statuses.has(pluginId)).toBe(false);
      expect(transient.statuses.has("codex")).toBe(false);
      expect(doorWrittenDeltasOf(pipeline).has(pluginId)).toBe(false);
      expect(doorWrittenDeltasOf(pipeline).has("codex")).toBe(false);
      expect(transient.lastApprovedAttemptHash.has(pluginId)).toBe(false);
      expect(transient.lastApprovedAttemptHash.has("codex")).toBe(false);
      expect(pipeline.list()).toEqual([]);
      const staleAliasRemoval = await pipeline.uninstall(
        "codex",
        pluginId,
        staleAliasPreflight.confirmationToken,
      );
      expect(staleAliasRemoval).toMatchObject({
        ok: false,
        error: { code: "confirmation-required" },
      });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Round 18 finding 4: settings used to route by id alone, and two
  // directories can share an id (a duplicate manifest name — discovery's
  // own tie-break degrades one side, but both still carry the same id).
  // Reading and saving must name the exact directory a caller selected,
  // never whichever row that id happens to resolve to first.
  it("keeps two id-colliding directories' settings apart", async () => {
    const fixture = await createPluginWorkspace();
    const settingsManifest = {
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
      ],
    };
    await writeFile(
      join(fixture.pluginRoot, "dohc-plugin.json"),
      `${JSON.stringify(settingsManifest, null, 2)}\n`,
    );

    // A second directory declaring the SAME manifest name — a genuine id
    // collision, not a broken-manifest fallback.
    const otherRoot = join(fixture.workspaceRoot, "plugins", "z-example-plugin");
    await mkdir(join(otherRoot, "src"), { recursive: true });
    await writeFile(
      join(otherRoot, "dohc-plugin.json"),
      `${JSON.stringify(settingsManifest, null, 2)}\n`,
    );
    await writeFile(join(otherRoot, "src", "index.ts"), "export default {};\n");

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
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
    });

    try {
      await pipeline.start();

      const saved = await pipeline.setPluginSettings("example-plugin", "example-plugin", {
        greeting: "Hei",
      });
      expect(saved).toEqual({ greeting: "Hei" });

      // The exact directory just saved to reads back its own answer.
      expect(await pipeline.getPluginSettings("example-plugin")).toEqual({
        greeting: "Hei",
      });
      // The id-colliding OTHER directory is untouched — still its own
      // manifest's default, never the answer just written under the
      // shared id.
      expect(await pipeline.getPluginSettings("z-example-plugin")).toEqual({
        greeting: "Hello",
      });
    } finally {
      await pipeline.dispose();
    }
  });

  it("keeps a built registration on its exact root when an invalid fallback id collides", async () => {
    const fixture = await createNamedPluginWorkspace("zzz", "aaa");
    const invalidRoot = join(fixture.workspaceRoot, "plugins", "aaa");
    await mkdir(invalidRoot, { recursive: true });
    await writeFile(
      join(invalidRoot, "dohc-plugin.json"),
      "{ this is not valid JSON\n",
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
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      expect(pipeline.pluginRegistration("aaa")).toMatchObject({
        pluginRoot: fixture.pluginRoot,
        directoryName: "zzz",
        manifest: { name: "aaa" },
      });

      const installed = await pipeline.install("aaa");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }

      expect(pipeline.pluginRegistration("aaa")).toMatchObject({
        pluginRoot: fixture.pluginRoot,
        directoryName: "zzz",
        manifest: { name: "aaa" },
      });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Round 19 finding 3: dohc's own build and state storage (liveRoot,
  // pluginStateRoot) is keyed by pluginId, not directoryName — an id an
  // invalid, never-installed collision loser shares with a genuinely
  // installed row's real id. Presence of an id alone must not report the
  // installed row's real bytes for the OTHER directory that happens to
  // share it.

  // Round 19 finding 3: dohc's own build and state storage (liveRoot,
  // pluginStateRoot) is keyed by pluginId, not directoryName — an id an
  // invalid, never-installed collision loser shares with a genuinely
  // installed row's real id. Presence of an id alone must not report the
  // installed row's real bytes for the OTHER directory that happens to
  // share it.
  it("reports no bytes for an id-colliding directory that never actually built or ran", async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), "dohc-plugin-sizes-collision-"));
    roots.push(targetRoot);
    const workspaceRoot = join(targetRoot, "workspace");
    const stateDir = join(targetRoot, "state");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const installedRoot = join(workspaceRoot, "plugins", "installed-dir");
    await mkdir(join(installedRoot, "src"), { recursive: true });
    await writeFile(
      join(installedRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "collide", entry: "src/main.ts" }, null, 2)}\n`,
    );
    await writeFile(
      join(installedRoot, "package.json"),
      `${JSON.stringify({
        name: "collide",
        version: "1.0.0",
        private: true,
        type: "module",
        packageManager: "pnpm@11.20.0",
      }, null, 2)}\n`,
    );
    await writeFile(join(installedRoot, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "importers:",
      "  .: {}",
      "",
    ].join("\n"));
    await writeFile(join(installedRoot, "src", "main.ts"), "export default {};\n");

    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir,
      workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot,
      stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("collide");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list().find((row) => row.directoryName === "installed-dir")?.status
          === "ready",
        "installed-dir did not reach ready.",
      );

      // The installed row's own bytes are real.
      const ownSizes = await pipeline.sizes("installed-dir", "collide");
      expect(ownSizes.installedBytes).not.toBeNull();

      // A second, unrelated directory declaring the SAME manifest name —
      // never installed, no build or state of its own.
      const otherRoot = join(workspaceRoot, "plugins", "other-dir");
      await mkdir(join(otherRoot, "src"), { recursive: true });
      await writeFile(
        join(otherRoot, "dohc-plugin.json"),
        `${JSON.stringify({ version: 1, name: "collide", entry: "src/main.ts" }, null, 2)}\n`,
      );
      await writeFile(join(otherRoot, "src", "main.ts"), "export default {};\n");
      await pipeline.handleWatcherEvents([{ operation: "update", path: "plugins" }]);

      // Never the installed row's real bytes, reported under the OTHER
      // directory's own name.
      expect(await pipeline.sizes("other-dir", "collide")).toEqual({
        installedBytes: null,
        dataBytes: null,
      });
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  // Round 20 finding 1: PluginHost.start() used to derive directoryName from
  // basename(pluginRoot) — correct for a test that passes the SOURCE
  // directory straight in, wrong for production, which starts a plugin
  // from its BUILT root (dohc's own .dohc/plugins/<safe-path> staging).
  // basename(builtRoot) reads pluginIdToSafePath(pluginId) — the id, not
  // the folder discovery found it at — so a plugin whose manifest name
  // differs from its folder got the wrong directoryName at every real
  // activation. Pinned through a REAL build and start, where the built
  // root's own basename ("foo") and the source folder ("my-copy") visibly
  // differ.

  // Round 20 finding 1: PluginHost.start() used to derive directoryName from
  // basename(pluginRoot) — correct for a test that passes the SOURCE
  // directory straight in, wrong for production, which starts a plugin
  // from its BUILT root (dohc's own .dohc/plugins/<safe-path> staging).
  // basename(builtRoot) reads pluginIdToSafePath(pluginId) — the id, not
  // the folder discovery found it at — so a plugin whose manifest name
  // differs from its folder got the wrong directoryName at every real
  // activation. Pinned through a REAL build and start, where the built
  // root's own basename ("foo") and the source folder ("my-copy") visibly
  // differ.
  it("activates with the source directory's own name, never the built root's basename", async () => {
    const fixture = await createPluginWorkspace();
    await rm(fixture.pluginRoot, { recursive: true, force: true });
    const myCopyRoot = join(fixture.workspaceRoot, "plugins", "my-copy");
    await mkdir(join(myCopyRoot, "src"), { recursive: true });
    await writeFile(
      join(myCopyRoot, "dohc-plugin.json"),
      `${JSON.stringify({ version: 1, name: "foo", entry: "src/index.ts" }, null, 2)}\n`,
    );
    await writeFile(
      join(myCopyRoot, "package.json"),
      `${JSON.stringify({
        name: "foo",
        version: "1.0.0",
        private: true,
        type: "module",
        packageManager: "pnpm@11.20.0",
      }, null, 2)}\n`,
    );
    await writeFile(join(myCopyRoot, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "importers:",
      "  .: {}",
      "",
    ].join("\n"));
    await writeFile(
      join(myCopyRoot, "src", "index.ts"),
      'export default { activate() {} };\n',
    );

    const readPluginSettings = vi.fn(async () => ({}));
    let pipeline: PluginPipeline;
    const host = new PluginHost({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      readPluginSettings,
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipeline({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      const installed = await pipeline.install("foo");
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => pipeline.list().find((row) => row.id === "foo")?.status === "ready",
        "foo did not reach ready.",
      );

      // Asked for the SOURCE folder's settings — never "foo", the built
      // root's own basename.
      expect(readPluginSettings).toHaveBeenCalledWith("my-copy");
    } finally {
      await pipeline.dispose();
    }
  }, 60_000);

  it("attributes and confirms an NFC-spelled write under an NFD plugin root", async () => {
    const nfdDirectory = "caf\u0065\u0301";
    const nfcDirectory = "caf\u00e9";
    const fixture = await createNamedPluginWorkspace(
      nfdDirectory,
      "unicode-plugin",
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
      hostOwnership: new PluginHostOwnership(host),
      platform: "darwin",
      resourcesBasePath,
      pnpmRunnerEntry,
    });

    try {
      await pipeline.start();
      const callerPath = join(
        fixture.workspaceRoot,
        "plugins",
        nfcDirectory,
        "src",
        "index.ts",
      );
      expect(pipeline.pluginIdForPath(callerPath)).toBe("unicode-plugin");

      const text = "normalization-equivalent root\n";
      const write = createPluginAuthoredTextWriter({
        platform: "darwin",
        signal: undefined,
        requireWritableCapture: async () => ({
          workspaceRoot: fixture.workspaceRoot,
          capture: {
            writeAuthoredTextFile: async (absolutePath) => {
              await writeFile(fixture.entryPath, text);
              return { resolvedAbsolutePath: absolutePath };
            },
          },
        }),
        pipeline: () => pipeline,
      });
      await write(
        join("plugins", nfcDirectory, "src", "index.ts"),
        text,
        {
          overwrite: true,
          author: {
            kind: "agent",
            agentId: "plugin:unicode-plugin",
            onBehalfOf: "local",
            agentRunId: "spawn-1",
          },
        },
      );

      expect(doorWrittenDeltasOf(pipeline).get("unicode-plugin"))
        .toEqual(new Map([[
          "src/index.ts",
          {
            sha256: createHash("sha256").update(text, "utf8").digest("hex"),
            seq: 1,
          },
        ]]));
    } finally {
      await pipeline.dispose();
    }
  });

  it("attributes a mixed-case directory that the source snapshot includes", async () => {
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
      hostOwnership: new PluginHostOwnership(host),
      platform: "darwin",
      resourcesBasePath,
      pnpmRunnerEntry,
    });

    try {
      await pipeline.start();
      pipeline.handleDoorWrittenSourceChange("example-plugin", {
        absolutePath: join(fixture.pluginRoot, "Node_Modules", "x.ts"),
        text: "included\n",
      });

      expect(doorWrittenDeltasOf(pipeline).get("example-plugin"))
        .toEqual(new Map([[
          "Node_Modules/x.ts",
          {
            sha256: createHash("sha256").update("included\n", "utf8").digest("hex"),
            seq: 1,
            provisional: true,
          },
        ]]));
    } finally {
      await pipeline.dispose();
    }
  });

  it("deletes a landed delta when rekeying reveals an excluded path", async () => {
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
      hostOwnership: new PluginHostOwnership(host),
      platform: "darwin",
      resourcesBasePath,
      pnpmRunnerEntry,
    });

    try {
      await pipeline.start();
      const callerPath = join(fixture.pluginRoot, "NODE_MODULES", "x.ts");
      pipeline.handleDoorWrittenSourceChange("example-plugin", {
        absolutePath: callerPath,
        text: "excluded\n",
      });
      pipeline.rekeyDoorWrittenSourceChange(
        "example-plugin",
        { absolutePath: callerPath },
        { absolutePath: join(fixture.pluginRoot, "node_modules", "x.ts") },
      );

      expect(doorWrittenDeltasOf(pipeline).get("example-plugin"))
        .toEqual(new Map());
    } finally {
      await pipeline.dispose();
    }
  });

  it("confirms a recovered plugin root by exact on-disk spelling", async () => {
    const actualPath = await vi.importActual<typeof import("node:path")>(
      "node:path",
    );
    vi.resetModules();
    // Model a case-sensitive volume even when this test runs on Windows.
    vi.doMock("node:path", () => ({
      ...actualPath,
      basename: actualPath.posix.basename,
      dirname: actualPath.posix.dirname,
      isAbsolute: actualPath.posix.isAbsolute,
      join: actualPath.posix.join,
      normalize: actualPath.posix.normalize,
      parse: actualPath.posix.parse,
      relative: actualPath.posix.relative,
      resolve: actualPath.posix.resolve,
      sep: actualPath.posix.sep,
    }));

    try {
      const { PluginPipeline: PluginPipelineWithPosixPaths } =
        await import("./PluginPipeline");
      const { PluginHost: PluginHostWithPosixPaths } =
        await import("./PluginHost");
      let pipeline: InstanceType<typeof PluginPipelineWithPosixPaths>;
      const host = new PluginHostWithPosixPaths({
        stateDir: "/state",
        workspaceRoot: "/workspace",
        spawnTransport: fakeSpawnTransport(),
        routeSdkRequest: async () => ({}),
        onStatusChange: (pluginId, status) => {
          pipeline.noteRuntimeStatus(pluginId, status);
        },
      });
      pipeline = new PluginPipelineWithPosixPaths({
        workspaceRoot: "/workspace",
        stateDir: "/state",
        hostOwnership: new PluginHostOwnership(host),
        platform: "darwin",
        pnpmRunnerEntry: "/runner",
      });
      const pipelineState = pipeline as unknown as {
        discovery: InstalledPluginRecord[];
        enqueueSourceRefresh(
          pluginId: string,
          run: () => Promise<void>,
        ): void;
      };
      pipelineState.discovery = [{
        id: "owned",
        directoryName: "owned",
        rootPath: "/workspace/plugins/owned",
        manifest: { version: 1, name: "owned", entry: "src/index.ts" },
        iconPath: null,
        diagnostics: [],
        valid: true,
        supersededPluginId: null,
      }];
      pipelineState.enqueueSourceRefresh = () => undefined;

      const recoveredPath = "/workspace/plugins/OWNED/src/index.ts";
      pipeline.handleDoorWrittenSourceChange("owned", {
        absolutePath: recoveredPath,
        text: "distinct root\n",
      });
      pipeline.rekeyDoorWrittenSourceChange(
        "owned",
        { absolutePath: recoveredPath },
        { absolutePath: recoveredPath },
      );

      expect(
        (pipeline as unknown as { doorWrittenDeltas: DoorWrittenDeltas })
          .doorWrittenDeltas.get("owned"),
      ).toEqual(new Map());
      pipeline.handleDoorWrittenSourceChange("owned", {
        absolutePath: recoveredPath,
        text: "confirmed root\n",
      });
      pipeline.rekeyDoorWrittenSourceChange(
        "owned",
        { absolutePath: recoveredPath },
        { absolutePath: "/workspace/plugins/owned/src/index.ts" },
      );

      expect(
        (pipeline as unknown as { doorWrittenDeltas: DoorWrittenDeltas })
          .doorWrittenDeltas.get("owned"),
      )
        .toEqual(new Map([[
          "src/index.ts",
          {
            sha256: createHash("sha256")
              .update("confirmed root\n", "utf8")
              .digest("hex"),
            seq: 2,
          },
        ]]));
    } finally {
      vi.doUnmock("node:path");
      vi.resetModules();
    }
  });

  for (const scenario of [
    { name: "an empty directory", excludedOnly: false },
    { name: "a directory with only excluded content", excludedOnly: true },
  ]) {
    it.skipIf(process.platform !== "win32")(
      `auto-approves a case-drifted Windows door write under ${scenario.name}`,
      async () => {
        const fixture = await createPluginWorkspace();
        const existingDirectory = join(fixture.pluginRoot, "src", "NewDir");
        await mkdir(existingDirectory, { recursive: true });
        if (scenario.excludedOnly) {
          const excludedPath = join(existingDirectory, "node_modules", "x.js");
          await mkdir(dirname(excludedPath), { recursive: true });
          await writeFile(excludedPath, "excluded\n");
        }
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
          hostOwnership: new PluginHostOwnership(host),
          resourcesBasePath,
          pnpmRunnerEntry,
          operations: {
            install: (input) =>
              installPluginDependencies({
                ...input,
                forkProcess: nodeForkProcess,
              }),
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
          await authoredDoorWrite(
            pipeline,
            fixture.workspaceRoot,
            join("plugins", "example-plugin", "SRC", "newdir", "a.ts"),
            "export const added = true;\n",
          );

          await waitFor(
            () => {
              const plugin = pipeline.list()[0];
              return plugin?.status === "disabled-pending-approval" ||
                (plugin?.status === "ready" &&
                  plugin.approvedHash !== originalHash);
            },
            "Door write did not finish reconciliation.",
          );
          expect(pipeline.list()[0]).toMatchObject({
            status: "ready",
            disabledReason: null,
          });
          expect(pipeline.list()[0]?.approvedHash).not.toBe(originalHash);
        } finally {
          await pipeline.dispose();
        }
      },
      60_000,
    );
  }

  it("retries a provisional new-directory delta before hashing it", async () => {
    const fixture = await createPluginWorkspace();
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    const canonicalDirectory = join(fixture.pluginRoot, "src", "NewDir");
    const canonicalPath = join(canonicalDirectory, "a.ts");
    const failedDirectory = resolve(join(fixture.pluginRoot, "src"));
    let transientFailures = 0;
    const readdirMock = vi.fn(async (...args: Parameters<typeof readdir>) => {
      if (
        resolve(String(args[0])) === failedDirectory &&
        transientFailures === 0
      ) {
        transientFailures += 1;
        throw new Error("simulated transient readdir failure");
      }
      return actualFs.readdir(...args);
    });
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => ({
      ...actualFs,
      readdir: readdirMock,
    }));

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
      hostOwnership: new PluginHostOwnership(host),
      platform: "darwin",
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
      const originalHash = pipeline.list()[0]?.approvedHash;
      await mkdir(canonicalDirectory, { recursive: true });

      const { createPluginAuthoredTextWriter: createWriterWithTransientRead } =
        await import("./pluginAuthoredWrite");
      const write = createWriterWithTransientRead({
        platform: "darwin",
        signal: undefined,
        requireWritableCapture: async () => ({
          workspaceRoot: fixture.workspaceRoot,
          capture: {
            writeAuthoredTextFile: async (_absolutePath, text) => {
              await writeFile(canonicalPath, text);
              return { resolvedAbsolutePath: _absolutePath };
            },
          },
        }),
        pipeline: () => pipeline,
      });
      await write(
        join("plugins", "example-plugin", "SRC", "newdir", "a.ts"),
        "export const recovered = true;\n",
        {
          overwrite: true,
          author: {
            kind: "agent",
            agentId: "plugin:example-plugin",
            onBehalfOf: "local",
            agentRunId: "spawn-1",
          },
        },
      );

      await waitFor(
        () => {
          const plugin = pipeline.list()[0];
          return plugin?.status === "ready" &&
            plugin.approvedHash !== originalHash;
        },
        "The retried door write did not reach ready.",
        60_000,
      );
      expect(transientFailures).toBe(1);
      expect(pipeline.list()[0]?.disabledReason).toBeNull();
    } finally {
      await pipeline.dispose();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  }, 120_000);

  it("confirms fold-attributed ownership before settling a provisional delta", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    const actualPath = await vi.importActual<typeof import("node:path")>(
      "node:path",
    );
    let pluginEntries: string[] = [];
    const readdirMock = vi.fn(async (...args: Parameters<typeof readdir>) => {
      switch (actualPath.posix.resolve(String(args[0]))) {
        case "/workspace":
          return ["plugins"];
        case "/workspace/plugins":
          return pluginEntries;
        case "/workspace/plugins/owned":
        case "/workspace/plugins/OWNED":
          return ["src"];
        case "/workspace/plugins/owned/src":
        case "/workspace/plugins/OWNED/src":
          return ["index.ts"];
        default:
          throw new Error("Unexpected readdir path: " + String(args[0]));
      }
    });
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => ({
      ...actualFs,
      readdir: readdirMock,
    }));
    vi.doMock("node:path", () => ({
      ...actualPath,
      basename: actualPath.posix.basename,
      dirname: actualPath.posix.dirname,
      isAbsolute: actualPath.posix.isAbsolute,
      join: actualPath.posix.join,
      normalize: actualPath.posix.normalize,
      parse: actualPath.posix.parse,
      relative: actualPath.posix.relative,
      resolve: actualPath.posix.resolve,
      sep: actualPath.posix.sep,
    }));

    try {
      const { PluginPipeline: PluginPipelineWithPosixPaths } =
        await import("./PluginPipeline");
      const { PluginHost: PluginHostWithPosixPaths } =
        await import("./PluginHost");

      for (const scenario of [
        { entries: ["owned", "OWNED"], confirmed: false },
        { entries: ["owned"], confirmed: true },
      ]) {
        pluginEntries = scenario.entries;
        let pipeline: InstanceType<typeof PluginPipelineWithPosixPaths>;
        const host = new PluginHostWithPosixPaths({
          stateDir: "/state",
          workspaceRoot: "/workspace",
          spawnTransport: fakeSpawnTransport(),
          routeSdkRequest: async () => ({}),
          onStatusChange: (pluginId, status) => {
            pipeline.noteRuntimeStatus(pluginId, status);
          },
        });
        pipeline = new PluginPipelineWithPosixPaths({
          workspaceRoot: "/workspace",
          stateDir: "/state",
          hostOwnership: new PluginHostOwnership(host),
          platform: "darwin",
          pnpmRunnerEntry: "/runner",
        });
        const pipelineState = pipeline as unknown as {
          discovery: InstalledPluginRecord[];
          doorWrittenDeltas: DoorWrittenDeltas;
          enqueueSourceRefresh(
            pluginId: string,
            run: () => Promise<void>,
          ): void;
          retryProvisionalDeltaRecovery(pluginId: string): Promise<void>;
        };
        pipelineState.discovery = [{
          id: "owned",
          directoryName: "owned",
          rootPath: "/workspace/plugins/owned",
          manifest: { version: 1, name: "owned", entry: "src/index.ts" },
          iconPath: null,
          diagnostics: [],
          valid: true,
          supersededPluginId: null,
        }];
        pipelineState.enqueueSourceRefresh = () => undefined;

        const callerPath = "/workspace/plugins/OWNED/src/index.ts";
        const text = scenario.confirmed ? "confirmed\n" : "distinct root\n";
        const sha256 = createHash("sha256")
          .update(text, "utf8")
          .digest("hex");
        pipeline.handleDoorWrittenSourceChange("owned", {
          absolutePath: callerPath,
          text,
        });
        expect(pipelineState.doorWrittenDeltas.get("owned")).toEqual(new Map([[
          "src/index.ts",
          {
            sha256,
            seq: 1,
            provisional: true,
            provisionalOrigin: callerPath,
          },
        ]]));

        await pipelineState.retryProvisionalDeltaRecovery("owned");

        expect(pipelineState.doorWrittenDeltas.get("owned")).toEqual(
          scenario.confirmed
            ? new Map([["src/index.ts", { sha256, seq: 1 }]])
            : new Map(),
        );
      }
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.doUnmock("node:path");
      vi.resetModules();
    }
  });

  it("converges baseline-absent provisional case variants after recovery confirms one", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    const actualPath = await vi.importActual<typeof import("node:path")>(
      "node:path",
    );
    const readdirMock = vi.fn(async (...args: Parameters<typeof readdir>) => {
      switch (actualPath.posix.resolve(String(args[0]))) {
        case "/workspace/plugins/owned":
          return ["SRC"];
        case "/workspace/plugins/owned/SRC":
          return ["new.ts"];
        default:
          throw new Error("Unexpected readdir path: " + String(args[0]));
      }
    });
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => ({
      ...actualFs,
      readdir: readdirMock,
    }));
    vi.doMock("node:path", () => ({
      ...actualPath,
      basename: actualPath.posix.basename,
      dirname: actualPath.posix.dirname,
      isAbsolute: actualPath.posix.isAbsolute,
      join: actualPath.posix.join,
      normalize: actualPath.posix.normalize,
      parse: actualPath.posix.parse,
      relative: actualPath.posix.relative,
      resolve: actualPath.posix.resolve,
      sep: actualPath.posix.sep,
    }));

    try {
      const { PluginPipeline: PluginPipelineWithPosixPaths } =
        await import("./PluginPipeline");
      const { PluginHost: PluginHostWithPosixPaths } =
        await import("./PluginHost");
      let pipeline: InstanceType<typeof PluginPipelineWithPosixPaths>;
      const host = new PluginHostWithPosixPaths({
        stateDir: "/state",
        workspaceRoot: "/workspace",
        spawnTransport: fakeSpawnTransport(),
        routeSdkRequest: async () => ({}),
        onStatusChange: (pluginId, status) => {
          pipeline.noteRuntimeStatus(pluginId, status);
        },
      });
      pipeline = new PluginPipelineWithPosixPaths({
        workspaceRoot: "/workspace",
        stateDir: "/state",
        hostOwnership: new PluginHostOwnership(host),
        platform: "darwin",
        pnpmRunnerEntry: "/runner",
      });
      const pipelineState = pipeline as unknown as {
        discovery: InstalledPluginRecord[];
        doorWrittenDeltas: DoorWrittenDeltas;
        enqueueSourceRefresh(
          pluginId: string,
          run: () => Promise<void>,
        ): void;
        retryProvisionalDeltaRecovery(pluginId: string): Promise<void>;
      };
      pipelineState.discovery = [{
        id: "owned",
        directoryName: "owned",
        rootPath: "/workspace/plugins/owned",
        manifest: { version: 1, name: "owned", entry: "src/index.ts" },
        iconPath: null,
        diagnostics: [],
        valid: true,
        supersededPluginId: null,
      }];
      pipelineState.enqueueSourceRefresh = () => undefined;

      const firstText = "first\n";
      const latestText = "latest\n";
      pipeline.handleDoorWrittenSourceChange("owned", {
        absolutePath: "/workspace/plugins/owned/SRC/new.ts",
        text: firstText,
      });
      pipeline.handleDoorWrittenSourceChange("owned", {
        absolutePath: "/workspace/plugins/owned/src/new.ts",
        text: latestText,
      });
      expect(pipelineState.doorWrittenDeltas.get("owned")).toEqual(new Map([
        ["SRC/new.ts", {
          sha256: createHash("sha256").update(firstText, "utf8").digest("hex"),
          seq: 1,
          provisional: true,
          provisionalOrigin: undefined,
        }],
        ["src/new.ts", {
          sha256: createHash("sha256").update(latestText, "utf8").digest("hex"),
          seq: 2,
          provisional: true,
          provisionalOrigin: undefined,
        }],
      ]));

      await pipelineState.retryProvisionalDeltaRecovery("owned");

      expect(pipelineState.doorWrittenDeltas.get("owned")).toEqual(new Map([[
        "SRC/new.ts",
        {
          sha256: createHash("sha256").update(latestText, "utf8").digest("hex"),
          seq: 2,
        },
      ]]));
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.doUnmock("node:path");
      vi.resetModules();
    }
  });

  it("does not let stale provisional recovery replace a newer same-path write", async () => {
    const fixture = await createPluginWorkspace();
    const recoveryStarted = deferred();
    const releaseRecovery = deferred();
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    let blockRecovery = false;
    let blocked = false;
    const readdirMock = vi.fn(async (...args: Parameters<typeof readdir>) => {
      if (
        blockRecovery &&
        !blocked &&
        resolve(String(args[0])) === resolve(fixture.pluginRoot)
      ) {
        blocked = true;
        recoveryStarted.resolve();
        await releaseRecovery.promise;
      }
      return actualFs.readdir(...args);
    });
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => ({
      ...actualFs,
      readdir: readdirMock,
    }));

    const { PluginPipeline: PluginPipelineWithDelayedRecovery } =
      await import("./PluginPipeline");
    const { PluginHost: PluginHostWithDelayedRecovery } =
      await import("./PluginHost");
    let pipeline: InstanceType<typeof PluginPipelineWithDelayedRecovery>;
    const host = new PluginHostWithDelayedRecovery({
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      spawnTransport: fakeSpawnTransport(),
      routeSdkRequest: async () => ({}),
      onStatusChange: (pluginId, status) => {
        pipeline.noteRuntimeStatus(pluginId, status);
      },
    });
    pipeline = new PluginPipelineWithDelayedRecovery({
      workspaceRoot: fixture.workspaceRoot,
      stateDir: fixture.stateDir,
      hostOwnership: new PluginHostOwnership(host),
      platform: "darwin",
      resourcesBasePath,
      pnpmRunnerEntry,
    });

    try {
      await pipeline.start();
      const oldText = "old bytes\n";
      const deltas = new Map([[
        "src/index.ts",
        {
          sha256: createHash("sha256").update(oldText, "utf8").digest("hex"),
          seq: 1,
          provisional: true,
        },
      ]]);
      doorWrittenDeltasOf(pipeline).set("example-plugin", deltas);
      (pipeline as unknown as { doorWriteSeq: number }).doorWriteSeq = 1;

      blockRecovery = true;
      const pendingRecovery = (pipeline as unknown as {
        retryProvisionalDeltaRecovery(pluginId: string): Promise<void>;
      }).retryProvisionalDeltaRecovery("example-plugin");
      await recoveryStarted.promise;

      const newText = "new bytes\n";
      pipeline.handleDoorWrittenSourceChange("example-plugin", {
        absolutePath: fixture.entryPath,
        text: newText,
      });
      releaseRecovery.resolve();
      await pendingRecovery;

      expect(deltas.get("src/index.ts")).toMatchObject({
        sha256: createHash("sha256").update(newText, "utf8").digest("hex"),
        seq: 2,
      });
    } finally {
      releaseRecovery.resolve();
      await pipeline.dispose();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  }, 120_000);

  it("attributes an authored write before delayed case recovery lets a watcher reconcile it", async () => {
    const fixture = await createPluginWorkspace();
    const recoveryStarted = deferred();
    const releaseRecovery = deferred();
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    let readCount = 0;
    const readdirMock = vi.fn(async (...args: Parameters<typeof readdir>) => {
      readCount += 1;
      if (readCount === 1) {
        recoveryStarted.resolve();
        await releaseRecovery.promise;
      }
      return actualFs.readdir(...args);
    });
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => ({
      ...actualFs,
      readdir: readdirMock,
    }));

    const observedStatuses: string[] = [];
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
      hostOwnership: new PluginHostOwnership(host),
      platform: "darwin",
      resourcesBasePath,
      pnpmRunnerEntry,
      onStatusChange: (event) => {
        if (event.kind === "changed") observedStatuses.push(event.plugin.status);
      },
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
      },
    });

    try {
      await pipeline.start();
      expect(pipeline.pluginIdForPath(
        join(fixture.workspaceRoot, "PLUGINS", "EXAMPLE-PLUGIN", "src", "index.ts"),
      )).toBe("example-plugin");
      const installed = await pipeline.install("example-plugin");
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );
      const originalHash = pipeline.list()[0]?.approvedHash;
      observedStatuses.length = 0;

      const { createPluginAuthoredTextWriter: createWriterWithDelayedRecovery } =
        await import("./pluginAuthoredWrite");
      const write = createWriterWithDelayedRecovery({
        platform: "darwin",
        signal: undefined,
        requireWritableCapture: async () => ({
          workspaceRoot: fixture.workspaceRoot,
          capture: {
            writeAuthoredTextFile: async (_absolutePath, text) => {
              await writeFile(fixture.entryPath, text);
              return { resolvedAbsolutePath: _absolutePath };
            },
          },
        }),
        pipeline: () => pipeline,
      });
      const pendingWrite = write(
        join("plugins", "example-plugin", "SRC", "index.ts"),
        [
          'export const marker = "watcher-window";',
          "export default { activate() {} };",
          "",
        ].join("\n"),
        {
          overwrite: true,
          author: {
            kind: "agent",
            agentId: "plugin:example-plugin",
            onBehalfOf: "local",
            agentRunId: "spawn-1",
          },
        },
      );
      await recoveryStarted.promise;

      await pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin/src/index.ts",
        operation: "update",
      }]);
      await waitFor(
        () =>
          pipeline.list()[0]?.status === "disabled-pending-approval" ||
          (pipeline.list()[0]?.status === "ready" &&
            pipeline.list()[0]?.approvedHash !== originalHash),
        "The watcher-window reconciliation did not settle.",
        60_000,
      );
      const statusesDuringRecovery = [...observedStatuses];
      releaseRecovery.resolve();
      await pendingWrite;
      await waitFor(
        () =>
          pipeline.list()[0]?.status === "ready" &&
          pipeline.list()[0]?.approvedHash !== originalHash,
        "The attributed write did not finish rebuilding.",
        60_000,
      );

      expect(statusesDuringRecovery).not.toContain("disabled-pending-approval");
    } finally {
      releaseRecovery.resolve();
      await pipeline.dispose();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  }, 120_000);

  it("keeps the second same-file write from two separate writers when the first recovery finishes last", async () => {
    const fixture = await createPluginWorkspace();
    const firstRecoveryStarted = deferred();
    const releaseFirstRecovery = deferred();
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    let readCount = 0;
    const readdirMock = vi.fn(async (...args: Parameters<typeof readdir>) => {
      readCount += 1;
      if (readCount === 1) {
        firstRecoveryStarted.resolve();
        await releaseFirstRecovery.promise;
      }
      return actualFs.readdir(...args);
    });
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => ({
      ...actualFs,
      readdir: readdirMock,
    }));

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
      hostOwnership: new PluginHostOwnership(host),
      platform: "darwin",
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

      const { createPluginAuthoredTextWriter: createIndependentWriter } =
        await import("./pluginAuthoredWrite");
      const input = {
        platform: "darwin" as const,
        signal: undefined,
        requireWritableCapture: async () => ({
          workspaceRoot: fixture.workspaceRoot,
          capture: {
            writeAuthoredTextFile: async (_absolutePath: string, text: string) => {
              await writeFile(fixture.entryPath, text);
              return { resolvedAbsolutePath: _absolutePath };
            },
          },
        }),
        pipeline: () => pipeline,
      };
      const firstWriter = createIndependentWriter(input);
      const secondWriter = createIndependentWriter(input);
      const relativePath = join(
        "plugins",
        "example-plugin",
        "SRC",
        "index.ts",
      );
      const firstWrite = firstWriter(
        relativePath,
        [
          'export const marker = "writer-one";',
          "export default { activate() {} };",
          "",
        ].join("\n"),
        {
          overwrite: true,
          author: {
            kind: "agent",
            agentId: "plugin:example-plugin",
            onBehalfOf: "local",
            agentRunId: "spawn-1",
          },
        },
      );
      await firstRecoveryStarted.promise;
      await secondWriter(
        relativePath,
        [
          'export const marker = "writer-two";',
          "export default { activate() {} };",
          "",
        ].join("\n"),
        {
          overwrite: true,
          author: {
            kind: "agent",
            agentId: "plugin:example-plugin",
            onBehalfOf: "local",
            agentRunId: "spawn-2",
          },
        },
      );
      releaseFirstRecovery.resolve();
      await firstWrite;

      await vi.waitFor(
        async () => {
          expect(pipeline.list()[0]?.status).toBe("ready");
          expect(await readFile(
            liveBundlePath(fixture, "example-plugin"),
            "utf8",
          )).toContain("writer-two");
        },
        { timeout: 60_000, interval: 20 },
      );
      expect(pipeline.list()[0]?.disabledReason).toBeNull();
    } finally {
      releaseFirstRecovery.resolve();
      await pipeline.dispose();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  }, 120_000);

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
      hostOwnership: new PluginHostOwnership(host),
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

      const preflight = await pipeline.uninstallPreflight("renamed-plugin", "example-plugin");
      if (!preflight.ok) throw new Error(preflight.error.message);
      expect(preflight.preflight.warning?.kind).toBe("plugin-state");
      expect(preflight.preflight.stateData).toMatchObject({
        path: stateRoot,
        fileCount: 1,
      });
      const uninstalled = await pipeline.uninstall(
        "renamed-plugin",
        "example-plugin",
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
      hostOwnership: new PluginHostOwnership(host),
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
      const { result } = await ensureFromCommand(pipeline, "example-plugin");

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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
    // The full preflight runs once for the dialog. Execution hashes the source
    // before stopping and again immediately before deletion; the second probe
    // sees drift across the real host-stop await window.
    let preflightCalls = 0;
    let hashSourceCalls = 0;
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
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        uninstallPreflight: async (input) => {
          preflightCalls += 1;
          return pluginUninstallPreflight(input);
        },
        hashSource: async (rootPath) => {
          hashSourceCalls += 1;
          const real = await hashPluginSourceFiles(rootPath);
          return hashSourceCalls === 1
            ? real
            : { ...real, sourceHash: "f".repeat(64) };
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

      const preflight = await pipeline.uninstallPreflight("example-plugin", "example-plugin");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const result = await pipeline.uninstall(
        "example-plugin",
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
      expect(preflightCalls).toBe(1);
      expect(hashSourceCalls).toBe(2);
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
    // The dialog can read the source, but execution's fail-closed hash probe
    // cannot. A present source with an unreadable hash must never compare as
    // equivalent to an absent source.
    let preflightCalls = 0;
    let hashSourceCalls = 0;
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
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        uninstallPreflight: async (input) => {
          preflightCalls += 1;
          return pluginUninstallPreflight(input);
        },
        hashSource: async () => {
          hashSourceCalls += 1;
          throw new Error("simulated unreadable source");
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

      const preflight = await pipeline.uninstallPreflight("example-plugin", "example-plugin");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const result = await pipeline.uninstall(
        "example-plugin",
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
      expect(preflightCalls).toBe(1);
      expect(hashSourceCalls).toBe(1);
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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

      const preflight = await pipeline.uninstallPreflight("example-plugin", "example-plugin");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const failed = await pipeline.uninstall(
        "example-plugin",
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
      const retryPreflight = await pipeline.uninstallPreflight("example-plugin", "example-plugin");
      if (!retryPreflight.ok) throw new Error(retryPreflight.error.message);
      const retried = await pipeline.uninstall(
        "example-plugin",
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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

      const preflight = await pipeline.uninstallPreflight("example-plugin", "example-plugin");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const uninstalled = await pipeline.uninstall(
        "example-plugin",
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
        hostOwnership: new PluginHostOwnership(host),
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

      const preflight = await pipeline.uninstallPreflight("example-plugin", "example-plugin");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const uninstalled = await pipeline.uninstall(
        "example-plugin",
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
      hostOwnership: new PluginHostOwnership(host),
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
      const { result: restarted } = await ensureFromCommand(
        pipeline,
        "example-plugin",
      );

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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
        hostOwnership: new PluginHostOwnership(host),
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

      const preflight = await pipeline.uninstallPreflight("@scope/bar", "foo");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const uninstalled = await pipeline.uninstall(
        "@scope/bar",
        "foo",
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
        hostOwnership: new PluginHostOwnership(host),
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

      const preflight = await pipeline.uninstallPreflight("shared-id", "zeta");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const uninstalled = await pipeline.uninstall(
        "shared-id",
        "zeta",
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
        hostOwnership: new PluginHostOwnership(host),
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

      const preflight = await pipeline.uninstallPreflight("shared-id", "beta");
      if (!preflight.ok) throw new Error(preflight.error.message);
      const uninstalled = await pipeline.uninstall(
        "shared-id",
        "beta",
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      const surface = await ensureFromSurface(pipeline, "example-plugin");
      const started = surface.result;

      // Fail-closed, and no staged bytes left beside the live root: the
      // rejected discard is retried by the same job's cleanup (#779 round
      // 10 A5).
      expect(started.ok).toBe(false);
      expect(discards).toHaveLength(2);
      expect(await stagingLeftovers(fixture, "example-plugin")).toEqual([]);
      await surface.release();
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
      hostOwnership: new PluginHostOwnership(host),
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
      drainTimeoutMs?: number;
      onRuntimeStopped?: (pluginId: string) => void | Promise<void>;
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
      let failNextStop = false;
      let nextSnapshotGate: { entered: Deferred; release: Deferred } | null = null;
      let buildCalls = 0;
      let registeredCommands = (options.commands ?? [])
        .map((command) => command.id);
      const statuses: string[] = [];
      let pipeline: PluginPipeline;
      const baseSpawnTransport = fakeSpawnTransport(
        () => [...registeredCommands],
        async (method) => {
          const gate = nextStopGate;
          if (method !== PLUGIN_HOST_METHODS.deactivate || !gate) return;
          nextStopGate = null;
          gate.entered.resolve();
          await gate.release.promise;
        },
      );
      const host = new PluginHost({
        stateDir: fixture.stateDir,
        workspaceRoot: fixture.workspaceRoot,
        // Wraps the base transport's dispose() so a test can make
        // PluginHost.stop() itself reject — shutdown() awaits dispose()
        // outside any catch, unlike the deactivate RPC beside it, so this
        // is the one seam that reaches stopOldRuntime's own stop() call
        // as a genuine rejection (round-12 finding 3).
        spawnTransport: (params) => {
          const transport = baseSpawnTransport(params);
          return {
            ...transport,
            dispose: async () => {
              if (failNextStop) {
                failNextStop = false;
                throw new Error("simulated: PluginHost.stop() transport dispose failed");
              }
              return transport.dispose();
            },
          };
        },
        routeSdkRequest: async () => ({}),
        onStatusChange: (pluginId, status) => {
          pipeline.noteRuntimeStatus(pluginId, status);
        },
      });
      const hostOwnership = new PluginHostOwnership(host, {
        drainTimeoutMs: options.drainTimeoutMs,
      });
      pipeline = new PluginPipeline({
        workspaceRoot: fixture.workspaceRoot,
        stateDir: fixture.stateDir,
        hostOwnership,
        resourcesBasePath,
        pnpmRunnerEntry,
        onStatusChange: (event) => {
          if (event.kind === "changed") statuses.push(event.plugin.status);
        },
        onRuntimeStopped: options.onRuntimeStopped,
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
            const gate = nextSnapshotGate;
            if (gate) {
              nextSnapshotGate = null;
              gate.entered.resolve();
              await gate.release.promise;
            }
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
        host,
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
        gateNextSnapshot: () => {
          const gate = { entered: deferred(), release: deferred() };
          nextSnapshotGate = gate;
          return gate;
        },
        failNextStop: () => {
          failNextStop = true;
        },
        hostOwnership,
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

    it("refuses an uninstall token after the durable record retargets to another directory", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        const preflight = await setup.pipeline.uninstallPreflight(
          "example-plugin",
          "example-plugin",
        );
        if (!preflight.ok) throw new Error(preflight.error.message);
        const runningRecord = setup.host.currentRecord("example-plugin");
        expect(runningRecord).toBeDefined();
        const bundleBefore = await readFile(
          liveBundlePath(setup.fixture, "example-plugin"),
        );

        await mutatePluginRecord(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
          "example-plugin",
          (record) => ({ ...record, directoryName: "replacement-directory" }),
        );

        const result = await setup.pipeline.uninstall(
          "example-plugin",
          "example-plugin",
          preflight.confirmationToken,
        );

        expect(result).toMatchObject({
          ok: false,
          error: { stage: "uninstall", code: "confirmation-stale" },
        });
        expect(setup.host.currentRecord("example-plugin")).toBe(runningRecord);
        await expect(lstat(setup.fixture.pluginRoot)).resolves.toBeDefined();
        expect(await readFile(liveBundlePath(setup.fixture, "example-plugin")))
          .toEqual(bundleBefore);
        const state = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!state.ok) throw new Error(state.warning);
        expect(state.state.plugins["example-plugin"]?.directoryName)
          .toBe("replacement-directory");
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

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
          runCommand: (operation) =>
            setup.hostOwnership.runCommand("example-plugin", operation),
          // This test isolates the recovered registration and old host. The
          // production start/activation seam has its own behavior tests.
          ensureStarted: async () => setup.pipeline.host,
          ensureCurrent: () => {},
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

    it("reports no live runtime, not the pre-build status it captured before this attempt started, once the old runtime actually stopped and publish then failed (#779 round 24 finding 2)", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");
        // publish() rejects only once the build itself has already
        // succeeded — runFullBuild stops the old runtime before either
        // publish, so this failure lands after that stop already ran.
        setup.failNextBuildPublish();
        await writeFile(setup.entryPath, [
          'export const marker = "attempted after the old runtime stopped";',
          "export default { activate() {} };",
          "",
        ].join("\n"));
        const approved = await setup.pipeline.approve("example-plugin");
        expect(approved.ok).toBe(false);
        expect(setup.pipeline.list()[0]?.status).toBe("failed");
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeUndefined();
        // The stale pre-build "ready" this attempt captured before it ever
        // touched anything must not be reported here — nothing is actually
        // running now.
        expect(setup.pipeline.list()[0]?.runtimeStatus).toBeNull();
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps the running build's commands after a verify-pass failure (round-8 finding 1)", async () => {
      // The twin of "keeps the running build's commands after a pre-stop
      // failure" above, reached through reconcileApprovedCandidate's
      // verifyApprovedSource pass instead of runFullBuild's own — the two
      // failure paths write the recovery cache from two different call
      // sites, and only one of them did until this fix.
      const oldCommands = [{ id: "old.cmd", title: "Old Command" }];
      const newCommands = [{ id: "new.cmd", title: "New Command" }];
      const setup = await setupEstablishedPlugin({ commands: oldCommands });
      try {
        await writeFile(setup.manifestPath, setup.manifestText(newCommands));
        await setup.pipeline.handleWatcherEvents([{
          path: "plugins/unrelated-plugin/dohc-plugin.json",
          operation: "update",
        }]);
        expect(
          setup.pipeline.pluginRegistration("example-plugin")?.manifest.commands,
        ).toEqual(newCommands);

        await setup.failEstablishedBuild();

        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");
        expect(setup.pipeline.list()[0]?.commands).toEqual(oldCommands);
        expect(
          setup.pipeline.pluginRegistration("example-plugin")?.manifest.commands,
        ).toEqual(oldCommands);
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

    it("keeps a failed approved attempt's recovery intact through a watcher touch that changes nothing, and leaves Retry still working (round-20 finding 3)", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        // Approve new content, but the build behind it fails —
        // recoveryState captures the still-running old build, and
        // lastApprovedAttemptHash remembers this exact attempted content
        // (the same hash Retry's own buildFromCurrentSource later accepts
        // via alsoAcceptHash).
        setup.failNextBuild();
        await writeFile(setup.entryPath, [
          'export const marker = "attempted approval";',
          "export default { activate() {} };",
          "",
        ].join("\n"));
        const approved = await setup.pipeline.approve("example-plugin");
        expect(approved.ok).toBe(false);
        expect(setup.pipeline.list()[0]?.status).toBe("failed");
        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");

        // A watcher event touches the plugin's tree without changing its
        // content — the exact same, still-unapproved attempted content
        // that just failed. Awaited, not fire-and-forget: it settles once
        // the reconcile below is queued (not once it has run), and the
        // next two calls share its per-plugin FIFO queue — enqueuing
        // after this await guarantees they land behind that reconcile,
        // not racing ahead of it.
        await setup.pipeline.handleWatcherEvents([{
          path: "plugins/example-plugin/src/index.ts",
          operation: "update",
        }]);

        // Synchronizes with the watcher's own queued reconcile without
        // itself changing anything: preflight shares the same per-plugin
        // queue, so by the time it resolves, the reconcile above already
        // has.
        const preflight = await setup.pipeline.uninstallPreflight("example-plugin", "example-plugin");
        expect(preflight.ok).toBe(true);

        // No hold: the recovery is untouched, and the old runtime the
        // failed attempt left running is still running.
        expect(setup.pipeline.list()[0]?.status).toBe("failed");
        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");

        // Retry still works against the same attempted content — it would
        // reject with "no-failed-build" had the watcher's own reconcile
        // held this for approval instead.
        const retried = await setup.pipeline.rebuild("example-plugin");
        expect(retried.ok).toBe(true);
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("never resurrects a superseded hold's own status for different content that only happens to hash the same as a much earlier failed attempt (round-21 finding 3, A-fail then B-hold then back-to-A)", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        const key = "example-plugin";
        // A fails to build — lastApprovedAttemptHash remembers A's hash,
        // the old runtime stays up under recovery.
        setup.failNextBuild();
        await writeFile(setup.entryPath, [
          'export const marker = "content A";',
          "export default { activate() {} };",
          "",
        ].join("\n"));
        const approvedA = await setup.pipeline.approve("example-plugin");
        expect(approvedA.ok).toBe(false);
        expect(setup.pipeline.list()[0]?.status).toBe("failed");

        // Edited to B — genuinely different content, so the watcher's own
        // reconcile finds no hash it recognizes and holds for approval,
        // stopping the old runtime for real. That stop is where the
        // recovery genuinely ends: A's own attempt hash must not survive
        // it.
        await writeFile(setup.entryPath, [
          'export const marker = "content B";',
          "export default { activate() {} };",
          "",
        ].join("\n"));
        await setup.pipeline.handleWatcherEvents([{
          path: "plugins/example-plugin/src/index.ts",
          operation: "update",
        }]);
        await setup.pipeline.uninstallPreflight("example-plugin", "example-plugin");
        const heldForB = setup.pipeline.list()[0];
        expect(heldForB?.status).toBe("disabled-pending-approval");
        const bSourceHash = heldForB?.sourceHash;
        expect(bSourceHash).toBeDefined();
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeUndefined();

        // Edited back to A — its content hash matches what step one's own
        // failed attempt recorded, but that recovery is long gone: this
        // must evaluate A on its own, not resurrect B's exact status
        // object (which would misreport A's own live content as B's).
        await writeFile(setup.entryPath, [
          'export const marker = "content A";',
          "export default { activate() {} };",
          "",
        ].join("\n"));
        await setup.pipeline.handleWatcherEvents([{
          path: "plugins/example-plugin/src/index.ts",
          operation: "update",
        }]);
        await setup.pipeline.uninstallPreflight("example-plugin", "example-plugin");
        const afterReturnToA = setup.pipeline.list()[0];
        expect(afterReturnToA?.status).toBe("disabled-pending-approval");
        expect(afterReturnToA?.sourceHash).not.toBe(bSourceHash);
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
          setup.pipeline.setPluginSettings("example-plugin", "example-plugin", { greeting: "Hi" }),
        ).resolves.toEqual({ greeting: "Hi" });
        await expect(
          setup.pipeline.setPluginSettings("example-plugin", "example-plugin", { repeat: 2 }),
        ).rejects.toThrow('does not declare a setting named "repeat"');

        expect((await setup.pipeline.approve("example-plugin")).ok).toBe(true);
        await waitFor(
          () => setup.pipeline.list()[0]?.status === "ready",
          "Plugin did not reach ready after replacing its settings declaration.",
        );
        expect(setup.pipeline.list()[0]?.settings).toEqual(newSettings);
        await expect(
          setup.pipeline.setPluginSettings("example-plugin", "example-plugin", { repeat: 2 }),
        ).resolves.toEqual({ repeat: 2 });
        await expect(
          setup.pipeline.setPluginSettings("example-plugin", "example-plugin", { greeting: "Hi" }),
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

    it("keeps offering a build retry through a crash-loop respawn, until the replacement publishes (round-8 finding 3)", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await setup.failEstablishedBuild();
        expect(setup.pipeline.list()[0]?.hasFailedReplacement).toBe(true);

        // A crash-loop respawn between the failure and the fix — the
        // host's own health reporting, not a rebuild — flips
        // runtimeStatus, and with it status via noteRuntimeStatus, back to
        // "ready" even though the replacement this failure owes was never
        // built.
        setup.pipeline.noteRuntimeStatus("example-plugin", "crashed");
        setup.pipeline.noteRuntimeStatus("example-plugin", "starting");
        setup.pipeline.noteRuntimeStatus("example-plugin", "ready");
        expect(setup.pipeline.list()[0]?.status).toBe("ready");
        expect(setup.pipeline.list()[0]?.hasFailedReplacement).toBe(true);

        const rebuilt = await setup.pipeline.rebuild("example-plugin");

        expect(rebuilt.ok).toBe(true);
        await waitFor(
          () =>
            setup.pipeline.list()[0]?.status === "ready" &&
            setup.pipeline.list()[0]?.hasFailedReplacement === false,
          "Plugin did not clear its failed-replacement fact after the retried build.",
        );
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps Retry available through a crash-loop respawn even when the generated manifest cannot be read (round-21 finding 5)", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        // captureRecoveredManifest reads this file to populate the
        // palette's own recovery cache — corrupted here so that read
        // fails, the way an interrupted publish or a permissions error
        // would leave it.
        const liveRoot = join(pluginsDataRoot(setup.fixture), "example-plugin");
        await writeFile(
          join(liveRoot, "dohc-plugin.generated.json"),
          "not valid json",
        );

        await setup.failEstablishedBuild();
        // hasFailedReplacement reports recoveryState's own has(), true
        // regardless of its value: the manifest above could not be
        // parsed, so the value stays null — only the palette's own
        // preview of what the recovered build contains is missing (#779
        // round 22 finding 2).
        expect(setup.pipeline.list()[0]?.hasFailedReplacement).toBe(true);

        // A crash-loop respawn between the failure and the fix — the
        // host's own health reporting, not a rebuild — flips status back
        // to "ready" even though the replacement this failure owes was
        // never built (mirrors round-8 finding 3's own respawn).
        setup.pipeline.noteRuntimeStatus("example-plugin", "crashed");
        setup.pipeline.noteRuntimeStatus("example-plugin", "starting");
        setup.pipeline.noteRuntimeStatus("example-plugin", "ready");
        expect(setup.pipeline.list()[0]?.status).toBe("ready");

        // Retry must still be offered — an unreadable manifest cost the
        // palette its preview, not the user their own way back.
        const rebuilt = await setup.pipeline.rebuild("example-plugin");
        expect(rebuilt.ok).toBe(true);
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps offering a build retry after a failed approve with no old runtime to preserve, even once something later resets status (round-22 finding 4)", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        const disabled = await setup.pipeline.disable("example-plugin");
        expect(disabled.ok).toBe(true);
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeUndefined();

        // Approve fails with nothing running to preserve — the branch
        // captureRecoveredManifest's own call used to skip entirely.
        setup.failNextBuild();
        await writeFile(setup.entryPath, [
          'export const marker = "attempted while disabled";',
          "export default { activate() {} };",
          "",
        ].join("\n"));
        const approved = await setup.pipeline.approve("example-plugin");
        expect(approved.ok).toBe(false);
        expect(setup.pipeline.list()[0]?.status).toBe("failed");
        expect(setup.pipeline.list()[0]?.hasFailedReplacement).toBe(true);

        // Nothing was ever running to crash-loop respawn, but the same
        // durable fact must survive whatever else can still reset status
        // for a stopped plugin — simulated directly here the way round-8's
        // own respawn test simulates its own status flip.
        setup.pipeline.noteRuntimeStatus("example-plugin", "ready");
        expect(setup.pipeline.list()[0]?.status).toBe("ready");

        const retried = await setup.pipeline.rebuild("example-plugin");
        expect(retried.ok).toBe(true);
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("publishes the manifest a build actually installed and started, not discovery's own stale candidate, when the source changed again after discovery scanned it (#779 round 23 finding 5)", async () => {
      const oldCommands = [{ id: "old.cmd", title: "Old Command" }];
      const newCommands = [{ id: "new.cmd", title: "New Command" }];
      const setup = await setupEstablishedPlugin({ commands: oldCommands });
      try {
        // No handleWatcherEvents call: requireValidCandidate's own
        // discovery cache still reads oldCommands. approve()'s own
        // snapshot reads this file directly off disk at build time and
        // picks up newCommands regardless — that snapshot's manifest, not
        // discovery's stale copy, is what actually got installed, scanned,
        // built and started.
        await writeFile(setup.manifestPath, setup.manifestText(newCommands));
        const approved = await setup.pipeline.approve("example-plugin");
        expect(approved.ok).toBe(true);
        expect(setup.pipeline.list()[0]?.commands).toEqual(newCommands);
        expect(
          setup.pipeline.pluginRegistration("example-plugin")?.manifest.commands,
        ).toEqual(newCommands);
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("refreshes the icon a build actually installed, not discovery's own stale one, when the source declared it again after discovery last scanned (#779 round 25 finding 2)", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        expect(setup.pipeline.list()[0]?.icon).toBeNull();
        // No handleWatcherEvents call, same as the manifest-staleness pin
        // above: discovery's own cached candidate still reports no icon.
        // Only this build's own snapshot sees the file added below.
        await writeFile(join(setup.fixture.pluginRoot, "icon.svg"), "<svg/>");
        await writeFile(
          setup.manifestPath,
          `${JSON.stringify({
            version: 1,
            name: "example-plugin",
            displayName: "Example plugin",
            entry: "src/index.ts",
            icon: "icon.svg",
            commands: [],
            settings: [],
          }, null, 2)}\n`,
        );
        const approved = await setup.pipeline.approve("example-plugin");
        expect(approved.ok).toBe(true);
        expect(setup.pipeline.list()[0]?.icon).toBe("icon.svg");
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("falls back to the prior contributions when a failed replacement has no readable manifest", async () => {
      const oldCommands = [{ id: "old.cmd", title: "Old Command" }];
      const newCommands = [{ id: "new.cmd", title: "New Command" }];
      const setup = await setupEstablishedPlugin({ commands: oldCommands });
      try {
        const liveRoot = join(pluginsDataRoot(setup.fixture), "example-plugin");
        await writeFile(
          join(liveRoot, "dohc-plugin.generated.json"),
          "not valid json",
        );
        await writeFile(setup.manifestPath, setup.manifestText(newCommands));
        await setup.pipeline.handleWatcherEvents([{
          path: "plugins/unrelated-plugin/dohc-plugin.json",
          operation: "update",
        }]);
        setup.failNextBuild();

        const approved = await setup.pipeline.approve("example-plugin");

        expect(approved.ok).toBe(false);
        expect(setup.pipeline.list()[0]).toMatchObject({
          status: "failed",
          hasFailedReplacement: true,
          commands: oldCommands,
        });
        expect(setup.pipeline.pluginRegistration("example-plugin")).toBeNull();
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps a build retry available after the old runtime reaches crash-loop disable", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await setup.failEstablishedBuild();
        setup.pipeline.noteRuntimeStatus("example-plugin", "disabled");

        expect(setup.pipeline.list()[0]).toMatchObject({
          status: "disabled",
          disabledReason: "crash-loop",
          hasFailedReplacement: true,
        });
        expect((await setup.pipeline.rebuild("example-plugin")).ok).toBe(true);
        await waitFor(
          () =>
            setup.pipeline.list()[0]?.status === "ready" &&
            setup.pipeline.list()[0]?.hasFailedReplacement === false,
          "Plugin did not recover from a crash-loop disable.",
        );
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("reserves a host change before the queued action can run", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        const disabling = setup.pipeline.disable("example-plugin");
        const racingCommand = await setup.hostOwnership.runCommand(
          "example-plugin",
          async () => "ran",
        );

        expect(racingCommand).toEqual({
          kind: "refused",
          reason: "change-in-progress",
        });
        expect((await disabling).ok).toBe(true);
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("revokes, stops, then awaits external runtime cleanup for disable", async () => {
      const steps: string[] = [];
      const cleanupEntered = deferred();
      const releaseCleanup = deferred();
      const setup = await setupEstablishedPlugin({
        onRuntimeStopped: async (pluginId) => {
          steps.push(`stopped:${pluginId}`);
          cleanupEntered.resolve();
          await releaseCleanup.promise;
          steps.push(`cleaned:${pluginId}`);
        },
      });
      const originalStop = setup.pipeline.host.stop.bind(setup.pipeline.host);
      const stop = vi.spyOn(setup.pipeline.host, "stop").mockImplementation(
        async (pluginId) => {
          steps.push("host-stop");
          await originalStop(pluginId);
        },
      );
      try {
        let settled = false;
        const disabling = setup.pipeline.disable("example-plugin", {
          onWillStopRuntime: (pluginId) => steps.push(`revoke:${pluginId}`),
        });
        void disabling.then(() => {
          settled = true;
        });

        await cleanupEntered.promise;
        expect(steps).toEqual([
          "revoke:example-plugin",
          "host-stop",
          "stopped:example-plugin",
        ]);
        await Promise.resolve();
        expect(settled).toBe(false);

        releaseCleanup.resolve();
        const disabled = await disabling;

        expect(disabled.ok).toBe(true);
        expect(steps).toEqual([
          "revoke:example-plugin",
          "host-stop",
          "stopped:example-plugin",
          "cleaned:example-plugin",
        ]);
      } finally {
        releaseCleanup.resolve();
        stop.mockRestore();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps external authority when disable fails before the stop boundary", async () => {
      const revoke = vi.fn();
      const stopped = vi.fn();
      const setup = await setupEstablishedPlugin({ onRuntimeStopped: stopped });
      try {
        setup.failNextRecordWrite();
        const disabled = await setup.pipeline.disable("example-plugin", {
          onWillStopRuntime: revoke,
        });

        expect(disabled.ok).toBe(false);
        expect(revoke).not.toHaveBeenCalled();
        expect(stopped).not.toHaveBeenCalled();
        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps a completed stop when external runtime cleanup rejects", async () => {
      const failure = new Error("simulated surface cleanup failure");
      const setup = await setupEstablishedPlugin({
        onRuntimeStopped: async () => {
          throw failure;
        },
      });
      const consoleError = vi.spyOn(console, "error").mockImplementation(
        () => undefined,
      );
      try {
        const disabled = await setup.pipeline.disable("example-plugin");

        expect(disabled.ok).toBe(true);
        expect(setup.pipeline.host.currentRecord("example-plugin"))
          .toBeUndefined();
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining("runtime-stopped cleanup failed"),
          failure,
        );
      } finally {
        consoleError.mockRestore();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps the live host when disable cannot revoke its external authority", async () => {
      const setup = await setupEstablishedPlugin();
      const runningRecord = setup.pipeline.host.currentRecord("example-plugin");
      const stop = vi.spyOn(setup.pipeline.host, "stop");
      try {
        const disabled = await setup.pipeline.disable("example-plugin", {
          onWillStopRuntime: () => {
            throw new Error("simulated authority revocation failure");
          },
        });

        expect(disabled).toMatchObject({
          ok: false,
          error: {
            code: "disable-failed",
            message: "simulated authority revocation failure",
          },
        });
        expect(stop).not.toHaveBeenCalled();
        expect(setup.pipeline.host.currentRecord("example-plugin"))
          .toBe(runningRecord);
        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");
        const state = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!state.ok) throw new Error(state.warning);
        expect(state.state.plugins["example-plugin"]?.disabled).toBe(false);
      } finally {
        stop.mockRestore();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("preserves a live plugin when uninstall cannot revoke its external authority", async () => {
      const setup = await setupEstablishedPlugin();
      const runningRecord = setup.pipeline.host.currentRecord("example-plugin");
      const stop = vi.spyOn(setup.pipeline.host, "stop");
      try {
        const preflight = await setup.pipeline.uninstallPreflight(
          "example-plugin",
          "example-plugin",
        );
        if (!preflight.ok) throw new Error(preflight.error.message);

        const removed = await setup.pipeline.uninstall(
          "example-plugin",
          "example-plugin",
          preflight.confirmationToken,
          {
            onWillStopRuntime: () => {
              throw new Error("simulated authority revocation failure");
            },
          },
        );

        expect(removed).toMatchObject({
          ok: false,
          error: {
            code: "delete-failed",
            message: "simulated authority revocation failure",
          },
        });
        expect(stop).not.toHaveBeenCalled();
        expect(setup.pipeline.host.currentRecord("example-plugin"))
          .toBe(runningRecord);
        await expect(lstat(setup.fixture.pluginRoot)).resolves.toBeDefined();
      } finally {
        stop.mockRestore();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("restores durable enablement when disable cannot stop the live host", async () => {
      const stopped = vi.fn();
      const setup = await setupEstablishedPlugin({ onRuntimeStopped: stopped });
      const record = setup.pipeline.host.currentRecord("example-plugin");
      expect(record).toBeDefined();
      const stop = vi.spyOn(setup.pipeline.host, "stop").mockRejectedValue(
        new Error("simulated stop failure with a live record"),
      );
      try {
        const disabled = await setup.pipeline.disable("example-plugin");

        expect(disabled).toMatchObject({
          ok: false,
          error: {
            code: "disable-failed",
            message: "simulated stop failure with a live record",
          },
        });
        expect(stop).toHaveBeenCalledTimes(1);
        expect(stopped).not.toHaveBeenCalled();
        expect(setup.pipeline.host.currentRecord("example-plugin")).toBe(record);
        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");
        expect(setup.pipeline.list()[0]).toMatchObject({
          status: "ready",
          runtimeStatus: "ready",
          error: { code: "disable-failed" },
        });
        const state = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!state.ok) throw new Error(state.warning);
        expect(state.state.plugins["example-plugin"]?.disabled).toBe(false);

        await expect(
          setup.hostOwnership.runCommand(
            "example-plugin",
            async (authority) => authority.start(() =>
              setup.pipeline.ensureStarted("example-plugin", authority)),
          ),
        ).resolves.toMatchObject({
          kind: "completed",
          value: {
            kind: "admitted",
            value: {
              ok: true,
              plugin: { status: "ready", runtimeStatus: "ready" },
            },
          },
        });
      } finally {
        stop.mockRestore();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps the safe durable disable when stop compensation cannot be written", async () => {
      const setup = await setupEstablishedPlugin();
      const record = setup.pipeline.host.currentRecord("example-plugin");
      expect(record).toBeDefined();
      const consoleError = vi.spyOn(console, "error").mockImplementation(
        () => undefined,
      );
      const stop = vi.spyOn(setup.pipeline.host, "stop").mockImplementation(
        async () => {
          setup.failNextRecordWrite();
          throw new Error("simulated original stop failure");
        },
      );
      try {
        const disabled = await setup.pipeline.disable("example-plugin");

        expect(disabled).toMatchObject({
          ok: false,
          error: {
            code: "disable-failed",
            message: "simulated original stop failure",
          },
        });
        expect(stop).toHaveBeenCalledTimes(1);
        expect(setup.pipeline.host.currentRecord("example-plugin")).toBe(record);
        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");
        const state = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!state.ok) throw new Error(state.warning);
        expect(state.state.plugins["example-plugin"]?.disabled).toBe(true);
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining("failed to restore the durable state"),
          expect.objectContaining({
            message: "simulated approval record write failure",
          }),
        );
      } finally {
        stop.mockRestore();
        consoleError.mockRestore();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps the durable disable when disposal supersedes the stop", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        const disabling = setup.pipeline.disable("example-plugin");
        const disposing = setup.pipeline.dispose();

        await expect(disabling).resolves.toMatchObject({ ok: false });
        await disposing;

        const state = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!state.ok) throw new Error(state.warning);
        expect(state.state.plugins["example-plugin"]?.disabled).toBe(true);
        expect(setup.pipeline.host.currentRecord("example-plugin")).toBeUndefined();
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps warm command admission open while approved source is verified", async () => {
      const setup = await setupEstablishedPlugin();
      const snapshotGate = setup.gateNextSnapshot();
      const statusEventStart = setup.statuses.length;
      let runChangeCalls = () => -1;
      try {
        const first = setup.hostOwnership.runCommand(
          "example-plugin",
          async (authority) => {
            const runChange = vi.spyOn(authority, "runChange");
            runChangeCalls = () => runChange.mock.calls.length;
            return authority.start(() =>
              setup.pipeline.ensureStarted("example-plugin", authority));
          },
        );
        await snapshotGate.entered.promise;
        expect(runChangeCalls()).toBe(0);

        const secondEntered = deferred();
        const second = setup.hostOwnership.runCommand(
          "example-plugin",
          async (authority) => {
            secondEntered.resolve();
            return authority.start(() =>
              setup.pipeline.ensureStarted("example-plugin", authority));
          },
        );
        await expect(Promise.race([
          secondEntered.promise.then(() => "entered"),
          second.then(() => "settled"),
        ])).resolves.toBe("entered");

        snapshotGate.release.resolve();
        await expect(first).resolves.toMatchObject({
          kind: "completed",
          value: { kind: "admitted", value: { ok: true } },
        });
        await expect(second).resolves.toMatchObject({
          kind: "completed",
          value: { kind: "admitted", value: { ok: true } },
        });
        expect(runChangeCalls()).toBe(0);
        expect(setup.pipeline.list()[0]).toMatchObject({
          status: "ready",
          runtimeStatus: "ready",
        });
        const warmStatusEvents = setup.statuses.slice(statusEventStart);
        expect(warmStatusEvents).not.toContain("starting");
        expect(warmStatusEvents.at(-1)).toBe("ready");
      } finally {
        snapshotGate.release.resolve();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("reserves a queued warm surface before a later command can queue behind it", async () => {
      const setup = await setupEstablishedPlugin({ drainTimeoutMs: 0 });
      const snapshotGate = setup.gateNextSnapshot();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const surface = setup.hostOwnership.acquireSurface("example-plugin");
      if ("kind" in surface) throw new Error("Surface lease was refused.");
      let first: Promise<unknown> | undefined;
      let surfaceStart: Promise<unknown> | undefined;
      let second: Promise<unknown> | undefined;
      try {
        first = setup.hostOwnership.runCommand(
          "example-plugin",
          async (authority) => authority.start(() =>
            setup.pipeline.ensureStarted("example-plugin", authority)),
        );
        await snapshotGate.entered.promise;
        const bundlePath = liveBundlePath(setup.fixture, "example-plugin");
        await writeFile(
          bundlePath,
          `${await readFile(bundlePath, "utf8")}\n// tampered before the queued surface\n`,
        );

        surfaceStart = surface.start((authority) =>
          setup.pipeline.ensureStarted("example-plugin", authority));
        const secondEntered = deferred();
        second = setup.hostOwnership.runCommand(
          "example-plugin",
          async (authority) => {
            secondEntered.resolve();
            return authority.start(() =>
              setup.pipeline.ensureStarted("example-plugin", authority));
          },
        );
        const secondObservation = await Promise.race([
          second.then((result) => ({ kind: "settled" as const, result })),
          secondEntered.promise.then(() => ({ kind: "entered" as const })),
        ]);
        expect(secondObservation).toEqual({
          kind: "settled",
          result: { kind: "refused", reason: "change-in-progress" },
        });

        snapshotGate.release.resolve();
        await expect(first).resolves.toMatchObject({
          kind: "completed",
          value: {
            kind: "admitted",
            value: {
              ok: false,
              error: { code: HOST_CHANGE_REFUSED_ERROR_CODE },
            },
          },
        });
        await expect(surfaceStart).resolves.toMatchObject({
          kind: "admitted",
          value: { ok: true },
        });
        await expect(second).resolves.toEqual({
          kind: "refused",
          reason: "change-in-progress",
        });
        expect(warn).not.toHaveBeenCalled();
      } finally {
        snapshotGate.release.resolve();
        await Promise.allSettled(
          [first, surfaceStart, second].filter(
            (pending): pending is Promise<unknown> => pending !== undefined,
          ),
        );
        await surface.release();
        await setup.pipeline.dispose();
        warn.mockRestore();
      }
    }, 60_000);

    it("parks a second queued surface outside the first surface change", async () => {
      const setup = await setupEstablishedPlugin({ drainTimeoutMs: 0 });
      const snapshotGate = setup.gateNextSnapshot();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const firstSurface = setup.hostOwnership.acquireSurface("example-plugin");
      const secondSurface = setup.hostOwnership.acquireSurface("example-plugin");
      if ("kind" in firstSurface || "kind" in secondSurface) {
        throw new Error("Surface lease was refused.");
      }
      let command: Promise<unknown> | undefined;
      let firstStart: Promise<unknown> | undefined;
      let secondStart: Promise<unknown> | undefined;
      let secondEnqueued = false;
      try {
        command = setup.hostOwnership.runCommand(
          "example-plugin",
          async (authority) => authority.start(() =>
            setup.pipeline.ensureStarted("example-plugin", authority)),
        );
        await snapshotGate.entered.promise;
        const bundlePath = liveBundlePath(setup.fixture, "example-plugin");
        await writeFile(
          bundlePath,
          `${await readFile(bundlePath, "utf8")}\n// tampered before two queued surfaces\n`,
        );

        firstStart = firstSurface.start((authority) =>
          setup.pipeline.ensureStarted("example-plugin", authority));
        secondStart = secondSurface.start((authority) => {
          secondEnqueued = true;
          return setup.pipeline.ensureStarted("example-plugin", authority);
        });
        expect(secondEnqueued).toBe(false);

        snapshotGate.release.resolve();
        await expect(command).resolves.toMatchObject({
          kind: "completed",
          value: {
            kind: "admitted",
            value: {
              ok: false,
              error: { code: HOST_CHANGE_REFUSED_ERROR_CODE },
            },
          },
        });
        await expect(firstStart).resolves.toMatchObject({
          kind: "admitted",
          value: { ok: true },
        });
        await expect(secondStart).resolves.toMatchObject({
          kind: "admitted",
          value: { ok: true },
        });
        expect(warn).not.toHaveBeenCalled();
      } finally {
        snapshotGate.release.resolve();
        await Promise.allSettled(
          [command, firstStart, secondStart].filter(
            (pending): pending is Promise<unknown> => pending !== undefined,
          ),
        );
        await firstSurface.release();
        await secondSurface.release();
        await setup.pipeline.dispose();
        warn.mockRestore();
      }
    }, 60_000);

    it("keeps surface verification under change admission", async () => {
      const setup = await setupEstablishedPlugin();
      const snapshotGate = setup.gateNextSnapshot();
      const lease = setup.hostOwnership.acquireSurface("example-plugin");
      if ("kind" in lease) throw new Error("Surface lease was refused.");
      let runChangeCalls = () => -1;
      try {
        const starting = lease.start(async (authority) => {
          const runChange = vi.spyOn(authority, "runChange");
          runChangeCalls = () => runChange.mock.calls.length;
          return setup.pipeline.ensureStarted("example-plugin", authority);
        });
        await snapshotGate.entered.promise;

        expect(runChangeCalls()).toBe(1);
        await expect(
          setup.hostOwnership.runCommand(
            "example-plugin",
            async () => "ran",
          ),
        ).resolves.toEqual({
          kind: "refused",
          reason: "change-in-progress",
        });

        snapshotGate.release.resolve();
        await expect(starting).resolves.toMatchObject({
          kind: "admitted",
          value: { ok: true },
        });
      } finally {
        snapshotGate.release.resolve();
        await lease.release();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("returns exact evidence for a cold command start", async () => {
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
      const hostOwnership = new PluginHostOwnership(host);
      pipeline = new PluginPipeline({
        workspaceRoot: fixture.workspaceRoot,
        stateDir: fixture.stateDir,
        hostOwnership,
        resourcesBasePath,
        pnpmRunnerEntry,
        operations: {
          install: (input) =>
            installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        },
      });

      try {
        await pipeline.start();
        let exactResult:
          | Awaited<ReturnType<PluginPipeline["ensureStarted"]>>
          | undefined;
        const command = await hostOwnership.runCommand(
          "example-plugin",
          async (authority) => authority.start(async () => {
            exactResult = await pipeline.ensureStarted("example-plugin", authority);
            return exactResult;
          }),
        );

        expect(command).toMatchObject({
          kind: "completed",
          value: {
            kind: "admitted",
            value: {
              ok: true,
              plugin: { status: "starting", runtimeStatus: "starting" },
            },
          },
        });
        expect(exactResult?.kind).toBe("started");
        expect(host.getStatus("example-plugin")).toBeUndefined();
      } finally {
        await pipeline.dispose();
      }
    }, 60_000);

    it("preserves workspace ownership when a surface rebuilds a running host", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await writeFile(
          liveBundlePath(setup.fixture, "example-plugin"),
          "// changed after approval\n",
        );
        const surface = await ensureFromSurface(
          setup.pipeline,
          "example-plugin",
        );

        expect(surface.result).toMatchObject({ ok: true });
        expect(surface.exact.kind).toBe("existing");
        await surface.release();
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeDefined();
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("restores ready status when a command finds a running host without approval", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await mutatePluginRecord(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
          "example-plugin",
          (record) => {
            if (!record) throw new Error("Expected an installed plugin record.");
            const { approvedHash: _approvedHash, ...withoutApproval } = record;
            return withoutApproval;
          },
        );
        const statusBefore = setup.pipeline.list()[0];
        const stateBefore = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!stateBefore.ok) throw new Error(stateBefore.warning);

        const started = await ensureFromCommand(setup.pipeline, "example-plugin");

        expect(started).toMatchObject({
          exact: { kind: "existing" },
          result: {
            ok: false,
            error: { code: HOST_CHANGE_REFUSED_ERROR_CODE },
          },
        });
        expect(setup.pipeline.list()[0]).toEqual(statusBefore);
        const stateAfter = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        expect(stateAfter).toEqual(stateBefore);
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeDefined();
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("refuses a command-origin approval hold before it mutates the record", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        await writeFile(setup.entryPath, [
          'export const marker = "edited out of band";',
          "export default { activate() {} };",
          "",
        ].join("\n"));

        let exactResult:
          | Awaited<ReturnType<PluginPipeline["ensureStarted"]>>
          | undefined;
        const command = await setup.hostOwnership.runCommand(
          "example-plugin",
          async (authority) => authority.start(async () => {
            exactResult = await setup.pipeline.ensureStarted(
              "example-plugin",
              authority,
            );
            return exactResult;
          }),
        );

        expect(command).toMatchObject({
          kind: "completed",
          value: {
            kind: "admitted",
            value: { ok: false, error: { code: HOST_CHANGE_REFUSED_ERROR_CODE } },
          },
        });
        expect(exactResult?.kind).toBe("existing");
        expect(setup.pipeline.list()[0]?.status).toBe("ready");
        const state = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!state.ok) throw new Error(state.warning);
        expect(state.state.plugins["example-plugin"]?.disabled).toBe(false);
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeDefined();
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("refuses a command-origin bundle repair before it mutates durable state", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        const stateBefore = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!stateBefore.ok) throw new Error(stateBefore.warning);
        await writeFile(
          liveBundlePath(setup.fixture, "example-plugin"),
          "globalThis.tampered = true;\n",
        );

        let exactResult:
          | Awaited<ReturnType<PluginPipeline["ensureStarted"]>>
          | undefined;
        const command = await setup.hostOwnership.runCommand(
          "example-plugin",
          async (authority) => authority.start(async () => {
            exactResult = await setup.pipeline.ensureStarted(
              "example-plugin",
              authority,
            );
            return exactResult;
          }),
        );

        expect(command).toMatchObject({
          kind: "completed",
          value: {
            kind: "admitted",
            value: { ok: false, error: { code: HOST_CHANGE_REFUSED_ERROR_CODE } },
          },
        });
        expect(exactResult?.kind).toBe("existing");
        expect(setup.pipeline.list()[0]?.status).toBe("ready");
        const stateAfter = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!stateAfter.ok) throw new Error(stateAfter.warning);
        expect(stateAfter.state.plugins["example-plugin"])
          .toEqual(stateBefore.state.plugins["example-plugin"]);
        expect(await stagingLeftovers(setup.fixture, "example-plugin")).toEqual([]);
        expect(await readFile(
          liveBundlePath(setup.fixture, "example-plugin"),
          "utf8",
        )).toBe("globalThis.tampered = true;\n");
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeDefined();
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("adopts a runtime that an explicit action started before it failed", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        expect((await setup.pipeline.disable("example-plugin")).ok).toBe(true);
        const originalStart = setup.pipeline.host.start.bind(setup.pipeline.host);
        let failNextPipelineStatus = false;
        vi.spyOn(setup.pipeline.host, "start").mockImplementation(async (...args) => {
          const evidence = await originalStart(...args);
          failNextPipelineStatus = true;
          return evidence;
        });
        const pipelineInternals = setup.pipeline as unknown as {
          setStatus: (...args: unknown[]) => unknown;
        };
        const originalSetStatus = pipelineInternals.setStatus.bind(setup.pipeline);
        vi.spyOn(pipelineInternals, "setStatus").mockImplementation((...args) => {
          if (failNextPipelineStatus) {
            failNextPipelineStatus = false;
            throw new Error("simulated post-start status failure");
          }
          return originalSetStatus(...args);
        });

        const enabled = await setup.pipeline.enable("example-plugin");

        expect(enabled).toMatchObject({
          ok: false,
          error: { code: "enable-failed" },
        });
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeDefined();
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("closes ownership once and prevents a queued action from starting the host", async () => {
      const setup = await setupEstablishedPlugin();
      const queueGate = deferred();
      try {
        expect((await setup.pipeline.disable("example-plugin")).ok).toBe(true);
        const enqueue = (
          setup.pipeline as unknown as {
            enqueueActionValue: <T>(
              pluginId: string,
              run: () => Promise<T>,
            ) => Promise<T>;
          }
        ).enqueueActionValue.bind(setup.pipeline);
        const blocker = enqueue("example-plugin", async () => {
          await queueGate.promise;
        });
        const enabling = setup.pipeline.enable("example-plugin");
        const close = vi.spyOn(setup.hostOwnership, "close");

        const firstDispose = setup.pipeline.dispose();
        const secondDispose = setup.pipeline.dispose();
        expect(secondDispose).toBe(firstDispose);
        queueGate.resolve();

        await blocker;
        await expect(enabling).resolves.toMatchObject({
          ok: false,
          error: { code: "pipeline-closed" },
        });
        await firstDispose;
        expect(close).toHaveBeenCalledTimes(1);
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeUndefined();
        await expect(setup.pipeline.enable("example-plugin")).resolves.toMatchObject({
          ok: false,
          error: { code: "pipeline-closed" },
        });
        await expect(
          setup.pipeline.uninstallPreflight("example-plugin", "example-plugin"),
        ).resolves.toMatchObject({
          ok: false,
          error: { code: "pipeline-closed" },
        });
        await expect(
          setup.pipeline.uninstall("example-plugin", "example-plugin", "expired"),
        ).resolves.toMatchObject({
          ok: false,
          error: { code: "pipeline-closed" },
        });
      } finally {
        queueGate.resolve();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("does not translate an ordinary stale reservation into pipeline close", async () => {
      const setup = await setupEstablishedPlugin();
      const stale = setup.hostOwnership.reserveChange("example-plugin");
      await stale.cancel();
      vi.spyOn(setup.hostOwnership, "reserveChange").mockReturnValueOnce(stale);

      const disabling = setup.pipeline.disable("example-plugin");
      const disposing = setup.pipeline.dispose();

      await expect(disabling).rejects.toThrow(
        "Change reservation is no longer active.",
      );
      await disposing;
    }, 60_000);

    it("releases reservations after action preconditions fail", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        expect((await setup.pipeline.rebuild("example-plugin")).ok).toBe(false);
        await expect(
          setup.hostOwnership.runCommand("example-plugin", async () => "ready"),
        ).resolves.toEqual({ kind: "completed", value: "ready" });

        expect((await setup.pipeline.disable("missing-plugin")).ok).toBe(false);
        await expect(
          setup.hostOwnership.runCommand("missing-plugin", async () => "ready"),
        ).resolves.toEqual({ kind: "completed", value: "ready" });
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("preserves a command cold start through a precondition-failed action", async () => {
      const setup = await setupEstablishedPlugin();
      const commandStarted = deferred();
      const releaseCommand = deferred();
      try {
        expect((await setup.pipeline.disable("example-plugin")).ok).toBe(true);
        await mutatePluginRecord(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
          "example-plugin",
          (record) => ({ ...record, disabled: false }),
        );
        const command = setup.hostOwnership.runCommand(
          "example-plugin",
          async (authority) => {
            const started = await authority.start(() =>
              setup.pipeline.ensureStarted("example-plugin", authority));
            commandStarted.resolve();
            await releaseCommand.promise;
            return started;
          },
        );
        await commandStarted.promise;
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeDefined();

        const rebuilt = await setup.pipeline.rebuild("example-plugin");
        expect(rebuilt).toMatchObject({
          ok: false,
          error: { code: "no-failed-build" },
        });
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeDefined();

        releaseCommand.resolve();
        await command;
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeUndefined();
      } finally {
        releaseCommand.resolve();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("propagates owner close failure after stopping the host", async () => {
      const setup = await setupEstablishedPlugin();
      const stopAll = setup.pipeline.host.stopAll.bind(setup.pipeline.host);
      vi.spyOn(setup.pipeline.host, "stopAll").mockImplementationOnce(async () => {
        await stopAll();
        throw new Error("simulated owner close failure");
      });

      await expect(setup.pipeline.dispose()).rejects.toThrow(
        "simulated owner close failure",
      );
      expect(setup.pipeline.host.getStatus("example-plugin")).toBeUndefined();
      await expect(setup.pipeline.enable("example-plugin")).resolves.toMatchObject({
        ok: false,
        error: { code: "pipeline-closed" },
      });
    }, 60_000);

    it("waits for a live command before disposal stops the host", async () => {
      const setup = await setupEstablishedPlugin();
      const commandEntered = deferred();
      const commandGate = deferred();
      const bumpGeneration = vi.spyOn(setup.pipeline.host, "bumpGeneration");
      try {
        const command = setup.hostOwnership.runCommand(
          "example-plugin",
          async () => {
            commandEntered.resolve();
            await commandGate.promise;
          },
        );
        await commandEntered.promise;

        const disposing = setup.pipeline.dispose();

        await expect(
          setup.hostOwnership.runCommand("example-plugin", async () => undefined),
        ).resolves.toEqual({ kind: "refused", reason: "closed" });
        expect(setup.pipeline.host.getStatus("example-plugin")).toBe("ready");
        expect(bumpGeneration).not.toHaveBeenCalled();

        commandGate.resolve();
        await command;
        await disposing;
        expect(bumpGeneration).toHaveBeenCalledTimes(1);
        expect(setup.pipeline.host.getStatus("example-plugin")).toBeUndefined();
      } finally {
        commandGate.resolve();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("warns when a host change reaches the command drain deadline", async () => {
      const setup = await setupEstablishedPlugin({ drainTimeoutMs: 0 });
      const commandEntered = deferred();
      const commandGate = deferred();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const command = setup.hostOwnership.runCommand(
          "example-plugin",
          async () => {
            commandEntered.resolve();
            await commandGate.promise;
          },
        );
        await commandEntered.promise;
        await writeFile(setup.entryPath, [
          'export const marker = "replacement";',
          "export default { activate() {} };",
          "",
        ].join("\n"));

        const approved = await setup.pipeline.approve("example-plugin");

        expect(approved.ok).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(
          'Plugin "example-plugin" still has work in flight',
        ));
        commandGate.resolve();
        await command;
      } finally {
        commandGate.resolve();
        warn.mockRestore();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("runs stop-boundary consequences after transport cleanup rejects", async () => {
      const setup = await setupEstablishedPlugin();
      let oldRuntimeStoppedCalls = 0;
      try {
        await setup.failEstablishedBuild();
        setup.failNextStop();

        const rebuilt = await setup.pipeline.rebuild("example-plugin", {
          onOldRuntimeStopped: () => {
            oldRuntimeStoppedCalls += 1;
          },
        });

        expect(rebuilt.ok).toBe(true);
        expect(oldRuntimeStoppedCalls).toBe(1);
        await expect(
          setup.hostOwnership.runCommand("example-plugin", async () => "ready"),
        ).resolves.toEqual({ kind: "completed", value: "ready" });
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("takes an ownership stop boundary when no host record exists yet", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        expect((await setup.pipeline.disable("example-plugin")).ok).toBe(true);
        expect(setup.pipeline.host.currentRecord("example-plugin")).toBeUndefined();
        const stop = vi.spyOn(setup.pipeline.host, "stop");

        const disabled = await setup.pipeline.disable("example-plugin");

        expect(disabled.ok).toBe(true);
        expect(stop).toHaveBeenCalledTimes(1);
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("holds changed source without stopping again when no host record exists", async () => {
      const setup = await setupEstablishedPlugin();
      try {
        expect((await setup.pipeline.disable("example-plugin")).ok).toBe(true);
        const stop = vi.spyOn(setup.pipeline.host, "stop");
        await writeFile(setup.entryPath, [
          'export const marker = "changed while disabled";',
          "export default { activate() {} };",
          "",
        ].join("\n"));

        const enabled = await setup.pipeline.enable("example-plugin");

        expect(enabled).toMatchObject({
          ok: true,
          plugin: { status: "disabled-pending-approval" },
        });
        expect(stop).not.toHaveBeenCalled();
      } finally {
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("keeps ownership closed across queued source refresh and identity removal", async () => {
      const setup = await setupEstablishedPlugin();
      let buildGate: ReturnType<typeof setup.gateNextBuild> | undefined;
      try {
        buildGate = setup.gateNextBuild();
        const driftedText = [
          'export const marker = "door-written drift";',
          "export default { activate() {} };",
          "",
        ].join("\n");
        await writeFile(setup.entryPath, driftedText);
        setup.pipeline.handleDoorWrittenSourceChange("example-plugin", {
          absolutePath: setup.entryPath,
          text: driftedText,
        });
        await buildGate.entered.promise;
        await expect(
          setup.hostOwnership.runCommand("example-plugin", async () => undefined),
        ).resolves.toEqual({ kind: "refused", reason: "change-in-progress" });

        await rm(setup.fixture.pluginRoot, { recursive: true, force: true });
        const watching = setup.pipeline.handleWatcherEvents([{
          path: "plugins/example-plugin",
          operation: "delete",
        }]);
        await expect(
          setup.hostOwnership.runCommand("example-plugin", async () => undefined),
        ).resolves.toEqual({ kind: "refused", reason: "change-in-progress" });

        buildGate.release.resolve();
        await watching;

        await expect(
          setup.hostOwnership.runCommand("example-plugin", async () => "ready"),
        ).resolves.toEqual({ kind: "completed", value: "ready" });
        expect(
          setup.pipeline.list().some((plugin) => plugin.id === "example-plugin"),
        ).toBe(false);
      } finally {
        buildGate?.release.resolve();
        await setup.pipeline.dispose();
      }
    }, 60_000);

    it("awaits failed surface cleanup before removing a watched identity", async () => {
      const cleanupEntered = deferred();
      const cleanupRelease = deferred();
      const cleanupFailure = new Error("simulated surface cleanup failure");
      const steps: string[] = [];
      let watcherSettled = false;
      const setup = await setupEstablishedPlugin({
        onRuntimeStopped: async (pluginId) => {
          steps.push(`cleanup:${pluginId}`);
          cleanupEntered.resolve();
          await cleanupRelease.promise;
          steps.push(`cleanup-failed:${pluginId}`);
          throw cleanupFailure;
        },
      });
      const consoleError = vi.spyOn(console, "error").mockImplementation(
        () => undefined,
      );
      try {
        await rm(setup.fixture.pluginRoot, { recursive: true, force: true });
        const watching = setup.pipeline.handleWatcherEvents([{
          path: "plugins/example-plugin",
          operation: "delete",
        }]).then(() => {
          watcherSettled = true;
          steps.push("watcher-settled");
        });

        await cleanupEntered.promise;

        expect(steps).toEqual(["cleanup:example-plugin"]);
        expect(setup.pipeline.host.currentRecord("example-plugin")).toBeUndefined();
        expect(watcherSettled).toBe(false);
        const whileCleaning = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!whileCleaning.ok) throw new Error(whileCleaning.warning);
        expect(whileCleaning.state.plugins["example-plugin"]).toBeDefined();

        cleanupRelease.resolve();
        await watching;

        expect(steps).toEqual([
          "cleanup:example-plugin",
          "cleanup-failed:example-plugin",
          "watcher-settled",
        ]);
        const removed = await readPluginLocalState(
          setup.fixture.stateDir,
          setup.fixture.workspaceRoot,
        );
        if (!removed.ok) throw new Error(removed.warning);
        expect(removed.state.plugins["example-plugin"]).toBeUndefined();
        expect(
          setup.pipeline.list().some((plugin) => plugin.id === "example-plugin"),
        ).toBe(false);
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining("runtime-stopped cleanup failed"),
          cleanupFailure,
        );
      } finally {
        cleanupRelease.resolve();
        consoleError.mockRestore();
        await setup.pipeline.dispose();
      }
    }, 60_000);

  });

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
      hostOwnership: new PluginHostOwnership(host),
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
    let hashSourceCalls = 0;
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
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
      operations: {
        install: (input) =>
          installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
        hashSource: async (rootPath) => {
          hashSourceCalls += 1;
          return hashPluginSourceFiles(rootPath);
        },
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
      const firstPreflight = await pipeline.uninstallPreflight("example-plugin", "example-plugin");
      if (!firstPreflight.ok) throw new Error(firstPreflight.error.message);
      const failed = await pipeline.uninstall(
        "example-plugin",
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
      expect(hashSourceCalls).toBe(2);
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
      const retryPreflight = await pipeline.uninstallPreflight("example-plugin", "example-plugin");
      if (!retryPreflight.ok) throw new Error(retryPreflight.error.message);
      expect(retryPreflight.preflight.liveHash).toBeNull();
      const finished = await pipeline.uninstall(
        "example-plugin",
        "example-plugin",
        retryPreflight.confirmationToken,
      );
      expect(finished.ok).toBe(true);
      // A confirmed absent source still re-resolves its identity twice, but
      // neither check tries to hash a path already proven absent.
      expect(hashSourceCalls).toBe(2);

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

  it("refuses a sourceless token after the same id is restored and restarted", async () => {
    const fixture = await createPluginWorkspace();
    const backupRoot = join(fixture.root, "source-backup");
    await cp(fixture.pluginRoot, backupRoot, { recursive: true });
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
      hostOwnership: new PluginHostOwnership(host),
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
      if (!installed.ok) throw new Error(installed.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "Plugin did not reach ready after install.",
      );

      failDataRemoval = true;
      const firstPreflight = await pipeline.uninstallPreflight(
        "example-plugin",
        "example-plugin",
      );
      if (!firstPreflight.ok) throw new Error(firstPreflight.error.message);
      const partial = await pipeline.uninstall(
        "example-plugin",
        "example-plugin",
        firstPreflight.confirmationToken,
      );
      expect(partial).toMatchObject({
        ok: false,
        error: { stage: "uninstall", code: "delete-failed" },
      });
      await expect(lstat(fixture.pluginRoot)).rejects.toMatchObject({ code: "ENOENT" });

      failDataRemoval = false;
      const sourceless = await pipeline.uninstallPreflight(
        "example-plugin",
        "example-plugin",
      );
      if (!sourceless.ok) throw new Error(sourceless.error.message);
      expect(sourceless.preflight.liveHash).toBeNull();

      await cp(backupRoot, fixture.pluginRoot, { recursive: true });
      await pipeline.handleWatcherEvents([{
        path: "plugins/example-plugin",
        operation: "update",
      }]);
      const enabled = await pipeline.enable("example-plugin");
      if (!enabled.ok) throw new Error(enabled.error.message);
      await waitFor(
        () => pipeline.list()[0]?.status === "ready",
        "The restored plugin did not restart.",
      );
      const runningRecord = host.currentRecord("example-plugin");
      expect(runningRecord).toBeDefined();
      const dataBundle = await readFile(liveBundlePath(fixture, "example-plugin"));
      const stateRoot = pluginStateRoot(
        pluginDataDir(fixture.stateDir, fixture.workspaceRoot),
        "example-plugin",
      );
      await mkdir(stateRoot, { recursive: true });
      await writeFile(join(stateRoot, "new-session.json"), "new state\n");

      const stale = await pipeline.uninstall(
        "example-plugin",
        "example-plugin",
        sourceless.confirmationToken,
      );

      expect(stale).toMatchObject({
        ok: false,
        error: { stage: "uninstall", code: "confirmation-stale" },
      });
      expect(host.currentRecord("example-plugin")).toBe(runningRecord);
      await expect(lstat(fixture.pluginRoot)).resolves.toBeDefined();
      expect(await readFile(liveBundlePath(fixture, "example-plugin")))
        .toEqual(dataBundle);
      expect(await readFile(join(stateRoot, "new-session.json"), "utf8"))
        .toBe("new state\n");
      const state = await readPluginLocalState(
        fixture.stateDir,
        fixture.workspaceRoot,
      );
      if (!state.ok) throw new Error(state.warning);
      expect(state.state.plugins["example-plugin"]).toBeDefined();
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
      hostOwnership: new PluginHostOwnership(newHost()),
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
      hostOwnership: new PluginHostOwnership(newHost()),
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
      hostOwnership: new PluginHostOwnership(host),
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
      supersededPluginId: null,
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      const preflight = await pipeline.uninstallPreflight("example-plugin", "example-plugin");
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
      const retry = await pipeline.uninstallPreflight("example-plugin", "example-plugin");
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      // Wait for the reconcile to SETTLE, not a fixed delay: under load the
      // no-op reconcile is still mid-flight ("snapshotting") long after its
      // snapshot started. A wrong re-enable never returns to "disabled" and
      // times out here; a wrong rebuild is caught by the counters below.
      await waitFor(
        () => pipeline.list()[0]?.status === "disabled",
        () =>
          `The reconcile never settled back to disabled; status is ` +
          `"${pipeline.list()[0]?.status}".`,
        60_000,
      );

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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
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
      hostOwnership: new PluginHostOwnership(host),
      resourcesBasePath,
      pnpmRunnerEntry,
    });

    try {
      await pipeline.start();

      const values = await pipeline.setPluginSettings("example-plugin", "example-plugin", {
        greeting: "Hei",
      });

      // Every declared setting under the one answer the user changed: a
      // plugin hears what its settings ARE, never the patch.
      expect(values).toEqual({ greeting: "Hei", shout: false });
      expect(told).toHaveBeenCalledWith("example-plugin", "example-plugin", values);
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
      hostOwnership: new PluginHostOwnership(host),
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
