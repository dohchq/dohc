import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DohcPluginManifest } from "./pluginManifestSchema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonRpcTransport } from "../agents/JsonRpcTransport";
import { createTestScratch } from "../workspaces/testTemp";
import { PluginHost, type PluginHostOptions } from "./PluginHost";
import {
  pluginStateFileName,
  readPluginLocalState,
  setPluginDisabled,
} from "./pluginLocalState";
import { readPluginManifestFile } from "./pluginManifest";
import { invokePluginSdkHost } from "./pluginSdkHost";
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

function trackHost(options: PluginHostOptions): PluginHost {
  const host = new PluginHost(options);
  hosts.push(host);
  return host;
}

function defaultRouter(): Promise<unknown> {
  return Promise.resolve({});
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
      routeSdkRequest: (pluginId, method, params, spawnId) =>
        invokePluginSdkHost(
          {
            pluginId,
            workspaceRoot: root,
            spawnId,
            writeAuthoredText: async (_workspaceRoot, path, text, options) => {
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
    await setPluginDisabled(localStateDir, root, "hello-plugin", true);
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
    // No generation bump here: onStatusChange is deferred, so a listener can
    // no longer race ahead of accountForFailure's own respawn decision the
    // way bumping the generation synchronously used to rely on. The crash's
    // own immediate respawn is now free to happen — correct policy for one
    // fast failure — and stop() must still not hang, on whichever spawn
    // (the crashed one or its respawn) happens to be current when it runs.
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

    await expect(
      Promise.race([
        host.stop("hello-plugin"),
        delay(2_000).then(() => {
          throw new Error("PluginHost stop hung after child exit.");
        }),
      ]),
    ).resolves.toBeUndefined();
  });
});
