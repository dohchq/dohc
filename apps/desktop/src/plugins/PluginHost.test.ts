import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DohcPluginManifest } from "@dohc/workspace-contracts/plugin-manifest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonRpcTransport } from "../agents/JsonRpcTransport";
import { createTestScratch } from "../workspaces/testTemp";
import { PluginHost, type PluginHostOptions } from "./PluginHost";
import { readPluginLocalState, setPluginDisabled } from "./pluginLocalState";
import { readPluginManifestFile } from "./pluginManifest";
import type { PluginRuntimeStatus } from "./pluginHostProtocol";

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

async function fixtureManifest(): Promise<DohcPluginManifest> {
  const result = await readPluginManifestFile(helloPluginRoot);
  if (!result.ok) throw new Error(result.diagnostics.join("; "));
  return result.manifest;
}

interface ProcessHarness {
  spawnTransport: PluginHostOptions["spawnTransport"];
  spawnedPluginIds: string[];
  disposedPluginIds: string[];
  exitedPluginIds: string[];
}

function createProcessHarness(options: {
  modes?: Record<string, string>;
  triggers?: Record<string, string>;
} = {}): ProcessHarness {
  const spawnedPluginIds: string[] = [];
  const disposedPluginIds: string[] = [];
  const exitedPluginIds: string[] = [];
  const spawnTransport = vi.fn<PluginHostOptions["spawnTransport"]>((params) => {
    spawnedPluginIds.push(params.pluginId);
    const env: Record<string, string | undefined> = {
      DOHC_PLUGIN_FIXTURE_MODE: options.modes?.[params.pluginId] ?? "hello",
    };
    const trigger = options.triggers?.[params.pluginId];
    if (trigger) env.DOHC_PLUGIN_FIXTURE_TRIGGER_COMMAND = trigger;

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

    return {
      request<T = unknown>(method: string, rpcParams?: unknown): Promise<T> {
        return transport.request<T>(method, rpcParams);
      },
      notify(method, rpcParams) {
        transport.notify(method, rpcParams);
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
      workspaceId: "workspace-1",
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
    });

    await host.start("hello-plugin", helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "ready",
      "Plugin did not become ready.",
    );

    expect(host.getRegisteredCommands("hello-plugin")).toEqual(["hello.write"]);
  });

  it("does not spawn a durably disabled plugin", async () => {
    const root = await workspaceRoot();
    await setPluginDisabled(root, "hello-plugin", true);
    const spawnTransport = vi.fn<PluginHostOptions["spawnTransport"]>(() => {
      throw new Error("Disabled plugin was spawned.");
    });
    const host = trackHost({
      workspaceId: "workspace-1",
      workspaceRoot: root,
      spawnTransport,
      routeSdkRequest: defaultRouter,
    });

    await expect(
      host.start("hello-plugin", helloPluginRoot, await fixtureManifest()),
    ).rejects.toThrow(
      'Plugin "hello-plugin" is disabled. Re-enable it in plugin settings.',
    );
    expect(spawnTransport).not.toHaveBeenCalled();
  });

  it("reports and disposes an activation failure", async () => {
    const root = await workspaceRoot();
    const statuses: PluginRuntimeStatus[] = [];
    const harness = createProcessHarness({
      modes: { "hello-plugin": "throws" },
    });
    const host = trackHost({
      workspaceId: "workspace-1",
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      onStatusChange: (_pluginId, status) => statuses.push(status),
    });

    await host.start("hello-plugin", helloPluginRoot, await fixtureManifest());
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

  it("lets a healthy activation finish before a short test deadline", async () => {
    const root = await workspaceRoot();
    const harness = createProcessHarness();
    const host = trackHost({
      workspaceId: "workspace-1",
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      activationTimeoutMs: 1_000,
    });
    const startedAt = Date.now();

    await host.start("hello-plugin", helloPluginRoot, await fixtureManifest());
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
      workspaceId: "workspace-1",
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      onStatusChange: (_pluginId, status) => statuses.push(status),
      activationTimeoutMs: 200,
    });
    const startedAt = Date.now();

    await host.start("hello-plugin", helloPluginRoot, await fixtureManifest());
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
    const harness = createProcessHarness({
      modes: { "hello-plugin": "crash-immediately" },
    });
    const host = trackHost({
      workspaceId: "workspace-1",
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
    });

    await host.start("hello-plugin", helloPluginRoot, await fixtureManifest());
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
    expect(
      (await readPluginLocalState(root)).state.plugins["hello-plugin"]?.disabled,
    ).toBe(true);
    await delay(300);
    expect(harness.spawnedPluginIds).toHaveLength(3);
  }, 15_000);

  it("disables a plugin after three activation timeouts", async () => {
    const root = await workspaceRoot();
    const harness = createProcessHarness({
      modes: { "hello-plugin": "never-resolves" },
    });
    const host = trackHost({
      workspaceId: "workspace-1",
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      activationTimeoutMs: 150,
    });

    await host.start("hello-plugin", helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => host.getStatus("hello-plugin") === "disabled",
      "Timeout loop did not disable the plugin.",
      10_000,
    );

    expect(harness.spawnedPluginIds).toHaveLength(3);
    expect(
      (await readPluginLocalState(root)).state.plugins["hello-plugin"]?.disabled,
    ).toBe(true);
  }, 15_000);

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
      workspaceId: "workspace-1",
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      onStatusChange: (pluginId, status) => statuses.push({ pluginId, status }),
    });
    const manifest = await fixtureManifest();

    await Promise.all([
      host.start("broken-plugin", helloPluginRoot, manifest),
      host.start("healthy-plugin", helloPluginRoot, manifest),
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

  it("stops the plugin process and its heartbeat descendant", async () => {
    const root = await workspaceRoot();
    const harness = createProcessHarness({
      modes: { "hello-plugin": "grandchild-heartbeat" },
    });
    const host = trackHost({
      workspaceId: "workspace-1",
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
    });
    const heartbeatPath = join(root, "grandchild-heartbeat.txt");

    await host.start("hello-plugin", helloPluginRoot, await fixtureManifest());
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
    const stoppedSize = (await stat(heartbeatPath)).size;
    await delay(500);
    expect((await stat(heartbeatPath)).size).toBe(stoppedSize);
  }, 15_000);

  it("discards an activation result from an older host generation", async () => {
    const root = await workspaceRoot();
    const statuses: PluginRuntimeStatus[] = [];
    const harness = createProcessHarness({
      modes: { "hello-plugin": "slow-hello" },
    });
    const host = trackHost({
      workspaceId: "workspace-1",
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest: defaultRouter,
      onStatusChange: (_pluginId, status) => statuses.push(status),
      activationTimeoutMs: 2_000,
    });

    await host.start("hello-plugin", helloPluginRoot, await fixtureManifest());
    host.bumpGeneration();
    await delay(500);

    expect(statuses).not.toContain("ready");
    expect(host.getStatus("hello-plugin")).toBe("starting");
  });

  it("does not hang when a child exits during an sdk.request", async () => {
    const root = await workspaceRoot();
    const harness = createProcessHarness({
      modes: { "hello-plugin": "crash-after-activate" },
      triggers: { "hello-plugin": "hello.write" },
    });
    const routeSdkRequest = vi.fn(
      () => new Promise<never>(() => undefined),
    );
    let host: PluginHost;
    host = trackHost({
      workspaceId: "workspace-1",
      workspaceRoot: root,
      spawnTransport: harness.spawnTransport,
      routeSdkRequest,
      onStatusChange: (_pluginId, status) => {
        if (status === "crashed") host.bumpGeneration();
      },
    });

    await host.start("hello-plugin", helloPluginRoot, await fixtureManifest());
    await waitFor(
      () => routeSdkRequest.mock.calls.length > 0,
      "Fixture did not send its sdk.request.",
    );
    await waitFor(
      () => host.getStatus("hello-plugin") === "crashed",
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
