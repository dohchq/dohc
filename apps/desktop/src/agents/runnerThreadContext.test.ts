import { renderShowMarkdown, type ShowResult } from "@dohc/cli/render";
import { CHATS_METHOD, ChatsLoopbackEngine } from "@dohc/workspace-engine-client";
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
        authorDisplayName: "Ice",
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
        authorDisplayName: "Ice",
        body: "I found one rollback gap and documented it.",
        attachments: [{ objectId: "object_without_path" }],
      },
    });

    const cliShowFixture: ShowResult = {
      thread: {
        id: "th_1",
        title: "Launch review",
        channel: {
          id: "files",
          name: "files",
          slug: "files",
          kind: "channel",
        },
        commentCount: 1,
        openDecisionCount: 0,
      },
      messages: [
        {
          id: "msg_1",
          author: { kind: "human", displayName: "Ice" },
          body: "Please audit the launch plan.\nFocus on rollback safety.",
          createdAtMs: FIRST_MESSAGE_AT_MS,
          attachments: [
            { objectId: "object_metrics", pathHint: "data/metrics.csv" },
            { objectId: "object_launch", pathHint: "plans/launch.md" },
          ],
        },
        {
          id: "msg_2",
          author: { kind: "agent", displayName: "Ice" },
          body: "I found one rollback gap and documented it.",
          createdAtMs: FIRST_MESSAGE_AT_MS + 1_000,
          attachments: [{ objectId: "object_without_path" }],
        },
      ],
    };

    await expect(buildRunnerThreadContext({
      store,
      workspaceId: WORKSPACE_ID,
      threadId: "th_1",
    })).resolves.toBe(renderShowMarkdown(cliShowFixture));
  });
});
