import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILT_IN_AGENT_DRIVER_IDS,
  type AgentDriver,
  type AgentEvent,
  type AgentSession,
} from "../agents/AgentDriver";
import { JsonRpcTransport } from "../agents/JsonRpcTransport";
import { createTestScratch } from "../workspaces/testTemp";
import { PluginHost, type PluginHostOptions } from "./PluginHost";
import { PluginChildProcessBroker } from "./pluginChildProcessBroker";
import {
  MAX_WORKSPACE_PLUGIN_DRIVERS,
  createPluginAgentDrivers,
  type PluginAgentDrivers,
} from "./pluginAgentDrivers";
import { readPluginManifestFile } from "./pluginManifest";
import { PLUGIN_HOST_METHODS } from "./pluginHostProtocol";

const pluginHostProcessPath = fileURLToPath(
  new URL("./pluginHostProcess.ts", import.meta.url),
);
const driverPluginSource = fileURLToPath(
  new URL("../../e2e/fixtures/driver-plugin", import.meta.url),
);
// The real list, not a copy of it: a driver dohc adds or drops has to reach
// these tests, because what a plugin may not take is exactly what dohc ships.
const BUILT_IN_DRIVER_IDS = BUILT_IN_AGENT_DRIVER_IDS;

const scratchRoots: string[] = [];
const liveHosts: PluginHost[] = [];
const liveBrokers: PluginChildProcessBroker[] = [];

