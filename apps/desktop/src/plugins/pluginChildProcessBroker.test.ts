import { EventEmitter } from "node:events";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_CHILD_PROCESS_METHODS } from "@dohc/sdk/node";
import { createTestScratch } from "../workspaces/testTemp";
import { PluginHost, type PluginHostOptions } from "./PluginHost";
import {
  PluginChildProcessBroker,
  type PluginChildProcessBrokerContext,
  type PluginChildProcessForkOptions,
  type PluginChildProcessHandle,
  type PluginChildProcessOutput,
} from "./pluginChildProcessBroker";
import { PLUGIN_HOST_METHODS } from "./pluginHostProtocol";

const roots: string[] = [];

class FakeUtilityProcess extends EventEmitter implements PluginChildProcessHandle {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly postMessages: unknown[] = [];
  killCalls = 0;

  constructor(readonly pid: number) {
    super();
  }

  postMessage(message: unknown): void {
    this.postMessages.push(message);
  }

  kill(): boolean {
    this.killCalls += 1;
    queueMicrotask(() => this.emit("exit", 0));
    return true;
  }
}

interface BrokerFixture {
  root: string;
  broker: PluginChildProcessBroker;
  children: FakeUtilityProcess[];
  forks: Array<{
    modulePath: string;
    args: string[];
    options: PluginChildProcessForkOptions;
  }>;
  windowsTreeKills: number[];
}

