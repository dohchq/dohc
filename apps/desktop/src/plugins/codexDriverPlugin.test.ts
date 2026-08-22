import { mkdir, cp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
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
import { createPluginAgentDrivers, type PluginAgentDrivers } from "./pluginAgentDrivers";
import { readPluginManifestFile } from "./pluginManifest";

/**
 * dohc's own Codex driver, proven where it now runs.
 *
 * This is the driver dohc shipped inside its main process until the driver
 * contribution point existed. Nothing below reaches into the plugin: the chain
 * is dohc's driver registry, a forked plugin process speaking the real host
 * protocol, and `codex app-server` — here, a stand-in that speaks the same
 * JSON-RPC — running as a real brokered command child. A double anywhere in
 * that chain would certify the double instead of the driver.
 */

const codexPluginSource = fileURLToPath(new URL("../../plugins/codex", import.meta.url));
const fakeCodex = fileURLToPath(
  new URL("../../plugins/codex/test/fakeCodexAppServer.mjs", import.meta.url),
);
const pluginHostProcessPath = fileURLToPath(new URL("./pluginHostProcess.ts", import.meta.url));

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

interface CodexFixture {
  drivers: PluginAgentDrivers;
  host: PluginHost;
  workspaceRoot: string;
  pluginStderr: () => string[];
}

/**
 * Installs the plugin the way a workspace would — a copy of its source — and
 * starts it. `codexCommand` is what the plugin will run as `codex`; the real
 * command needs a login and a network, so every test but the last one points
 * it at a stand-in through the plugin's own documented override.
 */
async function startCodexPlugin(
  codexCommand: { command: string; args: string[] } | null = {
    command: process.execPath,
    args: [fakeCodex, "ok"],
  },
): Promise<CodexFixture> {
  const root = await createTestScratch("dohc-codex-plugin-");
  scratchRoots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(join(workspaceRoot, "notes"), { recursive: true });
  const pluginRoot = join(root, "plugins", "codex");
  await cp(codexPluginSource, pluginRoot, { recursive: true });

  const broker = new PluginChildProcessBroker({ dohcDir: root, workspaceRoot });
  liveBrokers.push(broker);

  let host: PluginHost | null = null;
  const drivers = createPluginAgentDrivers({
    host: {
      requestDriver: (pluginId, spawnId, method, params) => {
        if (!host) throw new Error("The plugin host is not running.");
        return host.requestDriver(pluginId, spawnId, method, params);
      },
    },
    // The real list. A driver id dohc still ships is one this plugin could
    // not take, so the plugin's registration is only proof while this is
    // honest.
    reservedDriverIds: BUILT_IN_AGENT_DRIVER_IDS,
  });

  const spawnTransport: PluginHostOptions["spawnTransport"] = (params) => {
    const transport = JsonRpcTransport.spawn({
      command: process.execPath,
      args: [pluginHostProcessPath],
      cwd: params.pluginRoot,
      env: codexCommand
        ? {
            DOHC_AGENT_CODEX_COMMAND: codexCommand.command,
            DOHC_AGENT_CODEX_ARGS_JSON: JSON.stringify(codexCommand.args),
          }
        : {},
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
    onDriverEvent: (pluginId, spawnId, params) => drivers.handleEvent(pluginId, spawnId, params),
    onSpawnEnd: (pluginId, spawnId) => {
      drivers.endSpawn(pluginId, spawnId);
      return broker.disposeSpawn(pluginId, spawnId);
    },
  });
  liveHosts.push(host);

  const manifest = await readPluginManifestFile(pluginRoot);
  if (!manifest.ok) throw new Error(manifest.diagnostics.join("; "));
  // What dohc's own build does to this plugin before it ever runs
  // (pluginBuildRunner.ts): esbuild the manifest entry into `bundle.mjs` and
  // start that. Running the source directly instead would prove the plugin
  // works in a way it is never loaded — and would not prove, as this does,
  // that its `@dohc/sdk` import is type-only. The scratch root has no
  // node_modules, so a value import would fail to resolve here.
  await build({
    entryPoints: [join(pluginRoot, ...manifest.manifest.entry.split("/"))],
    outfile: join(pluginRoot, "bundle.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
  });
  await host.start(pluginRoot, "codex", { ...manifest.manifest, entry: "bundle.mjs" });
  await until(
    () => (host?.getStatus("codex") === "ready" ? true : undefined),
    `the codex plugin to activate (${host.getStderrLog("codex").join(" | ")})`,
    20_000,
  );

  return {
    drivers,
    host,
    workspaceRoot,
    pluginStderr: () => host?.getStderrLog("codex") ?? [],
  };
}

function codexDriver(fixture: CodexFixture): AgentDriver {
  const driver = fixture.drivers.list()[0];
  if (!driver) throw new Error("The codex plugin registered no driver.");
  return driver;
}

async function startSession(
  fixture: CodexFixture,
  input: Partial<Parameters<AgentDriver["startSession"]>[0]> = {},
): Promise<{ session: AgentSession; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  const session = await codexDriver(fixture).startSession({
    workspaceRoot: fixture.workspaceRoot,
    mode: "approval-required",
    mcp: { command: "dohc-mcp", args: ["--workspace", fixture.workspaceRoot] },
    onEvent: (event) => events.push(event),
    ...input,
  });
  return { session, events };
}

/** What the stand-in reported back about one exchange. */
function echoed(events: AgentEvent[], itemId: string): Record<string, unknown> | undefined {
  const text = events
    .filter(
      (event): event is Extract<AgentEvent, { kind: "text-delta" }> =>
        event.kind === "text-delta" && event.itemId === itemId,
    )
    .map((event) => event.text)
    .join("");
  return text.length === 0 ? undefined : (JSON.parse(text) as Record<string, unknown>);
}

describe("dohc's Codex driver, as a plugin", () => {
  it("is a plugin driver, not one dohc ships", async () => {
    const fixture = await startCodexPlugin();

    expect(fixture.drivers.list().map((driver) => driver.id)).toEqual(["codex"]);
    expect(codexDriver(fixture).displayName).toBe("Codex");
    // Nothing in the app reserves this id any more, which is the only reason
    // the registration above can succeed.
    expect([...BUILT_IN_AGENT_DRIVER_IDS]).not.toContain("codex");
    expect([...BUILT_IN_AGENT_DRIVER_IDS]).not.toContain("codex-app-server");
  });

  it("ships what installing it needs", async () => {
    // dohc installs every plugin's dependencies before it runs one, and that
    // step reads pnpm-lock.yaml whether or not the plugin declares any
    // (pluginInstallRunner.ts). A driver should have no dependencies — but a
    // plugin without the lockfile does not install at all.
    const manifest = JSON.parse(
      await readFile(join(codexPluginSource, "dohc-plugin.json"), "utf8"),
    ) as { drivers?: Array<{ id: string }> };
    expect(manifest.drivers).toEqual([{ id: "codex", displayName: "Codex" }]);
    await expect(readFile(join(codexPluginSource, "pnpm-lock.yaml"), "utf8")).resolves
      .toContain("lockfileVersion");
    const pkg = JSON.parse(
      await readFile(join(codexPluginSource, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it("reports the Codex it found on this machine", async () => {
    const fixture = await startCodexPlugin();

    await expect(codexDriver(fixture).probe()).resolves.toEqual({
      installed: true,
      version: "fake-codex 1.0.0",
      auth: { status: "unknown", label: "CLI login" },
      models: [{ id: "default", name: "Default", planIncluded: true }],
    });
  });

  it("reports the first line of what Codex printed, not all of it", async () => {
    const fixture = await startCodexPlugin({
      command: process.execPath,
      args: [fakeCodex, "probe-noisy"],
    });

    await expect(codexDriver(fixture).probe()).resolves.toMatchObject({
      installed: true,
      version: "fake-codex 1.0.0",
    });
  });

  it("reports why a Codex that answered badly is unusable", async () => {
    const fixture = await startCodexPlugin({
      command: process.execPath,
      args: [fakeCodex, "probe-fails"],
    });

    await expect(codexDriver(fixture).probe()).resolves.toMatchObject({
      installed: false,
      errorMessage: "fake codex is not installed properly",
      models: [],
    });
  });

  it("reports a Codex that is not on this machine at all", async () => {
    const fixture = await startCodexPlugin({
      command: "codex-that-is-not-installed",
      args: [],
    });

    const probe = await codexDriver(fixture).probe();
    expect(probe.installed).toBe(false);
    expect(probe.errorMessage ?? "").toContain("codex-that-is-not-installed");
  });

  it("gives up on a Codex that never answers rather than waiting forever", async () => {
    const fixture = await startCodexPlugin({
      command: process.execPath,
      args: [fakeCodex, "probe-hangs"],
    });

    await expect(codexDriver(fixture).probe()).resolves.toMatchObject({
      installed: false,
      errorMessage: "Probe timed out.",
    });
  }, 20_000);

  it("starts a thread in the workspace with dohc's MCP server", async () => {
    const fixture = await startCodexPlugin();

    const { session, events } = await startSession(fixture, {
      mcp: {
        command: "dohc-mcp",
        args: ["--workspace", fixture.workspaceRoot],
        env: { DOHC_MCP_CLOUD_USER_ID: "user-1" },
      },
    });
    await until(() => (echoed(events, "thread-start") ? true : undefined), "the thread to start");

    expect(echoed(events, "thread-start")).toEqual({
      cwd: fixture.workspaceRoot,
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      mcp: {
        command: "dohc-mcp",
        args: ["--workspace", fixture.workspaceRoot],
        env: { DOHC_MCP_CLOUD_USER_ID: "user-1" },
      },
    });
    expect(events.filter((event) => event.kind === "session-state").map((e) => e.state))
      .toEqual(["starting", "ready"]);
    await session.dispose();
  });

  it("asks Codex for the sandbox each dohc mode allows", async () => {
    for (const [mode, expected] of [
      ["approval-required", { approvalPolicy: "untrusted", sandbox: "read-only" }],
      ["auto-accept-edits", { approvalPolicy: "on-request", sandbox: "workspace-write" }],
      ["full-access", { approvalPolicy: "never", sandbox: "danger-full-access" }],
    ] as const) {
      const fixture = await startCodexPlugin();
      const { session, events } = await startSession(fixture, { mode });
      await until(() => (echoed(events, "thread-start") ? true : undefined), `${mode} to start`);

      expect(echoed(events, "thread-start")).toMatchObject(expected);
      await session.dispose();
    }
  }, 60_000);

  it("carries a whole turn between dohc and Codex", async () => {
    const fixture = await startCodexPlugin();
    const { session, events } = await startSession(fixture);

    const { turnId } = await session.prompt({ text: "write the codex note" });
    expect(turnId).toBe("fake-turn");

    // The turn keeps the mode's sandbox, so a turn cannot widen what the
    // thread was started with.
    await until(() => (echoed(events, "turn-start") ? true : undefined), "the turn to start");
    expect(echoed(events, "turn-start")).toEqual({
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      input: [{ type: "text", text: "write the codex note", text_elements: [] }],
    });

    const permission = await until(
      () =>
        events.find(
          (event): event is Extract<AgentEvent, { kind: "permission-request" }> =>
            event.kind === "permission-request",
        ),
      "Codex to ask for approval",
    );
    expect(permission).toMatchObject({
      requestType: "command",
      title: "write notes/codex-output.md",
      detail: "The fake Codex harness needs to create the requested note.",
    });
    expect(permission.options.map((option) => option.kind)).toEqual([
      "allow_once",
      "allow_always",
      "reject_once",
    ]);

    await session.answerPermission(permission.requestId, "allow_once");
    await until(
      () => (events.some((event) => event.kind === "turn-completed") ? true : undefined),
      "the turn to complete",
    );

    // Codex only did the work because dohc allowed it.
    await expect(
      readFile(join(fixture.workspaceRoot, "notes", "codex-output.md"), "utf8"),
    ).resolves.toContain("Fake Codex wrote this");
    expect(events).toContainEqual({
      kind: "permission-resolved",
      requestId: permission.requestId,
      decision: "allow_once",
    });
    expect(events).toContainEqual({ kind: "token-usage", used: 18, input: 11, output: 7 });
    expect(events).toContainEqual({
      kind: "turn-completed",
      turnId: "fake-turn",
      status: "completed",
    });
    await session.dispose();
  }, 30_000);

  it("leaves the work undone when dohc rejects it", async () => {
    const fixture = await startCodexPlugin();
    const { session, events } = await startSession(fixture);

    await session.prompt({ text: "write the codex note" });
    const permission = await until(
      () =>
        events.find(
          (event): event is Extract<AgentEvent, { kind: "permission-request" }> =>
            event.kind === "permission-request",
        ),
      "Codex to ask for approval",
    );
    await session.answerPermission(permission.requestId, "reject_once");
    await until(
      () => (events.some((event) => event.kind === "turn-completed") ? true : undefined),
      "the turn to complete",
    );

    await expect(
      readFile(join(fixture.workspaceRoot, "notes", "codex-output.md"), "utf8"),
    ).rejects.toThrow();
    await session.dispose();
  }, 30_000);

  it("refuses the two requests dohc cannot answer, and says so", async () => {
    const fixture = await startCodexPlugin();
    const { session, events } = await startSession(fixture);

    await session.prompt({ text: "write the codex note" });
    await until(
      () =>
        events.some(
          (event) => event.kind === "error" && event.message.includes("requested user input"),
        ) || undefined,
      "the user-input refusal",
    );
    await until(
      () =>
        events.some((event) => event.kind === "auth" && event.event === "login-required") ||
        undefined,
      "the token-refresh refusal",
    );

    // Neither refusal ends the session: Codex is asked to carry on without
    // them.
    expect(
      events.find(
        (event): event is Extract<AgentEvent, { kind: "error" }> =>
          event.kind === "error" && event.message.includes("requested user input"),
      )?.fatal,
    ).toBe(false);
    expect(
      events.find(
        (event): event is Extract<AgentEvent, { kind: "auth" }> => event.kind === "auth",
      )?.detail,
    ).toBe("Codex CLI manages ChatGPT token refresh.");
    await session.dispose();
  }, 30_000);

  it("reports an end for a session that never started", async () => {
    const fixture = await startCodexPlugin({
      command: "codex-that-is-not-installed",
      args: [],
    });
    const events: AgentEvent[] = [];

    await expect(
      codexDriver(fixture).startSession({
        workspaceRoot: fixture.workspaceRoot,
        mode: "approval-required",
        mcp: { command: "dohc-mcp", args: ["--workspace", fixture.workspaceRoot] },
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow(/codex-that-is-not-installed/);

    // A session left reporting "starting" is one a surface waits on forever.
    expect(events.map((event) => event.kind === "session-state" && event.state)).toEqual([
      "starting",
      "closed",
    ]);
  }, 30_000);

  it("stops Codex when the thread will not start", async () => {
    const fixture = await startCodexPlugin({
      command: process.execPath,
      args: [fakeCodex, "fail-thread"],
    });
    const events: AgentEvent[] = [];

    await expect(
      codexDriver(fixture).startSession({
        workspaceRoot: fixture.workspaceRoot,
        mode: "approval-required",
        mcp: { command: "dohc-mcp", args: ["--workspace", fixture.workspaceRoot] },
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow(/fake Codex thread failed/);

    await until(
      () =>
        events.some(
          (event) => event.kind === "session-state" && event.state === "closed",
        ) || undefined,
      "the failed Codex process to close",
    );
  }, 30_000);

  // The real `codex` on this machine, which needs an install and a login. It
  // proves the one thing a stand-in never can: that what this driver sends is
  // what Codex accepts. Opt in with DOHC_TEST_REAL_CODEX=1.
  it.runIf(process.env.DOHC_TEST_REAL_CODEX === "1")(
    "starts a thread in the real Codex on this machine",
    async () => {
      const fixture = await startCodexPlugin(null);

      const probe = await codexDriver(fixture).probe();
      expect(probe.installed).toBe(true);
      expect(probe.version ?? "").toMatch(/codex/i);

      const { session, events } = await startSession(fixture);
      await until(
        () =>
          events.some(
            (event) => event.kind === "session-state" && event.state === "ready",
          ) || undefined,
        `the real Codex thread to start (${JSON.stringify(events).slice(0, 500)})`,
        60_000,
      );
      expect(session.sessionId.length).toBeGreaterThan(0);
      await session.dispose();
    },
    120_000,
  );
});
