import { createLiveAgentDispatchStore } from "./liveAgentDispatchStore";
import { renderShowMarkdown, type ShowResult } from "@dohc/cli/render";
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
    dispatchStore = createLiveAgentDispatchStore({ workspaceId: WORKSPACE_ID, rootPath: root }, sessions);
    store = createLiveLinkedChatStore({ workspaceId: WORKSPACE_ID, rootPath: root }, sessions);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("is byte-identical to CLI show markdown for the same thread", async () => {
    await loopback.sendRequest({
      id: 1,
      method: CHATS_METHOD.threadCreate,
      workspace: WORKSPACE_ID,
      idempotencyKey: "th_1",
      params: {
        threadId: "th_1",
        nowMs: FIRST_MESSAGE_AT_MS - 1_000,
        title: "Launch review",
        linkedFile: { objectId: "object_launch", pathHint: "plans/launch.md" },
      },
    });
    await loopback.sendRequest({
      id: 2,
      method: CHATS_METHOD.messageSend,
      workspace: WORKSPACE_ID,
      idempotencyKey: "msg_1",
      params: {
        threadId: "th_1",
        messageId: "msg_1",
        nowMs: FIRST_MESSAGE_AT_MS,
        authorKind: "human",
        authorDisplayName: "Sam",
        body: "Please audit the launch plan.\nFocus on rollback safety.",
        attachments: [
          { objectId: "object_metrics", pathHint: "data/metrics.csv" },
          { objectId: "object_launch", pathHint: "plans/launch.md" },
        ],
      },
    });
    await loopback.sendRequest({
      id: 3,
      method: CHATS_METHOD.messageSend,
      workspace: WORKSPACE_ID,
      idempotencyKey: "msg_2",
      params: {
        threadId: "th_1",
        messageId: "msg_2",
        nowMs: FIRST_MESSAGE_AT_MS + 1_000,
        authorKind: "agent",
        authorDisplayName: "Sam",
        body: "I found one rollback gap and documented it.",
        attachments: [{ objectId: "object_without_path" }],
      },
    });

    const cliShowFixture: ShowResult = {
      dispatch: { paused: null, lastRun: null },
      thread: {
        id: "th_1",
        title: "Launch review",
        group: {
          id: "files",
          name: "files",
          slug: "files",
          kind: "group",
        },
        commentCount: 1,
        openDecisionCount: 0,
      },
      messages: [
        {
          id: "msg_1",
          author: { kind: "human", displayName: "Sam" },
          body: "Please audit the launch plan.\nFocus on rollback safety.",
          createdAtMs: FIRST_MESSAGE_AT_MS,
          attachments: [
            { objectId: "object_metrics", pathHint: "data/metrics.csv" },
            { objectId: "object_launch", pathHint: "plans/launch.md" },
          ],
        },
        {
          id: "msg_2",
          author: { kind: "agent", displayName: "Sam" },
          body: "I found one rollback gap and documented it.",
          createdAtMs: FIRST_MESSAGE_AT_MS + 1_000,
          attachments: [{ objectId: "object_without_path" }],
        },
      ],
    };

    await expect(buildRunnerThreadContext({
      dispatchStore: dispatchStore.store,
      store,
      workspaceId: WORKSPACE_ID,
      threadId: "th_1",
      askingMessageId: "msg_1",
    })).resolves.toBe(renderShowMarkdown(cliShowFixture));
    await dispatchStore.store.recordTrigger({ workspaceId: WORKSPACE_ID, threadId: "th_1", triggerMessageId: "msg_1", agentId: "default" });
    const claim = await dispatchStore.store.claimNextPending(WORKSPACE_ID);
    if (!claim) throw new Error("Expected run");
    await dispatchStore.store.completeRun({ runId: claim.run.runId, exitCode: 0 });
    await dispatchStore.store.markFailureHandled(claim.run.runId);
    cliShowFixture.dispatch.lastRun = { state: "failed", failureReason: "no-reply", exitCode: 0 };
    await expect(buildRunnerThreadContext({
      dispatchStore: dispatchStore.store, store, workspaceId: WORKSPACE_ID, threadId: "th_1", askingMessageId: "msg_1",
    })).resolves.toBe(renderShowMarkdown(cliShowFixture));
    await dispatchStore.store.setThreadDispatchPaused({ workspaceId: WORKSPACE_ID, threadId: "th_1", paused: true, reason: "re-dispatch budget exceeded" });
    await expect(buildRunnerThreadContext({ store, dispatchStore: dispatchStore.store, workspaceId: WORKSPACE_ID, threadId: "th_1", askingMessageId: "msg_1" })).resolves.toBe(renderShowMarkdown({ ...cliShowFixture, dispatch: { ...cliShowFixture.dispatch, paused: "budget" } }));
  });

  async function seedThread(bodies: readonly string[]): Promise<void> {
    let id = 1;
    await loopback.sendRequest({
      id: id++, method: CHATS_METHOD.threadCreate, workspace: WORKSPACE_ID, idempotencyKey: "th_long",
      params: { threadId: "th_long", nowMs: FIRST_MESSAGE_AT_MS - 1_000, title: "Long thread", linkedFile: { objectId: "object_long", pathHint: "long.md" } },
    });
    for (const [index, body] of bodies.entries()) {
      await loopback.sendRequest({
        id: id++, method: CHATS_METHOD.messageSend, workspace: WORKSPACE_ID, idempotencyKey: `m_${index}`,
        params: { threadId: "th_long", messageId: `m_${index}`, nowMs: FIRST_MESSAGE_AT_MS + index, authorKind: "human", authorDisplayName: "Sam", body, attachments: [] },
      });
    }
  }

  const shownIds = (markdown: string) => [...markdown.matchAll(/· (m_\d+)$/gm)].map((match) => match[1]);
  const context = (askingMessageId: string, readEarlier?: string) => buildRunnerThreadContext({
    store, dispatchStore: dispatchStore.store, workspaceId: WORKSPACE_ID, threadId: "th_long", askingMessageId,
    ...(readEarlier ? { readEarlier } : {}),
  });

  it("shows the newest 40 messages and says how many were left out", async () => {
    await seedThread(Array.from({ length: 45 }, (_, index) => `message ${index}`));
    const markdown = await context("m_44", "dohc chat show th_long --peek");
    expect(shownIds(markdown)).toEqual(Array.from({ length: 40 }, (_, index) => `m_${index + 5}`));
    expect(markdown).toContain("5 earlier messages in this thread aren't shown. Read them with `dohc chat show th_long --peek`.");
    expect(await context("m_44")).toContain("5 earlier messages in this thread aren't shown.\n");
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
      store: shortPages, dispatchStore: dispatchStore.store, workspaceId: WORKSPACE_ID, threadId: "th_long", askingMessageId: "m_44",
    });
    expect(shownIds(markdown)).toEqual(Array.from({ length: 40 }, (_, index) => `m_${index + 5}`));
  });

  it("reads on from the asking message when it is older than the newest 40", async () => {
    await seedThread(Array.from({ length: 45 }, (_, index) => `message ${index}`));
    const markdown = await context("m_2");
    expect(shownIds(markdown)).toEqual(Array.from({ length: 43 }, (_, index) => `m_${index + 2}`));
    expect(markdown).toContain("2 earlier messages in this thread aren't shown.");
  });

  it("drops the oldest messages past 48,000 characters, but none from the asking one on", async () => {
    await seedThread(Array.from({ length: 20 }, (_, index) => `${index}`.padEnd(5_000, ".")));
    const markdown = await context("m_15");
    expect(markdown.length).toBeLessThanOrEqual(48_000);
    const ids = shownIds(markdown);
    expect(ids.slice(-5)).toEqual(["m_15", "m_16", "m_17", "m_18", "m_19"]);
    expect(ids.length).toBeGreaterThan(5);
    expect(markdown).toContain(`${20 - ids.length} earlier messages in this thread aren't shown.`);
  });

  // A claim answers every request queued in its thread, not only the asking one.
  it("keeps a later request past 48,000 characters", async () => {
    await seedThread(["first request".padEnd(30_000, "."), "second request".padEnd(30_000, ".")]);
    const markdown = await context("m_0");
    expect(shownIds(markdown)).toEqual(["m_0", "m_1"]);
    expect(markdown.length).toBeGreaterThan(48_000);
  });
});
