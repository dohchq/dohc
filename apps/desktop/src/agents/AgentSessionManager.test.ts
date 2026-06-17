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

function harness(options: { startSession?: (input: AgentSessionStartInput) => Promise<AgentSession> } = {}) {
  const eventHandlers: Array<(event: AgentEvent) => void> = [];
  let runCount = 0;
  const driver: AgentDriver = {
    id: "fake-driver",
    displayName: "Fake",
    async probe() {
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
    mcpFor: () => ({ command: "dohc-mcp", args: [] }),
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
