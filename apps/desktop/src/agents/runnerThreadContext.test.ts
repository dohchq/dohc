import { createLiveAgentDispatchStore } from "./liveAgentDispatchStore";
import { CHATS_METHOD } from "@dohc/workspace-engine-client";
import { ChatsLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLiveLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import { createTestScratch } from "../workspaces/testTemp";
import { buildRunnerThreadContext } from "./runnerThreadContext";

const WORKSPACE_ID = "workspace-runner-thread-context";
const FIRST_MESSAGE_AT_MS = Date.parse("2026-07-10T04:05:06.000Z");

describe("buildRunnerThreadContext", () => {
  let loopback: ChatsLoopbackEngine;
  let root: string;
  let store: ReturnType<typeof createLiveLinkedChatStore>;
  let dispatchStore: ReturnType<typeof createLiveAgentDispatchStore>;

  beforeEach(async () => {
    root = await createTestScratch("dohc-runner-thread-context-");
    loopback = new ChatsLoopbackEngine();
    const client = {
      close: () => undefined,
      onEvent: () => () => undefined,
      async sendRequest(request: Parameters<ChatsLoopbackEngine["sendRequest"]>[0]) {
        if (request.method === "workspace.open") {
          return { id: request.id, result: { workspace: WORKSPACE_ID } };
        }
        if (request.method === "workspace.close") {
          return { id: request.id, result: { closed: true } };
        }
        return await loopback.sendRequest(request);
      },
    };
    const sessions = new EngineWorkspaceSessions({ currentClient: () => client });
    dispatchStore = createLiveAgentDispatchStore(
      { workspaceId: WORKSPACE_ID, rootPath: root },
      sessions,
    );
    store = createLiveLinkedChatStore({ workspaceId: WORKSPACE_ID, rootPath: root }, sessions);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seedThread(bodies: readonly string[]): Promise<void> {
    let id = 1;
    await loopback.sendRequest({
      id: id++,
      method: CHATS_METHOD.threadCreate,
      workspace: WORKSPACE_ID,
      idempotencyKey: "th_long",
      params: {
        threadId: "th_long",
        nowMs: FIRST_MESSAGE_AT_MS - 1_000,
        title: "Long thread",
        linkedFile: { objectId: "object_long", pathHint: "long.md" },
      },
    });
    for (const [index, body] of bodies.entries()) {
      await loopback.sendRequest({
        id: id++,
        method: CHATS_METHOD.messageSend,
        workspace: WORKSPACE_ID,
        idempotencyKey: `m_${index}`,
        params: {
          threadId: "th_long",
          messageId: `m_${index}`,
          nowMs: FIRST_MESSAGE_AT_MS + index,
          authorKind: "human",
          authorDisplayName: "Sam",
          body,
          attachments: [],
        },
      });
    }
  }

  const shownIds = (markdown: string) =>
    [...markdown.matchAll(/· (m_\d+)$/gm)].map((match) => match[1]);
  const context = (askingMessageId: string, readEarlier?: string) =>
    buildRunnerThreadContext({
      store,
      dispatchStore: dispatchStore.store,
      workspaceId: WORKSPACE_ID,
      threadId: "th_long",
      askingMessageId,
      ...(readEarlier ? { readEarlier } : {}),
    });

  it("reads the newest 40 when the engine cuts each page short", async () => {
    await seedThread(Array.from({ length: 45 }, (_, index) => `message ${index}`));
    // The engine ends a page at its byte budget and names where the next starts.
    const shortPages = {
      ...store,
      listMessagesPage: async (page: Parameters<typeof store.listMessagesPage>[0]) =>
        await store.listMessagesPage({ ...page, limit: Math.min(page.limit, 15) }),
    };
    const markdown = await buildRunnerThreadContext({
      store: shortPages,
      dispatchStore: dispatchStore.store,
      workspaceId: WORKSPACE_ID,
      threadId: "th_long",
      askingMessageId: "m_44",
    });
    expect(shownIds(markdown)).toEqual(Array.from({ length: 40 }, (_, index) => `m_${index + 5}`));
  });

  it("keeps a later request past 48,000 characters", async () => {
    await seedThread(["first request".padEnd(24_000, "."), "second request".padEnd(24_000, ".")]);
    const markdown = await context("m_0");
    expect(shownIds(markdown)).toEqual(["m_0", "m_1"]);
    expect(markdown.length).toBeGreaterThan(48_000);
  });

  describe("a request asked in a thread of a conversation", () => {
    const sam = { kind: "human" as const, displayName: "Sam" };
    async function seedConversation(replyBody = (index: number) => `reply ${index}`) {
      const nova = await store.ensureAgentChannel({
        workspaceId: WORKSPACE_ID,
        agentId: "default",
        name: "Nova",
      });
      const send = async (body: string, parentMessageId?: string) =>
        await store.sendMessage({
          authorActorKey: null,
          workspaceId: WORKSPACE_ID,
          threadId: chat.thread.id,
          author: sam,
          body,
          ...(parentMessageId ? { parentMessageId } : {}),
        });
      const chat = await store.startChannelThread({
        authorActorKey: null,
        workspaceId: WORKSPACE_ID,
        channelId: nova.id,
        author: sam,
        body: "stream 0",
      });
      const parent = await send("Draft the agenda");
      const replies = [];
      for (let index = 0; index < 3; index += 1) {
        await send(`stream ${index + 1}`);
        replies.push(await send(replyBody(index), parent.id));
      }
      return { threadId: chat.thread.id, parent, replies };
    }
    const bodies = (markdown: string) =>
      [
        "stream 0",
        "Draft the agenda",
        "stream 1",
        "reply 0",
        "stream 2",
        "reply 1",
        "stream 3",
        "reply 2",
      ].filter((body) => new RegExp(`^${body}`, "m").test(markdown));

    it("reads the message it hangs from and every reply, not the stream around them", async () => {
      const { threadId, replies } = await seedConversation();
      const markdown = await buildRunnerThreadContext({
        store,
        dispatchStore: dispatchStore.store,
        workspaceId: WORKSPACE_ID,
        threadId,
        askingMessageId: replies[1]!.id,
        readEarlier: "dohc chat show",
      });
      expect(bodies(markdown)).toEqual(["Draft the agenda", "reply 0", "reply 1", "reply 2"]);
      expect(markdown).toContain(
        "This request was asked in a thread of this conversation, so only that thread is shown. 4 other messages aren't shown. Read them with `dohc chat show`.",
      );

      const stream = await buildRunnerThreadContext({
        store,
        dispatchStore: dispatchStore.store,
        workspaceId: WORKSPACE_ID,
        threadId,
        askingMessageId: "message-7",
      });
      expect(bodies(stream)).toHaveLength(8);
    });
  });
});
