import { rm } from "node:fs/promises";
import type { Request } from "@dohc/workspace-engine-client";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { ChatsLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { describe, expect, it, vi } from "vitest";
import { AUTOMATION_NO_RUNNER, wakeAgent, type AgentWakeDependencies, type WokenAgent } from "./automationAgentWake";
import { automationAgentWakeThreadId, type AutomationChatMessage } from "@dohc/automation-executor/automation-chat";
import { createLiveLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import { createTestScratch } from "../workspaces/testTemp";

const message: AutomationChatMessage = {
  target: { kind: "agent" },
  effectId: "atc_1/h/0/wake",
  messageId: "message-auto-1",
  threadId: "thread-auto-wake",
  automation: { automationId: "collection:Tasks#ask", name: "Ask my agent", depth: 1 },
  body: "Plan the trip",
};

// Codex's thread for this automation.
const codexThread = automationAgentWakeThreadId("collection:Tasks#ask", "codex");

function dependencies(overrides: Partial<AgentWakeDependencies> = {}) {
  return {
    posted: vi.fn(async (_messageId: string) => null),
    readyAgent: vi.fn(async (): Promise<WokenAgent | null> => ({ id: "codex", name: "Codex" })),
    agentChannelId: vi.fn(async () => "agent-channel"),
    threadExists: vi.fn(async () => false),
    start: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    recordTrigger: vi.fn(async () => true),
    scan: vi.fn(),
    ...overrides,
  };
}

describe("waking a person's agent", () => {
  it("keeps the wake in its own thread when the agent DM's conversation already exists", async () => {
    const root = await createTestScratch("dohc-agent-wake-");
    const loopback = new ChatsLoopbackEngine();
    const client = {
      close: () => undefined,
      onEvent: () => () => undefined,
      sendRequest: async (request: Request) => request.method === "workspace.open"
        ? { id: request.id, result: { workspace: "ws" } }
        : await loopback.sendRequest(request),
    };
    const sessions = new EngineWorkspaceSessions({ currentClient: () => client });
    const store = createLiveLinkedChatStore({ workspaceId: "ws", rootPath: root }, sessions);
    try {
      const channelId = (await store.ensureAgentChannel({ workspaceId: "ws", agentId: "codex", name: "Codex" })).id;
      const person = { authorActorKey: null, workspaceId: "ws", channelId, author: { kind: "human" as const, displayName: "Sam" } };
      const conversation = (await store.startChannelThread({ ...person, body: "Hello" })).thread.id;
      const recorded = vi.fn(async () => true);
      await wakeAgent(dependencies({
        agentChannelId: async () => channelId,
        start: async ({ message: wake, ownThread }) => store.startChannelThread({
          ...person, threadId: wake.threadId, title: wake.automation.name, body: wake.body, ownThread,
        }),
        recordTrigger: recorded,
      }), message);

      expect(recorded).toHaveBeenCalledWith({ triggerMessageId: "message-auto-1", threadId: codexThread, agentId: "codex" });
      expect(await store.findThreadChannelId({ workspaceId: "ws", threadId: codexThread })).toBe(channelId);
      expect(conversation).not.toBe(codexThread);
      // A person's next message still joins the conversation.
      expect((await store.startChannelThread({ ...person, body: "Again" })).thread.id).toBe(conversation);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails before writing when no agent runner is set up", async () => {
    const wake = dependencies({ readyAgent: vi.fn(async () => null) });
    await expect(wakeAgent(wake, message)).rejects.toThrow(AUTOMATION_NO_RUNNER);
    expect(wake.start).not.toHaveBeenCalled();
    expect(wake.recordTrigger).not.toHaveBeenCalled();
  });
});

it("keeps a background wake open until dispatch has scanned its trigger", async () => {
  const scanned = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const wake = dependencies({ scan: () => { entered.resolve(); return scanned.promise; } });
  let done = false;
  const run = wakeAgent(wake, message).then(() => { done = true; });
  await entered.promise;
  expect(done).toBe(false);
  scanned.resolve();
  await run;
  expect(done).toBe(true);
});
