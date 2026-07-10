import { renderShowMarkdown, type ShowResult } from "@dohc/cli/render";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createLinkedChatStore,
  type LinkedChatStore,
} from "@dohc/workspace-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeTmpdir } from "../workspaces/testTemp";
import { buildRunnerThreadContext } from "./runnerThreadContext";

const WORKSPACE_ID = "workspace-runner-thread-context";
const FIRST_MESSAGE_AT_MS = Date.parse("2026-07-10T04:05:06.000Z");

describe("buildRunnerThreadContext", () => {
  let root: string;
  let store: LinkedChatStore;
  const counters = { channel: 0, message: 0, thread: 0 };
  let nowMs: number;

  beforeEach(async () => {
    root = await mkdtemp(join(nativeTmpdir(), "dohc-runner-thread-context-"));
    counters.channel = 0;
    counters.message = 0;
    counters.thread = 0;
    nowMs = FIRST_MESSAGE_AT_MS - 2_000;
    store = createLinkedChatStore(root, {
      nowMs: () => {
        nowMs += 1_000;
        return nowMs;
      },
      createId: (kind) => {
        counters[kind] += 1;
        return `${kind}_${counters[kind]}`;
      },
    });
  });

  afterEach(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("is byte-identical to CLI show markdown for the same thread", async () => {
    const thread = await store.createThread({
      workspaceId: WORKSPACE_ID,
      title: "Launch review",
      linkedFile: { objectId: "object_launch", pathHint: "plans/launch.md" },
    });
    await store.sendMessage({
      workspaceId: WORKSPACE_ID,
      threadId: thread.id,
      author: { kind: "human", displayName: "Ice" },
      body: "Please audit the launch plan.\nFocus on rollback safety.",
      attachments: [
        { objectId: "object_launch", pathHint: "plans/launch.md" },
        { objectId: "object_metrics", pathHint: "data/metrics.csv" },
      ],
    });
    await store.sendMessage({
      workspaceId: WORKSPACE_ID,
      threadId: thread.id,
      author: { kind: "agent", displayName: "Ice" },
      body: "I found one rollback gap and documented it.",
      attachments: [{ objectId: "object_without_path" }],
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
      threadId: thread.id,
    })).resolves.toBe(renderShowMarkdown(cliShowFixture));
  });
});
