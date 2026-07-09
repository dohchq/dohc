import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createLinkedChatStore,
  type LinkedChatStore,
} from "@dohc/workspace-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeTmpdir } from "../workspaces/testTemp";
import { renderThreadMarkdown } from "./threadMarkdown";

const WORKSPACE_ID = "workspace-thread-markdown";
const FIRST_MESSAGE_AT_MS = Date.parse("2026-07-10T04:05:06.000Z");

describe("renderThreadMarkdown", () => {
  let root: string;
  let store: LinkedChatStore;
  const counters = { channel: 0, message: 0, thread: 0 };
  let nowMs: number;

  beforeEach(async () => {
    root = await mkdtemp(join(nativeTmpdir(), "dohc-thread-markdown-"));
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

  it("renders the title, message metadata, bodies, and attachment paths", async () => {
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
      author: { kind: "agent", displayName: "Ice's agent" },
      body: "I found one rollback gap and documented it.",
      attachments: [{ objectId: "object_without_path" }],
    });

    await expect(
      renderThreadMarkdown({
        store,
        workspaceId: WORKSPACE_ID,
        threadId: thread.id,
      }),
    ).resolves.toMatchInlineSnapshot(`
      "# Launch review

      **Ice** · 2026-07-10T04:05:06.000Z · msg_message_1
      Please audit the launch plan.
      Focus on rollback safety.
      [attach: data/metrics.csv] [attach: plans/launch.md]

      **Ice's agent** · 2026-07-10T04:05:07.000Z · msg_message_2
      I found one rollback gap and documented it.
      [attach: object_without_path]
      "
    `);
  });
});