async function createFixture(
  options: {
    platform?: NodeJS.Platform;
    killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): Promise<BrokerFixture> {
  const root = await createTestScratch("dohc-plugin-child-broker-");
  roots.push(root);
  // Stands in for PluginPipeline's userData-resident dohcDir directly (no
  // extra ".dohc" segment — CERT779: this test's root already plays the
  // role of that userData plugin-data directory).
  for (const safeId of ["plugin-a", "plugin-b"]) {
    const pluginRoot = join(root, "plugins", safeId);
    await mkdir(join(pluginRoot, "data"), { recursive: true });
    await writeFile(join(pluginRoot, "server.mjs"), "export {};\n");
  }
  const children: FakeUtilityProcess[] = [];
  const forks: BrokerFixture["forks"] = [];
  const windowsTreeKills: number[] = [];
  const broker = new PluginChildProcessBroker({
    dohcDir: root,
    platform: options.platform ?? "win32",
    forkProcess: (modulePath, args, forkOptions) => {
      const child = new FakeUtilityProcess(10_000 + children.length);
      children.push(child);
      forks.push({ modulePath, args, options: forkOptions });
      return child;
    },
    killWindowsTree: async (pid) => {
      windowsTreeKills.push(pid);
      return true;
    },
    killProcessGroup: options.killProcessGroup,
    stopGraceMs: 10,
    exitWaitMs: 50,
  });
  return { root, broker, children, forks, windowsTreeKills };
}

function context(
  pluginId: string,
  spawnId: string,
  controller = new AbortController(),
  events: Array<{
    subscriptionId: string;
    event: string;
    data: unknown;
  }> = [],
): PluginChildProcessBrokerContext {
  return {
    pluginId,
    spawnId,
    signal: controller.signal,
    emitEvent: (subscriptionId, event, data) => {
      events.push({ subscriptionId, event, data });
    },
  };
}

async function spawnChild(
  fixture: BrokerFixture,
  brokerContext: PluginChildProcessBrokerContext,
  input: Record<string, unknown> = { modulePath: "server.mjs" },
): Promise<string> {
  const result = await fixture.broker.invoke(
    brokerContext,
    PLUGIN_CHILD_PROCESS_METHODS.spawn,
    input,
  );
  if (
    typeof result !== "object" ||
    result === null ||
    !("childId" in result) ||
    typeof result.childId !== "string"
  ) {
    throw new Error("Broker returned an invalid test child id.");
  }
  return result.childId;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("PluginChildProcessBroker", () => {
  it("constructs contained utilityProcess argv, cwd, env, and stdio", async () => {
    const fixture = await createFixture();
    const brokerContext = context("plugin-a", "spawn-a");

    await spawnChild(fixture, brokerContext, {
      modulePath: "server.mjs",
      args: ["--port", "0"],
      cwd: "data",
      env: { PLUGIN_PORT: "0" },
    });

    expect(fixture.forks).toHaveLength(1);
    expect(fixture.forks[0]).toMatchObject({
      modulePath: resolve(
        fixture.root,
        "plugins",
        "plugin-a",
        "server.mjs",
      ),
      args: ["--port", "0"],
      options: {
        cwd: resolve(
          fixture.root,
          "plugins",
          "plugin-a",
          "data",
        ),
        env: expect.objectContaining({ PLUGIN_PORT: "0" }),
        serviceName: "dohc.plugin.plugin-a.child",
        stdio: ["ignore", "pipe", "pipe"],
      },
    });
  });

  it("refuses cwd and module paths that escape the plugin built directory", async () => {
    const fixture = await createFixture();
    const brokerContext = context("plugin-a", "spawn-a");

    await expect(
      spawnChild(fixture, brokerContext, {
        modulePath: "server.mjs",
        cwd: "../plugin-b",
      }),
    ).rejects.toThrow(
      `childProcesses.spawn cwd "../plugin-b" escapes plugin directory`,
    );
    await expect(
      spawnChild(fixture, brokerContext, { modulePath: "../plugin-b/server.mjs" }),
    ).rejects.toThrow(
      `childProcesses.spawn modulePath "../plugin-b/server.mjs" escapes plugin directory`,
    );
    expect(fixture.forks).toEqual([]);
  });

  it("refuses a cwd link that resolves outside the plugin built directory", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    await symlink(
      outside,
      join(fixture.root, "plugins", "plugin-a", "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      spawnChild(fixture, context("plugin-a", "spawn-a"), {
        modulePath: "server.mjs",
        cwd: "escape",
      }),
    ).rejects.toThrow(
      `childProcesses.spawn cwd "escape" resolves outside plugin directory`,
    );
    expect(fixture.forks).toEqual([]);
  });

  it("rejects an environment block above its configured entry limit", async () => {
    const fixture = await createFixture();
    const env = Object.fromEntries(
      Array.from({ length: 513 }, (_, index) => [`KEY_${index}`, "value"]),
    );

    await expect(
      spawnChild(fixture, context("plugin-a", "spawn-a"), {
        modulePath: "server.mjs",
        env,
      }),
    ).rejects.toThrow(
      "childProcesses.spawn env has 513 entries; the configured limit is 512 entries.",
    );
    expect(fixture.forks).toEqual([]);
  });

  it("captures and streams bounded stdout and stderr", async () => {
    const fixture = await createFixture();
    const events: Array<{
      subscriptionId: string;
      event: string;
      data: unknown;
    }> = [];
    const brokerContext = context("plugin-a", "spawn-a", undefined, events);
    const childId = await spawnChild(fixture, brokerContext);
    const subscribed = await fixture.broker.invoke(
      brokerContext,
      PLUGIN_CHILD_PROCESS_METHODS.subscribeOutput,
      { childId },
    );
    expect(subscribed).toMatchObject({ subscriptionId: expect.any(String) });

    fixture.children[0]?.stdout.write("first stdout\n");
    fixture.children[0]?.stderr.write("first stderr\n");
    for (let index = 0; index < 201; index += 1) {
      fixture.children[0]?.stdout.write(`line-${index}\n`);
    }

    const logs = await fixture.broker.invoke(
      brokerContext,
      PLUGIN_CHILD_PROCESS_METHODS.logs,
      { childId },
    );
    expect(Array.isArray(logs)).toBe(true);
    expect(logs).toHaveLength(200);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stream: "stdout", text: "line-200\n" }),
      ]),
    );
    expect(events.some(({ event }) => event === "stdout")).toBe(true);
    expect(events.some(({ event }) => event === "stderr")).toBe(true);
    expect(
      events.every(({ data }) => {
        const output = data as Partial<PluginChildProcessOutput>;
        return typeof output.sequence === "number" && typeof output.text === "string";
      }),
    ).toBe(true);
  });

  it("sends messages only to a child owned by the calling plugin spawn", async () => {
    const fixture = await createFixture();
    const pluginA = context("plugin-a", "spawn-a");
    const pluginB = context("plugin-b", "spawn-b");
    const childA = await spawnChild(fixture, pluginA);
    await spawnChild(fixture, pluginB);

    await fixture.broker.invoke(
      pluginA,
      PLUGIN_CHILD_PROCESS_METHODS.send,
      { childId: childA, message: { kind: "ping" } },
    );
    expect(fixture.children[0]?.postMessages).toEqual([{ kind: "ping" }]);
    expect(fixture.children[1]?.postMessages).toEqual([]);

    await expect(
      fixture.broker.invoke(
        pluginB,
        PLUGIN_CHILD_PROCESS_METHODS.terminate,
        { childId: childA },
      ),
    ).rejects.toThrow(
      `Plugin "plugin-b" spawn "spawn-b" cannot control child process`,
    );
    expect(fixture.children[0]?.killCalls).toBe(0);
  });

  it("awaits natural exit and terminates an owned child", async () => {
    const fixture = await createFixture();
    const brokerContext = context("plugin-a", "spawn-a");
    const naturalChildId = await spawnChild(fixture, brokerContext);
    const waited = fixture.broker.invoke(
      brokerContext,
      PLUGIN_CHILD_PROCESS_METHODS.wait,
      { childId: naturalChildId },
    );
    fixture.children[0]?.emit("exit", 7);
    await expect(waited).resolves.toEqual({ code: 7, reason: "exited" });

    const terminatedChildId = await spawnChild(fixture, brokerContext);
    await expect(
      fixture.broker.invoke(
        brokerContext,
        PLUGIN_CHILD_PROCESS_METHODS.terminate,
        { childId: terminatedChildId },
      ),
    ).resolves.toEqual({ code: 0, reason: "terminated" });
    expect(fixture.windowsTreeKills).toEqual([10_001]);
    expect(fixture.children[1]?.killCalls).toBe(1);
  });

  it("tears down only the aborted Windows plugin spawn", async () => {
    const fixture = await createFixture({ platform: "win32" });
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const pluginA = context("plugin-a", "spawn-a", controllerA);
    const pluginB = context("plugin-b", "spawn-b", controllerB);
    await spawnChild(fixture, pluginA);
    await spawnChild(fixture, pluginB);

    controllerA.abort();
    await fixture.broker.disposeSpawn("plugin-a", "spawn-a");

    expect(fixture.windowsTreeKills).toEqual([10_000]);
    expect(fixture.children[0]?.killCalls).toBe(1);
    expect(fixture.children[1]?.killCalls).toBe(0);
  });

  it("terminates the POSIX process group when a spawn aborts", async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let child: FakeUtilityProcess | undefined;
    const fixture = await createFixture({
      platform: "linux",
      killProcessGroup: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGTERM") queueMicrotask(() => child?.emit("exit", 0));
      },
    });
    const controller = new AbortController();
    const brokerContext = context("plugin-a", "spawn-a", controller);
    await spawnChild(fixture, brokerContext);
    child = fixture.children[0];

    controller.abort();
    await fixture.broker.disposeSpawn("plugin-a", "spawn-a");

    expect(signals).toEqual([{ pid: 10_000, signal: "SIGTERM" }]);
    expect(child?.killCalls).toBe(0);
    expect(fixture.windowsTreeKills).toEqual([]);
  });

  it("tears down every remaining plugin child on broker disposal", async () => {
    const fixture = await createFixture();
    await spawnChild(fixture, context("plugin-a", "spawn-a"));
    await spawnChild(fixture, context("plugin-b", "spawn-b"));

    await fixture.broker.dispose();

    expect(fixture.windowsTreeKills).toEqual([10_000, 10_001]);
    expect(fixture.children.map((child) => child.killCalls)).toEqual([1, 1]);
  });

  it("tears down every brokered child during PluginHost disposal", async () => {
    const fixture = await createFixture();
    let callbacks:
      | Parameters<PluginHostOptions["spawnTransport"]>[0]
      | undefined;
    const host = new PluginHost({
      stateDir: join(fixture.root, "state"),
      workspaceRoot: fixture.root,
      spawnTransport: (params) => {
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
      },
      routeSdkRequest: (
        pluginId,
        method,
        params,
        spawnId,
        signal,
        emitEvent,
      ) => fixture.broker.invoke(
        { pluginId, spawnId, signal, emitEvent },
        method,
        params,
      ),
      onSpawnEnd: (pluginId, spawnId) =>
        fixture.broker.disposeSpawn(pluginId, spawnId),
      onDispose: () => fixture.broker.dispose(),
    });

    try {
      const pluginRoot = join(fixture.root, "plugins", "plugin-a");
      await host.start(pluginRoot, {
        version: 1,
        name: "plugin-a",
        entry: "server.mjs",
      });
      if (!callbacks) throw new Error("Plugin transport did not spawn.");
      await callbacks.onRequest(PLUGIN_HOST_METHODS.sdkRequest, {
        method: PLUGIN_CHILD_PROCESS_METHODS.spawn,
        params: { modulePath: "server.mjs" },
      });

      await host.stopAll();

      expect(fixture.windowsTreeKills).toEqual([10_000]);
      expect(fixture.children[0]?.killCalls).toBe(1);
    } finally {
      await host.stopAll();
    }
  });
});