afterEach(async () => {
  await Promise.allSettled(liveHosts.splice(0).map((host) => host.stopAll()));
  await Promise.allSettled(liveBrokers.splice(0).map((broker) => broker.dispose()));
  await Promise.all(
    scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface DriverFixture {
  drivers: PluginAgentDrivers;
  host: PluginHost;
  workspaceRoot: string;
  heartbeatPath: string;
  warnings: string[];
  pluginStderr: () => string[];
}

/**
 * The whole chain, real: dohc's main-side registry, a forked plugin process
 * speaking the real host protocol, and the plugin's harness running as a real
 * brokered command child. A double anywhere in this chain would certify the
 * double, not the boundary.
 */
async function startDriverPlugin(
  mode = "driver",
  options: { start?: boolean } = {},
): Promise<DriverFixture> {
  const root = await createTestScratch("dohc-driver-plugin-");
  scratchRoots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const pluginRoot = join(root, "plugins", "driver-plugin");
  await cp(driverPluginSource, pluginRoot, { recursive: true });
  const heartbeatPath = join(workspaceRoot, "harness-heartbeat.txt");

  const broker = new PluginChildProcessBroker({
    dohcDir: root,
    workspaceRoot,
  });
  liveBrokers.push(broker);

  const warnings: string[] = [];
  let host: PluginHost | null = null;
  const drivers = createPluginAgentDrivers({
    host: {
      requestDriver: (pluginId, spawnId, method, params) => {
        if (!host) throw new Error("The plugin host is not running.");
        return host.requestDriver(pluginId, spawnId, method, params);
      },
    },
    reservedDriverIds: BUILT_IN_DRIVER_IDS,
    onWarning: (message) => warnings.push(message),
  });

  const spawnTransport: PluginHostOptions["spawnTransport"] = (params) => {
    const transport = JsonRpcTransport.spawn({
      command: process.execPath,
      args: [pluginHostProcessPath],
      cwd: params.pluginRoot,
      env: {
        DOHC_PLUGIN_FIXTURE_MODE: mode,
        DOHC_DRIVER_FIXTURE_HEARTBEAT: heartbeatPath,
      },
      detached: true,
      label: `plugin ${params.pluginId}`,
      onNotification: params.onNotification,
      onRequest: params.onRequest,
      onStderr: params.onStderr,
      onExit: (code, signal) => params.onExit({ code, signal }),
    });
    return {
      request: (method, rpcParams) => transport.request(method, rpcParams),
      notify: (method, rpcParams) => transport.notify(method, rpcParams),
      dispose: () => transport.dispose(),
    };
  };

  host = new PluginHost({
    stateDir: join(root, "state"),
    workspaceRoot,
    spawnTransport,
    routeSdkRequest: (pluginId, method, params, spawnId, signal, emitEvent) =>
      broker.invoke({ pluginId, spawnId, signal, emitEvent }, method, params),
    onDriversRegistered: (pluginId, spawnId, declared) =>
      drivers.register(pluginId, spawnId, declared),
    onDriverEvent: (pluginId, spawnId, params) =>
      drivers.handleEvent(pluginId, spawnId, params),
    onSpawnEnd: (pluginId, spawnId) => {
      drivers.endSpawn(pluginId, spawnId);
      return broker.disposeSpawn(pluginId, spawnId);
    },
  });
  liveHosts.push(host);

  const manifest = await readPluginManifestFile(pluginRoot);
  if (!manifest.ok) throw new Error(manifest.diagnostics.join("; "));
  if (options.start !== false) {
    await host.start(pluginRoot, "driver-plugin", manifest.manifest);
    await until(
      () => (host?.getStatus("driver-plugin") === "ready" ? true : undefined),
      `the plugin to activate (${host.getStderrLog("driver-plugin").join(" | ")})`,
      20_000,
    ).catch((error: unknown) => {
      throw new Error(
        `${String(error)} stderr: ${host?.getStderrLog("driver-plugin").join(" | ")}`,
      );
    });
  }

  return {
    drivers,
    host,
    workspaceRoot,
    heartbeatPath,
    warnings,
    pluginStderr: () => host?.getStderrLog("driver-plugin") ?? [],
  };
}

function onlyDriver(fixture: DriverFixture): AgentDriver {
  const driver = fixture.drivers.list()[0];
  if (!driver) throw new Error("No plugin driver was registered.");
  return driver;
}

async function startSession(
  fixture: DriverFixture,
  input: Partial<Parameters<AgentDriver["startSession"]>[0]> = {},
): Promise<{ session: AgentSession; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  const session = await onlyDriver(fixture).startSession({
    workspaceRoot: fixture.workspaceRoot,
    mode: "approval-required",
    mcp: { command: "dohc-mcp", args: ["--workspace", fixture.workspaceRoot] },
    onEvent: (event) => events.push(event),
    ...input,
  });
  return { session, events };
}

function textOf(events: AgentEvent[], itemId: string): string | undefined {
  return events.find(
    (event): event is Extract<AgentEvent, { kind: "text-delta" }> =>
      event.kind === "text-delta" && event.itemId === itemId,
  )?.text;
}

describe("plugin agent drivers, through the real plugin process", () => {
  it(
    "registers a plugin's declared driver and probes its harness",
    async () => {
      const fixture = await startDriverPlugin();

      expect(fixture.drivers.list().map((driver) => ({
        id: driver.id,
        displayName: driver.displayName,
      }))).toEqual([
        { id: "fixture-harness", displayName: "Fixture Harness" },
      ]);

      // MUTATION (driver.probe never reaches the plugin): the probe answers
      // "cannot read" instead of the harness's own version and login state.
      const probe = await onlyDriver(fixture).probe();
      expect(probe.installed).toBe(true);
      expect(probe.version).toBe("fixture-harness 1.0.0");
      expect(probe.auth.status).toBe("unauthenticated");
      expect(probe.models).toEqual([
        { id: "fixture-fast", name: "Fixture Fast", planIncluded: true },
      ]);
      // The probe's personal data crosses into main, where the panel summary
      // is what decides it goes no further (AgentSessionManager.test.ts).
      expect(probe.auth.email).toBe("person@example.com");
    },
    30_000,
  );

  it(
    "carries a whole turn between dohc and a real harness process",
    async () => {
      const fixture = await startDriverPlugin();
      const { session, events } = await startSession(fixture, {
        model: "fixture-fast",
        resumeCursor: { threadId: "earlier-thread" },
        logDir: "C:/logs/fixture",
      });

      // What dohc handed the driver, read back from the driver itself.
      const startInput = JSON.parse(
        await until(() => textOf(events, "start-input"), "the start input"),
      ) as Record<string, unknown>;
      expect(startInput).toMatchObject({
        workspaceRoot: fixture.workspaceRoot,
        mode: "approval-required",
        model: "fixture-fast",
        resumeCursor: { threadId: "earlier-thread" },
        mcpCommand: "dohc-mcp",
        logDir: "C:/logs/fixture",
      });

      expect(session.sessionId).toMatch(/^fixture-session-/);
      expect(session.resumeCursor).toMatchObject({ threadId: "fixture-thread" });

      await until(
        () => events.find((event) =>
          event.kind === "session-state" && event.state === "ready"),
        "the harness to report itself ready",
      );

      // MUTATION (driver.prompt never reaches the plugin): no answer comes
      // back and this times out.
      const { turnId } = await session.prompt({ text: "hello" });
      expect(turnId).toBe("turn-1");

      const answer = await until(
        () => textOf(events, "answer"),
        "the harness's answer",
      );
      expect(answer).toBe("working on hello");

      const completed = await until(
        () => events.find((event) => event.kind === "turn-completed"),
        "the turn to complete",
      );
      expect(completed).toMatchObject({ turnId: "turn-1", status: "completed" });

      await session.dispose();
    },
    30_000,
  );

  it(
    "drops the harness's own payload at the process boundary",
    async () => {
      const fixture = await startDriverPlugin();
      const { session, events } = await startSession(fixture);
      await session.prompt({ text: "hello" });

      const item = await until(
        () => events.find((event) => event.kind === "item"),
        "the driver's tool item",
      );
      expect(item).toEqual({
        kind: "item",
        phase: "completed",
        item: {
          id: "tool-1",
          type: "tool_call",
          title: "read notes.md",
          status: "completed",
        },
      });
      // MUTATION (the boundary passes unknown keys through): `raw` arrives
      // with the harness's provider payload in it.
      expect(JSON.stringify(item)).not.toContain("provider payload");

      await session.dispose();
    },
    30_000,
  );

  it(
    "answers a permission the host's policy decides, without asking the person",
    async () => {
      const fixture = await startDriverPlugin();
      const asked: string[] = [];
      const { session, events } = await startSession(fixture, {
        permissionPolicy: (event) => {
          asked.push(event.requestId);
          return "allow_once";
        },
      });
      await session.prompt({ text: "ask first" });

      // The policy is a function. It never left this process, and the driver
      // still obeyed it.
      const resolved = await until(
        () => events.find((event) => event.kind === "permission-resolved"),
        "the harness to record the policy's answer",
      );
      expect(resolved).toEqual({
        kind: "permission-resolved",
        requestId: "permission-1",
        decision: "allow_once",
      });
      expect(asked).toEqual(["permission-1"]);
      // The person still sees the request the policy answered, exactly as a
      // built-in driver reports it.
      expect(events.some((event) => event.kind === "permission-request")).toBe(true);

      await session.dispose();
    },
    30_000,
  );

  it(
    "leaves a permission its policy declines to decide for the person to answer",
    async () => {
      const fixture = await startDriverPlugin();
      const { session, events } = await startSession(fixture, {
        permissionPolicy: () => null,
      });
      await session.prompt({ text: "ask first" });

      await until(
        () => events.find((event) => event.kind === "permission-request"),
        "the permission request",
      );
      await new Promise((settle) => setTimeout(settle, 250));
      // MUTATION (a null policy answers anyway): a resolution arrives that
      // nobody decided.
      expect(events.some((event) => event.kind === "permission-resolved")).toBe(false);

      await session.answerPermission("permission-1", "reject_once");
      const resolved = await until(
        () => events.find((event) => event.kind === "permission-resolved"),
        "the person's answer to reach the harness",
      );
      expect(resolved).toMatchObject({ decision: "reject_once" });

      await session.dispose();
    },
    30_000,
  );

  it(
    "offers only the optional session members the driver implements",
    async () => {
      const withMembers = await startDriverPlugin();
      const full = await startSession(withMembers);
      expect(typeof full.session.setModel).toBe("function");
      // The driver implements one optional member and not the other, and the
      // host reports each as it is.
      expect(full.session.answerUserInput).toBeUndefined();
      await full.session.setModel?.("fixture-fast");
      await full.session.dispose();

      const without = await startDriverPlugin("session-without-optional-members");
      const bare = await startSession(without);
      // MUTATION (the host offers every optional member): setModel exists on
      // a session that cannot serve it.
      expect(bare.session.setModel).toBeUndefined();
      await bare.session.dispose();
    },
    60_000,
  );

  it(
    "refuses a resume cursor that is not JSON, naming what it must be",
    async () => {
      const fixture = await startDriverPlugin("resume-cursor-is-not-json");
      await expect(startSession(fixture)).rejects.toThrow(
        /resumeCursor must be JSON data/,
      );
    },
    30_000,
  );

  it(
    "takes the harness's whole process tree down when dohc stops the plugin",
    async () => {
      const fixture = await startDriverPlugin();
      const { session, events } = await startSession(fixture);
      await until(
        () => events.find((event) =>
          event.kind === "session-state" && event.state === "ready"),
        "the harness to start",
      );
      const cursor = session.resumeCursor as { pid: number };
      const heartbeat = await until(
        async () => {
          try {
            const lines = (await readFile(fixture.heartbeatPath, "utf8")).trim();
            return lines.length > 0 ? lines : undefined;
          } catch {
            return undefined;
          }
        },
        "the harness's grandchild to write a heartbeat",
      );
      expect(heartbeat.length).toBeGreaterThan(0);
      expect(isAlive(cursor.pid)).toBe(true);

      // dohc stops the plugin. Nothing asks the driver to co-operate.
      await fixture.host.stop("driver-plugin");

      // MUTATION (the spawn teardown skips the broker): the harness keeps
      // running after the plugin that started it is gone.
      await until(
        () => (isAlive(cursor.pid) ? undefined : true),
        "the harness process to die with its plugin",
      );
      const beforeQuiet = (await readFile(fixture.heartbeatPath, "utf8")).length;
      await new Promise((settle) => setTimeout(settle, 400));
      const afterQuiet = (await readFile(fixture.heartbeatPath, "utf8")).length;
      expect(afterQuiet).toBe(beforeQuiet);

      // The session hears about it as its own failure, not as silence.
      expect(events.at(-1)).toMatchObject({ kind: "error", fatal: true });
      expect(fixture.drivers.list()).toEqual([]);
    },
    60_000,
  );

  it(
    "fails activation when a declared driver never registers",
    async () => {
      const fixture = await startDriverPlugin("declares-but-never-registers", {
        start: false,
      });
      const manifest = await readPluginManifestFile(
        join(fixture.workspaceRoot, "..", "plugins", "driver-plugin"),
      );
      if (!manifest.ok) throw new Error(manifest.diagnostics.join("; "));
      await fixture.host.start(
        join(fixture.workspaceRoot, "..", "plugins", "driver-plugin"),
        "driver-plugin",
        manifest.manifest,
      );

      await until(
        () =>
          fixture.pluginStderr().find((line) =>
            line.includes('did not register driver id "fixture-harness"')),
        `the activation failure (${fixture.pluginStderr().join(" | ")})`,
      );
      expect(fixture.host.getStatus("driver-plugin")).toBe("failed");
      expect(fixture.drivers.list()).toEqual([]);
    },
    30_000,
  );

  it(
    "fails activation when a plugin registers a driver its manifest never declared",
    async () => {
      const fixture = await startDriverPlugin(
        "registers-an-undeclared-driver",
        { start: false },
      );
      const pluginRoot = join(
        fixture.workspaceRoot,
        "..",
        "plugins",
        "driver-plugin",
      );
      const manifest = await readPluginManifestFile(pluginRoot);
      if (!manifest.ok) throw new Error(manifest.diagnostics.join("; "));
      await fixture.host.start(pluginRoot, "driver-plugin", manifest.manifest);

      await until(
        () =>
          fixture.pluginStderr().find((line) =>
            line.includes('registered driver id "surprise-harness" that its manifest does not declare')),
        `the activation failure (${fixture.pluginStderr().join(" | ")})`,
      );
      expect(fixture.drivers.list()).toEqual([]);
    },
    30_000,
  );

  it(
    "fails activation when a plugin registers one driver id twice",
    async () => {
      const fixture = await startDriverPlugin(
        "registers-the-same-driver-twice",
        { start: false },
      );
      const pluginRoot = join(
        fixture.workspaceRoot,
        "..",
        "plugins",
        "driver-plugin",
      );
      const manifest = await readPluginManifestFile(pluginRoot);
      if (!manifest.ok) throw new Error(manifest.diagnostics.join("; "));
      await fixture.host.start(pluginRoot, "driver-plugin", manifest.manifest);

      await until(
        () =>
          fixture.pluginStderr().find((line) =>
            line.includes('duplicate driver id "fixture-harness"')),
        `the activation failure (${fixture.pluginStderr().join(" | ")})`,
      );
      expect(fixture.drivers.list()).toEqual([]);
    },
    30_000,
  );
});

describe("the plugin driver registry", () => {
  function registryOnly(): {
    drivers: PluginAgentDrivers;
    warnings: string[];
    calls: Array<{ method: string; params: unknown }>;
  } {
    const warnings: string[] = [];
    const calls: Array<{ method: string; params: unknown }> = [];
    const drivers = createPluginAgentDrivers({
      host: {
        requestDriver: async <T = unknown>(
          _pluginId: string,
          _spawnId: string,
          method: string,
          params: unknown,
        ): Promise<T> => {
          calls.push({ method, params });
          return {} as T;
        },
      },
      reservedDriverIds: BUILT_IN_DRIVER_IDS,
      onWarning: (message) => warnings.push(message),
    });
    return { drivers, warnings, calls };
  }

  it("refuses a driver id dohc ships, naming it", () => {
    const { drivers } = registryOnly();
    expect(() =>
      drivers.register("rogue", "spawn-1", [
        { id: "claude-acp", displayName: "Not really Claude" },
      ]),
    ).toThrow('Driver id "claude-acp" is one dohc ships.');
    expect(drivers.list()).toEqual([]);
  });

  it("refuses a driver id another plugin already holds, naming the owner", () => {
    const { drivers } = registryOnly();
    drivers.register("first", "spawn-1", [
      { id: "shared", displayName: "First" },
    ]);
    expect(() =>
      drivers.register("second", "spawn-2", [
        { id: "shared", displayName: "Second" },
      ]),
    ).toThrow('already registered by plugin "first"');
    expect(drivers.list().map((driver) => driver.displayName)).toEqual(["First"]);
  });

  it("refuses the driver past the workspace cap, naming the cap", () => {
    const { drivers } = registryOnly();
    for (let index = 0; index < MAX_WORKSPACE_PLUGIN_DRIVERS; index += 1) {
      drivers.register(`plugin-${index}`, "spawn-1", [
        { id: `driver-${index}`, displayName: `Driver ${index}` },
      ]);
    }
    expect(drivers.list()).toHaveLength(MAX_WORKSPACE_PLUGIN_DRIVERS);
    expect(() =>
      drivers.register("one-too-many", "spawn-1", [
        { id: "last", displayName: "Last" },
      ]),
    ).toThrow(
      `This workspace already has ${MAX_WORKSPACE_PLUGIN_DRIVERS} of ${MAX_WORKSPACE_PLUGIN_DRIVERS} plugin agent drivers`,
    );
    // MUTATION (the cap counts only the arriving plugin): the merged list
    // grows past what the agent panel's contract accepts.
    expect(drivers.list()).toHaveLength(MAX_WORKSPACE_PLUGIN_DRIVERS);
  });

  it("counts a re-registering plugin's own drivers once", () => {
    const { drivers } = registryOnly();
    drivers.register("plugin-a", "spawn-1", [
      { id: "a", displayName: "A" },
    ]);
    drivers.register("plugin-a", "spawn-2", [
      { id: "a", displayName: "A again" },
    ]);
    expect(drivers.list().map((driver) => driver.displayName)).toEqual(["A again"]);
  });

  it("drops an event it cannot read, and says which rule refused it", async () => {
    const { drivers, warnings } = registryOnly();
    drivers.register("plugin-a", "spawn-1", [{ id: "a", displayName: "A" }]);
    const events: AgentEvent[] = [];
    const driver = drivers.list()[0];
    if (!driver) throw new Error("no driver");
    await driver.startSession({
      workspaceRoot: "C:/workspace",
      mode: "approval-required",
      mcp: { command: "dohc-mcp", args: [] },
      onEvent: (event) => events.push(event),
    }).catch(() => undefined);

    drivers.handleEvent("plugin-a", "spawn-1", {
      sessionKey: "not-a-session",
      event: { kind: "error", message: "hi", fatal: false },
    });
    drivers.handleEvent("plugin-a", "spawn-1", {
      sessionKey: "not-a-session",
      event: { kind: "nonsense" },
    });

    // MUTATION (the boundary trusts the plugin's shape): an event dohc has
    // no case for reaches the surfaces, and nothing says why.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("cannot read");
    expect(events).toEqual([]);
  });
});
