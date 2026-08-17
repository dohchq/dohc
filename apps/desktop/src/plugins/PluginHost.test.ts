import {
  VERSIONED_METHOD,
  VersionedLoopbackEngine,
  type Request,
} from "@dohc/workspace-engine-client";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { databaseOpLogPath } from "@dohc/workspace-core";
import type { DohcPluginManifest } from "./pluginManifestSchema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonRpcTransport } from "../agents/JsonRpcTransport";
import { createTestScratch } from "../workspaces/testTemp";
import { mockLiveSessions } from "../testing/liveEngineSessions";
import { createWorkspaceEngineCapture } from "../workspaces/workspaceEngineCapture";
import { PluginHost, type PluginHostOptions } from "./PluginHost";
import {
  mutatePluginRecord,
  pluginDataDir,
  pluginStateFileName,
  readPluginLocalState,
} from "./pluginLocalState";
import { pluginStateRoot } from "./pluginSourceSnapshot";
import { readPluginManifestFile } from "./pluginManifest";
import { invokePluginSdkHost } from "./pluginSdkHost";
import { createPluginPanelSdkAuthorityRegistry } from "./pluginPanelSdkAuthority";
import {
  revokePluginPanelAuthorities,
  revokePluginPanelAuthoritiesForStatus,
  startPluginPanelWithLock,
  stopPluginPanelWithLock,
} from "./pluginPanelStartLifecycle";
import {
  PLUGIN_ACTIVATION_TIMEOUT_MS,
  PLUGIN_HOST_METHODS,
  type PluginRuntimeStatus,
} from "./pluginHostProtocol";

const pluginHostProcessPath = fileURLToPath(
  new URL("./pluginHostProcess.ts", import.meta.url),
);
const helloPluginRoot = fileURLToPath(
  new URL("../../e2e/fixtures/hello-plugin", import.meta.url),
);
const tempRoots: string[] = [];
const hosts: PluginHost[] = [];

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function workspaceRoot(): Promise<string> {
  const scratch = await createTestScratch("dohc-plugin-host-");
  tempRoots.push(scratch);
  const root = join(scratch, "workspace");
  await mkdir(root);
  return root;
}

async function stateDir(): Promise<string> {
  const scratch = await createTestScratch("dohc-plugin-state-");
  tempRoots.push(scratch);
  return scratch;
}

const requireModule = createRequire(import.meta.url);

async function seedFixtureDatabase(root: string): Promise<void> {
  const { DatabaseSync } = requireModule("node:sqlite") as {
    DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
  };
  await mkdir(join(root, "data"), { recursive: true });
  const database = new DatabaseSync(join(root, "data", "app.sqlite"));
  try {
    database.exec(
      "CREATE TABLE sentinel (id TEXT PRIMARY KEY, marker TEXT); INSERT INTO sentinel VALUES ('1', 'start');",
    );
  } finally {
    database.close();
  }
}

async function fixtureManifest(): Promise<DohcPluginManifest> {
  const result = await readPluginManifestFile(helloPluginRoot);
  if (!result.ok) throw new Error(result.diagnostics.join("; "));
  return result.manifest;
}

interface ProcessHarness {
  spawnTransport: PluginHostOptions["spawnTransport"];
  spawnedPluginIds: string[];
  activationResolvedPluginIds: string[];
  readonly deactivateRequestCount: number;
  disposedPluginIds: string[];
  exitedPluginIds: string[];
}

type SpawnTransportParams = Parameters<
  PluginHostOptions["spawnTransport"]
>[0];

function createCallbackHarness(): {
  spawnTransport: PluginHostOptions["spawnTransport"];
  getCallbacks: () => SpawnTransportParams;
} {
  let callbacks: SpawnTransportParams | undefined;
  const spawnTransport = vi.fn<PluginHostOptions["spawnTransport"]>((params) => {
    callbacks = params;
    return {
      request<T = unknown>(method: string): Promise<T> {
        const result = method === PLUGIN_HOST_METHODS.activate
          ? { commands: [] }
          : {};
        return Promise.resolve(result as T);
      },
      notify: () => undefined,
      dispose: () => Promise.resolve(),
    };
  });
  return {
    spawnTransport,
    getCallbacks() {
      if (!callbacks) throw new Error("Plugin transport did not spawn.");
      return callbacks;
    },
  };
}

function createProcessHarness(options: {
  modes?: Record<string, string>;
  waitForActivationBeforeDeactivate?: boolean;
} = {}): ProcessHarness {
  const spawnedPluginIds: string[] = [];
  const activationResolvedPluginIds: string[] = [];
  const disposedPluginIds: string[] = [];
  const exitedPluginIds: string[] = [];
  let deactivateRequestCount = 0;
  const spawnTransport = vi.fn<PluginHostOptions["spawnTransport"]>((params) => {
    spawnedPluginIds.push(params.pluginId);
    const env: Record<string, string | undefined> = {
      DOHC_PLUGIN_FIXTURE_MODE: options.modes?.[params.pluginId] ?? "hello",
    };

    const transport = JsonRpcTransport.spawn({
      command: process.execPath,
      args: [pluginHostProcessPath],
      cwd: params.pluginRoot,
      env,
      detached: true,
      label: `plugin ${params.pluginId}`,
      onNotification: params.onNotification,
      onRequest: params.onRequest,
      onStderr: params.onStderr,
      onExit: (code, signal) => {
        exitedPluginIds.push(params.pluginId);
        params.onExit({ code, signal });
      },
    });
    let activationRequest: Promise<unknown> | undefined;

    return {
      async request<T = unknown>(method: string, rpcParams?: unknown): Promise<T> {
        if (method === PLUGIN_HOST_METHODS.deactivate) {
          deactivateRequestCount += 1;
        }
        if (
          method === PLUGIN_HOST_METHODS.deactivate &&
          options.waitForActivationBeforeDeactivate
        ) {
          await activationRequest?.catch(() => undefined);
        }
        const request = transport.request<T>(method, rpcParams);
        if (method === PLUGIN_HOST_METHODS.activate) {
          activationRequest = request;
          void request.then(
            () => activationResolvedPluginIds.push(params.pluginId),
            () => undefined,
          );
        }
        return request;
      },
      notify(method: string, notifyParams?: unknown) {
        transport.notify(method, notifyParams);
      },
      async dispose() {
        disposedPluginIds.push(params.pluginId);
        await transport.dispose();
      },
    };
  });

  return {
    spawnTransport,
    spawnedPluginIds,
    activationResolvedPluginIds,
    get deactivateRequestCount() {
      return deactivateRequestCount;
    },
    disposedPluginIds,
    exitedPluginIds,
  };
}

function createCrashAccountingHarness(): {
  spawnTransport: PluginHostOptions["spawnTransport"];
  beginFreshCode: () => void;
} {
  let phase: "crash-loop" | "fresh-code" = "crash-loop";
  let freshCodeSpawns = 0;
  const spawnTransport = vi.fn<PluginHostOptions["spawnTransport"]>(
    (params) => {
      if (phase === "fresh-code") freshCodeSpawns += 1;
      const shouldCrash =
        phase === "crash-loop" || freshCodeSpawns <= 2;
      return {
        request<T = unknown>(method: string): Promise<T> {
          const result = method === PLUGIN_HOST_METHODS.activate
            ? { commands: [] }
            : {};
          if (method === PLUGIN_HOST_METHODS.activate && shouldCrash) {
            setTimeout(() => params.onExit({ code: 1, signal: null }), 0);
          }
          return Promise.resolve(result as T);
        },
        notify: () => undefined,
        dispose: () => Promise.resolve(),
      };
    },
  );
  return {
    spawnTransport,
    beginFreshCode() {
      phase = "fresh-code";
      freshCodeSpawns = 0;
    },
  };
}

function trackHost(options: PluginHostOptions): PluginHost {
  const host = new PluginHost(options);
  hosts.push(host);
  return host;
}

function defaultRouter(): Promise<unknown> {
  return Promise.resolve({});
}

function mutateDisabledState(
  localStateDir: string,
  root: string,
  pluginId: string,
  disabled: boolean,
): Promise<void> {
  return mutatePluginRecord(
    localStateDir,
    root,
    pluginId,
    (record) => ({ ...record, disabled }),
  );
}

afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.stopAll()));
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("PluginHost", () => {
  it("activates a real plugin and records its command contributions", async () => {
    const root = await workspaceRoot();
    const harness = createProcessHarness();
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Plugin did not become ready.",
    );

    expect(host.getRegisteredCommands("hello-plugin")).toEqual(["hello.write"]);
  });

  it("routes a plugin's files.write through the real SDK host with host-derived attribution", async () => {
    const root = await workspaceRoot();
    const writes: Array<{ path: string; text: string; author: unknown }> = [];
    const harness = createProcessHarness();
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: (pluginId, method, params, spawnId, signal) =>
        invokePluginSdkHost(
          {
            pluginId,
            workspaceRoot: root,
            spawnId,
            requestPath: "plugin-process",
            isWritable: () => true,
            writeAvailable: async () => true,
            signal,
            invokeChildProcess: async () => ({}),
            writeAuthoredText: async (path, text, options) => {
              writes.push({ path, text, author: options.author });
              return { path };
            },
          },
          method,
          params,
        ),
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Plugin did not become ready.",
    );

    await host.invokeCommand("hello-plugin", "hello.write");

    expect(writes).toEqual([
      {
        path: "hello-plugin-output.txt",
        text: "Hello from hello-plugin\n",
        author: {
          kind: "agent",
          agentId: "plugin:hello-plugin",
          onBehalfOf: "local",
          agentRunId: expect.any(String),
        },
      },
    ]);
  });

  it("round-trips databases.read and a plugin-attributed databases.edit over the real protocol", async () => {
    const root = await workspaceRoot();
    await seedFixtureDatabase(root);
    const harness = createProcessHarness({
      modes: { "hello-plugin": "use-workspace" },
    });
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: (pluginId, method, params, spawnId, signal) =>
        invokePluginSdkHost(
          {
            pluginId,
            workspaceRoot: root,
            spawnId,
            requestPath: "plugin-process",
            isWritable: () => true,
            writeAvailable: async () => true,
            signal,
            invokeChildProcess: async () => ({}),
            writeAuthoredText: async (path) => ({ path }),
          },
          method,
          params,
        ),
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Plugin did not become ready.",
    );

    // The snapshot really crossed the protocol.
    expect(await host.invokeCommand("hello-plugin", "database.roundTrip")).toEqual({
      tables: ["sentinel"],
    });

    // The edit landed, and the op log names the plugin as its author.
    const log = await readFile(
      join(root, databaseOpLogPath("data/app.sqlite")),
      "utf8",
    );
    const ops = log
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { payload: unknown; author: unknown });
    expect(ops).toHaveLength(1);
    expect(ops[0]?.payload).toEqual({ marker: "edited-by-plugin" });
    expect(ops[0]?.author).toEqual({
      kind: "agent",
      agentId: "plugin:hello-plugin",
      onBehalfOf: "local",
    });
  });

  it("tells a plugin's own process that ui.open needs a renderer", async () => {
    const root = await workspaceRoot();
    const harness = createProcessHarness({
      modes: { "hello-plugin": "use-workspace" },
    });
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: (pluginId, method, params, spawnId, signal) =>
        invokePluginSdkHost(
          {
            pluginId,
            workspaceRoot: root,
            spawnId,
            requestPath: "plugin-process",
            isWritable: () => true,
            writeAvailable: async () => true,
            signal,
            invokeChildProcess: async () => ({}),
            writeAuthoredText: async (path) => ({ path }),
          },
          method,
          params,
        ),
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Plugin did not become ready.",
    );

    const result = (await host.invokeCommand("hello-plugin", "ui.tryOpen")) as {
      opened: boolean;
      message: string | null;
    };
    expect(result.opened).toBe(false);
    expect(result.message).toMatch(/ui\.open capability is disabled by this host/);
  });

  it("rejects invokeCommand for an unregistered command by name", async () => {
    const root = await workspaceRoot();
    const harness = createProcessHarness();
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Plugin did not become ready.",
    );

    await expect(
      host.invokeCommand("hello-plugin", "does-not-exist"),
    ).rejects.toThrow('Command "does-not-exist" is not registered.');
  });

  it("rejects invokeCommand for a plugin that is not running", async () => {
    const root = await workspaceRoot();
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: vi.fn<PluginHostOptions["spawnTransport"]>(),
      routeSdkRequest: defaultRouter,
    });

    await expect(
      host.invokeCommand("hello-plugin", "hello.write"),
    ).rejects.toThrow('Plugin "hello-plugin" is not running.');
  });

  it("rejects invokeCommand while the plugin is still starting", async () => {
    const root = await workspaceRoot();
    let invokeCommandCalls = 0;
    let resolveActivation:
      | ((result: { commands: string[] }) => void)
      | undefined;
    const activation = new Promise<{ commands: string[] }>((resolve) => {
      resolveActivation = resolve;
    });
    const spawnTransport = vi.fn<PluginHostOptions["spawnTransport"]>(() => ({
      request<T = unknown>(method: string): Promise<T> {
        if (method === PLUGIN_HOST_METHODS.activate) {
          return activation as Promise<T>;
        }
        if (method === PLUGIN_HOST_METHODS.invokeCommand) invokeCommandCalls += 1;
        return Promise.resolve({} as T);
      },
      notify: () => undefined,
      dispose: () => Promise.resolve(),
    }));
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport,
      routeSdkRequest: defaultRouter,
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    await expect(
      host.invokeCommand("hello-plugin", "hello.write"),
    ).rejects.toThrow('Plugin "hello-plugin" is still starting.');

    expect(invokeCommandCalls).toBe(0);
    resolveActivation?.({ commands: [] });
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Plugin did not finish activation.",
    );
  });

  it("answers a request only after activationOf settles, on a real spawn (#798)", async () => {
    const root = await workspaceRoot();
    const harness = createProcessHarness({
      modes: { "hello-plugin": "slow-hello" },
    });
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
    });

    await host.start(helloPluginRoot, await fixtureManifest());

    // The spawn id already exists — this is what a panel or web-app open used
    // to read as "running" — and every request in this window is refused.
    expect(typeof host.getSpawnId("hello-plugin")).toBe("string");
    expect(host.getStatus("hello-plugin")).toBe("starting");
    await expect(
      host.invokeCommand("hello-plugin", "does-not-exist"),
    ).rejects.toThrow('Plugin "hello-plugin" is still starting.');

    const activation = host.activationOf("hello-plugin");
    expect(activation).toBeDefined();
    await activation;

    expect(host.getStatus("hello-plugin")).toBe("ready");
    // The same call now reaches the plugin: this is the plugin's own answer,
    // not the host refusing to carry it.
    await expect(
      host.invokeCommand("hello-plugin", "does-not-exist"),
    ).rejects.toThrow('Command "does-not-exist" is not registered.');
  });

  it("rejects activationOf with the activation error a real spawn failed on (#798)", async () => {
    const root = await workspaceRoot();
    const harness = createProcessHarness({
      modes: { "hello-plugin": "throws" },
    });
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
    });

    await host.start(helloPluginRoot, await fixtureManifest());

    await expect(host.activationOf("hello-plugin")).rejects.toThrow(
      "fixture activation failed",
    );
  });

  it("reports no activation for a plugin that has no spawn (#798)", async () => {
    const root = await workspaceRoot();
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: vi.fn<PluginHostOptions["spawnTransport"]>(),
      routeSdkRequest: defaultRouter,
    });

    expect(host.activationOf("hello-plugin")).toBeUndefined();
  });

  it("releases activationOf when the spawn stops before it activated (#798)", async () => {
    const root = await workspaceRoot();
    const harness = createProcessHarness({
      modes: { "hello-plugin": "never-resolves" },
    });
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    const activation = host.activationOf("hello-plugin");
    expect(activation).toBeDefined();

    await host.stop("hello-plugin");

    // Without this the waiter would hang to the activation deadline for a
    // process that is already gone.
    await expect(activation).rejects.toThrow(
      'Plugin "hello-plugin" stopped before it finished starting.',
    );
  });

  it("rejects a second start while the first start continues", async () => {
    const root = await workspaceRoot();
    const harness = createProcessHarness();
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
    });
    const manifest = await fixtureManifest();

    const firstStart = host.start(helloPluginRoot, manifest);
    await expect(
      host.start(helloPluginRoot, manifest),
    ).rejects.toThrow('Plugin "hello-plugin" is already running.');
    await firstStart;
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "The first plugin start did not become ready.",
    );

    expect(harness.spawnedPluginIds).toEqual(["hello-plugin"]);
  });

  it("does not spawn when stop races a pending start", async () => {
    const root = await workspaceRoot();
    const harness = createProcessHarness();
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
    });

    const start = host.start(
      helloPluginRoot,
      await fixtureManifest(),
    );
    await host.stop("hello-plugin");
    await start;

    expect(harness.spawnedPluginIds).toEqual([]);
    expect(host.getStatus("hello-plugin")).toBeUndefined();
  });

  it("does not spawn when stopAll races a pending start", async () => {
    const root = await workspaceRoot();
    const harness = createProcessHarness();
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
    });

    const start = host.start(
      helloPluginRoot,
      await fixtureManifest(),
    );
    const stopAll = host.stopAll();
    await Promise.all([start, stopAll]);

    expect(harness.spawnedPluginIds).toEqual([]);
    expect(host.getStatus("hello-plugin")).toBeUndefined();
  });

  it("does not spawn a durably disabled plugin", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();
    await mutateDisabledState(localStateDir, root, "hello-plugin", true);
    const spawnTransport = vi.fn<PluginHostOptions["spawnTransport"]>(() => {
      throw new Error("Disabled plugin was spawned.");
    });
    const host = trackHost({
      stateDir: localStateDir,
      workspaceRoot: root,
      spawnTransport,
      routeSdkRequest: defaultRouter,
    });

    await expect(
      host.start(helloPluginRoot, await fixtureManifest()),
    ).rejects.toThrow(
      'Plugin "hello-plugin" is disabled. Re-enabling it is not yet available in the app.',
    );
    expect(spawnTransport).not.toHaveBeenCalled();
  });

  it("does not spawn any plugin when local state is unreadable", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();
    const pluginStateDir = join(localStateDir, "plugin-state");
    await mkdir(pluginStateDir);
    await writeFile(
      join(pluginStateDir, pluginStateFileName(root)),
      "{not json",
    );
    const localState = await readPluginLocalState(localStateDir, root);
    if (localState.ok) throw new Error("expected malformed local state to fail");
    const spawnTransport = vi.fn<PluginHostOptions["spawnTransport"]>(() => {
      throw new Error("Plugin with unreadable local state was spawned.");
    });
    const host = trackHost({
      stateDir: localStateDir,
      workspaceRoot: root,
      spawnTransport,
      routeSdkRequest: defaultRouter,
    });

    await expect(
      host.start(helloPluginRoot, {
        ...(await fixtureManifest()),
        name: "another-plugin",
      }),
    ).rejects.toThrow(localState.warning);
    expect(spawnTransport).not.toHaveBeenCalled();
  });

  it("reports and disposes an activation failure", async () => {
    const root = await workspaceRoot();
    const statuses: PluginRuntimeStatus[] = [];
    const harness = createProcessHarness({
      modes: { "hello-plugin": "throws" },
    });
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      onStatusChange: (_pluginId, status) => statuses.push(status),
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => statuses.includes("failed"),
      "Plugin did not report its activation failure.",
    );
    await waitFor(
      () => harness.disposedPluginIds.includes("hello-plugin"),
      "Failed plugin transport was not disposed.",
    );
    await waitFor(
      () => harness.exitedPluginIds.includes("hello-plugin"),
      "Disposed plugin process did not exit.",
    );
  });

  it("handles a malformed activation result as an activation failure", async () => {
    const root = await workspaceRoot();
    const statuses: PluginRuntimeStatus[] = [];
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    const spawnTransport = vi.fn<PluginHostOptions["spawnTransport"]>(() => ({
      request<T = unknown>(): Promise<T> {
        return Promise.resolve({} as T);
      },
      notify: () => undefined,
      dispose: () => Promise.resolve(),
    }));
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport,
      routeSdkRequest: defaultRouter,
      onStatusChange: (_pluginId, status) => statuses.push(status),
    });

    process.on("unhandledRejection", onUnhandledRejection);
    try {
      await host.start(helloPluginRoot, await fixtureManifest());
      const reachedFailed = await waitFor(
        () => statuses.includes("failed"),
        "Malformed activation result did not fail the plugin.",
        500,
      ).then(
        () => true,
        () => false,
      );
      await delay(25);

      expect.soft(reachedFailed).toBe(true);
      expect(unhandledRejections).toEqual([]);
      expect(host.getStderrLog("hello-plugin")).toContain(
        'Activation failed: Plugin activation returned an invalid result: "commands" must be an array of non-empty strings.',
      );
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("rejects duplicate command ids returned by activation", async () => {
    const root = await workspaceRoot();
    const statuses: PluginRuntimeStatus[] = [];
    const harness = createProcessHarness({
      modes: { "hello-plugin": "duplicate-command" },
    });
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      onStatusChange: (_pluginId, status) => statuses.push(status),
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => statuses.includes("failed") || statuses.includes("ready"),
      "Duplicate command activation did not settle.",
    );

    expect(statuses).toContain("failed");
    expect(statuses).not.toContain("ready");
    expect(host.getStderrLog("hello-plugin")).toContain(
      'Activation failed: Plugin activation returned duplicate command id "hello.write". Command ids must be unique.',
    );
  });

  it("reports a post-activation asynchronous crash", async () => {
    const root = await workspaceRoot();
    const statuses: PluginRuntimeStatus[] = [];
    const harness = createProcessHarness({
      modes: { "hello-plugin": "async-throw-after-activate" },
    });
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      onStatusChange: (_pluginId, status) => statuses.push(status),
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => statuses.includes("ready"),
      "Plugin did not become ready before the asynchronous error.",
    );
    await waitFor(
      () => statuses.includes("crashed"),
      "Plugin did not crash after the asynchronous error.",
      2_000,
    );

    expect(
      host
        .getStderrLog("hello-plugin")
        .some((line) => line.includes("fixture: uncaught error after activation")),
    ).toBe(true);
  });

  it("rejects a malformed sdk.request before routing it", async () => {
    const root = await workspaceRoot();
    const harness = createCallbackHarness();
    const routeSdkRequest = vi.fn(defaultRouter);
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest,
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    const callbacks = harness.getCallbacks();

    await expect(
      Promise.resolve().then(() =>
        callbacks.onRequest(PLUGIN_HOST_METHODS.sdkRequest, { method: "" }),
      ),
    ).rejects.toThrow(
      "Malformed sdk.request params: method must be a non-empty string.",
    );
    expect(routeSdkRequest).not.toHaveBeenCalled();
  });

  it("forwards spawn-scoped SDK subscription events to the plugin transport", async () => {
    const root = await workspaceRoot();
    let callbacks: SpawnTransportParams | undefined;
    const notifications: Array<{ method: string; params: unknown }> = [];
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: (params) => {
        callbacks = params;
        return {
          request<T = unknown>(method: string): Promise<T> {
            const result = method === PLUGIN_HOST_METHODS.activate
              ? { commands: [] }
              : {};
            return Promise.resolve(result as T);
          },
          notify: (method, notificationParams) => {
            notifications.push({ method, params: notificationParams });
          },
          dispose: () => Promise.resolve(),
        };
      },
      routeSdkRequest: async (
        _pluginId,
        _method,
        _params,
        _spawnId,
        _signal,
        emitEvent,
      ) => {
        emitEvent("subscription-1", "stdout", {
          sequence: 1,
          stream: "stdout",
          text: "ready\n",
        });
        return { subscriptionId: "subscription-1" };
      },
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    if (!callbacks) throw new Error("Plugin transport did not spawn.");
    await callbacks.onRequest(PLUGIN_HOST_METHODS.sdkRequest, {
      method: "childProcesses.output.subscribe",
      params: { childId: "child-1" },
    });

    expect(notifications).toEqual([
      {
        method: PLUGIN_HOST_METHODS.sdkEvent,
        params: {
          subscriptionId: "subscription-1",
          event: "stdout",
          data: {
            sequence: 1,
            stream: "stdout",
            text: "ready\n",
          },
        },
      },
    ]);
  });

  it("aborts an in-flight SDK request when stop begins", async () => {
    const root = await workspaceRoot();
    const harness = createCallbackHarness();
    let requestSignal: AbortSignal | undefined;
    let observedAbort = false;
    const routeSdkRequest = vi.fn<PluginHostOptions["routeSdkRequest"]>(
      async (_pluginId, _method, _params, _spawnId, signal) => {
        requestSignal = signal;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
            resolve();
          }, { once: true });
        });
        throw new Error("request aborted");
      },
    );
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest,
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    const request = Promise.resolve(
      harness.getCallbacks().onRequest(PLUGIN_HOST_METHODS.sdkRequest, {
        method: "files.read",
        params: { path: "notes/today.md" },
      }),
    );
    await waitFor(() => requestSignal !== undefined, "SDK request was not routed.");

    await host.stop("hello-plugin");

    expect(requestSignal?.aborted).toBe(true);
    expect(observedAbort).toBe(true);
    await expect(request).rejects.toThrow("request aborted");
  });

  it("does not abort an SDK request that completes before stop", async () => {
    const root = await workspaceRoot();
    const harness = createCallbackHarness();
    let signalAtCompletion: AbortSignal | undefined;
    const routeSdkRequest = vi.fn<PluginHostOptions["routeSdkRequest"]>(
      async (_pluginId, _method, _params, _spawnId, signal) => {
        signalAtCompletion = signal;
        return { text: "done" };
      },
    );
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest,
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    await expect(
      harness.getCallbacks().onRequest(PLUGIN_HOST_METHODS.sdkRequest, {
        method: "files.read",
        params: { path: "notes/today.md" },
      }),
    ).resolves.toEqual({ text: "done" });
    expect(signalAtCompletion?.aborted).toBe(false);

    await host.stop("hello-plugin");
  });

  it("finishes spawn resource teardown before disposing the plugin transport", async () => {
    const root = await workspaceRoot();
    const order: string[] = [];
    let disposed = false;
    let finishResourceTeardown: (() => void) | undefined;
    let routedSignal: AbortSignal | undefined;
    let callbacks: SpawnTransportParams | undefined;
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: (params) => {
        callbacks = params;
        return {
          request<T = unknown>(method: string): Promise<T> {
            const result = method === PLUGIN_HOST_METHODS.activate
              ? { commands: [] }
              : {};
            return Promise.resolve(result as T);
          },
          notify: () => undefined,
          dispose: async () => {
            if (disposed) return;
            disposed = true;
            order.push("transport");
          },
        };
      },
      routeSdkRequest: async (
        _pluginId,
        _method,
        _params,
        _spawnId,
        signal,
      ) => {
        routedSignal = signal;
        return {};
      },
      onSpawnEnd: () => new Promise<void>((resolve) => {
        finishResourceTeardown = () => {
          order.push("resources");
          resolve();
        };
      }),
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    if (!callbacks) throw new Error("Plugin transport did not spawn.");
    await callbacks.onRequest(PLUGIN_HOST_METHODS.sdkRequest, {
      method: "capabilities",
    });
    const stop = host.stop("hello-plugin");
    await waitFor(
      () => routedSignal?.aborted === true && finishResourceTeardown !== undefined,
      "Spawn teardown did not begin.",
    );
    expect(order).toEqual([]);

    finishResourceTeardown?.();
    await stop;

    expect(order).toEqual(["resources", "transport"]);
  });

  it("gives a respawn a fresh signal and never reuses the crashed spawn signal", async () => {
    const root = await workspaceRoot();
    const callbacks: SpawnTransportParams[] = [];
    const spawnTransport = vi.fn<PluginHostOptions["spawnTransport"]>((params) => {
      callbacks.push(params);
      return {
        request<T = unknown>(method: string): Promise<T> {
          const result = method === PLUGIN_HOST_METHODS.activate
            ? { commands: [] }
            : {};
          return Promise.resolve(result as T);
        },
        notify: () => undefined,
        dispose: () => Promise.resolve(),
      };
    });
    const signals: AbortSignal[] = [];
    const routeSdkRequest = vi.fn<PluginHostOptions["routeSdkRequest"]>(
      async (_pluginId, _method, _params, _spawnId, signal) => {
        signals.push(signal);
        return {};
      },
    );
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport,
      routeSdkRequest,
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    await callbacks[0]?.onRequest(PLUGIN_HOST_METHODS.sdkRequest, {
      method: "capabilities",
    });
    const oldSignal = signals[0];
    expect(oldSignal?.aborted).toBe(false);

    callbacks[0]?.onExit({ code: 1, signal: null });
    await waitFor(() => callbacks.length === 2, "Plugin did not respawn.");
    expect(oldSignal?.aborted).toBe(true);

    await callbacks[1]?.onRequest(PLUGIN_HOST_METHODS.sdkRequest, {
      method: "capabilities",
    });
    const newSignal = signals[1];
    expect(newSignal).not.toBe(oldSignal);
    expect(newSignal?.aborted).toBe(false);
    expect(oldSignal?.aborted).toBe(true);

    await host.stop("hello-plugin");
    expect(newSignal?.aborted).toBe(true);
    expect(oldSignal?.aborted).toBe(true);
  });

  it("records a malformed plugin.log notification as a diagnostic", async () => {
    const root = await workspaceRoot();
    const harness = createCallbackHarness();
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    harness.getCallbacks().onNotification(PLUGIN_HOST_METHODS.log, {
      level: "debug",
      message: 42,
    });

    expect(host.getStderrLog("hello-plugin")).toContain(
      'Malformed plugin.log notification: {"level":"debug","message":42}',
    );
  });

  it("lets a healthy activation finish before a short test deadline", async () => {
    const root = await workspaceRoot();
    const harness = createProcessHarness();
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      activationTimeoutMs: 1_000,
    });
    const startedAt = Date.now();

    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Healthy plugin missed the test activation deadline.",
    );

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("fails and disposes an activation at its wall-clock deadline", async () => {
    const root = await workspaceRoot();
    const statuses: PluginRuntimeStatus[] = [];
    const harness = createProcessHarness({
      modes: { "hello-plugin": "never-resolves" },
    });
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      onStatusChange: (_pluginId, status) => statuses.push(status),
      activationTimeoutMs: 200,
    });
    const startedAt = Date.now();

    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => statuses.includes("failed"),
      "Plugin activation did not fail at the deadline.",
      2_000,
    );

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    expect(harness.disposedPluginIds).toContain("hello-plugin");
  });

  it("disables a plugin after three immediate crashes", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();
    const harness = createProcessHarness({
      modes: { "hello-plugin": "crash-immediately" },
    });
    const host = trackHost({
      stateDir: localStateDir,
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "disabled",
      "Crash loop did not disable the plugin.",
      10_000,
    );

    expect(harness.spawnedPluginIds).toEqual([
      "hello-plugin",
      "hello-plugin",
      "hello-plugin",
    ]);
    const localState = await readPluginLocalState(localStateDir, root);
    if (!localState.ok) throw new Error(localState.warning);
    expect(localState.state.plugins["hello-plugin"]?.disabled).toBe(true);
    await delay(300);
    expect(harness.spawnedPluginIds).toHaveLength(3);
  }, 15_000);

  it("disables a plugin after three activation timeouts", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();
    const harness = createProcessHarness({
      modes: { "hello-plugin": "never-resolves" },
    });
    const host = trackHost({
      stateDir: localStateDir,
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      activationTimeoutMs: 150,
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "disabled",
      "Timeout loop did not disable the plugin.",
      10_000,
    );

    expect(harness.spawnedPluginIds).toHaveLength(3);
    const localState = await readPluginLocalState(localStateDir, root);
    if (!localState.ok) throw new Error(localState.warning);
    expect(localState.state.plugins["hello-plugin"]?.disabled).toBe(true);
  }, 15_000);

  it("lets freshly built code use a new fast-failure window after reset", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();
    const harness = createCrashAccountingHarness();
    const host = trackHost({
      stateDir: localStateDir,
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
    });
    const manifest = await fixtureManifest();

    await host.start(helloPluginRoot, manifest);
    await waitFor(
      () => host.getStatus("hello-plugin") === "disabled",
      "Initial crash loop did not disable the plugin.",
    );
    expect(harness.spawnTransport).toHaveBeenCalledTimes(3);

    await host.stop("hello-plugin");
    await mutateDisabledState(localStateDir, root, "hello-plugin", false);
    harness.beginFreshCode();
    host.resetCrashAccounting("hello-plugin");
    await host.start(helloPluginRoot, manifest);
    await waitFor(
      () =>
        vi.mocked(harness.spawnTransport).mock.calls.length === 6 &&
        host.getStatus("hello-plugin") === "ready",
      "Fresh code did not receive a new fast-failure window.",
    );
    await delay(50);

    expect(host.getStatus("hello-plugin")).toBe("ready");
    expect(harness.spawnTransport).toHaveBeenCalledTimes(6);
    const localState = await readPluginLocalState(localStateDir, root);
    if (!localState.ok) throw new Error(localState.warning);
    expect(localState.state.plugins["hello-plugin"]?.disabled).toBe(false);
  });

  it("keeps crash accounting across a rebuild when it is not reset", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();
    const harness = createCrashAccountingHarness();
    const host = trackHost({
      stateDir: localStateDir,
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
    });
    const manifest = await fixtureManifest();

    await host.start(helloPluginRoot, manifest);
    await waitFor(
      () => host.getStatus("hello-plugin") === "disabled",
      "Initial crash loop did not disable the plugin.",
    );
    await host.stop("hello-plugin");
    await mutateDisabledState(localStateDir, root, "hello-plugin", false);
    harness.beginFreshCode();

    await host.start(helloPluginRoot, manifest);
    await waitFor(
      () => host.getStatus("hello-plugin") === "disabled",
      "Preserved crash accounting did not disable the plugin.",
    );
    await delay(50);

    expect(harness.spawnTransport).toHaveBeenCalledTimes(4);
    const localState = await readPluginLocalState(localStateDir, root);
    if (!localState.ok) throw new Error(localState.warning);
    expect(localState.state.plugins["hello-plugin"]?.disabled).toBe(true);
  });

  it("counts fast crashes after successful activations", async () => {
    const root = await workspaceRoot();
    const statuses: PluginRuntimeStatus[] = [];
    const spawnTransport = vi.fn<PluginHostOptions["spawnTransport"]>(
      (params) => ({
        request<T = unknown>(method: string): Promise<T> {
          const result = method === PLUGIN_HOST_METHODS.activate
            ? { commands: [] }
            : {};
          return Promise.resolve(result as T).then((value) => {
            if (method === PLUGIN_HOST_METHODS.activate) {
              setTimeout(
                () => params.onExit({ code: 1, signal: null }),
                0,
              );
            }
            return value;
          });
        },
        notify: () => undefined,
        dispose: () => Promise.resolve(),
      }),
    );
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport,
      routeSdkRequest: defaultRouter,
      onStatusChange: (_pluginId, status) => statuses.push(status),
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "disabled",
      "Fast crashes after activation did not disable the plugin.",
    );

    expect(statuses.filter((status) => status === "ready")).toHaveLength(3);
    expect(spawnTransport).toHaveBeenCalledTimes(3);
  });

  it("uses the live respawn id for a surviving panel's authored write", async () => {
    const root = await workspaceRoot();
    const spawned: Array<
      Parameters<PluginHostOptions["spawnTransport"]>[0]
    > = [];
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: (callbacks) => {
        spawned.push(callbacks);
        return {
          request: async <T,>(method: string) =>
            (method === PLUGIN_HOST_METHODS.activate
              ? { commands: [] }
              : {}) as T,
          notify: () => undefined,
          dispose: async () => undefined,
        };
      },
      routeSdkRequest: defaultRouter,
    });
    await host.start(helloPluginRoot, await fixtureManifest());
    const originalSpawnId = host.getSpawnId("hello-plugin");
    if (!originalSpawnId) throw new Error("Plugin did not expose its first spawn id.");

    spawned[0]?.onExit({ code: 1, signal: null });
    await waitFor(
      () => {
        const live = host.getSpawnId("hello-plugin");
        return Boolean(live && live !== originalSpawnId && host.getStatus("hello-plugin") === "ready");
      },
      "Plugin did not become ready after its respawn.",
    );
    const liveSpawnId = host.getSpawnId("hello-plugin");
    if (!liveSpawnId) throw new Error("Plugin did not expose its respawn id.");

    const registry = createPluginPanelSdkAuthorityRegistry();
    registry.register({
      senderId: 1,
      generation: 1,
      workspaceId: "workspace-a",
      pluginId: "hello-plugin",
      panelId: "main",
    });
    const authority = registry.authorize({
      senderId: 1,
      generation: 1,
      activeWorkspaceId: "workspace-a",
      workspaceId: "workspace-a",
      pluginId: "hello-plugin",
      panelId: "main",
      panelRunning: true,
      liveSpawnId,
    });
    let authoredRunId: string | undefined;
    await invokePluginSdkHost(
      {
        pluginId: "hello-plugin",
        workspaceRoot: root,
        spawnId: authority.spawnId,
        requestPath: "panel",
        isWritable: () => true,
        writeAvailable: async () => true,
        writeAuthoredText: async (path, _text, options) => {
          authoredRunId = options.author.agentRunId;
          return { path };
        },
      },
      "files.write",
      { path: "respawn.txt", text: "new process\n" },
    );

    expect(authoredRunId).toBe(liveSpawnId);
  });

  it("aborts a queued panel write when the plugin crashes", async () => {
    const root = await workspaceRoot();
    const entered = deferredVoid();
    const release = deferredVoid();
    const writeQueued = deferredVoid();
    const loopbackTarget = new VersionedLoopbackEngine();
    let blocked = false;
    const loopback = new Proxy(loopbackTarget, {
      get(target, property, receiver) {
        if (property !== "sendRequest") {
          return Reflect.get(target, property, receiver);
        }
        return async (request: Request) => {
          if (!blocked && request.method === VERSIONED_METHOD.textWrite) {
            blocked = true;
            entered.resolve();
            await release.promise;
          }
          return target.sendRequest(request);
        };
      },
    });
    const engine = createWorkspaceEngineCapture({
      workspaceId: "workspace-a",
      rootPath: root,
      rustEngineSessions: mockLiveSessions(loopback),
    });
    await writeFile(join(root, "queue-blocker.txt"), "block\n", "utf8");
    engine.captureBatch([{ path: "queue-blocker.txt", operation: "update" }]);
    await entered.promise;

    const registry = createPluginPanelSdkAuthorityRegistry();
    const grant = registry.register({
      senderId: 1,
      generation: 1,
      workspaceId: "workspace-a",
      pluginId: "hello-plugin",
      panelId: "main",
    });
    const spawned: SpawnTransportParams[] = [];
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: (callbacks) => {
        spawned.push(callbacks);
        return {
          request: async <T,>(method: string) =>
            (method === PLUGIN_HOST_METHODS.activate
              ? { commands: [] }
              : {}) as T,
          notify: () => undefined,
          dispose: async () => undefined,
        };
      },
      routeSdkRequest: defaultRouter,
      onStatusChange: (pluginId, status) =>
        revokePluginPanelAuthoritiesForStatus({
          workspaceId: "workspace-a",
          pluginId,
          status,
          panels: [
            {
              workspaceId: "workspace-a",
              pluginId: "hello-plugin",
              panelId: "main",
            },
          ],
          revokePanel: registry.revokePanel,
        }),
    });
    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Plugin did not become ready.",
    );
    const spawnId = host.getSpawnId("hello-plugin");
    if (!spawnId) throw new Error("Plugin did not expose its spawn id.");

    const pending = invokePluginSdkHost(
      {
        pluginId: "hello-plugin",
        workspaceRoot: root,
        spawnId,
        requestPath: "panel",
        isWritable: () => true,
        writeAvailable: async () => true,
        signal: grant.signal,
        writeAuthoredText: (path, text, options) => {
          writeQueued.resolve();
          return engine
            .writeAuthoredTextFile(
              join(root, path),
              text,
              options.author,
              { signal: grant.signal },
            )
            .then(() => ({ path }));
        },
      },
      "files.write",
      { path: "cancelled.txt", text: "must not land\n" },
    );
    await writeQueued.promise;
    spawned[0]?.onExit({ code: 1, signal: null });
    await waitFor(
      () => spawned.length === 2,
      "Plugin did not respawn after the crash.",
    );
    await delay(0);
    release.resolve();

    await expect(pending).rejects.toThrow("Plugin panel is no longer active.");
    expect(grant.signal.aborted).toBe(true);
    expect(existsSync(join(root, "cancelled.txt"))).toBe(false);
    await engine.stop();
  });

  it("aborts a queued panel write when its plugin is disabled (#779 round 12 A4)", async () => {
    const root = await workspaceRoot();
    const entered = deferredVoid();
    const release = deferredVoid();
    const writeQueued = deferredVoid();
    const loopbackTarget = new VersionedLoopbackEngine();
    let blocked = false;
    const loopback = new Proxy(loopbackTarget, {
      get(target, property, receiver) {
        if (property !== "sendRequest") {
          return Reflect.get(target, property, receiver);
        }
        return async (request: Request) => {
          if (!blocked && request.method === VERSIONED_METHOD.textWrite) {
            blocked = true;
            entered.resolve();
            await release.promise;
          }
          return target.sendRequest(request);
        };
      },
    });
    const engine = createWorkspaceEngineCapture({
      workspaceId: "workspace-a",
      rootPath: root,
      rustEngineSessions: mockLiveSessions(loopback),
    });
    await writeFile(join(root, "queue-blocker.txt"), "block\n", "utf8");
    engine.captureBatch([{ path: "queue-blocker.txt", operation: "update" }]);
    await entered.promise;

    const registry = createPluginPanelSdkAuthorityRegistry();
    const grant = registry.register({
      senderId: 1,
      generation: 1,
      workspaceId: "workspace-a",
      pluginId: "hello-plugin",
      panelId: "main",
    });
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: () => ({
        request: async <T,>(method: string) =>
          (method === PLUGIN_HOST_METHODS.activate
            ? { commands: [] }
            : {}) as T,
        notify: () => undefined,
        dispose: async () => undefined,
      }),
      routeSdkRequest: defaultRouter,
    });
    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Plugin did not become ready.",
    );
    const spawnId = host.getSpawnId("hello-plugin");
    if (!spawnId) throw new Error("Plugin did not expose its spawn id.");

    const pending = invokePluginSdkHost(
      {
        pluginId: "hello-plugin",
        workspaceRoot: root,
        spawnId,
        requestPath: "panel",
        isWritable: () => true,
        writeAvailable: async () => true,
        signal: grant.signal,
        writeAuthoredText: (path, text, options) => {
          writeQueued.resolve();
          return engine
            .writeAuthoredTextFile(
              join(root, path),
              text,
              options.author,
              { signal: grant.signal },
            )
            .then(() => ({ path }));
        },
      },
      "files.write",
      { path: "disabled.txt", text: "must not land\n" },
    );
    await writeQueued.promise;

    // What the disable action site does before it stops the plugin. Stopping
    // the process alone leaves this queued write holding a live authority.
    revokePluginPanelAuthorities({
      workspaceId: "workspace-a",
      pluginId: "hello-plugin",
      panels: [
        {
          workspaceId: "workspace-a",
          pluginId: "hello-plugin",
          panelId: "main",
        },
      ],
      revokePanel: registry.revokePanel,
    });
    await host.stop("hello-plugin");
    release.resolve();

    await expect(pending).rejects.toThrow("Plugin panel is no longer active.");
    expect(grant.signal.aborted).toBe(true);
    expect(existsSync(join(root, "disabled.txt"))).toBe(false);
    await engine.stop();
  });

  it("rejects a tracked panel grant after its underlying host stops", async () => {
    const root = await workspaceRoot();
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: () => ({
        request: async <T,>(method: string) =>
          (method === PLUGIN_HOST_METHODS.activate ? { commands: [] } : {}) as T,
        notify: () => undefined,
        dispose: async () => undefined,
      }),
      routeSdkRequest: defaultRouter,
    });
    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Plugin did not become ready.",
    );
    const registry = createPluginPanelSdkAuthorityRegistry();
    const grant = registry.register({
      senderId: 1,
      generation: 1,
      workspaceId: "workspace-a",
      pluginId: "hello-plugin",
      panelId: "main",
    });

    await host.stop("hello-plugin");
    const liveSpawnId = host.getSpawnId("hello-plugin");
    expect(liveSpawnId).toBeUndefined();
    expect(() =>
      registry.authorize({
        senderId: 1,
        generation: 1,
        activeWorkspaceId: "workspace-a",
        workspaceId: "workspace-a",
        pluginId: "hello-plugin",
        panelId: "main",
        panelRunning: Boolean(liveSpawnId),
        liveSpawnId,
      }),
    ).toThrow(/stale/i);
    expect(grant.signal.aborted).toBe(true);
  });

  it("sequences different panels against one plugin host", async () => {
    const root = await workspaceRoot();
    const stopEntered = deferredVoid();
    const releaseStop = deferredVoid();
    let spawnCount = 0;
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: () => {
        spawnCount += 1;
        const thisSpawn = spawnCount;
        return {
          request: async <T,>(method: string) => {
            if (
              thisSpawn === 1 &&
              method === PLUGIN_HOST_METHODS.deactivate
            ) {
              stopEntered.resolve();
              await releaseStop.promise;
            }
            return (method === PLUGIN_HOST_METHODS.activate
              ? { commands: [] }
              : {}) as T;
          },
          notify: () => undefined,
          dispose: async () => undefined,
        };
      },
      routeSdkRequest: defaultRouter,
    });
    const manifest = await fixtureManifest();
    await host.start(helloPluginRoot, manifest);
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Plugin did not become ready.",
    );

    const panelLocks = new Map<string, Promise<void>>();
    const pluginLocks = new Map<string, Promise<void>>();
    const lock = (locks: Map<string, Promise<void>>) =>
      async <T>(key: string, operation: () => Promise<T>) => {
        const previous = locks.get(key) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
          release = resolve;
        });
        const queued = previous.catch(() => undefined).then(() => current);
        locks.set(key, queued);
        await previous.catch(() => undefined);
        try {
          return await operation();
        } finally {
          release();
          if (locks.get(key) === queued) locks.delete(key);
        }
      };
    const withPanelLock = lock(panelLocks);
    const withPluginLock = lock(pluginLocks);
    const panels = new Set(["panel-a"]);

    const stop = stopPluginPanelWithLock(
      "workspace-a\0hello-plugin\0panel-a",
      "workspace-a\0hello-plugin",
      withPanelLock,
      withPluginLock,
      async () => {
        panels.delete("panel-a");
        await host.stop("hello-plugin");
      },
    );
    await stopEntered.promise;
    const start = startPluginPanelWithLock(
      "workspace-a\0hello-plugin\0panel-b",
      "workspace-a\0hello-plugin",
      withPanelLock,
      withPluginLock,
      async () => {
        if (!host.getSpawnId("hello-plugin")) {
          await host.start(helloPluginRoot, manifest);
        }
        return host;
      },
      async () => {
        panels.add("panel-b");
      },
    );
    expect(spawnCount).toBe(1);
    expect(panels).toEqual(new Set());

    releaseStop.resolve();
    await Promise.all([stop, start]);

    expect(spawnCount).toBe(2);
    expect(host.getSpawnId("hello-plugin")).toBeTruthy();
    expect(panels).toEqual(new Set(["panel-b"]));
  });

  it("cleanly stops the respawned plugin when a status listener reacts to a crash", async () => {
    // onStatusChange is always deferred (queueMicrotask), so a listener can
    // no longer preempt the crash-loop's own immediate-respawn decision —
    // that decision finishes synchronously before any listener even learns
    // the plugin crashed. What a listener CAN still do is call stop()
    // afterward, and that must land cleanly on whatever is current then
    // (the respawned instance), not on stale state and not orphan anything.
    const root = await workspaceRoot();
    const deactivateRequests: string[] = [];
    let disposeCount = 0;
    let triggerExit: (() => void) | undefined;
    const spawnTransport = vi.fn<PluginHostOptions["spawnTransport"]>(
      (params) => {
        triggerExit = () => params.onExit({ code: 1, signal: null });
        // Idempotent, like the real JsonRpcTransport.dispose() — this spawn's
        // in-flight activation and its own shutdown() can each independently
        // decide to dispose once the plugin is stopping; only one of those
        // calls should count as the transport actually being torn down.
        let disposed = false;
        return {
          request<T = unknown>(method: string): Promise<T> {
            if (method === PLUGIN_HOST_METHODS.deactivate) {
              deactivateRequests.push(params.pluginId);
            }
            const result = method === PLUGIN_HOST_METHODS.activate
              ? { commands: [] }
              : {};
            return Promise.resolve(result as T);
          },
          notify: () => undefined,
          dispose: () => {
            if (!disposed) {
              disposed = true;
              disposeCount += 1;
            }
            return Promise.resolve();
          },
        };
      },
    );
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport,
      routeSdkRequest: defaultRouter,
      onStatusChange: (pluginId, status) => {
        if (status === "crashed") void host.stop(pluginId);
      },
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Plugin did not become ready.",
    );
    expect(spawnTransport).toHaveBeenCalledTimes(1);

    triggerExit?.();
    await waitFor(
      () => spawnTransport.mock.calls.length >= 2,
      "The crash's own immediate respawn did not happen.",
    );
    await delay(50);

    expect(spawnTransport).toHaveBeenCalledTimes(2);
    expect(deactivateRequests).toEqual(["hello-plugin"]);
    expect(disposeCount).toBe(1);
    expect(host.getStatus("hello-plugin")).toBeUndefined();
  });

  it("does not orphan a transport when a status listener stops on \"starting\"", async () => {
    // Same structural guarantee from the other side: by the time any
    // listener's deferred callback sees "starting", spawn() has already
    // finished creating the transport and sending plugin.activate — so
    // stop() (called from the listener) always has a real transport to
    // dispose through the normal shutdown path. Nothing is left to the
    // 30s activation deadline to eventually clean up.
    const root = await workspaceRoot();
    const harness = createProcessHarness();
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      activationTimeoutMs: PLUGIN_ACTIVATION_TIMEOUT_MS,
      onStatusChange: (pluginId, status) => {
        if (status === "starting") void host.stop(pluginId);
      },
    });
    const startedAt = Date.now();

    await host.start(helloPluginRoot, await fixtureManifest());
    // disposedPluginIds only proves shutdown() STARTED disposing — the real
    // process kill it awaits can still be in flight. Wait for the record to
    // actually be gone, which only happens once shutdown() fully completes.
    await waitFor(
      () => host.getStatus("hello-plugin") === undefined,
      "Plugin was not fully stopped after a listener stopped it on \"starting\".",
    );

    expect(harness.disposedPluginIds).toContain("hello-plugin");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(harness.spawnedPluginIds).toEqual(["hello-plugin"]);
    expect(host.getStatus("hello-plugin")).toBeUndefined();
  });

  it("rejects invokeCommand while the plugin is stopping and sends nothing", async () => {
    const root = await workspaceRoot();
    let invokeCommandCalls = 0;
    const spawnTransport = vi.fn<PluginHostOptions["spawnTransport"]>(() => ({
      request<T = unknown>(method: string): Promise<T> {
        if (method === PLUGIN_HOST_METHODS.invokeCommand) invokeCommandCalls += 1;
        const result = method === PLUGIN_HOST_METHODS.activate
          ? { commands: [] }
          : {};
        return Promise.resolve(result as T);
      },
      notify: () => undefined,
      dispose: () => Promise.resolve(),
    }));
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport,
      routeSdkRequest: defaultRouter,
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Plugin did not become ready.",
    );

    const stop = host.stop("hello-plugin");
    await expect(
      host.invokeCommand("hello-plugin", "hello.write"),
    ).rejects.toThrow('Plugin "hello-plugin" is stopping.');
    await stop;

    expect(invokeCommandCalls).toBe(0);
  });

  it("keeps one plugin ready while another plugin crash-loops", async () => {
    const root = await workspaceRoot();
    const statuses: Array<{ pluginId: string; status: PluginRuntimeStatus }> = [];
    const harness = createProcessHarness({
      modes: {
        "broken-plugin": "crash-immediately",
        "healthy-plugin": "hello",
      },
    });
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      onStatusChange: (pluginId, status) => statuses.push({ pluginId, status }),
    });
    const manifest = await fixtureManifest();

    await Promise.all([
      host.start(helloPluginRoot, { ...manifest, name: "broken-plugin" }),
      host.start(helloPluginRoot, { ...manifest, name: "healthy-plugin" }),
    ]);
    await waitFor(
      () => host.getStatus("healthy-plugin") === "ready",
      "Healthy plugin did not become ready.",
    );
    await waitFor(
      () => host.getStatus("broken-plugin") === "disabled",
      "Broken plugin did not finish its crash loop.",
      10_000,
    );
    await delay(300);

    const healthyStatuses = statuses
      .filter(({ pluginId }) => pluginId === "healthy-plugin")
      .map(({ status }) => status);
    const readyIndex = healthyStatuses.indexOf("ready");
    expect(readyIndex).toBeGreaterThanOrEqual(0);
    expect(healthyStatuses.slice(readyIndex)).toEqual(["ready"]);
    expect(host.getStatus("healthy-plugin")).toBe("ready");
    expect(
      harness.spawnedPluginIds.filter((id) => id === "broken-plugin"),
    ).toHaveLength(3);
  }, 15_000);

  it("does not become ready when stopped during activation", async () => {
    const root = await workspaceRoot();
    const statuses: PluginRuntimeStatus[] = [];
    const harness = createProcessHarness({
      modes: { "hello-plugin": "slow-hello" },
      waitForActivationBeforeDeactivate: true,
    });
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      onStatusChange: (_pluginId, status) => statuses.push(status),
      activationTimeoutMs: 5_000,
    });

    const start = host.start(
      helloPluginRoot,
      await fixtureManifest(),
    );
    await waitFor(
      () => harness.spawnedPluginIds.includes("hello-plugin"),
      "Slow plugin process did not spawn.",
    );
    expect(statuses).not.toContain("ready");

    const stop = host.stop("hello-plugin");
    await waitFor(
      () => harness.activationResolvedPluginIds.includes("hello-plugin"),
      "Slow plugin activation did not resolve while stop was pending.",
    );
    await Promise.all([start, stop]);

    expect(statuses).not.toContain("ready");
    expect(host.getStatus("hello-plugin")).toBeUndefined();
  });

  it("shares one shutdown between concurrent stop calls", async () => {
    const root = await workspaceRoot();
    const harness = createProcessHarness();
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Plugin did not become ready.",
    );

    const firstStop = host.stop("hello-plugin");
    const secondStop = host.stop("hello-plugin");
    await Promise.all([firstStop, secondStop]);

    expect(harness.deactivateRequestCount).toBe(1);
  });

  it("does not respawn when a crash races a stop in failure accounting", async () => {
    const root = await workspaceRoot();
    const harness = createProcessHarness({
      modes: { "hello-plugin": "crash-after-activate" },
    });
    let host: PluginHost;
    let nowCalls = 0;
    let stopDuringAccounting: Promise<void> | undefined;
    host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      now: () => {
        nowCalls += 1;
        if (nowCalls === 2) {
          stopDuringAccounting = host.stop("hello-plugin");
        }
        return nowCalls;
      },
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Plugin did not become ready before the crash.",
    );

    void host.invokeCommand("hello-plugin", "hello.write").catch(() => undefined);
    await waitFor(
      () => stopDuringAccounting !== undefined,
      "Plugin crash did not reach failure accounting.",
    );
    await stopDuringAccounting;
    await delay(100);

    expect(harness.spawnedPluginIds).toEqual(["hello-plugin"]);
    expect(host.getStatus("hello-plugin")).toBeUndefined();
  });

  it("stops the plugin process and its heartbeat descendant", async () => {
    const root = await workspaceRoot();
    const harness = createProcessHarness({
      modes: { "hello-plugin": "grandchild-heartbeat" },
    });
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
    });
    const heartbeatPath = join(root, "grandchild-heartbeat.txt");

    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Heartbeat plugin did not become ready.",
    );
    await delay(500);
    const firstSize = (await stat(heartbeatPath)).size;
    await delay(300);
    const secondSize = (await stat(heartbeatPath)).size;
    expect(secondSize).toBeGreaterThan(firstSize);

    await host.stop("hello-plugin");
    await delay(500);
    const settledSize = (await stat(heartbeatPath)).size;
    await delay(500);
    expect((await stat(heartbeatPath)).size).toBe(settledSize);
  }, 15_000);

  it("discards an activation result from an older host generation", async () => {
    const root = await workspaceRoot();
    const statuses: PluginRuntimeStatus[] = [];
    const harness = createProcessHarness({
      modes: { "hello-plugin": "slow-hello" },
    });
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      onStatusChange: (_pluginId, status) => statuses.push(status),
      activationTimeoutMs: 2_000,
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    host.bumpGeneration();
    await waitFor(
      () => harness.disposedPluginIds.includes("hello-plugin"),
      "Discarded plugin transport was not disposed.",
    );

    expect(statuses).not.toContain("ready");
    expect(host.getStatus("hello-plugin")).toBe("starting");
  });

  it("disposes an activation failure from an older host generation", async () => {
    const root = await workspaceRoot();
    const statuses: PluginRuntimeStatus[] = [];
    const harness = createProcessHarness({
      modes: { "hello-plugin": "throws" },
    });
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      onStatusChange: (_pluginId, status) => statuses.push(status),
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    host.bumpGeneration();
    await waitFor(
      () => harness.disposedPluginIds.includes("hello-plugin"),
      "Discarded failed plugin transport was not disposed.",
    );

    expect(statuses).not.toContain("failed");
    expect(host.getStatus("hello-plugin")).toBe("starting");
  });

  it("does not hang when a child exits during an sdk.request", async () => {
    // No generation bump here: one fast failure must recover even while the
    // dead child's sdk.request handler remains pending.
    const root = await workspaceRoot();
    const harness = createProcessHarness({
      modes: { "hello-plugin": "crash-after-activate" },
    });
    const routeSdkRequest = vi.fn(
      () => new Promise<never>(() => undefined),
    );
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest,
    });

    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Plugin did not become ready.",
    );

    // Fires the command that sends the request and immediately exits the
    // child — the child dies before it can answer this call, so it is left
    // to settle on its own; the point of this test is what happens next.
    void host.invokeCommand("hello-plugin", "hello.write").catch(() => undefined);
    await waitFor(
      () => routeSdkRequest.mock.calls.length > 0,
      "Fixture did not send its sdk.request.",
    );
    // "crashed" can be transient (the immediate respawn moves the status on
    // in the same synchronous chain) — wait on the real process exit event
    // instead of a status value that may never be observed by a poll.
    await waitFor(
      () => harness.exitedPluginIds.includes("hello-plugin"),
      "Plugin host did not report the child exit.",
    );
    await waitFor(
      () =>
        harness.spawnedPluginIds.length === 2 &&
        host.getStatus("hello-plugin") === "ready",
      "Plugin did not recover after the child exit.",
    );

    await host.stop("hello-plugin");

    expect(host.getStatus("hello-plugin")).toBeUndefined();
  });

  it("logs, instead of leaving unhandled, a spawn teardown rejection (CodeRabbit #779 R13)", async () => {
    // Calling bumpGeneration() immediately, ahead of the harness's own
    // async activation callback, exercises both of R13's discarded-promise
    // call sites in one pass: bumpGeneration's own endSpawn call, and
    // handleActivationSuccess's not-live branch once that generation bump
    // makes the in-flight activation stale. Vitest reports an unhandled
    // rejection separately from any expect() failure, so this only stays
    // clean when both sites attach their own .catch().
    const root = await workspaceRoot();
    const harness = createCallbackHarness();
    const teardownError = new Error("synthetic teardown failure (R13 PoC)");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      onSpawnEnd: async () => {
        throw teardownError;
      },
    });

    try {
      await host.start(helloPluginRoot, await fixtureManifest());
      harness.getCallbacks();

      host.bumpGeneration();
      await delay(20);

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("spawn teardown failed"),
        teardownError,
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("PluginHost web apps", () => {
  async function webAppManifest(): Promise<DohcPluginManifest> {
    return {
      ...(await fixtureManifest()),
      webApps: [{ id: "main-app", title: "Hello App" }],
    };
  }

  async function startWebAppHost(options: {
    mode: string;
    webAppStartTimeoutMs?: number;
  }): Promise<PluginHost> {
    const root = await workspaceRoot();
    const harness = createProcessHarness({
      modes: { "hello-plugin": options.mode },
    });
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      webAppStartTimeoutMs: options.webAppStartTimeoutMs,
    });
    await host.start(helloPluginRoot, await webAppManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Plugin did not become ready.",
    );
    return host;
  }

  it("routes startWebApp through the real plugin process and returns its URL in memory", async () => {
    const host = await startWebAppHost({ mode: "web-app" });
    await expect(host.startWebApp("hello-plugin", "main-app")).resolves.toEqual({
      url: "http://127.0.0.1:43210/pair#token=fixture-main-app",
    });
  });

  it("refuses a web app the manifest does not declare", async () => {
    const host = await startWebAppHost({ mode: "web-app" });
    await expect(host.startWebApp("hello-plugin", "other")).rejects.toThrow(
      'does not declare web app "other"',
    );
  });

  it("reports a handler that does not implement startWebApp", async () => {
    const host = await startWebAppHost({ mode: "hello" });
    await expect(host.startWebApp("hello-plugin", "main-app")).rejects.toThrow(
      "does not implement startWebApp",
    );
  });

  it("rejects an empty url from the plugin", async () => {
    const host = await startWebAppHost({ mode: "web-app-bad-result" });
    await expect(host.startWebApp("hello-plugin", "main-app")).rejects.toThrow(
      "non-empty string url",
    );
  });

  it("bounds a hung web app start with an error naming the limit", async () => {
    const host = await startWebAppHost({
      mode: "web-app-hang",
      webAppStartTimeoutMs: 200,
    });
    await expect(host.startWebApp("hello-plugin", "main-app")).rejects.toThrow(
      "did not start within 200 ms",
    );
  });

  it("refuses when the plugin is not running", async () => {
    const root = await workspaceRoot();
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: createProcessHarness().spawnTransport,
      routeSdkRequest: defaultRouter,
    });
    await expect(host.startWebApp("hello-plugin", "main-app")).rejects.toThrow(
      'Plugin "hello-plugin" is not running.',
    );
  });

  it("carries a stop to the plugin, so the next start pairs again", async () => {
    const host = await startWebAppHost({ mode: "web-app-pairing" });
    const first = await host.startWebApp("hello-plugin", "main-app");
    expect(first.url).toBe("http://127.0.0.1:43210/pair#token=fixture-1");
    // Paired: a second start rides the session the first one established.
    await expect(host.startWebApp("hello-plugin", "main-app")).resolves.toEqual({
      url: "http://127.0.0.1:43210/?app=main-app",
    });

    await host.stopWebApp("hello-plugin", "main-app");

    // MUTATION (drop the protocol stop dispatch, or the host method): the
    // plugin never learns the guest is gone, so this start returns the paired
    // URL into a guest with no session — the workspace-started host's whole
    // failure mode.
    await expect(host.startWebApp("hello-plugin", "main-app")).resolves.toEqual({
      url: "http://127.0.0.1:43210/pair#token=fixture-2",
    });
  });

  it("reports a handler that implements startWebApp without stopWebApp", async () => {
    const host = await startWebAppHost({ mode: "web-app" });
    await expect(host.stopWebApp("hello-plugin", "main-app")).rejects.toThrow(
      "does not implement stopWebApp",
    );
  });

  it("refuses to stop a web app the manifest does not declare", async () => {
    const host = await startWebAppHost({ mode: "web-app-pairing" });
    await expect(host.stopWebApp("hello-plugin", "other")).rejects.toThrow(
      'does not declare web app "other"',
    );
  });

  it("has nothing to unpair when the plugin is not running", async () => {
    const root = await workspaceRoot();
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: createProcessHarness().spawnTransport,
      routeSdkRequest: defaultRouter,
    });
    // The broker takes a wrapper's whole process tree down with its spawn, so
    // a dead plugin's server and session are already gone. The recovery must
    // not turn that into a failure it reports.
    await expect(
      host.stopWebApp("hello-plugin", "main-app"),
    ).resolves.toBeUndefined();
  });

  it("hands every activation the same durable state root uninstall deletes", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();
    const harness = createProcessHarness({
      modes: { "hello-plugin": "report-context" },
    });
    const host = trackHost({
      stateDir: localStateDir,
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
    });
    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Plugin did not become ready.",
    );

    const reported = await host.invokeCommand(
      "hello-plugin",
      "report.context",
    ) as { stateRoot: string; workspaceRoot: string };
    expect(reported.workspaceRoot).toBe(root);
    expect(reported.stateRoot).toBe(
      pluginStateRoot(pluginDataDir(localStateDir, root), "hello-plugin"),
    );
  });

  it("gives a plugin its settings at activation and tells it about every change", async () => {
    const root = await workspaceRoot();
    const localStateDir = await stateDir();
    const harness = createProcessHarness({
      modes: { "hello-plugin": "report-settings" },
    });
    const host = trackHost({
      stateDir: localStateDir,
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      readPluginSettings: async () => ({ greeting: "Hei", shout: false }),
    });
    await host.start(helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Plugin did not become ready.",
    );

    type Report = {
      atActivation: Record<string, unknown>;
      current: Record<string, unknown>;
      heard: Record<string, unknown> | null;
      changeCount: number;
    };

    // The plugin never asked for these: they arrived with its activation.
    const started = await host.invokeCommand(
      "hello-plugin",
      "report.settings",
    ) as Report;
    expect(started.atActivation).toEqual({ greeting: "Hei", shout: false });
    expect(started.current).toEqual({ greeting: "Hei", shout: false });
    expect(started.heard).toBeNull();
    expect(started.changeCount).toBe(0);

    await host.notifySettingsChanged("hello-plugin", {
      greeting: "Hello",
      shout: true,
    });

    const changed = await host.invokeCommand(
      "hello-plugin",
      "report.settings",
    ) as Report;
    // Both halves of the SDK surface: the listener fired, and the snapshot
    // getter now answers with the new values rather than the old ones.
    expect(changed.heard).toEqual({ greeting: "Hello", shout: true });
    expect(changed.current).toEqual({ greeting: "Hello", shout: true });
    expect(changed.changeCount).toBe(1);
    // The values it activated with are still what they were.
    expect(changed.atActivation).toEqual({ greeting: "Hei", shout: false });
  });

  it("does not push settings at a plugin that is not running", async () => {
    const root = await workspaceRoot();
    const harness = createProcessHarness({
      modes: { "hello-plugin": "report-settings" },
    });
    const host = trackHost({
      stateDir: await stateDir(),
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
    });

    // Never started: a plugin with no process reads its settings from its next
    // activation, so this must resolve quietly rather than throw or hang.
    await expect(
      host.notifySettingsChanged("hello-plugin", { greeting: "Hello" }),
    ).resolves.toBeUndefined();
  });
});
