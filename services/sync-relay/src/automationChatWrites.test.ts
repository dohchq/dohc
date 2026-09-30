import type { StoredRun } from "@dohc/automation-executor/automation-run-store";
import { afterEach, describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "@dohc/service-http";
import { NoticeNotSentError, type AutomationChatMessage, type AutomationNotice } from "@dohc/automation-executor/automation-chat";
import type { ReachRoster } from "@dohc/automation-executor/automation-reach";
import {
  replicaAutomationChat,
  replicaNoticePoster,
  type ReplicaChatStore,
} from "./automationChatWrites";
import type { SyncRelayStorage } from "./storage";
import { closeTestStorages, inspectDatabase, storagePath, testStorage } from "./testing";

afterEach(closeTestStorages);

const WORKSPACE = "workspace-trip";
const replica = (signal = new AbortController().signal) => ({ workspaceId: WORKSPACE, ownerUserId: "owner", signal });
const automation = { automationId: "collection:Tasks#tell", name: "Tell the group", depth: 2 };
const OWNER_ROSTER: Exclude<ReachRoster, { kind: "unknown" }> = { kind: "owner", ownerUserId: "owner", grants: [] };

/** A replica's chat store with one Group, recording each write. */
/** A message already in the replica, by id. */
type Sent = { id: string; threadId: string; author: { kind: string }; automation?: { automationId: string } };
const sentByTell = (id: string, threadId = "thread-auto-1"): Sent =>
  ({ id, threadId, author: { kind: "automation" }, automation: { automationId: "collection:Tasks#tell" } });

function chatStore(options: { refuse?: Error; sent?: Sent[] } = {}) {
  const writes: Array<{ method: string; input: unknown }> = [];
  const store: ReplicaChatStore = {
    listChannels: async () => [{
      workspaceId: WORKSPACE, id: "channel-planning", name: "Planning", slug: "planning", kind: "channel", type: "posts",
      purpose: "", createdAtMs: 1, updatedAtMs: 1, threadCount: 0, unreadCount: 0,
    }],
    getChannelWireId: async () => "wire-planning",
    listChannelThreads: async () => [],
    startChannelThread: async (input) => {
      if (options.refuse) throw options.refuse;
      writes.push({ method: "startChannelThread", input });
      return {} as Awaited<ReturnType<ReplicaChatStore["startChannelThread"]>>;
    },
    sendMessage: async (input) => {
      writes.push({ method: "sendMessage", input });
      return {} as Awaited<ReturnType<ReplicaChatStore["sendMessage"]>>;
    },
    getMessage: async ({ messageId }) => {
      const sent = options.sent?.find((row) => row.id === messageId);
      if (!sent) throw new Error("chat-message-not-found");
      return sent as Awaited<ReturnType<ReplicaChatStore["getMessage"]>>;
    },
    findThreadChannelId: async ({ threadId }) => threadId === "thread-auto-1" ? "channel-planning" : "channel-other",
  };
  return { store, writes };
}

const message = (target: AutomationChatMessage["target"]): AutomationChatMessage => ({
  target, effectId: "claim/hash/0/wake", messageId: "message-auto-1", threadId: "thread-auto-1", automation, body: "Packed.",
});

const savedRun = (): StoredRun => ({
  version: 8, rules: null, collections: [], undoCalls: [], undoCovers: [], claimId: "claim", automationId: automation.automationId, definitionHash: "hash", keySeed: "hash",
  startedAtMs: 10_000, finishedAtMs: 10_000, steps: [], applied: [], created: [], replans: [], undoRequests: [],
  readableFields: null, superseded: false, undo: null, undoKept: [], settled: true, outcome: { state: "done" },
});
const runStore = { supersedeWake: async () => undefined };

describe("an automation's messages on this server", () => {
  it("posts in a Group as the automation, for the owner, at its depth, under its effect id", async () => {
    const { store, writes } = chatStore();
    const chat = replicaAutomationChat({ runStore, storage: { postAutomationWake: () => { throw new Error("unexpected wake"); } }, nowMs: () => 10_000, replica: replica(), store, ownerName: async () => "Ice" });
    const directory = await chat.directory(OWNER_ROSTER, { groups: new Set(["Planning"]), people: new Set() });
    const group = directory?.group("Planning");
    expect(group).toMatchObject({ channelId: "channel-planning", wireId: "wire-planning", lane: "posts" });
    await chat.write(new AbortController().signal, message({ kind: "group", channelId: "channel-planning", lane: "posts" }), savedRun());
    expect(writes).toEqual([{ method: "startChannelThread", input: {
      workspaceId: WORKSPACE, channelId: "channel-planning", lane: "posts", threadId: "thread-auto-1",
      messageId: "message-auto-1", idempotencyKey: "claim/hash/0/wake",
      author: { kind: "automation", displayName: "Tell the group" }, authorOwnerDisplayName: "Ice", authorUserId: "owner",
      automation: { automationId: "collection:Tasks#tell", chainDepth: 2 }, body: "Packed.",
    } }]);
  });

  it("sends a direct message into its running conversation", async () => {
    const { store, writes } = chatStore();
    const chat = replicaAutomationChat({ runStore, storage: { postAutomationWake: () => { throw new Error("unexpected wake"); } }, nowMs: () => 10_000, replica: replica(), store, ownerName: async () => "Ice" });
    await chat.write(new AbortController().signal, message({ kind: "direct-message", threadId: "thread-dm" }), savedRun());
    expect(writes).toEqual([{ method: "sendMessage", input: expect.objectContaining({
      threadId: "thread-dm", idempotencyKey: "claim/hash/0/wake", authorUserId: "owner",
      author: { kind: "automation", displayName: "Tell the group" },
    }) }]);
  });

  it("counts a message already sent as sent when the engine refuses its replay", async () => {
    // The owner renamed themselves after the first attempt landed.
    const refused = new Error("idempotency-key-reuse-mismatch");
    const group = message({ kind: "group", channelId: "channel-planning", lane: "posts" });
    const writeWith = (sent?: Sent[]) => replicaAutomationChat({ runStore, storage: { postAutomationWake: () => { throw new Error("unexpected wake"); } }, nowMs: () => 10_000,
      replica: replica(), store: chatStore({ refuse: refused, ...(sent ? { sent } : {}) }).store, ownerName: async () => "Ice",
    }).write(new AbortController().signal, group, savedRun());
    await expect(writeWith([sentByTell("message-auto-1")])).resolves.toMatchObject({ id: "message-auto-1" });
    await expect(writeWith()).rejects.toBe(refused);
    // Only this automation's message, in the Group the effect named, counts.
    await expect(writeWith([{ ...sentByTell("message-auto-1"), author: { kind: "human" } }])).rejects.toBe(refused);
    await expect(writeWith([{ ...sentByTell("message-auto-1"), automation: { automationId: "collection:Tasks#other" } }])).rejects.toBe(refused);
    await expect(writeWith([sentByTell("message-auto-1", "thread-elsewhere")])).rejects.toBe(refused);
  });

  it("hands the wake to the owner once without writing chat on the server", async () => {
    const storage = await testStorage();
    storage.claimWorkspace({ workspaceId: WORKSPACE, ownerUserId: "owner", createdAtMs: 10_000 });
    const { store, writes } = chatStore();
    const chat = replicaAutomationChat({ runStore, replica: replica(), store, storage, nowMs: () => 10_000, ownerName: async () => "Ice" });
    expect(await chat.write(new AbortController().signal, message({ kind: "agent" }), savedRun())).toMatchObject({ name: "Ice" });
    await chat.write(new AbortController().signal, message({ kind: "agent" }), savedRun());
    const notices = storage.readNoticeChanges({ recipientUserId: "owner", cursor: null, limit: 50, nowMs: 10_000 }).notices;
    expect(notices).toEqual([expect.objectContaining({
      kind: "automation-wake", senderUserId: "owner", originInstallId: "server",
      wake: { ...automation, body: "Packed." },
    })]);
    expect(writes).toEqual([]);
  });

  it("posts a wake with an opaque effect id using its explicit run metadata", async () => {
    const storage = await testStorage();
    storage.claimWorkspace({ workspaceId: WORKSPACE, ownerUserId: "owner", createdAtMs: 10_000 });
    const chat = replicaAutomationChat({ runStore, replica: replica(), store: chatStore().store, storage, nowMs: () => 10_000, ownerName: async () => "Ice" });
    await expect(chat.write(new AbortController().signal,
      { ...message({ kind: "agent" }), effectId: "opaque-effect" }, savedRun())).resolves.toMatchObject({ name: "Ice" });
    expect(storage.readNoticeChanges({ recipientUserId: "owner", cursor: null, limit: 50, nowMs: 10_000 }).notices[0]?.wake?.body).toBe("Packed.");
  });

  it("records supersession in the older run and retries that record after a failed save", async () => {
    const storage = await testStorage();
    storage.claimWorkspace({ workspaceId: WORKSPACE, ownerUserId: "owner", createdAtMs: 10_000 });
    const old = { ...savedRun(), claimId: "claim/with/slashes", keySeed: "seed/with/slashes" };
    const latest = { ...savedRun(), claimId: "new" };
    const kept = new Map([[old.claimId, old], ["new", latest]]);
    let failSave = true;
    const chat = replicaAutomationChat({
      replica: replica(), store: chatStore().store, storage, nowMs: () => 10_000, ownerName: async () => "Ice",
      runStore: {
        supersedeWake: async (_automationId, claimId, _keySeed, noticeId, supersededBy) => {
          if (failSave) { failSave = false; throw new Error("disk unavailable"); }
          const run = kept.get(claimId)!;
          run.applied = run.applied.map(step => ({ ...step, writes: step.writes.map(write =>
            write.kind === "notice" && write.noticeId === noticeId && !write.supersededBy
              ? { ...write, supersededBy, name: write.name + "; agent wake superseded by a later run" } : write) }));
        },
      },
    });
    const sent = await chat.write(new AbortController().signal, { ...message({ kind: "agent" }), effectId: "opaque-old-effect" }, old) as { noticeId: string };
    old.applied = [{ ordinal: 0, writes: [{ kind: "notice", noticeId: sent.noticeId, name: "Ice" }] }];
    const next = { ...message({ kind: "agent" }), effectId: "opaque-next-effect" };
    await expect(chat.write(new AbortController().signal, next, latest)).rejects.toThrow("disk unavailable");
    await chat.write(new AbortController().signal, next, latest);
    expect(await chat.write(new AbortController().signal, { ...message({ kind: "agent" }), effectId: "opaque-old-effect" }, old)).toMatchObject({
      name: "Ice; agent wake superseded by a later run", supersededBy: expect.stringMatching(/^automation-wake:/),
    });
    expect(kept.get(old.claimId)!.applied[0]!.writes[0]).toMatchObject({
      supersededBy: expect.stringMatching(/^automation-wake:/), name: "Ice; agent wake superseded by a later run",
    });
    expect(storage.readNoticeChanges({ recipientUserId: "owner", cursor: null, limit: 50, nowMs: 10_000 }).notices.filter((row) => row.wake)).toHaveLength(1);
  });

  it("writes nothing once its run ends or the replica closes", async () => {
    const run = new AbortController();
    const { store, writes } = chatStore();
    const chat = replicaAutomationChat({ runStore, storage: { postAutomationWake: () => { throw new Error("unexpected wake"); } }, nowMs: () => 10_000, replica: replica(), store, ownerName: async () => { run.abort(); return "Ice"; } });
    await expect(chat.write(run.signal, message({ kind: "group", channelId: "channel-planning", lane: "posts" }), savedRun())).rejects.toThrow();
    const closed = new AbortController();
    closed.abort();
    const onClosed = replicaAutomationChat({ runStore, storage: { postAutomationWake: () => { throw new Error("unexpected wake"); } }, nowMs: () => 10_000, replica: replica(closed.signal), store, ownerName: async () => "Ice" });
    await expect(onClosed.write(new AbortController().signal, message({ kind: "direct-message", threadId: "thread-dm" }), savedRun())).rejects.toThrow();
    await expect(onClosed.directory(OWNER_ROSTER, { groups: new Set(), people: new Set() })).resolves.toBeNull();
    expect(writes).toEqual([]);
  });
});

describe("an automation's notices on this server", () => {
  let clock = 10_000;
  async function relay() {
    const storage = await testStorage();
    storage.claimWorkspace({ workspaceId: WORKSPACE, ownerUserId: "owner", createdAtMs: clock });
    return storage;
  }
  function share(storage: SyncRelayStorage, recipientUserId: string, paths: string[]) {
    storage.createShare({
      share: { shareId: `share-${recipientUserId}`, workspaceId: WORKSPACE, granterUserId: "owner",
        selectorJson: JSON.stringify({ paths, versionId: null }), createdAtMs: clock },
      grant: { grantId: `grant-${recipientUserId}`, shareId: `share-${recipientUserId}`, principalKind: "user", principalUserId: recipientUserId,
        principalEmail: null, access: "view", generation: 1, status: "active", createdAtMs: clock, revokedAtMs: null, parentGrantId: null },
    });
    const db = inspectDatabase(storagePath(storage));
    db.prepare("DELETE FROM sync_relay_share_notice_deliveries WHERE grant_id = ?").run(`grant-${recipientUserId}`);
    db.close();
  }
  const notice = (recipientUserId: string, noticeId = "automation-notify:1"): AutomationNotice => ({
    noticeId, kind: "automation-notify", title: "Packed", body: "The car is packed.",
    target: { path: "Tasks/one.md", automation: "collection:Tasks#tell", run: "run-1" }, recipientUserId,
  });
  const poster = (storage: SyncRelayStorage, limiter = new TokenBucketLimiter(10, 1, 100)) =>
    replicaNoticePoster({ replica: replica(), storage, noticeLimiter: limiter, ownerName: async () => "Ice", nowMs: () => clock });
  const received = (storage: SyncRelayStorage, userId: string) =>
    storage.readNoticeChanges({ recipientUserId: userId, cursor: null, limit: 50, nowMs: clock }).notices;

  it("sends a notice from the owner to a person who can read what it points to, once", async () => {
    const storage = await relay();
    share(storage, "ana", ["Tasks"]);
    const post = poster(storage);
    await post(notice("ana"), new AbortController().signal);
    await post(notice("ana"), new AbortController().signal);
    expect(received(storage, "ana")).toEqual([expect.objectContaining({
      kind: "automation-notify", title: "Packed", senderUserId: "owner", senderLabel: "Ice",
      target: { path: "Tasks/one.md", automation: "collection:Tasks#tell", run: "run-1" },
    })]);
  });

  it("refuses a notice the notice route would refuse, before it reaches the list", async () => {
    const storage = await relay();
    const long = { ...notice("owner"), target: { path: `Tasks/${"a".repeat(2048)}`, automation: "collection:Tasks#tell", run: "run-1" } };
    await expect(poster(storage)(long, new AbortController().signal))
      .rejects.toEqual(new NoticeNotSentError("This notice points to a path too long to send."));
    const spaced = { ...notice("owner"), target: { path: " Tasks", automation: "collection: Tasks#tell", run: "run-1" } };
    await expect(poster(storage)(spaced, new AbortController().signal))
      .rejects.toEqual(new NoticeNotSentError("This notice points to a path that starts or ends with whitespace."));
    await expect(poster(storage)({ ...notice("owner"), title: "Packed\n" }, new AbortController().signal))
      .rejects.toEqual(new NoticeNotSentError("This server refused the notice."));
    expect(received(storage, "owner")).toEqual([]);
  });

  it("does not notify a person who cannot read what it points to", async () => {
    const storage = await relay();
    share(storage, "ana", ["Budget"]);
    await expect(poster(storage)(notice("ana"), new AbortController().signal))
      .rejects.toEqual(new NoticeNotSentError("This person can't open what the notice points to."));
    expect(received(storage, "ana")).toEqual([]);
  });

  it("counts a notice to someone else against the owner's limit, and not one to the owner", async () => {
    const storage = await relay();
    share(storage, "ana", ["Tasks"]);
    const post = poster(storage, new TokenBucketLimiter(1, 0.001, 100));
    await post(notice("ana", "automation-notify:1"), new AbortController().signal);
    await expect(post(notice("ana", "automation-notify:2"), new AbortController().signal))
      .rejects.toEqual(new NoticeNotSentError("Too many notices went to other people. Wait a minute, then try again."));
    await post(notice("owner", "automation-notify:3"), new AbortController().signal);
    expect(received(storage, "owner")).toHaveLength(1);
  });
});
