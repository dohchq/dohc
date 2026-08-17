import { EventEmitter } from "node:events";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_CHILD_PROCESS_METHODS } from "@dohc/sdk/node";
import { createTestScratch } from "../workspaces/testTemp";
import { processTreePids } from "../process/posixSpawn";
import { PluginHost, type PluginHostOptions } from "./PluginHost";
import {
  EXITED_CHILD_RETENTION_LIMIT,
  MAX_CHILD_ENV_BYTES,
  MAX_MERGED_CHILD_ENV_CODE_UNITS,
  PluginChildProcessBroker,
  type PluginChildProcessBrokerContext,
  type PluginChildProcessForkOptions,
  type PluginChildProcessHandle,
  type PluginChildProcessOutput,
  type PluginCommandSpawnOptions,
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

/** A command child: no message channel, a writable standard input. */
class FakeCommandProcess extends EventEmitter implements PluginChildProcessHandle {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  killCalls = 0;

  constructor(readonly pid: number) {
    super();
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
  commandChildren: FakeCommandProcess[];
  forks: Array<{
    modulePath: string;
    args: string[];
    options: PluginChildProcessForkOptions;
  }>;
  commands: Array<{
    command: string;
    args: string[];
    options: PluginCommandSpawnOptions;
  }>;
  windowsTreeKills: number[];
}

async function createFixture(
  options: {
    platform?: NodeJS.Platform;
    /** Configures the broker with a link to the workspace root instead of the
     * root itself, so a resolved path and a canonical one differ. */
    linkedWorkspaceRoot?: boolean;
    killProcessTreePosix?: (
      pid: number,
      signal: NodeJS.Signals,
      alsoSignal: readonly number[],
    ) => Promise<readonly number[]> | readonly number[];
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
  const commandChildren: FakeCommandProcess[] = [];
  const forks: BrokerFixture["forks"] = [];
  const commands: BrokerFixture["commands"] = [];
  const windowsTreeKills: number[] = [];
  await mkdir(join(root, "workspace"), { recursive: true });
  if (options.linkedWorkspaceRoot) {
    await symlink(join(root, "workspace"), join(root, "workspace-link"), "junction");
  }
  const broker = new PluginChildProcessBroker({
    dohcDir: root,
    workspaceRoot: options.linkedWorkspaceRoot
      ? join(root, "workspace-link")
      : join(root, "workspace"),
    platform: options.platform ?? "win32",
    forkProcess: (modulePath, args, forkOptions, lifecycle) => {
      const child = new FakeUtilityProcess(10_000 + children.length);
      // The real fork wires these in the same turn it starts the child.
      child.once("exit", (code: number) => lifecycle.onExit(code));
      child.once(
        "error",
        (type: string, location: string, report: string) =>
          lifecycle.onError(
            `Utility process error ${type} at ${location}: ${report}`,
          ),
      );
      children.push(child);
      forks.push({ modulePath, args, options: forkOptions });
      return child;
    },
    spawnCommandProcess: (command, args, commandOptions, lifecycle) => {
      const child = new FakeCommandProcess(20_000 + commandChildren.length);
      child.once("exit", (code: number) => lifecycle.onExit(code));
      commandChildren.push(child);
      commands.push({ command, args, options: commandOptions });
      return child;
    },
    killWindowsTree: async (pid) => {
      windowsTreeKills.push(pid);
      return true;
    },
    killProcessTreePosix: options.killProcessTreePosix,
    stopGraceMs: 10,
    exitWaitMs: 50,
  });
  return {
    root,
    broker,
    children,
    commandChildren,
    forks,
    commands,
    windowsTreeKills,
  };
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
  it("resolves the explicit workspace-root cwd form to the canonical workspace root", async () => {
    const fixture = await createFixture();
    const brokerContext = context("plugin-a", "spawn-a");

    await spawnChild(fixture, brokerContext, {
      modulePath: "server.mjs",
      cwd: { workspaceRoot: true },
    });

    expect(fixture.forks).toHaveLength(1);
    expect(fixture.forks[0]?.options.cwd).toBe(
      await realpath(join(fixture.root, "workspace")),
    );
  });

  it("canonicalizes a workspace root reached through a link", async () => {
    const fixture = await createFixture({ linkedWorkspaceRoot: true });
    const brokerContext = context("plugin-a", "spawn-a");

    await spawnChild(fixture, brokerContext, {
      modulePath: "server.mjs",
      cwd: { workspaceRoot: true },
    });

    // MUTATION (realpath → resolve): the child would run in the link's path,
    // so every containment check downstream compares two different names for
    // one directory.
    expect(fixture.forks[0]?.options.cwd).toBe(
      await realpath(join(fixture.root, "workspace")),
    );
    expect(fixture.forks[0]?.options.cwd).not.toBe(
      resolve(join(fixture.root, "workspace-link")),
    );
  });

  it("rejects any cwd object that is not exactly { workspaceRoot: true }", async () => {
    const fixture = await createFixture();
    const brokerContext = context("plugin-a", "spawn-a");

    for (const cwd of [
      { workspaceRoot: false },
      // MUTATION (`=== true` → `Boolean(...)`): a truthy value is not the
      // request form, and resolving it to the workspace root anyway would
      // make "exactly" a word the code does not keep.
      { workspaceRoot: 1 },
      { workspaceRoot: "workspace" },
      { workspaceRoot: {} },
      { workspaceRoot: true, extra: 1 },
      { root: "workspace" },
    ]) {
      await expect(
        spawnChild(fixture, brokerContext, { modulePath: "server.mjs", cwd }),
      ).rejects.toThrow("must be exactly { workspaceRoot: true }");
    }
    expect(fixture.forks).toHaveLength(0);
  });

  it("returns the forked child's pid from spawn", async () => {
    const fixture = await createFixture();
    const brokerContext = context("plugin-a", "spawn-a");

    const result = await fixture.broker.invoke(
      brokerContext,
      PLUGIN_CHILD_PROCESS_METHODS.spawn,
      { modulePath: "server.mjs" },
    ) as { childId: string; pid: number | null };

    expect(result.pid).toBe(fixture.children[0]?.pid);
  });

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

  it("cannot reach a build staged beside the plugin's live root (#779 round 7 A1)", async () => {
    const fixture = await createFixture();
    const brokerContext = context("plugin-a", "spawn-a");
    const stagedBuild = "plugin-a.staging-run7";
    await mkdir(join(fixture.root, "plugins", stagedBuild), { recursive: true });
    await writeFile(
      join(fixture.root, "plugins", stagedBuild, "bundle.mjs"),
      "export {};\n",
    );
    const stagedModulePath = `../${stagedBuild}/bundle.mjs`;

    await expect(
      spawnChild(fixture, brokerContext, { modulePath: stagedModulePath }),
    ).rejects.toThrow(
      `childProcesses.spawn modulePath "${stagedModulePath}" escapes plugin directory`,
    );
    expect(fixture.forks).toEqual([]);

    // Why the build has to stage out there: containment is rooted at the live
    // root and has no dot-directory filter, so the same unapproved bundle
    // staged INSIDE the live root — the round 6 layout — is spawnable.
    await mkdir(join(fixture.root, "plugins", "plugin-a", ".staging-run6"));
    await writeFile(
      join(fixture.root, "plugins", "plugin-a", ".staging-run6", "bundle.mjs"),
      "export {};\n",
    );
    await spawnChild(fixture, brokerContext, {
      modulePath: ".staging-run6/bundle.mjs",
    });
    expect(fixture.forks).toHaveLength(1);
  });

  it("accepts a dot-prefixed directory whose name starts with two dots (#779 round 10 B5)", async () => {
    const fixture = await createFixture();
    const brokerContext = context("plugin-a", "spawn-a");
    const cacheDirectory = join(fixture.root, "plugins", "plugin-a", "..cache");
    await mkdir(cacheDirectory);
    await writeFile(join(cacheDirectory, "server.mjs"), "export {};\n");

    // "..cache/server.mjs" is contained; only a whole ".." segment escapes.
    await spawnChild(fixture, brokerContext, {
      modulePath: "..cache/server.mjs",
      cwd: "..cache",
    });

    expect(fixture.forks).toHaveLength(1);
    expect(fixture.forks[0]?.modulePath).toBe(join(cacheDirectory, "server.mjs"));
    await expect(
      spawnChild(fixture, brokerContext, { modulePath: "../plugin-b/server.mjs" }),
    ).rejects.toThrow("escapes plugin directory");
    expect(fixture.forks).toHaveLength(1);
  });

  it("finishes a child that exited before the broker held its handle (#779 round 10 B4)", async () => {
    const root = await createTestScratch("dohc-plugin-child-broker-");
    roots.push(root);
    const pluginRoot = join(root, "plugins", "plugin-a");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, "server.mjs"), "export {};\n");
    const child = new FakeUtilityProcess(12_345);
    const broker = new PluginChildProcessBroker({
      dohcDir: root,
      workspaceRoot: root,
      platform: "win32",
      // A fork that resolves only after the child has already exited. The
      // default Electron path leaves a one-microtask window; the seam makes
      // that window arbitrarily wide.
      forkProcess: async (_modulePath, _args, _options, lifecycle) => {
        child.once("exit", (code: number) => lifecycle.onExit(code));
        child.emit("exit", 3);
        await Promise.resolve();
        return child;
      },
      killWindowsTree: async () => true,
    });
    const brokerContext = context("plugin-a", "spawn-a");

    const childId = await spawnChild(
      {
        root,
        broker,
        children: [child],
        commandChildren: [],
        forks: [],
        commands: [],
        windowsTreeKills: [],
      },
      brokerContext,
    );

    await expect(
      broker.invoke(brokerContext, PLUGIN_CHILD_PROCESS_METHODS.wait, { childId }),
    ).resolves.toMatchObject({ code: 3, reason: "exited" });
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

  it("spawns a child whose plugin-supplied env uses the whole configured budget", async () => {
    const fixture = await createFixture();
    // Just under MAX_CHILD_ENV_BYTES: 2 * (5 + 32,000 + 2) = 64,014 bytes.
    const value = "v".repeat(32_000);
    const env = { KEY_A: value, KEY_B: value };

    await spawnChild(fixture, context("plugin-a", "spawn-a"), {
      modulePath: "server.mjs",
      env,
    });

    expect(fixture.forks).toHaveLength(1);
    expect(fixture.forks[0]?.options.env).toMatchObject(env);
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

  it("terminates the POSIX process tree when a spawn aborts", async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let child: FakeUtilityProcess | undefined;
    const fixture = await createFixture({
      platform: "linux",
      killProcessTreePosix: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGTERM") queueMicrotask(() => child?.emit("exit", 0));
        return [pid];
      },
    });
    const controller = new AbortController();
    const brokerContext = context("plugin-a", "spawn-a", controller);
    await spawnChild(fixture, brokerContext);
    child = fixture.children[0];

    controller.abort();
    await fixture.broker.disposeSpawn("plugin-a", "spawn-a");

    expect(signals).toEqual([
      { pid: 10_000, signal: "SIGTERM" },
      { pid: 10_000, signal: "SIGKILL" },
    ]);
    expect(child?.killCalls).toBe(0);
    expect(fixture.windowsTreeKills).toEqual([]);
  });

  it("runs the SIGKILL round over the captured pids even when the root exits first", async () => {
    // The root's SIGTERM handler exits immediately and its worker ignores
    // SIGTERM. Skipping the force round because the root is gone would leave
    // that worker running with the plugin's ports and files.
    const rounds: Array<{
      pid: number;
      signal: NodeJS.Signals;
      alsoSignal: readonly number[];
    }> = [];
    let child: FakeUtilityProcess | undefined;
    const fixture = await createFixture({
      platform: "linux",
      killProcessTreePosix: (pid, signal, alsoSignal) => {
        rounds.push({ pid, signal, alsoSignal });
        if (signal === "SIGTERM") {
          queueMicrotask(() => child?.emit("exit", 0));
          return [20_001, pid];
        }
        return [...alsoSignal];
      },
    });
    const brokerContext = context("plugin-a", "spawn-a");
    const childId = await spawnChild(fixture, brokerContext);
    child = fixture.children[0];

    await fixture.broker.invoke(
      brokerContext,
      PLUGIN_CHILD_PROCESS_METHODS.terminate,
      { childId },
    );

    expect(rounds).toEqual([
      { pid: 10_000, signal: "SIGTERM", alsoSignal: [] },
      { pid: 10_000, signal: "SIGKILL", alsoSignal: [20_001, 10_000] },
    ]);
  });

  it("tears down every remaining plugin child on broker disposal", async () => {
    const fixture = await createFixture();
    await spawnChild(fixture, context("plugin-a", "spawn-a"));
    await spawnChild(fixture, context("plugin-b", "spawn-b"));

    await fixture.broker.dispose();

    expect(fixture.windowsTreeKills).toEqual([10_000, 10_001]);
    expect(fixture.children.map((child) => child.killCalls)).toEqual([1, 1]);
  });

  it("forgets a fulfilled spawn teardown instead of retaining it across restarts (#779 round 13 A4)", async () => {
    const fixture = await createFixture();
    const teardowns = () => (fixture.broker as unknown as {
      spawnTeardowns: Map<string, Promise<void>>;
    }).spawnTeardowns;

    // Ten restarts of one plugin: every spawn id is new, so a map that only
    // ever adds entries grows by one per restart.
    for (let restart = 0; restart < 10; restart += 1) {
      const spawnId = `spawn-${restart}`;
      await spawnChild(fixture, context("plugin-a", spawnId));
      await fixture.broker.disposeSpawn("plugin-a", spawnId);
    }
    expect(teardowns().size).toBe(0);
  });

  it("still joins a second teardown started while the first drains (#779 round 13 A4)", async () => {
    const fixture = await createFixture();
    await spawnChild(fixture, context("plugin-a", "spawn-a"));

    const first = fixture.broker.disposeSpawn("plugin-a", "spawn-a");
    const second = fixture.broker.disposeSpawn("plugin-a", "spawn-a");
    await Promise.all([first, second]);

    // One stop for one child: the second call joined the in-flight teardown
    // rather than tearing the same spawn down twice.
    expect(fixture.windowsTreeKills).toEqual([10_000]);
    expect(fixture.children[0]?.killCalls).toBe(1);
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
              ? { commands: [], drivers: [] }
              : {};
            return Promise.resolve(result as T);
          },
          notify: () => undefined,
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

  it("evicts old exited-child records once a spawn's retained count passes the cap (CodeRabbit #779 R9)", async () => {
    const fixture = await createFixture();
    const brokerContext = context("plugin-a", "spawn-a");
    const total = 205;
    const childIds: string[] = [];

    for (let index = 0; index < total; index += 1) {
      const childId = await spawnChild(fixture, brokerContext);
      fixture.children[index]?.emit("exit", 0);
      childIds.push(childId);
    }

    // A plugin spawning many short-lived children within one still-open
    // spawn must not retain every exited record forever — the oldest ones
    // are evicted once the cap is passed.
    const firstChildId = childIds[0];
    if (!firstChildId) throw new Error("No child was spawned.");
    await expect(
      fixture.broker.invoke(brokerContext, PLUGIN_CHILD_PROCESS_METHODS.logs, {
        childId: firstChildId,
      }),
    ).rejects.toThrow(`Child process "${firstChildId}" was not found.`);

    const lastChildId = childIds[childIds.length - 1];
    if (!lastChildId) throw new Error("No child was spawned.");
    await expect(
      fixture.broker.invoke(brokerContext, PLUGIN_CHILD_PROCESS_METHODS.logs, {
        childId: lastChildId,
      }),
    ).resolves.toEqual([]);
  });

  it("signals a POSIX child's own pid directly, never a negated process-group id (CodeRabbit #779 R10)", async () => {
    const fixture = await createFixture({ platform: "linux" });
    const brokerContext = context("plugin-a", "spawn-a");
    const childId = await spawnChild(fixture, brokerContext);
    const child = fixture.children[0];
    if (!child) throw new Error("No child was spawned.");
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const killSpy = vi.spyOn(process, "kill").mockImplementation(
      ((pid: number, signal?: NodeJS.Signals) => {
        killCalls.push({ pid, signal: signal ?? "SIGTERM" });
        queueMicrotask(() => child.emit("exit", 0));
        return true;
      }) as typeof process.kill,
    );

    try {
      await fixture.broker.invoke(brokerContext, PLUGIN_CHILD_PROCESS_METHODS.terminate, {
        childId,
      });
      // The tree sweep may add descendant pids on a host with a readable
      // process table. None of them may ever be a negated group id.
      expect(killCalls).toContainEqual({ pid: child.pid, signal: "SIGTERM" });
      expect(killCalls.every((call) => call.pid > 0)).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("signals a POSIX child's descendants, re-enumerating before the SIGKILL round", async () => {
    // The live `ps` path cannot run on this Windows host, so the sweep is
    // driven through an injected process table.
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let round = 0;
    const fixture = await createFixture({
      platform: "linux",
      killProcessTreePosix: async (pid, signal) => {
        round += 1;
        // A worker the child started only after the SIGTERM round.
        const table = round === 1
          ? [{ pid: 10_000, ppid: 1 }, { pid: 20_001, ppid: 10_000 }]
          : [
            { pid: 10_000, ppid: 1 },
            { pid: 20_001, ppid: 10_000 },
            { pid: 20_002, ppid: 20_001 },
          ];
        const targets = processTreePids(table, pid);
        for (const target of targets) signals.push({ pid: target, signal });
        return targets;
      },
    });
    const brokerContext = context("plugin-a", "spawn-a");
    const childId = await spawnChild(fixture, brokerContext);
    const child = fixture.children[0];
    if (!child) throw new Error("No child was spawned.");

    const terminate = fixture.broker.invoke(
      brokerContext,
      PLUGIN_CHILD_PROCESS_METHODS.terminate,
      { childId },
    );
    // Never exits on SIGTERM, so the SIGKILL escalation has to run.
    setTimeout(() => child.emit("exit", 0), 30);
    await terminate;

    expect(signals.filter((entry) => entry.signal === "SIGTERM")).toEqual([
      { pid: 20_001, signal: "SIGTERM" },
      { pid: 10_000, signal: "SIGTERM" },
    ]);
    // The second round enumerated freshly and caught the new grandchild.
    expect(signals.filter((entry) => entry.signal === "SIGKILL")).toEqual([
      { pid: 20_002, signal: "SIGKILL" },
      { pid: 20_001, signal: "SIGKILL" },
      { pid: 10_000, signal: "SIGKILL" },
    ]);
  });

  it("names the retention limit when an evicted child handle is used", async () => {
    const fixture = await createFixture();
    const brokerContext = context("plugin-a", "spawn-a");
    const childIds: string[] = [];
    for (let index = 0; index <= EXITED_CHILD_RETENTION_LIMIT; index += 1) {
      childIds.push(await spawnChild(fixture, brokerContext));
    }
    // Exit them all: the oldest passes the retention cap and is discarded.
    for (const child of fixture.children) child.emit("exit", 0);

    const evictedId = childIds[0];
    if (!evictedId) throw new Error("No child id was recorded.");
    await expect(
      fixture.broker.invoke(brokerContext, PLUGIN_CHILD_PROCESS_METHODS.logs, {
        childId: evictedId,
      }),
    ).rejects.toThrow(
      /discarded 1 exited child: the broker retains at most 200 exited children per spawn and discards the oldest first/,
    );
  });

  // The merged-env limit rejects otherwise valid work, so AGENTS.md requires
  // recorded evidence for it. These numbers are the environment measurements
  // in docs/superpowers/plans/2026-08-13-plugin-timeout-measurements.md.
  it("keeps the merged env limit clear of a healthy env plus the plugin budget", () => {
    // Largest healthy inherited environment measured on 2026-08-14 (Git Bash
    // dev shell: 82 entries, 5,052 UTF-16 code units).
    const MEASURED_HEALTHY_ENV_CODE_UNITS = 5_052;
    // Windows refuses to start a process with an environment block over
    // 32,767 characters, so no healthy Windows environment can pass it.
    const WINDOWS_ENV_BLOCK_CEILING = 32_767;

    expect(MAX_MERGED_CHILD_ENV_CODE_UNITS).toBeGreaterThan(
      MEASURED_HEALTHY_ENV_CODE_UNITS + MAX_CHILD_ENV_BYTES,
    );
    expect(MAX_MERGED_CHILD_ENV_CODE_UNITS).toBeGreaterThan(
      WINDOWS_ENV_BLOCK_CEILING + MAX_CHILD_ENV_BYTES,
    );
  });

  it("leaves this host's own environment the whole plugin env budget", () => {
    // Fails on any host whose environment is far outside the measured range,
    // which is the signal to re-measure rather than to widen the limit.
    const inherited = Object.entries(process.env).reduce(
      (total, [key, value]) =>
        value === undefined ? total : total + key.length + value.length + 2,
      1,
    );

    expect(MAX_MERGED_CHILD_ENV_CODE_UNITS - inherited).toBeGreaterThanOrEqual(
      MAX_CHILD_ENV_BYTES,
    );
  });

  it("does not mention retention when an unknown child id was never spawned", async () => {
    const fixture = await createFixture();
    const brokerContext = context("plugin-a", "spawn-a");
    await spawnChild(fixture, brokerContext);

    await expect(
      fixture.broker.invoke(brokerContext, PLUGIN_CHILD_PROCESS_METHODS.logs, {
        childId: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toThrow(/^Child process "[^"]+" was not found\.$/);
  });
});

/**
 * A broker with no injected launchers: real spawns, real pids, the real
 * platform's tree kill. Command children run real executables, so their pins
 * run real executables — a fake that spawns nothing can certify neither a
 * pid, an exit code, a standard-input round trip, nor a tree that has to die.
 */
async function createRealFixture(): Promise<BrokerFixture> {
  const root = await createTestScratch("dohc-plugin-command-broker-");
  roots.push(root);
  await mkdir(join(root, "plugins", "plugin-a", "data"), { recursive: true });
  await mkdir(join(root, "workspace"), { recursive: true });
  return {
    root,
    broker: new PluginChildProcessBroker({
      dohcDir: root,
      workspaceRoot: join(root, "workspace"),
    }),
    children: [],
    commandChildren: [],
    forks: [],
    commands: [],
    windowsTreeKills: [],
  };
}

async function commandScript(
  fixture: BrokerFixture,
  name: string,
  source: string,
): Promise<string> {
  const path = join(fixture.root, "plugins", "plugin-a", name);
  await writeFile(path, source);
  return path;
}

async function spawnCommandChild(
  fixture: BrokerFixture,
  brokerContext: PluginChildProcessBrokerContext,
  input: Record<string, unknown>,
): Promise<{ childId: string; pid: number | null }> {
  const result = await fixture.broker.invoke(
    brokerContext,
    PLUGIN_CHILD_PROCESS_METHODS.spawnCommand,
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
  return result as { childId: string; pid: number | null };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((settle) => setTimeout(settle, 25));
  }
}

describe("PluginChildProcessBroker command children", () => {
  it(
    "runs a real executable and reports its pid and exit code",
    async () => {
      const fixture = await createRealFixture();
      const brokerContext = context("plugin-a", "spawn-a");
      const script = await commandScript(
        fixture,
        "exit-seven.mjs",
        "process.exit(7);\n",
      );

      const spawned = await spawnCommandChild(fixture, brokerContext, {
        command: process.execPath,
        args: [script],
      });

      expect(spawned.pid).toBeGreaterThan(0);
      await expect(
        fixture.broker.invoke(brokerContext, PLUGIN_CHILD_PROCESS_METHODS.wait, {
          childId: spawned.childId,
        }),
      ).resolves.toEqual({ code: 7, reason: "exited" });
    },
    20_000,
  );

  it(
    "carries a duplex round trip: written standard input comes back on stdout",
    async () => {
      const fixture = await createRealFixture();
      const events: Array<{
        subscriptionId: string;
        event: string;
        data: unknown;
      }> = [];
      const brokerContext = context("plugin-a", "spawn-a", undefined, events);
      // The shape a harness CLI speaks: read a line, answer a line, and stay
      // alive until its input ends.
      const newline = "String.fromCharCode(10)";
      const script = await commandScript(
        fixture,
        "echo-lines.mjs",
        [
          'process.stdin.setEncoding("utf8");',
          'let buffered = "";',
          'process.stdin.on("data", (chunk) => {',
          "  buffered += chunk;",
          `  let breakAt = buffered.indexOf(${newline});`,
          "  while (breakAt >= 0) {",
          "    const line = buffered.slice(0, breakAt);",
          "    buffered = buffered.slice(breakAt + 1);",
          `    process.stdout.write("echo:" + line + ${newline});`,
          `    breakAt = buffered.indexOf(${newline});`,
          "  }",
          "});",
          'process.stdin.on("end", () => process.exit(0));',
          "",
        ].join("\n"),
      );
      const spawned = await spawnCommandChild(fixture, brokerContext, {
        command: process.execPath,
        args: [script],
      });
      await fixture.broker.invoke(
        brokerContext,
        PLUGIN_CHILD_PROCESS_METHODS.subscribeOutput,
        { childId: spawned.childId },
      );

      await fixture.broker.invoke(
        brokerContext,
        PLUGIN_CHILD_PROCESS_METHODS.write,
        { childId: spawned.childId, data: "ping\n" },
      );

      // MUTATION (the write never reaches stdin): the answer never arrives
      // and this times out.
      await until(
        () =>
          events.find(
            ({ event, data }) =>
              event === "stdout" &&
              (data as PluginChildProcessOutput).text.includes("echo:ping"),
          ),
        "the child's answer on stdout",
      );

      await fixture.broker.invoke(
        brokerContext,
        PLUGIN_CHILD_PROCESS_METHODS.endInput,
        { childId: spawned.childId },
      );

      // MUTATION (endInput does not end the pipe): the child never sees end
      // of file, never exits, and this wait times out.
      await expect(
        fixture.broker.invoke(brokerContext, PLUGIN_CHILD_PROCESS_METHODS.wait, {
          childId: spawned.childId,
        }),
      ).resolves.toEqual({ code: 0, reason: "exited" });
    },
    20_000,
  );

  it(
    "kills a command child's own children when the spawn is torn down",
    async () => {
      const fixture = await createRealFixture();
      const brokerContext = context("plugin-a", "spawn-a");
      const pidFile = join(fixture.root, "grandchild.pid");
      const grandchild = await commandScript(
        fixture,
        "grandchild.mjs",
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      // The grandchild detaches on purpose. Measured on Windows 2026-08-17: an
      // attached grandchild dies with its parent anyway, so a test built on
      // one passes whether the broker kills the tree or only the child it
      // spawned. A detached grandchild survives a plain kill of its parent and
      // dies only to a real tree kill, which is the difference being pinned.
      const parent = await commandScript(
        fixture,
        "parent.mjs",
        [
          'import { spawn } from "node:child_process";',
          `const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "ignore", detached: true });`,
          "child.unref();",
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );

      const spawned = await spawnCommandChild(fixture, brokerContext, {
        command: process.execPath,
        args: [parent],
      });
      const grandchildPid = await until(async () => {
        const pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
        return pid > 0 ? pid : undefined;
      }, "the grandchild to record its pid");
      expect(spawned.pid).toBeGreaterThan(0);
      expect(isAlive(grandchildPid)).toBe(true);

      await fixture.broker.disposeSpawn("plugin-a", "spawn-a");

      try {
        // MUTATION (the tree kill becomes a plain kill of the spawned child):
        // the grandchild outlives the teardown and is still alive here.
        await until(
          () => (isAlive(grandchildPid) ? undefined : true),
          "the grandchild to die with its parent",
        );
        expect(isAlive(grandchildPid)).toBe(false);
      } finally {
        // A detached survivor would outlive the whole test run.
        if (isAlive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
      }
    },
    30_000,
  );

  it(
    "names the executable and where it was looked for when it does not exist",
    async () => {
      const fixture = await createRealFixture();
      const brokerContext = context("plugin-a", "spawn-a");

      await expect(
        spawnCommandChild(fixture, brokerContext, {
          command: "dohc-no-such-executable-w2",
        }),
      ).rejects.toThrow(/looked up on the child environment's PATH/);
      await expect(
        spawnCommandChild(fixture, brokerContext, {
          command: join(fixture.root, "plugins", "plugin-a", "missing-tool"),
        }),
      ).rejects.toThrow("No executable exists at that path.");
    },
    20_000,
  );

  it(
    "passes arguments as argv, so no shell ever reads them",
    async () => {
      const fixture = await createRealFixture();
      const brokerContext = context("plugin-a", "spawn-a");
      const script = await commandScript(
        fixture,
        "print-argv.mjs",
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
      );
      // Every one of these means something to a shell and nothing to argv.
      const args = ["a && echo pwned", "$(id)", "; rm -rf /", "|", ">out.txt"];

      const spawned = await spawnCommandChild(fixture, brokerContext, {
        command: process.execPath,
        args: [script, ...args],
      });
      await fixture.broker.invoke(brokerContext, PLUGIN_CHILD_PROCESS_METHODS.wait, {
        childId: spawned.childId,
      });
      const logs = (await fixture.broker.invoke(
        brokerContext,
        PLUGIN_CHILD_PROCESS_METHODS.logs,
        { childId: spawned.childId },
      )) as PluginChildProcessOutput[];

      // MUTATION (`shell: true`): the child receives split and expanded
      // tokens, and this exact array never comes back.
      expect(
        logs
          .filter(({ stream }) => stream === "stdout")
          .map(({ text }) => text)
          .join(""),
      ).toBe(JSON.stringify(args));
    },
    20_000,
  );

  it("refuses a whole command line in place of an executable name", async () => {
    const fixture = await createFixture();
    const brokerContext = context("plugin-a", "spawn-a");

    // A command line is not a command: this names one executable that cannot
    // exist, and no request form would make it two.
    await expect(
      spawnCommandChild(fixture, brokerContext, {
        command: "./node_modules/.bin/tool --flag",
      }),
    ).rejects.toThrow(
      'command "./node_modules/.bin/tool --flag" must be an absolute path to an executable, or a name with no path separator',
    );
    // MUTATION (args accepts a string): a caller could pass one command line
    // and depend on something splitting it.
    await expect(
      spawnCommandChild(fixture, brokerContext, {
        command: "tool",
        args: "--flag value",
      }),
    ).rejects.toThrow("args must contain at most");
    expect(fixture.commands).toEqual([]);
  });

  it("contains a command child's cwd exactly as it contains a module child's", async () => {
    const fixture = await createFixture();
    const brokerContext = context("plugin-a", "spawn-a");

    // MUTATION (containment skipped for commands): a command child would run
    // in another plugin's directory, and "the same cwd rules" would be a
    // sentence the code does not keep.
    await expect(
      spawnCommandChild(fixture, brokerContext, {
        command: "tool",
        cwd: "../plugin-b",
      }),
    ).rejects.toThrow(
      'childProcesses.command.spawn cwd "../plugin-b" escapes plugin directory',
    );
    expect(fixture.commands).toEqual([]);

    await spawnCommandChild(fixture, brokerContext, {
      command: "tool",
      args: ["--serve"],
      cwd: "data",
      env: { PLUGIN_PORT: "0" },
    });
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.commands[0]).toMatchObject({
      command: "tool",
      args: ["--serve"],
      options: {
        cwd: resolve(fixture.root, "plugins", "plugin-a", "data"),
        env: expect.objectContaining({ PLUGIN_PORT: "0" }),
        requestedCommand: "tool",
      },
    });
  });

  it("keeps the workspace-root cwd form exact for commands too", async () => {
    const fixture = await createFixture();
    const brokerContext = context("plugin-a", "spawn-a");

    for (const cwd of [
      { workspaceRoot: false },
      // MUTATION (`=== true` → `Boolean(...)`): the command path would take a
      // truthy value as the escape and run outside the plugin's root.
      { workspaceRoot: 1 },
      { workspaceRoot: "workspace" },
      { workspaceRoot: true, extra: 1 },
    ]) {
      await expect(
        spawnCommandChild(fixture, brokerContext, { command: "tool", cwd }),
      ).rejects.toThrow("must be exactly { workspaceRoot: true }");
    }
    expect(fixture.commands).toEqual([]);

    await spawnCommandChild(fixture, brokerContext, {
      command: "tool",
      cwd: { workspaceRoot: true },
    });
    expect(fixture.commands[0]?.options.cwd).toBe(
      await realpath(join(fixture.root, "workspace")),
    );
  });

  it("refuses to subscribe to a command child that has exited", async () => {
    const fixture = await createFixture();
    const brokerContext = context("plugin-a", "spawn-a");
    const spawned = await spawnCommandChild(fixture, brokerContext, {
      command: "tool",
    });
    fixture.commandChildren[0]?.emit("exit", 0);

    await expect(
      fixture.broker.invoke(
        brokerContext,
        PLUGIN_CHILD_PROCESS_METHODS.subscribeOutput,
        { childId: spawned.childId },
      ),
    ).rejects.toThrow(`Child process "${spawned.childId}" has exited.`);
    await expect(
      fixture.broker.invoke(brokerContext, PLUGIN_CHILD_PROCESS_METHODS.write, {
        childId: spawned.childId,
        data: "ping\n",
      }),
    ).rejects.toThrow(`Child process "${spawned.childId}" has exited.`);
  });

  it("routes input by child kind and names the member that fits", async () => {
    const fixture = await createFixture();
    const brokerContext = context("plugin-a", "spawn-a");
    const moduleChildId = await spawnChild(fixture, brokerContext);
    const commandChild = await spawnCommandChild(fixture, brokerContext, {
      command: "tool",
    });

    await expect(
      fixture.broker.invoke(brokerContext, PLUGIN_CHILD_PROCESS_METHODS.write, {
        childId: moduleChildId,
        data: "ping\n",
      }),
    ).rejects.toThrow(
      `runs a module and has no standard input; post it a message with ${PLUGIN_CHILD_PROCESS_METHODS.send}`,
    );
    await expect(
      fixture.broker.invoke(brokerContext, PLUGIN_CHILD_PROCESS_METHODS.send, {
        childId: commandChild.childId,
        message: { kind: "ping" },
      }),
    ).rejects.toThrow(
      `runs a command and has no message channel; write to its standard input with ${PLUGIN_CHILD_PROCESS_METHODS.write}`,
    );

    await fixture.broker.invoke(brokerContext, PLUGIN_CHILD_PROCESS_METHODS.write, {
      childId: commandChild.childId,
      data: "ping\n",
    });
    expect(fixture.commandChildren[0]?.stdin.read()?.toString()).toBe("ping\n");
  });
});
