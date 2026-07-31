import { describe, expect, it, vi } from "vitest";
import type {
  AgentDriver,
  AgentEvent,
  AgentSession,
  AgentSessionStartInput,
} from "./AgentDriver";
import { createAgentDriverRegistry } from "./AgentDriver";
import type { AgentIntegration } from "./AgentIntegration";
import { createAgentSessionManager } from "./AgentSessionManager";

class FakeSession implements AgentSession {
  readonly sessionId = "fake-session";
  readonly resumeCursor = "fake-session";

  async prompt(): Promise<{ turnId: string }> {
    return { turnId: "turn-1" };
  }

  async cancel(): Promise<void> {}
  async answerPermission(): Promise<void> {}
  async stop(): Promise<void> {}
  async dispose(): Promise<void> {}
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness(
  options: {
    startSession?: (input: AgentSessionStartInput) => Promise<AgentSession>;
    probe?: AgentDriver["probe"];
    mcpFor?: (
      rootPath: string,
    ) => AgentSessionStartInput["mcp"] | Promise<AgentSessionStartInput["mcp"]>;
  } = {},
) {
  const eventHandlers: Array<(event: AgentEvent) => void> = [];
  let runCount = 0;
  const driver: AgentDriver = {
    id: "fake-driver",
    displayName: "Fake",
    async probe(env) {
      if (options.probe) return options.probe(env);
      return { installed: true, auth: { status: "unknown" }, models: [] };
    },
    async startSession(input: AgentSessionStartInput) {
      eventHandlers.push(input.onEvent);
      if (options.startSession) return options.startSession(input);
      return new FakeSession();
    },
  };
  const startAgentRun = vi.fn(async () => {
    runCount += 1;
    return {
      id: `run-${runCount}`,
      startedAt: 1,
      agentId: "fake",
      onBehalfOf: "local",
      status: "running" as const,
    };
  });
  const endAgentRun = vi.fn(async () => undefined);
  const integration = {
    startAgentRun,
    endAgentRun,
    getAgentRunStatus: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as AgentIntegration;
  const manager = createAgentSessionManager({
    registry: createAgentDriverRegistry([driver]),
    integration,
    rootFor: () => "/tmp/workspace",
    mcpFor: options.mcpFor ?? (() => ({ command: "dohc-mcp", args: [] })),
    now: () => 10,
  });
  return {
    manager,
    integration,
    endAgentRun,
    emit(event: AgentEvent, index = eventHandlers.length - 1) {
      const onEvent = eventHandlers[index];
      if (!onEvent) throw new Error("session was not started");
      onEvent(event);
    },
  };
}

describe("AgentSessionManager", () => {
  it("passes main-owned MCP env through to the selected driver", async () => {
    const captured: AgentSessionStartInput[] = [];
    const { manager } = harness({
      mcpFor: () => ({
        command: "dohc-mcp",
        args: ["--workspace", "/tmp/workspace"],
        env: { DOHC_MCP_CLOUD_TOKEN: "tok" },
      }),
      async startSession(input) {
        captured.push(input);
        return new FakeSession();
      },
    });

    await manager.startSession({
      workspaceId: "ws-1",
      driverId: "fake-driver",
      prompt: "go",
    });

    expect(captured[0]?.mcp).toEqual({
      command: "dohc-mcp",
      args: ["--workspace", "/tmp/workspace"],
      env: { DOHC_MCP_CLOUD_TOKEN: "tok" },
    });
  });

  it("awaits the main-owned MCP environment before starting the provider", async () => {
    const mcp = deferred<NonNullable<AgentSessionStartInput["mcp"]>>();
    const mcpRequested = deferred<void>();
    const mcpFor = vi.fn(() => {
      mcpRequested.resolve(undefined);
      return mcp.promise;
    });
    const startSession = vi.fn(async () => new FakeSession());
    const { manager } = harness({
      mcpFor,
      startSession,
    });

    const starting = manager.startSession({
      workspaceId: "ws-1",
      driverId: "fake-driver",
      prompt: "go",
    });
    await mcpRequested.promise;
    expect(mcpFor).toHaveBeenCalledWith("/tmp/workspace");
    expect(startSession).not.toHaveBeenCalled();

    mcp.resolve({
      command: "dohc-mcp",
      args: [],
      env: { DOHC_MCP_CLOUD_USER_ID: "user-1" },
    });
    await starting;
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mcp: expect.objectContaining({
          env: { DOHC_MCP_CLOUD_USER_ID: "user-1" },
        }),
      }),
    );
  });

