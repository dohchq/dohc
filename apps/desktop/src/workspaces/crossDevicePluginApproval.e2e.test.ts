import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stop as stopEsbuild } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openLiveDaemonWorkspace } from "../../e2e/helpers/daemonSeed";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { PluginHost, type PluginHostOptions } from "../plugins/PluginHost";
import { PluginHostOwnership } from "../plugins/pluginHostOwnership";
import { PluginPipeline } from "../plugins/PluginPipeline";
import { resolvePluginEsbuildBinary } from "../plugins/pluginBuildRunner";
import {
  installPluginDependencies,
  type PluginInstallForkOptions,
  type PluginInstallProcessHandle,
} from "../plugins/pluginInstallRunner";
import { workspaceStateKey } from "../plugins/pluginLocalState";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import type { EngineRelayWorkspaceClient } from "./engineRelayClient";
import { probeRelayWorkspace } from "./relayWorkspaceProbe";
import { createTestScratch } from "./testTemp";
import { waitForPathMoments } from "./waitForPathMoments";
import {
  createWorkspaceEngineCapture,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";
import { bootstrapJoinedWorkspace } from "./workspaceJoinEnrollment";
import { spawn } from "node:child_process";

/**
 * The cross-device proof for the plugin design's marquee security claim:
 * "executed code is device-approved, not just workspace-synced."
 *
 * Real sync (#356) replicates `plugins/` source like any other workspace
 * content. This suite runs two real daemons through one real relay and asks
 * what device B does with plugin source it never approved. The pin is
 * positive, not a status read: device B's plugin host really imports and runs
 * a bundle when it starts one, and the plugin's entry writes a marker file
 * beside its own bundle on activation. Device A proves that observation works
 * by producing its marker; device B must never produce one.
 */

const engine = requireEngineBinaryOrSkip();

const PLUGIN_ID = "xdevice-plugin";
const PLUGIN_DIR = `plugins/${PLUGIN_ID}`;
/** Written by the plugin's own module body, beside whichever bundle ran. */
const EXECUTION_MARKER = "EXECUTED.txt";

let resourcesParent: string;
let resourcesBasePath: string;
const pnpmRunnerEntry = join(
  import.meta.dirname,
  "..",
  "plugins",
  "pluginPnpmRunnerProcess.ts",
);

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

/** Stages the real pnpm and esbuild the install/build stages shell out to. */
async function stagePluginTools(): Promise<void> {
  resourcesParent = await mkdtemp(join(tmpdir(), "dohc-xdevice-tools-"));
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

/**
 * The plugin's source. Identical bytes on both devices, because sync copies
 * them verbatim — so the marker path cannot name a device. It is derived from
 * the module's own location instead, which puts each device's marker beside
 * that device's own built bundle under its own userData.
 */
function pluginEntrySource(marker: string): string {
  return [
    'import { writeFileSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    `export const marker = ${JSON.stringify(marker)};`,
    "",
    "// Module body: runs on import, before any activate() call. If a byte of",
    "// this plugin ever executes on a device, that device gets a marker.",
    "writeFileSync(",
    `  join(dirname(fileURLToPath(import.meta.url)), ${JSON.stringify(EXECUTION_MARKER)}),`,
    "  `${marker}\\n`,",
    ");",
    "",
    "export default { activate() {} };",
    "",
  ].join("\n");
}

function pluginSourceFiles(marker: string): { path: string; contents: string }[] {
  return [
    {
      path: `${PLUGIN_DIR}/dohc-plugin.json`,
      contents: `${JSON.stringify({
        version: 1,
        name: PLUGIN_ID,
        displayName: "Cross-device plugin",
        entry: "src/index.ts",
      }, null, 2)}\n`,
    },
    {
      path: `${PLUGIN_DIR}/package.json`,
      contents: `${JSON.stringify({
        name: PLUGIN_ID,
        version: "1.0.0",
        private: true,
        type: "module",
        packageManager: "pnpm@11.20.0",
      }, null, 2)}\n`,
    },
    {
      path: `${PLUGIN_DIR}/pnpm-lock.yaml`,
      contents: [
        "lockfileVersion: '9.0'",
        "settings:",
        "  autoInstallPeers: true",
        "  excludeLinksFromLockfile: false",
        "importers:",
        "  .: {}",
        "",
      ].join("\n"),
    },
    { path: `${PLUGIN_DIR}/src/index.ts`, contents: pluginEntrySource(marker) },
  ];
}

interface LiveDaemonCapture {
  capture: WorkspaceEngineCapture;
  relay: EngineRelayWorkspaceClient;
  ensureGeneralChannel(): Promise<void>;
  close(): Promise<void>;
}

async function openDaemon(
  input: {
    workspaceId: string;
    rootPath: string;
    relay: { baseUrl: string; token: string };
  },
  join_: boolean,
): Promise<LiveDaemonCapture> {
  const workspace = await openLiveDaemonWorkspace(input, { maxRestarts: 0 });
  const relay = workspace.relay.bind(input);
  if (join_) {
    const probe = await probeRelayWorkspace({
      workspaceId: input.workspaceId,
      relay: input.relay,
    });
    try {
      await bootstrapJoinedWorkspace({
        workspaceId: input.workspaceId,
        identity: probe.identity,
        transport: relay,
        installDataKey: async () => undefined,
      });
    } catch (error) {
      await workspace.close().catch(() => undefined);
      throw error;
    }
  }
  const capture = createWorkspaceEngineCapture({
    workspaceId: input.workspaceId,
    rootPath: input.rootPath,
    rustEngineSessions: workspace.sessions,
    daemonOwnsCapture: true,
  });
  return {
    capture,
    relay,
    ensureGeneralChannel: async () => {
      await workspace.chats.ensureGeneralChannel({
        workspaceId: input.workspaceId,
      });
    },
    close: async () => {
      try {
        await capture.stop();
      } finally {
        await workspace.close();
      }
    },
  };
}

async function writeAndCapture(
  daemon: LiveDaemonCapture,
  rootPath: string,
  path: string,
  contents: string,
): Promise<void> {
  const before = (await daemon.capture.listMoments({ limit: 1_000 })).moments
    .filter((moment) => moment.path === path).length;
  const absolute = join(rootPath, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
  daemon.capture.captureBatch([{ path, operation: "update" }]);
  await waitForPathMoments(daemon.capture, path, before + 1);
}

/**
 * A plugin host that really runs the plugin. `spawnTransport` stands in for
 * Electron's `utilityProcess.fork`, which vitest cannot use, but the part that
 * matters is faithful: on `plugin.activate` it imports the built bundle from
 * the live root the pipeline handed it and calls the handler, exactly as
 * `pluginHostProcess.ts` does. A test that only counted spawn calls could not
 * tell "held for approval" from "started something that did nothing".
 */
function executingHost(): {
  spawnTransport: PluginHostOptions["spawnTransport"];
  activations: string[];
} {
  const activations: string[] = [];
  const spawnTransport: PluginHostOptions["spawnTransport"] = (params) => ({
    request: async <T = unknown>(method: string): Promise<T> => {
      if (method !== "plugin.activate") return {} as T;
      activations.push(params.pluginRoot);
      const bundle = join(params.pluginRoot, "bundle.mjs");
      // Cache-bust: a re-approval rebuilds the same path, and ESM would
      // otherwise return the first module without re-running its body.
      const loaded = await import(
        `${pathToFileURL(bundle).href}?v=${createHash("sha256")
          .update(await readFile(bundle))
          .digest("hex")}`
      ) as { default?: { activate?: (context: unknown) => unknown } };
      await loaded.default?.activate?.({});
      return { commands: [], drivers: [] } as T;
    },
    notify: () => undefined,
    dispose: async () => undefined,
  });
  return { spawnTransport, activations };
}

interface Device {
  pipeline: PluginPipeline;
  stateDir: string;
  workspaceRoot: string;
  activations: string[];
}

async function openDevice(
  workspaceRoot: string,
  stateDir: string,
): Promise<Device> {
  await mkdir(stateDir, { recursive: true });
  const { spawnTransport, activations } = executingHost();
  let pipeline: PluginPipeline;
  const host = new PluginHost({
    stateDir,
    workspaceRoot,
    spawnTransport,
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
      install: async (input) =>
        await installPluginDependencies({ ...input, forkProcess: nodeForkProcess }),
    },
  });
  return { pipeline, stateDir, workspaceRoot, activations };
}

/** Where this device's built artifacts live — under its own userData. */
function deviceLiveRoot(device: Device): string {
  return join(
    device.stateDir,
    "plugin-data",
    workspaceStateKey(device.workspaceRoot),
    "plugins",
    PLUGIN_ID,
  );
}

async function markerContents(device: Device): Promise<string | null> {
  return await readFile(join(deviceLiveRoot(device), EXECUTION_MARKER), "utf8")
    .catch(() => null);
}

async function waitFor(
  condition: () => boolean,
  message: () => string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message());
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function statusOf(device: Device): string | undefined {
  return device.pipeline.list().find((plugin) => plugin.id === PLUGIN_ID)?.status;
}

/**
 * Pulls exactly as production does, and reports which plugin paths the relay
 * materialized. Nothing is fed to the pipeline here on purpose, and no
 * watcher runs in this suite, so the pull cannot wake the device's pipeline.
 *
 * That models a workspace nobody has open. A closed workspace has no pipeline
 * at all (main.ts:2621), so it can execute nothing until the next reopen —
 * the path this test drives.
 *
 * An OPEN workspace holds at pull time instead. The pipeline hears about disk
 * changes through `handleWatcherEvents`, whose one caller is `main.ts`'s
 * `onWatcherBatch` (main.ts:2229) by way of `onSettledBatch`
 * (workspaceActivity.ts:243). Expected-event suppression does not hide the
 * pull from it: `registerExpectedEngineEvents`/`consumeExpectedEvent` apply
 * only on the engine-journaling side, inside `captureBatch`, while
 * `onSettledBatch` receives its own raw copy of the same events
 * (workspaceWatcher.ts). Both routes end at the same approval predicate.
 */
async function pullSynced(daemon: LiveDaemonCapture): Promise<string[]> {
  const pull = await daemon.capture.runRelaySync((materializePage) =>
    daemon.relay.pull(materializePage));
  return pull.fastForwardedPaths
    .map((entry) => entry.path)
    .filter((path) => path.startsWith(`${PLUGIN_DIR}/`));
}

/**
 * Nothing about this plugin was built, published, or run on this device.
 * Checked together because each alone is weak: no marker could mean a broken
 * fixture, and no bundle could mean a build that failed after executing an
 * install hook.
 */
async function expectNothingExecuted(device: Device): Promise<void> {
  expect(device.activations).toEqual([]);
  expect(await markerContents(device)).toBeNull();
  await expect(lstat(join(deviceLiveRoot(device), "bundle.mjs")))
    .rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(join(deviceLiveRoot(device), "snapshot")))
    .rejects.toMatchObject({ code: "ENOENT" });
}

beforeAll(stagePluginTools, 120_000);

afterAll(async () => {
  await stopEsbuild();
  await rm(resourcesParent, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

it.skipIf(engine.missing)(
  "never executes synced plugin source on a device that did not approve it",
  async () => {
    const workspaceId = "cross-device-plugin-approval";
    const token = `test:${workspaceId}`;
    const rootA = await createTestScratch("dohc-xdevice-a-");
    const rootB = await createTestScratch("dohc-xdevice-b-");
    const stateA = await createTestScratch("dohc-xdevice-state-a-");
    const stateB = await createTestScratch("dohc-xdevice-state-b-");
    const relayRoot = await createTestScratch("dohc-xdevice-relay-");
    const relay = await spawnSyncRelay({
      dbPath: join(relayRoot, "relay.sqlite"),
    });
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    let deviceA: Device | null = null;
    let deviceB: Device | null = null;
    const opened: Device[] = [];
    try {
      daemonA = await openDaemon(
        { workspaceId, rootPath: rootA, relay: { baseUrl: relay.baseUrl, token } },
        false,
      );
      await daemonA.relay.claim();
      await daemonA.ensureGeneralChannel();
      expect((await daemonA.relay.push()).pushed).toBeGreaterThan(0);

      // 1. Device A carries the plugin, installed and approved locally.
      for (const file of pluginSourceFiles("one")) {
        await writeAndCapture(daemonA, rootA, file.path, file.contents);
      }
      deviceA = await openDevice(rootA, stateA);
      opened.push(deviceA);
      await deviceA.pipeline.start();
      expect(statusOf(deviceA)).toBe("discovered");

      const installed = await deviceA.pipeline.install(PLUGIN_ID);
      if (!installed.ok) {
        throw new Error(
          `${installed.error.stage}/${installed.error.code}: ${installed.error.message}`,
        );
      }
      await waitFor(
        () => statusOf(deviceA!) === "ready",
        () => `Device A did not reach ready: ${statusOf(deviceA!)}`,
      );
      // The positive control: this harness can see a plugin execute.
      expect(deviceA.activations).toHaveLength(1);
      expect(await markerContents(deviceA)).toBe("one\n");

      // 2. Real sync replicates the workspace to device B.
      expect((await daemonA.relay.push()).pushed).toBeGreaterThan(0);
      daemonB = await openDaemon(
        { workspaceId, rootPath: rootB, relay: { baseUrl: relay.baseUrl, token } },
        true,
      );
      const synced = await pullSynced(daemonB);

      // The source really arrived, byte for byte.
      expect(synced).toContain(`${PLUGIN_DIR}/src/index.ts`);
      expect(await readFile(join(rootB, `${PLUGIN_DIR}/src/index.ts`), "utf8"))
        .toBe(pluginEntrySource("one"));

      // 3. THE CLAIM: B discovers the plugin and runs not one byte of it.
      // B has no approval record for it, because an approval lives in the
      // device's own userData and never travels with the workspace.
      deviceB = await openDevice(rootB, stateB);
      opened.push(deviceB);
      await deviceB.pipeline.start();
      expect(statusOf(deviceB)).toBe("discovered");
      const discoveredOnB = deviceB.pipeline.list()
        .find((plugin) => plugin.id === PLUGIN_ID);
      expect(discoveredOnB?.approvedHash).toBeNull();
      // A real observation window: give an auto-install every chance to run.
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      await expectNothingExecuted(deviceB);

      // 4. Approving on B runs the normal install/build flow, and it activates.
      const approvedOnB = await deviceB.pipeline.install(PLUGIN_ID);
      if (!approvedOnB.ok) {
        throw new Error(
          `${approvedOnB.error.stage}/${approvedOnB.error.code}: ${approvedOnB.error.message}`,
        );
      }
      await waitFor(
        () => statusOf(deviceB!) === "ready",
        () => `Device B did not reach ready after approval: ${statusOf(deviceB!)}`,
      );
      expect(deviceB.activations).toHaveLength(1);
      expect(await markerContents(deviceB)).toBe("one\n");

      // 5. A post-approval source change from A puts B back into the hold.
      await writeAndCapture(
        daemonA,
        rootA,
        `${PLUGIN_DIR}/src/index.ts`,
        pluginEntrySource("two"),
      );
      expect((await daemonA.relay.push()).pushed).toBeGreaterThan(0);
      const resynced = await pullSynced(daemonB);
      expect(resynced).toContain(`${PLUGIN_DIR}/src/index.ts`);
      expect(await readFile(join(rootB, `${PLUGIN_DIR}/src/index.ts`), "utf8"))
        .toBe(pluginEntrySource("two"));

      // No watcher runs here, so the pull leaves this pipeline asleep (see
      // pullSynced) and the running plugin keeps serving the bundle B
      // approved. Stale, not unsafe: the bytes B never approved are on disk
      // and still have not run. An open workspace would hold here instead,
      // through the watcher; a closed one has no pipeline to hold.
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      expect(deviceB.activations).toHaveLength(1);
      expect(await markerContents(deviceB)).toBe("one\n");

      // Device B restarts — a new pipeline over the same device state dir,
      // which is what relaunching the app does. Discovery re-hashes the live
      // tree, finds the approved hash moved, and holds.
      const restartedB = await openDevice(rootB, stateB);
      opened.push(restartedB);
      deviceB = restartedB;
      await restartedB.pipeline.start();
      await waitFor(
        () => statusOf(restartedB) === "disabled-pending-approval",
        () =>
          `Device B did not hold the synced change for approval: ${statusOf(restartedB)}`,
      );
      const heldOnB = restartedB.pipeline.list()
        .find((plugin) => plugin.id === PLUGIN_ID);
      expect(heldOnB?.disabledReason).toBe("approval");
      // The moved hash never became an approval, and the new bytes never ran.
      expect(heldOnB?.approvedHash).not.toBe(heldOnB?.sourceHash);
      expect(restartedB.activations).toEqual([]);
      expect(await markerContents(restartedB)).toBe("one\n");
    } finally {
      for (const device of opened.reverse()) {
        await device.pipeline.dispose().catch(() => undefined);
      }
      await daemonB?.close().catch(() => undefined);
      await daemonA?.close().catch(() => undefined);
      await relay.stop();
    }
  },
  240_000,
);
