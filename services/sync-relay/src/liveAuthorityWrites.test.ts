import { constants, type DatabaseSync } from "node:sqlite";
import * as preparedStatements from "./storage/preparedStatements";
import { afterEach, expect, it, vi } from "vitest";
import { binding, fixture as ticketFixture, scope, seedLinkAgent } from "./liveTickets.test-helper";
import { cleanups, fixture as namedLiveFixture } from "./namedLiveRoutes.test-helper";
import { NO_LIVE_AUTHORITY, observeRelayWrites } from "./relayWriteChanges";
import type { StorageContext } from "./storage/context";
import { LIVE_AUTHORITY_TABLES } from "./storage/liveAuthorityWrites";
import { appendLogBatchInTransaction } from "./storage/log";
import type { CurrentLiveBindingRequest } from "./storage/types";
import { chatChannelCreate, chatMessageAppend, chatThreadCreate, sequenced } from "./testing";

// Which writes recheck every live connection. A chat append changes nothing
// a live connection's authority is read from, so it rechecks none, unless
// its transaction also wrote one of those tables.

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closes.splice(0).reverse()) await close();
  for (const close of cleanups.splice(0).reverse()) await close();
});
const document = {
  workspaceId: binding.workspaceId,
  mainVersionId: binding.mainVersionId,
  objectId: binding.objectId,
  lineageClaimId: binding.lineageClaimId,
};
const channelWireId = "c".repeat(26),
  threadId = "t".repeat(26);
const reaction = (reactionId: string, messageId: string) => ({
  opKind: "chat.reaction.set",
  payload: {
    reactionId,
    messageId,
    threadId,
    emoji: "+1",
    authorId: "member-1",
    authorKind: "human",
    authorDisplayName: "Sam",
    state: "on",
    atMs: 5,
  },
});

async function community() {
  const f = await ticketFixture();
  closes.push(f.close);
  const storage = f.storage as StorageContext,
    workspaceId = scope.workspaceId;
  storage.claimWorkspaceIdentity({
    workspaceId,
    replicationEpoch: "epoch",
    streamIdentity: "stream",
  });
  expect(
    storage.inviteWorkspaceMember({
      workspaceId,
      actorUserId: "owner-1",
      workspaceName: "Plans",
      email: "sam@example.test",
      recipientUserId: "member-1",
      newMemberId: () => "member-entry",
      newGrantId: () => "member-grant",
      newShareId: () => "members-share",
      nowMs: 5,
    }),
  ).toMatchObject({ ok: true });
  expect(
    storage.setWorkspaceMemberLevel({
      workspaceId,
      actorUserId: "owner-1",
      level: "edit",
      workspaceName: undefined,
      newShareId: () => "unused-share",
      nowMs: 6,
    }),
  ).toEqual({ ok: true });
  const ops = (originId: string, input: Parameters<typeof sequenced>[0]) =>
    sequenced(input, storage.maxOriginSeq(workspaceId, originId) + 1).map(({ payload, ...op }) => ({
      ...op,
      payloadJson: JSON.stringify(payload),
    }));
  const append = (input: Parameters<typeof sequenced>[0], originId = "member-desktop") =>
    storage.appendLogBatch({ workspaceId, originId, ops: ops(originId, input) });
  append(
    [
      chatChannelCreate(channelWireId, {
        kind: "channel",
        name: "Events",
        type: "both",
        folderPath: "events",
      }),
      chatThreadCreate(threadId, channelWireId),
    ],
    "owner-desktop",
  );
  const scopes: unknown[] = [];
  const stop = observeRelayWrites(storage, (documents) => {
    scopes.push(documents);
  });
  closes.push(async () => stop());
  const written = async () => {
    await new Promise<void>(queueMicrotask);
    return scopes.splice(0);
  };
  await written();
  return { ...f, storage, workspaceId, ops, append, written };
}

it("names no live document for a member's posts, replies and reactions, yet still wakes every relay write observer", async () => {
  const f = await community();
  f.append([
    chatMessageAppend("m1", threadId, "Who brings the tables?", {
      authorUserId: "member-1",
      authorDisplayName: "Sam",
    }),
  ]);
  expect(await f.written()).toEqual([[]]);
  f.append(
    [
      chatMessageAppend("m2", threadId, "I will", {
        authorUserId: "owner-1",
        authorDisplayName: "Owner",
        parentMessageId: "m1",
      }),
    ],
    "owner-desktop",
  );
  expect(await f.written()).toEqual([[]]);
  f.append([reaction("r1", "m2")]);
  expect(await f.written()).toEqual([[]]);
  // A reply in a thread of its own, as a browser member posts it.
  const replyThread = "u".repeat(26);
  f.storage.appendBrowserChatBatch({
    workspaceId: f.workspaceId,
    originId: "browser-chat",
    messageId: "m3",
    ops: f.ops("browser-chat", [
      chatThreadCreate(replyThread, channelWireId),
      chatMessageAppend("m3", replyThread, "Thanks", {
        authorUserId: "member-1",
        authorDisplayName: "Sam",
      }),
    ]),
  });
  expect(await f.written()).toEqual([[]]);
  // A Group's creation and every membership change still recheck every connection.
  f.append(
    [
      chatChannelCreate("d".repeat(26), {
        kind: "channel",
        name: "Ops",
        type: "both",
        folderPath: "ops",
      }),
    ],
    "owner-desktop",
  );
  expect(await f.written()).toEqual([undefined]);
  expect(
    f.storage.setWorkspaceMemberLevel({
      workspaceId: f.workspaceId,
      actorUserId: "owner-1",
      level: "comment",
      workspaceName: undefined,
      newShareId: () => "unused-share",
      nowMs: 7,
    }),
  ).toEqual({ ok: true });
  expect(await f.written()).toEqual([undefined]);
  expect(
    f.storage.removeWorkspaceMember({
      workspaceId: f.workspaceId,
      actorUserId: "owner-1",
      memberId: "member-entry",
      nowMs: 8,
    }),
  ).toEqual({ ok: true });
  expect(await f.written()).toEqual([undefined]);
});

