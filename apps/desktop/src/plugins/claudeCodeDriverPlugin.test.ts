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
 * The Claude Code driver, proven where it runs.
 *
 * Nothing below reaches into the plugin: the chain is dohc's driver registry,
 * a forked plugin process speaking the real host protocol, and the `claude`
 * CLI — here, a stand-in that speaks the same stream-json — running as a real
 * brokered command child. A double anywhere in that chain would certify the
 * double instead of the driver.
 */

const claudePluginSource = fileURLToPath(new URL("../../plugins/claude-code", import.meta.url));
const fakeClaude = fileURLToPath(
  new URL("../../plugins/claude-code/test/fakeClaudeCli.mjs", import.meta.url),
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

interface ClaudeFixture {
  drivers: PluginAgentDrivers;
  host: PluginHost;
  workspaceRoot: string;
}

/**
 * Installs the plugin the way a workspace would — a copy of its source — and
 * starts it. `claudeCommand` is what the plugin will run as `claude`; the real
 * command needs a login and a network, so every test but the last one points
 * it at a stand-in through the plugin's own documented override.
 */
async function startClaudePlugin(
  claudeCommand: { command: string; args: string[] } | null = {
    command: process.execPath,
    args: [fakeClaude, "ok"],
  },
  readyTimeoutMs?: number,
): Promise<ClaudeFixture> {
  const root = await createTestScratch("dohc-claude-plugin-");
  scratchRoots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(join(workspaceRoot, "notes"), { recursive: true });
  const pluginRoot = join(root, "plugins", "claude-code");
  await cp(claudePluginSource, pluginRoot, { recursive: true });

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
    reservedDriverIds: BUILT_IN_AGENT_DRIVER_IDS,
  });

  const spawnTransport: PluginHostOptions["spawnTransport"] = (params) => {
    const transport = JsonRpcTransport.spawn({
      command: process.execPath,
      args: [pluginHostProcessPath],
      cwd: params.pluginRoot,
      env: {
        ...(claudeCommand
          ? {
              DOHC_AGENT_CLAUDE_CODE_COMMAND: claudeCommand.command,
              DOHC_AGENT_CLAUDE_CODE_ARGS_JSON: JSON.stringify(claudeCommand.args),
            }
          : {}),
        ...(readyTimeoutMs === undefined
          ? {}
          : { DOHC_AGENT_CLAUDE_CODE_READY_TIMEOUT_MS: String(readyTimeoutMs) }),
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
  await host.start(pluginRoot, { ...manifest.manifest, entry: "bundle.mjs" });
  await until(
    () => (host?.getStatus("claude-code") === "ready" ? true : undefined),
    `the claude-code plugin to activate (${host.getStderrLog("claude-code").join(" | ")})`,
    20_000,
  );

  return { drivers, host, workspaceRoot };
}

function claudeDriver(fixture: ClaudeFixture): AgentDriver {
  const driver = fixture.drivers.list()[0];
  if (!driver) throw new Error("The claude-code plugin registered no driver.");
  return driver;
}

async function startSession(
  fixture: ClaudeFixture,
  input: Partial<Parameters<AgentDriver["startSession"]>[0]> = {},
): Promise<{ session: AgentSession; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  const session = await claudeDriver(fixture).startSession({
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

async function permissionOf(events: AgentEvent[]): Promise<
  Extract<AgentEvent, { kind: "permission-request" }>
> {
  return until(
    () =>
      events.find(
        (event): event is Extract<AgentEvent, { kind: "permission-request" }> =>
          event.kind === "permission-request",
      ),
    "Claude to ask for permission",
  );
}

describe("dohc's Claude Code driver, as a plugin", () => {
  it("is a plugin driver, not one dohc ships", async () => {
    const fixture = await startClaudePlugin();

    expect(fixture.drivers.list().map((driver) => driver.id)).toEqual(["claude-code"]);
    expect(claudeDriver(fixture).displayName).toBe("Claude Code");
    expect([...BUILT_IN_AGENT_DRIVER_IDS]).not.toContain("claude-code");
    // The ACP adapter driver dohc still ships keeps its own id. This plugin
    // drives the `claude` CLI directly and takes an id of its own, so the two
    // stand side by side rather than one replacing the other.
    expect([...BUILT_IN_AGENT_DRIVER_IDS]).toContain("claude-acp");
  });

  it("ships what installing it needs", async () => {
    // dohc installs every plugin's dependencies before it runs one, and that
    // step reads pnpm-lock.yaml whether or not the plugin declares any
    // (pluginInstallRunner.ts). A driver should have no dependencies — but a
    // plugin without the lockfile does not install at all.
    const manifest = JSON.parse(
      await readFile(join(claudePluginSource, "dohc-plugin.json"), "utf8"),
    ) as { drivers?: Array<{ id: string }> };
    expect(manifest.drivers).toEqual([{ id: "claude-code", displayName: "Claude Code" }]);
    await expect(readFile(join(claudePluginSource, "pnpm-lock.yaml"), "utf8")).resolves
      .toContain("lockfileVersion");
    const pkg = JSON.parse(
      await readFile(join(claudePluginSource, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it("reports the Claude Code it found and the login it found", async () => {
    const fixture = await startClaudePlugin();

    await expect(claudeDriver(fixture).probe()).resolves.toEqual({
      installed: true,
      version: "2.1.233 (Fake Claude Code)",
      auth: { status: "authenticated", label: "claude.ai" },
      models: [{ id: "default", name: "Default", planIncluded: true }],
    });
  });

  it("reports a Claude Code nobody is logged into as exactly that", async () => {
    const fixture = await startClaudePlugin({
      command: process.execPath,
      args: [fakeClaude, "logged-out"],
    });

    const probe = await claudeDriver(fixture).probe();
    // Installed, and unusable for a different reason than not being there.
    expect(probe.installed).toBe(true);
    expect(probe.auth.status).toBe("unauthenticated");
    expect(probe.auth.loginHint ?? "").toContain("log in");
  });

  it("says it does not know the login when Claude would not say", async () => {
    for (const mode of ["auth-unreadable", "auth-fails"]) {
      const fixture = await startClaudePlugin({
        command: process.execPath,
        args: [fakeClaude, mode],
      });
      const probe = await claudeDriver(fixture).probe();
      expect(probe.installed).toBe(true);
      expect(probe.auth.status).toBe("unknown");
    }
  }, 60_000);

  it("reports a Claude Code that is not on this machine at all", async () => {
    const fixture = await startClaudePlugin({
      command: "claude-that-is-not-installed",
      args: [],
    });

    const probe = await claudeDriver(fixture).probe();
    expect(probe.installed).toBe(false);
    expect(probe.errorMessage ?? "").toContain("claude-that-is-not-installed");
  });

  it("reports why a Claude Code that answered badly is unusable", async () => {
    const fixture = await startClaudePlugin({
      command: process.execPath,
      args: [fakeClaude, "probe-fails"],
    });

    await expect(claudeDriver(fixture).probe()).resolves.toMatchObject({
      installed: false,
      errorMessage: "fake claude is not installed properly",
      models: [],
    });
  });

  it("gives up on a Claude Code that never answers rather than waiting forever", async () => {
    const fixture = await startClaudePlugin({
      command: process.execPath,
      args: [fakeClaude, "probe-hangs"],
    });

    await expect(claudeDriver(fixture).probe()).resolves.toMatchObject({
      installed: false,
      errorMessage: "Probe timed out.",
    });
  }, 20_000);

  it("starts Claude in the workspace, with dohc holding the permissions", async () => {
    const fixture = await startClaudePlugin();
    const { session, events } = await startSession(fixture, {
      mcp: {
        command: "dohc-mcp",
        args: ["--workspace", fixture.workspaceRoot],
        env: { DOHC_MCP_CLOUD_USER_ID: "user-1" },
      },
    });

    await session.prompt({ text: "write the note" });
    await until(() => (echoed(events, "argv-echo") ? true : undefined), "Claude to report its argv");
    const started = echoed(events, "argv-echo") as { args: string[]; cwd: string };

    // The permission seam, as it actually reached the harness. Without this
    // pair of arguments Claude answers its own prompts and dohc is never
    // asked — which is the whole reason this driver speaks the native
    // protocol instead of an adapter.
    expect(started.args).toContain("--permission-prompt-tool");
    expect(started.args[started.args.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
    // Claude has no working-directory flag: the workspace is the child's cwd.
    expect(started.cwd).toBe(fixture.workspaceRoot);
    expect(started.args[started.args.indexOf("--permission-mode") + 1]).toBe("manual");
    expect(
      JSON.parse(started.args[started.args.indexOf("--mcp-config") + 1] ?? "null"),
    ).toEqual({
      mcpServers: {
        dohc: {
          command: "dohc-mcp",
          args: ["--workspace", fixture.workspaceRoot],
          env: { DOHC_MCP_CLOUD_USER_ID: "user-1" },
        },
      },
    });
    // A session dohc calls ready is one that answered the handshake.
    expect(events.filter((event) => event.kind === "session-state").map((e) => e.state)).toEqual([
      "starting",
      "ready",
      "running",
    ]);
    await session.dispose();
  }, 30_000);

  it("asks Claude for the permission mode each dohc mode allows", async () => {
    for (const [mode, expected] of [
      ["approval-required", "manual"],
      ["auto-accept-edits", "acceptEdits"],
      ["full-access", "bypassPermissions"],
    ] as const) {
      const fixture = await startClaudePlugin();
      const { session, events } = await startSession(fixture, { mode });
      await session.prompt({ text: "write the note" });
      await until(() => (echoed(events, "argv-echo") ? true : undefined), `${mode} to start`);

      const started = echoed(events, "argv-echo") as { args: string[] };
      expect(started.args[started.args.indexOf("--permission-mode") + 1]).toBe(expected);
      await session.dispose();
    }
  }, 90_000);

  it("carries a whole turn between dohc and Claude", async () => {
    const fixture = await startClaudePlugin();
    const { session, events } = await startSession(fixture);

    const { turnId } = await session.prompt({ text: "write the note" });
    expect(turnId.length).toBeGreaterThan(0);

    const permission = await permissionOf(events);
    expect(permission).toMatchObject({
      requestType: "file-change",
      title: "Write",
      detail: "notes/claude-output.md",
      locations: ["notes/claude-output.md"],
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

    // Claude only did the work because dohc allowed it.
    await expect(
      readFile(join(fixture.workspaceRoot, "notes", "claude-output.md"), "utf8"),
    ).resolves.toContain("Fake Claude wrote this");
    // The driver's own record of the answer. The plugin path depends on the
    // driver emitting this; nothing else can see a decision made inside the
    // harness conversation.
    expect(events).toContainEqual({
      kind: "permission-resolved",
      requestId: permission.requestId,
      decision: "allow_once",
    });
    expect(events).toContainEqual({ kind: "token-usage", used: 18, input: 11, output: 7 });
    // The turn dohc was told to wait for is the turn that ended.
    expect(events).toContainEqual({
      kind: "turn-completed",
      turnId,
      status: "completed",
      errorMessage: undefined,
    });
    await session.dispose();
  }, 30_000);

  it("leaves the work undone when dohc rejects it", async () => {
    const fixture = await startClaudePlugin();
    const { session, events } = await startSession(fixture);

    await session.prompt({ text: "write the note" });
    const permission = await permissionOf(events);
    await session.answerPermission(permission.requestId, "reject_once");
    await until(
      () => (events.some((event) => event.kind === "turn-completed") ? true : undefined),
      "the turn to complete",
    );

    await expect(
      readFile(join(fixture.workspaceRoot, "notes", "claude-output.md"), "utf8"),
    ).rejects.toThrow();
    expect(events).toContainEqual({
      kind: "permission-resolved",
      requestId: permission.requestId,
      decision: "reject_once",
    });
    // What Claude was told, read back off the wire.
    expect(echoed(events, "permission-echo")).toMatchObject({ behavior: "deny" });
    await session.dispose();
  }, 30_000);

  it("keeps 'allow for session' out of the user's own Claude settings", async () => {
    const fixture = await startClaudePlugin();
    const { session, events } = await startSession(fixture);

    await session.prompt({ text: "write the note" });
    const permission = await permissionOf(events);
    await session.answerPermission(permission.requestId, "allow_always");
    await until(
      () => (echoed(events, "permission-echo") ? true : undefined),
      "Claude to report the answer",
    );

    const answered = echoed(events, "permission-echo") as {
      behavior: string;
      updatedPermissions?: Array<{ destination: string; type: string }>;
    };
    expect(answered.behavior).toBe("allow");
    // Claude suggested one session rule, one rule for the user's own settings
    // file, and a mode change for the whole session. Only the rules crossed,
    // and both crossed as session rules.
    expect(answered.updatedPermissions?.map((rule) => rule.destination)).toEqual([
      "session",
      "session",
    ]);
    expect(JSON.stringify(answered)).not.toContain("localSettings");
    expect(JSON.stringify(answered)).not.toContain("setMode");
    await session.dispose();
  }, 30_000);

  it("reads Claude's messages however the pipe breaks them up", async () => {
    const fixture = await startClaudePlugin({
      command: process.execPath,
      args: [fakeClaude, "chunked"],
    });
    const { session, events } = await startSession(fixture);

    // This harness writes every message in seven-character pieces, so whole
    // messages arrive split and separate messages arrive joined.
    await session.prompt({ text: "write the note" });
    const permission = await permissionOf(events);
    await session.answerPermission(permission.requestId, "allow_once");
    await until(
      () => (events.some((event) => event.kind === "turn-completed") ? true : undefined),
      "the turn to complete",
    );

    await expect(
      readFile(join(fixture.workspaceRoot, "notes", "claude-output.md"), "utf8"),
    ).resolves.toContain("Fake Claude wrote this");
    await session.dispose();
  }, 30_000);

  it("continues a session dohc started before", async () => {
    const fixture = await startClaudePlugin();
    const { session, events } = await startSession(fixture, { resumeCursor: "kept-session-id" });

    await session.prompt({ text: "carry on" });
    await until(() => (echoed(events, "argv-echo") ? true : undefined), "Claude to report its argv");

    const started = echoed(events, "argv-echo") as { args: string[] };
    expect(started.args[started.args.indexOf("--resume") + 1]).toBe("kept-session-id");
    // Naming a session and continuing one are alternatives, never both.
    expect(started.args).not.toContain("--session-id");
    expect(session.resumeCursor).toBe("kept-session-id");
    await session.dispose();
  }, 30_000);

  it("reports an end for a session that never started", async () => {
    const fixture = await startClaudePlugin({
      command: "claude-that-is-not-installed",
      args: [],
    });
    const events: AgentEvent[] = [];

    await expect(
      claudeDriver(fixture).startSession({
        workspaceRoot: fixture.workspaceRoot,
        mode: "approval-required",
        mcp: { command: "dohc-mcp", args: ["--workspace", fixture.workspaceRoot] },
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow(/claude-that-is-not-installed/);

    // A session left reporting "starting" is one a surface waits on forever.
    expect(events.map((event) => event.kind === "session-state" && event.state)).toEqual([
      "starting",
      "closed",
    ]);
  }, 30_000);

  it("gives up on a session Claude will not resume", async () => {
    const fixture = await startClaudePlugin({
      command: process.execPath,
      args: [fakeClaude, "resume-missing"],
    });
    const events: AgentEvent[] = [];

    await expect(
      claudeDriver(fixture).startSession({
        workspaceRoot: fixture.workspaceRoot,
        mode: "approval-required",
        resumeCursor: "a-session-claude-forgot",
        mcp: { command: "dohc-mcp", args: ["--workspace", fixture.workspaceRoot] },
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow(/No conversation found/);

    await until(
      () =>
        events.some((event) => event.kind === "session-state" && event.state === "closed") ||
        undefined,
      "the failed Claude process to close",
    );
  }, 30_000);

  it("gives up on a Claude that starts but never answers", async () => {
    // The control channel is dead: the process is up, so nothing fails at
    // spawn, and it will never speak. Without a deadline the session waits
    // forever and the surface waits with it.
    const fixture = await startClaudePlugin(
      { command: process.execPath, args: [fakeClaude, "no-handshake"] },
      1500,
    );
    const events: AgentEvent[] = [];

    const started = Date.now();
    await expect(
      claudeDriver(fixture).startSession({
        workspaceRoot: fixture.workspaceRoot,
        mode: "approval-required",
        mcp: { command: "dohc-mcp", args: ["--workspace", fixture.workspaceRoot] },
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow(/did not answer dohc's handshake within 1500ms/);
    // The deadline is the configured one, not the production default.
    expect(Date.now() - started).toBeLessThan(15_000);

    // A session that reported "starting" reports an end.
    await until(
      () =>
        events.some((event) => event.kind === "session-state" && event.state === "closed") ||
        undefined,
      "the silent Claude to close",
    );

    // And the harness dohc gave up on is gone, not left running.
    const pid = Number(
      await readFile(join(fixture.workspaceRoot, "no-handshake.pid"), "utf8"),
    );
    expect(Number.isFinite(pid)).toBe(true);
    await until(
      () => {
        try {
          process.kill(pid, 0);
          return undefined;
        } catch {
          return true;
        }
      },
      `the abandoned harness (pid ${pid}) to be gone`,
    );
  }, 30_000);

  it("says so when Claude speaks before dohc can place the message", async () => {
    const fixture = await startClaudePlugin({
      command: process.execPath,
      args: [fakeClaude, "speaks-early"],
    });
    const { session, events } = await startSession(fixture);

    // The message is dropped either way. Reporting it is what separates a
    // protocol that changed under dohc from a silence nobody can explain.
    expect(events).toContainEqual({
      kind: "error",
      message: "Claude spoke before the session was ready; the message was dropped.",
      fatal: false,
    });
    // Not fatal: the session still started.
    expect(events.some((event) => event.kind === "session-state" && event.state === "ready")).toBe(
      true,
    );
    await session.dispose();
  }, 30_000);

  it("refuses the request dohc cannot answer, and says so", async () => {
    const fixture = await startClaudePlugin({
      command: process.execPath,
      args: [fakeClaude, "dialog"],
    });
    const { session, events } = await startSession(fixture);

    await session.prompt({ text: "write the note" });
    const refusal = await until(
      () =>
        events.find(
          (event): event is Extract<AgentEvent, { kind: "error" }> =>
            event.kind === "error" && event.message.includes("request_user_dialog"),
        ),
      "the dialog refusal",
    );

    // The refusal does not end the session: Claude is asked to carry on.
    expect(refusal.fatal).toBe(false);
    const permission = await permissionOf(events);
    await session.answerPermission(permission.requestId, "allow_once");
    await until(
      () => (events.some((event) => event.kind === "turn-completed") ? true : undefined),
      "the turn to complete",
    );
    await session.dispose();
  }, 30_000);

  it("cancels a turn that has not finished", async () => {
    const fixture = await startClaudePlugin({
      command: process.execPath,
      args: [fakeClaude, "no-turn-end"],
    });
    const { session, events } = await startSession(fixture);

    const { turnId } = await session.prompt({ text: "write the note" });
    await until(
      () => (events.some((event) => event.kind === "item") ? true : undefined),
      "Claude to start work",
    );
    await session.cancel();

    const completed = await until(
      () =>
        events.find(
          (event): event is Extract<AgentEvent, { kind: "turn-completed" }> =>
            event.kind === "turn-completed",
        ),
      "the cancelled turn to end",
    );
    expect(completed).toMatchObject({ turnId, status: "cancelled" });
    await session.dispose();
  }, 30_000);

  // The real `claude` on this machine, which needs an install and a login. It
  // proves the one thing a stand-in never can: that what this driver sends is
  // what Claude Code accepts. Opt in with DOHC_TEST_REAL_CLAUDE=1.
  it.runIf(process.env.DOHC_TEST_REAL_CLAUDE === "1")(
    "runs a turn in the real Claude Code on this machine",
    async () => {
      const fixture = await startClaudePlugin(null);

      const probe = await claudeDriver(fixture).probe();
      expect(probe.installed).toBe(true);
      expect(probe.version ?? "").toMatch(/\d+\.\d+/);
      expect(probe.auth.status).toBe("authenticated");

      const { session, events } = await startSession(fixture);
      const { turnId } = await session.prompt({
        text: "Reply with the single word ready. Do not use any tool.",
      });
      const completed = await until(
        () =>
          events.find(
            (event): event is Extract<AgentEvent, { kind: "turn-completed" }> =>
              event.kind === "turn-completed",
          ),
        `the real Claude turn to end (${JSON.stringify(events).slice(0, 800)})`,
        120_000,
      );
      expect(completed.turnId).toBe(turnId);
      expect(session.sessionId.length).toBeGreaterThan(0);
      await session.dispose();
    },
    180_000,
  );
});