  it("does not start the provider after stopSession ends a pending MCP lookup", async () => {
    const mcp = deferred<NonNullable<AgentSessionStartInput["mcp"]>>();
    const mcpRequested = deferred<void>();
    const startSession = vi.fn(async () => new FakeSession());
    const { manager, integration } = harness({
      mcpFor() {
        mcpRequested.resolve(undefined);
        return mcp.promise;
      },
      startSession,
    });

    const starting = manager.startSession({
      workspaceId: "ws-1",
      driverId: "fake-driver",
      prompt: "go",
    });
    await mcpRequested.promise;
    await expect(manager.stopSession("ws-1")).resolves.toMatchObject({
      session: { status: "stopped" },
    });

    mcp.resolve({ command: "dohc-mcp", args: [] });
    await expect(starting).resolves.toMatchObject({
      session: { status: "stopped" },
    });
    expect(startSession).not.toHaveBeenCalled();
    expect(integration.startAgentRun).not.toHaveBeenCalled();
  });

  it("does not start the provider after stopAll ends a pending MCP lookup", async () => {
    const mcp = deferred<NonNullable<AgentSessionStartInput["mcp"]>>();
    const mcpRequested = deferred<void>();
    const startSession = vi.fn(async () => new FakeSession());
    const { manager, integration } = harness({
      mcpFor() {
        mcpRequested.resolve(undefined);
        return mcp.promise;
      },
      startSession,
    });

    const starting = manager.startSession({
      workspaceId: "ws-1",
      driverId: "fake-driver",
      prompt: "go",
    });
    await mcpRequested.promise;
    await manager.stopAll();
    expect(manager.panelSnapshot("ws-1").session).toBeNull();

    mcp.resolve({ command: "dohc-mcp", args: [] });
    await expect(starting).resolves.toMatchObject({ session: null });
    expect(startSession).not.toHaveBeenCalled();
    expect(integration.startAgentRun).not.toHaveBeenCalled();
  });

  it("keeps a stopped session stopped when its pending MCP lookup rejects", async () => {
    const mcp = deferred<NonNullable<AgentSessionStartInput["mcp"]>>();
    const mcpRequested = deferred<void>();
    const startSession = vi.fn(async () => new FakeSession());
    const { manager, integration } = harness({
      mcpFor() {
        mcpRequested.resolve(undefined);
        return mcp.promise;
      },
      startSession,
    });

    const starting = manager.startSession({
      workspaceId: "ws-1",
      driverId: "fake-driver",
      prompt: "go",
    });
    await mcpRequested.promise;
    await manager.stopSession("ws-1");
    mcp.reject(new Error("MCP setup failed after cancellation"));

    await expect(starting).resolves.toMatchObject({
      session: { status: "stopped", lastError: undefined },
    });
    expect(startSession).not.toHaveBeenCalled();
    expect(integration.startAgentRun).not.toHaveBeenCalled();
  });