it("rechecks every live connection when a chat append's transaction also writes a table the live checks read", async () => {
  const f = await community();
  const post = (messageId: string) =>
    appendLogBatchInTransaction(f.storage, {
      workspaceId: f.workspaceId,
      originId: "member-desktop",
      ops: f.ops("member-desktop", [
        chatMessageAppend(messageId, threadId, "hello", { authorUserId: "member-1" }),
      ]),
    });
  f.storage.tx(() => post("m1"), NO_LIVE_AUTHORITY);
  expect(await f.written()).toEqual([[]]);
  f.storage.tx(() => {
    post("m2");
    f.storage.db
      .prepare("UPDATE sync_relay_share_grants SET generation = generation + 1 WHERE grant_id = ?")
      .run(scope.grantId);
  }, NO_LIVE_AUTHORITY);
  expect(await f.written()).toEqual([undefined]);
  // One rolled back changed nothing.
  expect(() =>
    f.storage.tx(() => {
      post("m3");
      f.storage.db
        .prepare(
          "UPDATE sync_relay_share_grants SET generation = generation + 1 WHERE grant_id = ?",
        )
        .run(scope.grantId);
      throw new Error("rolled back");
    }, NO_LIVE_AUTHORITY),
  ).toThrow("rolled back");
  expect(await f.written()).toEqual([[]]);
});

// Guard: a table a live check reads that this list misses would let a chat
// append's write to it skip the recheck.
it("lists every table the live checks read, and watches each for writes", async () => {
  // The authorizer observes statement compilation, so each read compiles here.
  vi.spyOn(preparedStatements, "reusePreparedStatements").mockImplementation((db) => db);
  const read = new Set<string>();
  const capture = (storage: StorageContext, actor: CurrentLiveBindingRequest["actor"]) => {
    const db = storage.db as unknown as DatabaseSync;
    db.setAuthorizer((action, table, _column, database) => {
      if (action === constants.SQLITE_READ && database === "main" && table) read.add(table);
      return constants.SQLITE_OK;
    });
    try {
      expect(storage.resolveCurrentLiveDocumentBinding({ document, actor }).kind).toBe("current");
    } finally {
      db.setAuthorizer(null);
    }
  };
  const f = await community();
  capture(f.storage, { kind: "owner", userId: "owner-1" });
  capture(f.storage, { kind: "named", userId: scope.userId, grantId: scope.grantId });
  capture(f.storage, { kind: "named", userId: "member-1", grantId: "member-grant" });
  const link = await namedLiveFixture(undefined, true);
  await link.mint();
  const holder = link.currentScope as Extract<typeof link.currentScope, { kind: "link" }>;
  capture(link.storage as StorageContext, {
    kind: "link",
    sessionId: holder.sessionId,
    profileTokenHash: holder.profileTokenHash,
    grantId: holder.grantId,
    workspaceId: holder.workspaceId,
  });
  const agent = seedLinkAgent(link.raw, {
    connectionId: "agent-connection",
    workspaceId: holder.workspaceId,
    shareId: holder.shareId,
    grantId: holder.grantId,
    generation: 4,
    expiresAtMs: 2000,
  });
  capture(link.storage as StorageContext, agent.actor);
  // Each kind of editor was checked.
  expect([...read]).toEqual(
    expect.arrayContaining([
      "sync_relay_workspaces",
      "sync_relay_share_grants",
      "sync_relay_workspace_members",
      "sync_relay_link_sessions",
      "sync_relay_agent_tokens",
    ]),
  );
  expect(
    [...read]
      .filter((table) => !(LIVE_AUTHORITY_TABLES as readonly string[]).includes(table))
      .sort(),
  ).toEqual([]);
  // Each listed table counts its writes, except the log's new rows.
  const watched = (
    f.storage.db
      .prepare("SELECT tbl_name AS name, sql FROM sqlite_temp_schema WHERE type = 'trigger'")
      .all() as Array<{ name: string; sql: string }>
  ).map(({ name, sql }) => `${name} ${/AFTER (INSERT|UPDATE|DELETE) ON/u.exec(sql)?.[1]}`);
  const expected = LIVE_AUTHORITY_TABLES.flatMap((table) =>
    ["INSERT", "UPDATE", "DELETE"]
      .filter((event) => table !== "sync_relay_log" || event !== "INSERT")
      .map((event) => `${table} ${event}`),
  );
  expect(watched.sort()).toEqual(expected.sort());
});
