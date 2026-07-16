import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncReplicationEnvelope } from "@dohc/workspace-contracts/engine";
import { afterEach, describe, expect, it } from "vitest";
import { closeTrackedEngineDbHandlesForTest } from "./engineDbSchema";
import { createLinkedChatStore } from "./linkedChatStore";

const WORKSPACE_ID = "workspace-thread-replication-validation";
const roots: string[] = [];

afterEach(async () => {
  closeTrackedEngineDbHandlesForTest();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function makeStore() {
  const root = await mkdtemp(join(tmpdir(), "dohc-thread-replication-validation-"));
  roots.push(root);
  return createLinkedChatStore(root, {
    nowMs: () => 10_000,
    createId: (kind) => `local-${kind}`,
  });
}

function threadCreateEnvelope(
  originId: string,
  payload: unknown,
): SyncReplicationEnvelope {
  return {
    workspaceId: WORKSPACE_ID,
    originId,
    originSeq: 0,
    opKind: "chat.thread.create",
    payload,
    recordedAtMs: 1_000,
  } as unknown as SyncReplicationEnvelope;
}

const validChannelPayload = {
  threadId: "thread-valid",
  title: "",
  createdAtMs: 1_000,
  channelSlug: "team-updates",
  channelWireId: "wire-team-updates",
};

describe("replicated chat.thread.create payload validation", () => {
  it("rejects every malformed field before deriving ownership or inserting placeholders", async () => {
    const store = await makeStore();
    const invalidPayloads: Array<[string, unknown]> = [
      ["null payload", null],
      ["array payload", []],
      ["missing thread id", { ...validChannelPayload, threadId: undefined }],
      ["non-string thread id", { ...validChannelPayload, threadId: 42 }],
      ["blank thread id", { ...validChannelPayload, threadId: "" }],
      ["whitespace-padded thread id", { ...validChannelPayload, threadId: " thread " }],
      ["oversized thread id", { ...validChannelPayload, threadId: "t".repeat(257) }],
      ["non-string title", { ...validChannelPayload, title: 42 }],
      ["whitespace-only title", { ...validChannelPayload, title: "   " }],
      ["oversized title", { ...validChannelPayload, title: "t".repeat(201) }],
      ["non-number created timestamp", { ...validChannelPayload, createdAtMs: "1000" }],
      ["non-finite created timestamp", { ...validChannelPayload, createdAtMs: Number.NaN }],
      ["fractional created timestamp", { ...validChannelPayload, createdAtMs: 1.5 }],
      ["negative created timestamp", { ...validChannelPayload, createdAtMs: -1 }],
      [
        "unsafe created timestamp",
        { ...validChannelPayload, createdAtMs: Number.MAX_SAFE_INTEGER + 1 },
      ],
      [
        "missing owner",
        {
          threadId: "thread-ownerless",
          title: "Ownerless",
          createdAtMs: 1_000,
        },
      ],
      [
        "both file and channel owners",
        { ...validChannelPayload, linkedObjectId: "object-file" },
      ],
      [
        "blank linked object id",
        {
          ...validChannelPayload,
          channelSlug: undefined,
          channelWireId: undefined,
          linkedObjectId: "",
        },
      ],
      [
        "oversized linked object id",
        {
          ...validChannelPayload,
          channelSlug: undefined,
          channelWireId: undefined,
          linkedObjectId: "o".repeat(201),
        },
      ],
      [
        "invalid linked path",
        {
          ...validChannelPayload,
          channelSlug: undefined,
          channelWireId: undefined,
          linkedObjectId: "object-file",
          linkedPathHint: "../escape.md",
        },
      ],
      [
        "non-string linked path",
        {
          ...validChannelPayload,
          channelSlug: undefined,
          channelWireId: undefined,
          linkedObjectId: "object-file",
          linkedPathHint: 42,
        },
      ],
      [
        "invalid linked timestamp",
        {
          ...validChannelPayload,
          channelSlug: undefined,
          channelWireId: undefined,
          linkedObjectId: "object-file",
          linkedAtMs: -1,
        },
      ],
      [
        "non-number linked timestamp",
        {
          ...validChannelPayload,
          channelSlug: undefined,
          channelWireId: undefined,
          linkedObjectId: "object-file",
          linkedAtMs: "1000",
        },
      ],
      ["linked path on channel owner", { ...validChannelPayload, linkedPathHint: "notes/a.md" }],
      ["linked timestamp on channel owner", { ...validChannelPayload, linkedAtMs: 1_000 }],
      ["non-string channel slug", { ...validChannelPayload, channelSlug: 42 }],
      ["blank channel slug", { ...validChannelPayload, channelSlug: "" }],
      ["malformed channel slug", { ...validChannelPayload, channelSlug: "Team Updates" }],
      ["oversized channel slug", { ...validChannelPayload, channelSlug: "s".repeat(201) }],
      ["non-string channel wire id", { ...validChannelPayload, channelWireId: 42 }],
      ["blank channel wire id", { ...validChannelPayload, channelWireId: "" }],
      ["oversized channel wire id", { ...validChannelPayload, channelWireId: "w".repeat(257) }],
    ];

    for (const [index, [label, payload]] of invalidPayloads.entries()) {
      await expect(
        store.applyReplicationOp(threadCreateEnvelope(`invalid-${index}`, payload)),
        label,
      ).rejects.toMatchObject({ code: "state-corrupt" });
    }

    expect(await store.listThreads({ workspaceId: WORKSPACE_ID })).toEqual([]);
    expect(await store.listChannels({ workspaceId: WORKSPACE_ID })).toEqual([]);
    await store.close();
  });

  it("preserves valid channel/file replication and idempotency, while validating duplicate ids", async () => {
    const store = await makeStore();
    const channelOp = threadCreateEnvelope("valid-channel", validChannelPayload);
    await expect(store.applyReplicationOp(channelOp)).resolves.toMatchObject({ status: "applied" });
    await expect(store.applyReplicationOp(channelOp)).resolves.toMatchObject({ status: "skipped" });

    const fileOp = threadCreateEnvelope("valid-file", {
      threadId: "thread-file",
      title: "File discussion",
      createdAtMs: 2_000,
      linkedObjectId: "object-file",
      linkedPathHint: "notes/file.md",
      linkedAtMs: 2_000,
    });
    await expect(store.applyReplicationOp(fileOp)).resolves.toMatchObject({ status: "applied" });
    await expect(store.applyReplicationOp(fileOp)).resolves.toMatchObject({ status: "skipped" });

    await expect(
      store.applyReplicationOp(
        threadCreateEnvelope("malformed-duplicate", {
          ...validChannelPayload,
          title: 42,
        }),
      ),
    ).rejects.toMatchObject({ code: "state-corrupt" });

    expect(
      (await store.listThreads({ workspaceId: WORKSPACE_ID })).map((thread) => ({
        id: thread.id,
        title: thread.title,
      })),
    ).toEqual([
      { id: "thread-valid", title: "New chat" },
      { id: "thread-file", title: "File discussion" },
    ]);
    expect(await store.listChannels({ workspaceId: WORKSPACE_ID })).toEqual([
      expect.objectContaining({ slug: "team-updates" }),
    ]);
    await store.close();
  });
});