  it("passes only agent probe allowlist env through to drivers", async () => {
    const captured: Array<Record<string, string | undefined> | undefined> = [];
    const previousSecret = process.env.DOHC_TEST_SECRET_TOKEN;
    const previousAgentCommand = process.env.DOHC_AGENT_FAKE_COMMAND;
    process.env.DOHC_TEST_SECRET_TOKEN = "do-not-leak";
    process.env.DOHC_AGENT_FAKE_COMMAND = "fake-agent";
    try {
      const { manager } = harness({
        async probe(env) {
          captured.push(env);
          return { installed: true, auth: { status: "unknown" }, models: [] };
        },
      });

      await manager.probeDrivers();

      expect(captured[0]).toMatchObject({ DOHC_AGENT_FAKE_COMMAND: "fake-agent" });
      expect(captured[0]).not.toHaveProperty("DOHC_TEST_SECRET_TOKEN");
    } finally {
      if (previousSecret === undefined) delete process.env.DOHC_TEST_SECRET_TOKEN;
      else process.env.DOHC_TEST_SECRET_TOKEN = previousSecret;
      if (previousAgentCommand === undefined) delete process.env.DOHC_AGENT_FAKE_COMMAND;
      else process.env.DOHC_AGENT_FAKE_COMMAND = previousAgentCommand;
    }
  });

  it("ends attribution as failed when the provider closes before turn completion", async () => {
    const { manager, endAgentRun, emit } = harness();
    await manager.startSession({
      workspaceId: "ws-1",
      driverId: "fake-driver",
      prompt: "go",
    });

    emit({ kind: "session-state", state: "closed" });
    emit({ kind: "permission-resolved", requestId: "permission-1", decision: "allow_once" });

    expect(endAgentRun).toHaveBeenCalledWith("ws-1", "run-1", "failed");
    expect(manager.panelSnapshot("ws-1").session?.status).toBe("failed");
  });

  it("does not start attribution when the provider closes during startup", async () => {
    const prompt = vi.fn(async () => ({ turnId: "turn-1" }));
    const dispose = vi.fn(async () => undefined);
    const closingSession: AgentSession = {
      sessionId: "closing-session",
      resumeCursor: "closing-session",
      prompt,
      cancel: vi.fn(async () => undefined),
      answerPermission: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      dispose,
    };
    const { manager, integration } = harness({
      async startSession(input) {
        input.onEvent({ kind: "session-state", state: "closed" });
        return closingSession;
      },
    });

    await manager.startSession({
      workspaceId: "ws-1",
      driverId: "fake-driver",
      prompt: "go",
    });

    expect(integration.startAgentRun).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
    expect(manager.panelSnapshot("ws-1").session?.status).toBe("failed");
  });

  it("rejects a concurrent start for the same workspace (one session, no duplicate)", async () => {
    // Hold the first start open so it is still in flight when the second fires.
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let driverStarts = 0;
    const { manager, integration } = harness({
      async startSession() {
        driverStarts += 1;
        await gate;
        return new FakeSession();
      },
    });

    const first = manager.startSession({ workspaceId: "ws-1", driverId: "fake-driver", prompt: "a" });
    // Second call while the first is mid-flight — rejected synchronously.
    const second = manager.startSession({ workspaceId: "ws-1", driverId: "fake-driver", prompt: "b" });
    await expect(second).rejects.toThrow(/already starting/i);

    releaseFirst();
    await first;
    // Only ONE session/run was ever created.
    expect(driverStarts).toBe(1);
    expect(integration.startAgentRun).toHaveBeenCalledTimes(1);
  });

  it("allows a fresh start for a DIFFERENT workspace concurrently", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let driverStarts = 0;
    const { manager } = harness({
      async startSession() {
        driverStarts += 1;
        await gate;
        return new FakeSession();
      },
    });
    const a = manager.startSession({ workspaceId: "ws-a", driverId: "fake-driver", prompt: "a" });
    const b = manager.startSession({ workspaceId: "ws-b", driverId: "fake-driver", prompt: "b" });
    release();
    await Promise.all([a, b]);
    expect(driverStarts).toBe(2);
  });

  it("permits a sequential restart after the first start settles", async () => {
    const { manager } = harness();
    await manager.startSession({ workspaceId: "ws-1", driverId: "fake-driver", prompt: "a" });
    // Not concurrent — the mutex has been released, so a restart is allowed.
    await expect(
      manager.startSession({ workspaceId: "ws-1", driverId: "fake-driver", prompt: "b" }),
    ).resolves.toBeDefined();
  });

  it("ends attribution as failed when the provider reports a fatal error", async () => {
    const { manager, endAgentRun, emit } = harness();
    await manager.startSession({
      workspaceId: "ws-1",
      driverId: "fake-driver",
      prompt: "go",
    });
    emit({
      kind: "permission-request",
      requestId: "permission-1",
      requestType: "tool",
      title: "Permission",
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });

    emit({ kind: "error", message: "provider died", fatal: true });
    emit({ kind: "permission-resolved", requestId: "permission-1", decision: "allow_once" });

    const session = manager.panelSnapshot("ws-1").session;
    expect(endAgentRun).toHaveBeenCalledWith("ws-1", "run-1", "failed");
    expect(session?.status).toBe("failed");
    expect(session?.pendingPermissions).toHaveLength(0);
  });

  it("does not downgrade failed attribution to complete when stopped later", async () => {
    const { manager, endAgentRun, emit } = harness();
    await manager.startSession({
      workspaceId: "ws-1",
      driverId: "fake-driver",
      prompt: "go",
    });

    emit({ kind: "error", message: "provider died", fatal: true });
    endAgentRun.mockClear();
    await manager.stopSession("ws-1");

    expect(endAgentRun).not.toHaveBeenCalled();
    expect(manager.panelSnapshot("ws-1").session?.status).toBe("failed");
  });

  it("ignores late terminal events after explicit stop", async () => {
    const { manager, endAgentRun, emit } = harness();
    await manager.startSession({
      workspaceId: "ws-1",
      driverId: "fake-driver",
      prompt: "go",
    });
    await manager.stopSession("ws-1");
    endAgentRun.mockClear();

    emit({ kind: "turn-completed", turnId: "turn-1", status: "failed" });

    expect(endAgentRun).not.toHaveBeenCalled();
    expect(manager.panelSnapshot("ws-1").session?.status).toBe("stopped");
  });

  it("ignores late events from a provider session replaced by a new session", async () => {
    const { manager, endAgentRun, emit } = harness();
    await manager.startSession({
      workspaceId: "ws-1",
      driverId: "fake-driver",
      prompt: "first",
    });
    await manager.startSession({
      workspaceId: "ws-1",
      driverId: "fake-driver",
      prompt: "second",
    });

    emit({ kind: "session-state", state: "closed" }, 0);
    emit({ kind: "turn-completed", turnId: "turn-2", status: "completed" }, 1);

    expect(endAgentRun).not.toHaveBeenCalledWith("ws-1", "run-2", "failed");
    expect(manager.panelSnapshot("ws-1").session?.status).toBe("completed");
  });

  it("caps long session arrays before producing renderer snapshots", async () => {
    const { manager, emit } = harness();
    await manager.startSession({
      workspaceId: "ws-1",
      driverId: "fake-driver",
      prompt: "go",
    });

    for (let index = 0; index < 205; index += 1) {
      emit({
        kind: "text-delta",
        itemId: `message-${index}`,
        stream: "assistant",
        text: `${index}`,
      });
      emit({
        kind: "item",
        phase: "started",
        item: {
          id: `item-${index}`,
          type: "tool_call",
          title: `Tool ${index}`,
          status: "in_progress",
        },
      });
    }
    emit({
      kind: "text-delta",
      itemId: "long-message",
      stream: "assistant",
      text: "m".repeat(10_050),
    });
    emit({ kind: "auth", event: "rate-limits", detail: "a".repeat(350) });
    emit({ kind: "error", message: "e".repeat(550), fatal: false });
    for (let index = 0; index < 25; index += 1) {
      emit({
        kind: "permission-request",
        requestId: `permission-${index}`,
        requestType: "tool",
        title: `Permission ${index}`,
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });
    }

    const session = manager.panelSnapshot("ws-1").session;
    expect(session?.messages).toHaveLength(200);
    expect(session?.items).toHaveLength(200);
    expect(session?.pendingPermissions).toHaveLength(20);
    expect(session?.messages.at(-1)?.text).toHaveLength(10_000);
    expect(session?.authNotices.at(-1)).toHaveLength(300);
    expect(session?.lastError).toHaveLength(500);
  });
});
