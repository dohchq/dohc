import { GENERAL_CHANNEL_WIRE_ID } from "@dohc/security-contract/chat-wire-ids";
import { afterEach, describe, expect, it } from "vitest";
import type { SyncRelayHandler } from "./server";
import type { SyncRelayStorage } from "./storage";
import { createWorkspaceReplicationRoutes } from "./workspaceReplicationRoutes";
import {
  RELAY_EXCHANGE_KEY,
  SHARE_WEB_ORIGIN,
  chatChannelCreate,
  chatMessageAppend,
  chatThreadCreate,
  closeTestStorages,
  createShare,
  expectNoDeletedDigest,
  inspect,
  json,
  jsonBody,
  logOp,
  putBlob,
  request,
  resetOpSeq,
  resolveTestActor,
  storagePath,
  testHandler,
  testStorage,
} from "./testing";

// Moderation (docs/engineering/plans/workspace-members.md): the relay deletes
// a message in a Group or a file's Comments, rewrites every append of it into
// a tombstone, and appends the delete op every copy pulls.

afterEach(closeTestStorages);

const OWNER = "owner";
const WORKSPACE = "workspace-moderation";
const GROUP = "wire-team";
const DM = "wire-dm";
const AGENT = "wire-agent";
const UNKNOWN = "wire-never-created";
const PLAN_OBJECT = "object-docs/plan.md";

function channel(wireId: string, name: string, kind: "channel" | "dm" | "agent" = "channel") {
  return logOp(
    "chat.channel.create",
    chatChannelCreate(wireId, {
      channelId: `chan-${wireId}`,
      name,
      slug: name,
      kind,
      ...(kind === "channel" ? { type: "both", purpose: "", folderPath: name } : {}),
    }).payload,
  );
}

function thread(threadId: string, wireId: string, slug: string) {
  return logOp("chat.thread.create", chatThreadCreate(threadId, wireId, { slug }).payload);
}

function ownerMessage(messageId: string, threadId: string, body: string) {
  return logOp(
    "chat.message.append",
    chatMessageAppend(messageId, threadId, body, { authorUserId: OWNER }).payload,
  );
}

async function ownerAppend(h: SyncRelayHandler, ops: unknown[], originId = "origin-owner") {
  const response = await h(request(OWNER, `/sync/${WORKSPACE}/log`, jsonBody({ originId, ops })));
  expect(response.status, await response.clone().text()).toBe(200);
}

// A pull's author-name lookup waits here while a test holds it.
let heldNames: { hold(): Promise<void> } | null = null;
function holdNames() {
  let reached!: () => void, release!: () => void;
  const atLookup = new Promise<void>((resolve) => (reached = resolve));
  const open = new Promise<void>((resolve) => (release = resolve));
  heldNames = {
    hold: () => {
      reached();
      return open;
    },
  };
  return {
    atLookup,
    release: () => {
      heldNames = null;
      release();
    },
  };
}

// The owner's workspace: a Group, General, a direct message, an agent chat, a
// channel the log never created, and a file with a Comment thread. Nobody is
// a member yet.
async function seed(): Promise<{ storage: SyncRelayStorage; h: SyncRelayHandler }> {
  resetOpSeq();
  const storage = await testStorage();
  const h = testHandler(storage, {
    lookupUserDisplayName: (userId: string) =>
      heldNames ? heldNames.hold().then(() => `Name ${userId}`) : `Name ${userId}`,
    relayExchangeKey: RELAY_EXCHANGE_KEY,
    namedBrowserSessionLimits: {
      maxSessions: 8,
      retentionMs: 60_000,
      maxPendingRequests: 8,
      maxRequestBytes: 100_000,
      maxResponseBytes: 200_000,
      timeoutMs: 1000,
    },
    // A browser call carries the share site's session cookie; the rest sign in.
    resolveActor: (incoming, workspaceId) => {
      const match = /^session=(\w+)$/u.exec(incoming.headers.get("cookie") ?? "");
      return match ? { userId: match[1]!, workspaceId } : resolveTestActor(incoming, workspaceId);
    },
  });
  expect(
    (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
  ).toBe(200);
  const sha = await putBlob(h, OWNER, WORKSPACE, "the plan");
  await ownerAppend(h, [
    logOp("moment.append", {
      momentId: "m-plan",
      versionId: "main",
      objectId: PLAN_OBJECT,
      path: "docs/plan.md",
      recordedAtMs: 900,
      operation: "write",
      payloadBeforeBlobSha256: null,
      payloadBeforePath: null,
      payloadAfterBlobSha256: sha,
      payloadAfterPath: "docs/plan.md",
      metadata: { origin: "user" },
      beforePresent: "null",
    }),
    channel(GROUP, "team"),
    thread("t-team", GROUP, "team"),
    ownerMessage("msg-team", "t-team", "welcome to the team"),
    channel(GENERAL_CHANNEL_WIRE_ID, "general"),
    thread("t-general", GENERAL_CHANNEL_WIRE_ID, "general"),
    ownerMessage("msg-general", "t-general", "in general"),
    channel(DM, "someone", "dm"),
    thread("t-dm", DM, "someone"),
    ownerMessage("msg-dm", "t-dm", "a direct message"),
    channel(AGENT, "bot", "agent"),
    thread("t-agent", AGENT, "bot"),
    ownerMessage("msg-agent", "t-agent", "an agent chat"),
    thread("t-unknown", UNKNOWN, "ghost"),
    ownerMessage("msg-unknown", "t-unknown", "in no channel"),
    logOp("chat.thread.create", {
      threadId: "t-comment",
      title: "",
      createdAtMs: 4,
      linkedAtMs: 4,
      linkedObjectId: PLAN_OBJECT,
    }),
    ownerMessage("msg-comment", "t-comment", "a comment on the plan"),
  ]);
  return { storage, h };
}

function post(h: SyncRelayHandler, as: string, path: string, body: Record<string, unknown> = {}) {
  return h(request(as, path, jsonBody(body)));
}

function deleteMessage(h: SyncRelayHandler, as: string, messageId: string, threadId: string) {
  return post(h, as, `/sync/${WORKSPACE}/chat/messages/${encodeURIComponent(messageId)}/delete`, {
    threadId,
  });
}

async function invited(h: SyncRelayHandler, userId: string): Promise<string> {
  const response = await post(h, OWNER, `/sync/${WORKSPACE}/members/invites`, {
    email: `${userId}@dohc.test`,
    workspaceName: "Community",
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const view = (await response.json()) as { people: { name: string; memberId: string }[] };
  return view.people.find((person) => person.name === `Name ${userId}`)!.memberId;
}

async function shareIdOf(h: SyncRelayHandler, userId: string): Promise<string> {
  const response = await h(request(userId, "/sync/shares"));
  const row = ((await json(response)).received as Array<Record<string, unknown>>).find(
    (entry) => (entry.selector as { kind?: string } | undefined)?.kind === "workspace",
  );
  expect(row).toBeDefined();
  return row!.shareId as string;
}

async function member(h: SyncRelayHandler, userId: string) {
  const memberId = await invited(h, userId);
  return { memberId, shareId: await shareIdOf(h, userId) };
}

function memberBatch(
  userId: string,
  messageId: string,
  body: string,
  seq: number,
  threadId = "t-team",
) {
  return {
    originId: `origin-${userId}`,
    ops: [
      {
        ...logOp(
          "chat.message.append",
          chatMessageAppend(messageId, threadId, body, { authorUserId: userId }).payload,
        ),
        originSeq: seq,
        recordedAtMs: 7000 + seq,
      },
    ],
  };
}

// A share-site page's call, as share-web forwards it.
function browser(h: SyncRelayHandler, user: string, path: string, body?: Record<string, unknown>) {
  return h(
    new Request(`http://relay.test/sync/named-chat/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie: `session=${user}`,
        origin: SHARE_WEB_ORIGIN,
        "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

function push(h: SyncRelayHandler, userId: string, shareId: string, batch: unknown) {
  return h(request(userId, `/sync/shares/${shareId}/log`, jsonBody(batch)));
}

interface StoredRow {
  relay_seq: number;
  op_kind: string;
  origin_id: string;
  payload_json: string;
}

function rowsOf(storage: SyncRelayStorage, messageId: string): StoredRow[] {
  return inspect(storagePath(storage), (db) =>
    db
      .prepare(
        `SELECT relay_seq, op_kind, origin_id, payload_json FROM sync_relay_log
         WHERE workspace_id = ? AND json_extract(payload_json, '$.messageId') = ?
         ORDER BY relay_seq`,
      )
      .all(WORKSPACE, messageId),
  ) as unknown as StoredRow[];
}

function deletedRows(storage: SyncRelayStorage, messageId: string) {
  return inspect(storagePath(storage), (db) =>
    db
      .prepare(
        `SELECT relay_seq, deleted_by FROM sync_relay_deleted_messages
         WHERE workspace_id = ? AND message_id = ? ORDER BY relay_seq`,
      )
      .all(WORKSPACE, messageId),
  );
}

describe("deleting a message", () => {
  it("lets a member delete their own message; no row then holds its body", async () => {
    const { storage, h } = await seed();
    const ana = await member(h, "ana");
    expect(
      (await push(h, "ana", ana.shareId, memberBatch("ana", "m-ana", "my secret", 0))).status,
    ).toBe(200);

    const deleted = await deleteMessage(h, "ana", "m-ana", "t-team");
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    // Every delete door answers the same three fields.
    expect(await deleted.json()).toEqual({
      messageId: "m-ana",
      threadId: "t-team",
      deletedAtMs: 2_000,
    });

    const rows = rowsOf(storage, "m-ana");
    expect(rows.map((row) => row.op_kind)).toEqual([
      "chat.message.tombstone",
      "chat.message.delete",
    ]);
    expect(JSON.stringify(rows)).not.toContain("my secret");
    expect(JSON.parse(rows[1]!.payload_json)).toEqual({
      messageId: "m-ana",
      threadId: "t-team",
      deletedAtMs: 2_000,
    });
    // Every delete in the workspace comes from one origin, so it does not say who deleted.
    expect((await deleteMessage(h, OWNER, "msg-team", "t-team")).status).toBe(200);
    expect(
      inspect(storagePath(storage), (db) =>
        db
          .prepare(
            `SELECT origin_id, origin_seq FROM sync_relay_log
             WHERE workspace_id = ? AND op_kind = 'chat.message.delete' ORDER BY relay_seq`,
          )
          .all(WORKSPACE),
      ),
    ).toEqual([
      { origin_id: "relay:message-delete:workspace", origin_seq: 0 },
      { origin_id: "relay:message-delete:workspace", origin_seq: 1 },
    ]);
  });

  it("lets a member who dropped to View delete their own message, but not post or delete another's", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    const ben = await member(h, "ben");
    expect(
      (await push(h, "ana", ana.shareId, memberBatch("ana", "m-ana", "hello", 0))).status,
    ).toBe(200);
    expect((await push(h, "ben", ben.shareId, memberBatch("ben", "m-ben", "hi", 0))).status).toBe(
      200,
    );
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/level`, { level: "view" })).status,
    ).toBe(200);

    expect(
      (await push(h, "ana", ana.shareId, memberBatch("ana", "m-ana-2", "again", 1))).status,
    ).toBe(403);
    expect((await deleteMessage(h, "ana", "m-ben", "t-team")).status).toBe(404);
    expect((await deleteMessage(h, "ana", "msg-team", "t-team")).status).toBe(404);
    expect((await deleteMessage(h, "ana", "m-ana", "t-team")).status).toBe(200);
  });

  it("lets an admin delete anyone's message in a Group, and never in General, a direct message, an agent chat or an unknown channel", async () => {
    const { storage, h } = await seed();
    // A file whose Comments a member writes in before the owner moves it where the workspace share hides it.
    await ownerAppend(h, [
      logOp("moment.append", {
        momentId: "m-notes",
        versionId: "main",
        objectId: "object-notes",
        path: "docs/notes.md",
        recordedAtMs: 901,
        operation: "write",
        payloadBeforeBlobSha256: null,
        payloadBeforePath: null,
        payloadAfterBlobSha256: null,
        payloadAfterPath: "docs/notes.md",
        metadata: { origin: "user" },
        beforePresent: "null",
      }),
      logOp("chat.thread.create", {
        threadId: "t-notes",
        title: "",
        createdAtMs: 5,
        linkedAtMs: 5,
        linkedObjectId: "object-notes",
      }),
      ownerMessage("msg-notes", "t-notes", "a comment on the notes"),
    ]);
    const ana = await member(h, "ana");
    const ben = await member(h, "ben");
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana.memberId}/role`, { role: "admin" }))
        .status,
    ).toBe(200);
    expect((await push(h, "ben", ben.shareId, memberBatch("ben", "m-ben", "spam", 0))).status).toBe(
      200,
    );
    // A member the owner then removes.
    const dan = await member(h, "dan");
    expect((await push(h, "dan", dan.shareId, memberBatch("dan", "m-dan", "mine", 0))).status).toBe(
      200,
    );
    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/${dan.memberId}/remove`)).status).toBe(
      200,
    );
    // A named recipient of the plan, who is not a member, comments on it.
    const cara = await createShare(h, OWNER, WORKSPACE, {
      recipientUserId: "cara",
      paths: ["docs/plan.md"],
      access: "comment",
    });
    expect(
      (await push(h, "cara", cara, memberBatch("cara", "m-cara", "a note", 0, "t-comment"))).status,
    ).toBe(200);
    expect(
      (await push(h, "ben", ben.shareId, memberBatch("ben", "m-ben-notes", "mine", 1, "t-notes")))
        .status,
    ).toBe(200);
    await ownerAppend(
      h,
      [
        {
          originSeq: 0,
          recordedAtMs: 902,
          opKind: "moment.append",
          payload: {
            momentId: "m-notes-hidden",
            versionId: "main",
            objectId: "object-notes",
            path: "docs/.env",
            recordedAtMs: 902,
            operation: "rename",
            payloadBeforeBlobSha256: null,
            payloadBeforePath: "docs/notes.md",
            beforePath: "docs/notes.md",
            payloadAfterBlobSha256: null,
            payloadAfterPath: "docs/.env",
            metadata: { origin: "user" },
            beforePresent: "null",
          },
        },
      ],
      "origin-owner-move",
    );

    expect((await deleteMessage(h, "ana", "m-ben", "t-team")).status).toBe(200);
    expect((await deleteMessage(h, "ana", "msg-team", "t-team")).status).toBe(200);
    expect(deletedRows(storage, "m-ben")).toEqual([
      expect.objectContaining({ deleted_by: "account:ana" }),
    ]);

    for (const [messageId, threadId, actors] of [
      ["msg-general", "t-general", ["ana", OWNER]],
      ["msg-dm", "t-dm", ["ana", OWNER]],
      ["msg-agent", "t-agent", ["ana", OWNER]],
      ["msg-unknown", "t-unknown", ["ana", OWNER]],
      ["msg-missing", "t-team", ["ana", OWNER]],
      // A removed member, their own message.
      ["m-dan", "t-team", ["dan"]],
      // A named file-share recipient who is not a member, their own Comment.
      ["m-cara", "t-comment", ["cara"]],
      // A Comment on a file under a path the workspace share hides: an admin, and its member author.
      ["msg-notes", "t-notes", ["ana"]],
      ["m-ben-notes", "t-notes", ["ben"]],
    ] as const) {
      for (const as of actors) {
        const refused = await deleteMessage(h, as, messageId, threadId);
        expect(refused.status, `${as} ${messageId}`).toBe(404);
      }
      expect(
        rowsOf(storage, messageId).map((row) => row.op_kind),
        messageId,
      ).not.toContain("chat.message.tombstone");
    }
    // A thread id that does not hold the message finds nothing.
    expect((await deleteMessage(h, OWNER, "msg-comment", "t-team")).status).toBe(404);
  });

  it("lets an owner with no members delete a Comment message", async () => {
    const { storage, h } = await seed();
    const deleted = await deleteMessage(h, OWNER, "msg-comment", "t-comment");
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(rowsOf(storage, "msg-comment").map((row) => row.op_kind)).toEqual([
      "chat.message.tombstone",
      "chat.message.delete",
    ]);
  });

  it("answers a repeat by the deleter with success and changes nothing; anyone else gets not-found", async () => {
    const { storage, h } = await seed();
    const ana = await member(h, "ana");
    await member(h, "ben");
    expect(
      (await push(h, "ana", ana.shareId, memberBatch("ana", "m-ana", "hello", 0))).status,
    ).toBe(200);
    const first = await deleteMessage(h, "ana", "m-ana", "t-team");
    expect(first.status).toBe(200);
    const before = rowsOf(storage, "m-ana");

    const repeat = await deleteMessage(h, "ana", "m-ana", "t-team");
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual(await first.json());
    expect(rowsOf(storage, "m-ana")).toEqual(before);
    expect((await deleteMessage(h, "ben", "m-ana", "t-team")).status).toBe(404);
    expect((await deleteMessage(h, "stranger", "m-ana", "t-team")).status).toBe(404);
  });

  it("refuses a browser cookie from any origin but the share site", async () => {
    const { h } = await seed();
    const refused = await h(
      request(OWNER, `/sync/${WORKSPACE}/chat/messages/msg-team/delete`, {
        ...jsonBody({ threadId: "t-team" }),
        headers: { "content-type": "application/json", cookie: "a=b", origin: "https://evil.test" },
      }),
    );
    expect(refused.status).toBe(404);
  });
});

describe("retries after a delete", () => {
  it("holds an exact retry, refuses a changed one, and stores a later append of the message as a tombstone", async () => {
    const { storage, h } = await seed();
    const ana = await member(h, "ana");
    const batch = memberBatch("ana", "m-ana", "my secret", 0);
    // The acknowledgement is lost, so the member's engine will send it again.
    expect((await push(h, "ana", ana.shareId, batch)).status).toBe(200);
    expect((await deleteMessage(h, "ana", "m-ana", "t-team")).status).toBe(200);

    const retried = await push(h, "ana", ana.shareId, batch);
    expect(retried.status, await retried.clone().text()).toBe(200);
    const changed = await push(h, "ana", ana.shareId, memberBatch("ana", "m-ana", "edited", 0));
    expect(changed.status).toBe(409);

    const later = await push(h, "ana", ana.shareId, memberBatch("ana", "m-ana", "my secret", 1));
    expect(later.status, await later.clone().text()).toBe(200);
    const rows = rowsOf(storage, "m-ana");
    expect(rows.map((row) => row.op_kind)).toEqual([
      "chat.message.tombstone",
      "chat.message.delete",
      "chat.message.tombstone",
    ]);
    expect(JSON.stringify(rows)).not.toContain("my secret");
    expect(deletedRows(storage, "m-ana")).toHaveLength(2);
  });

  it("tombstones the message at every origin and holds an exact retry of each", async () => {
    const { storage, h } = await seed();
    const at = (originId: string, body: string) => ({
      originId,
      ops: [
        {
          ...logOp(
            "chat.message.append",
            chatMessageAppend("m-twice", "t-team", body, { authorUserId: OWNER }).payload,
          ),
          originSeq: 0,
          recordedAtMs: 8000,
        },
      ],
    });
    const first = at("origin-a", "first copy");
    const second = at("origin-b", "second copy");
    await ownerAppend(h, first.ops, first.originId);
    await ownerAppend(h, second.ops, second.originId);

    expect((await deleteMessage(h, OWNER, "m-twice", "t-team")).status).toBe(200);
    const rows = rowsOf(storage, "m-twice");
    expect(rows.map((row) => row.op_kind)).toEqual([
      "chat.message.tombstone",
      "chat.message.tombstone",
      "chat.message.delete",
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/first copy|second copy/u);
    expect(deletedRows(storage, "m-twice").map((row) => row.relay_seq)).toEqual([
      rows[0]!.relay_seq,
      rows[1]!.relay_seq,
    ]);
    await ownerAppend(h, first.ops, first.originId);
    await ownerAppend(h, second.ops, second.originId);
    expect(rowsOf(storage, "m-twice")).toEqual(rows);
  });
});

describe("what only the relay writes", () => {
  it("refuses a client push of a tombstone or a delete op", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    for (const opKind of ["chat.message.tombstone", "chat.message.delete"]) {
      const payload = { messageId: "msg-team", threadId: "t-team", deletedAtMs: 1 };
      const owner = await h(
        request(
          OWNER,
          `/sync/${WORKSPACE}/log`,
          jsonBody({
            originId: "origin-owner-forged",
            ops: [{ ...logOp(opKind, payload), originSeq: 0 }],
          }),
        ),
      );
      expect(owner.ok, opKind).toBe(false);
      const memberPush = await push(h, "ana", ana.shareId, {
        originId: "origin-ana-forged",
        ops: [{ ...logOp(opKind, payload), originSeq: 0 }],
      });
      expect(memberPush.ok, opKind).toBe(false);
    }
    const forgedOrigin = await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/log`,
        jsonBody({
          originId: "relay:message-delete:abc",
          ops: [ownerMessage("m-x", "t-team", "x")],
        }),
      ),
    );
    expect(forgedOrigin.status).toBe(400);
  });

  it("serves a new member the tombstone and the delete, with no body and no attachment", async () => {
    const { storage, h } = await seed();
    await ownerAppend(h, [
      ownerMessage("m-pic", "t-team", "look at this"),
      logOp("chat.attachment.add", {
        attachmentId: "att-1",
        messageId: "m-pic",
        threadId: "t-team",
        targetKind: "file",
        targetPath: "docs/plan.md",
        createdAtMs: 5,
      }),
    ]);
    expect((await deleteMessage(h, OWNER, "m-pic", "t-team")).status).toBe(200);
    const ana = await member(h, "ana");
    const pulled = await h(request("ana", `/sync/shares/${ana.shareId}/log?since=0&limit=500`));
    expect(pulled.status, await pulled.clone().text()).toBe(200);
    const ops = (await json(pulled)).ops as Array<{
      opKind: string;
      payload: Record<string, unknown>;
    }>;
    const about = ops.filter((op) => op.payload.messageId === "m-pic");
    expect(about.map((op) => op.opKind)).toEqual(["chat.message.tombstone", "chat.message.delete"]);
    expect(JSON.stringify(ops)).not.toContain("look at this");
    expectNoDeletedDigest(storagePath(storage), ops);
  });

  it("shows a delete to a browser that already followed past the message, and holds a browser post retry on its line", async () => {
    const { storage, h } = await seed();
    const ana = await member(h, "ana");
    const ben = await member(h, "ben");
    const send = {
      shareId: ana.shareId,
      channelWireId: GROUP,
      threadId: "t-team",
      id: "request-1",
      body: "ana's words",
      authorKind: "human",
    };
    const posted = await browser(h, "ana", "messages", send);
    expect(posted.status, await posted.clone().text()).toBe(200);
    const { messageId, threadId } = (await json(posted)).message as {
      messageId: string;
      threadId: string;
    };
    const history = `messages?shareId=${ben.shareId}&channelWireId=${GROUP}`;
    const page = await json(await browser(h, "ben", history));
    expect(page.messages).toContainEqual(
      expect.objectContaining({ messageId, body: "ana's words" }),
    );

    const removed = await browser(h, "ana", "messages/delete", {
      shareId: ana.shareId,
      threadId,
      messageId,
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    const { deleted } = (await json(removed)) as { deleted: { deletedAtMs: number } };
    expect(deleted).toMatchObject({ messageId, threadId });

    const followed = await json(
      await browser(h, "ben", `messages?shareId=${ben.shareId}&since=${page.nextCursor}`),
    );

    expect(followed.deleted).toEqual([
      expect.objectContaining({ messageId, threadId, deletedAtMs: deleted.deletedAtMs }),
    ]);
    expect(JSON.stringify(followed)).not.toContain("ana's words");
    const fresh = await json(await browser(h, "ben", history));
    expect(fresh.messages).toContainEqual(
      expect.objectContaining({ messageId, body: null, deletedAtMs: deleted.deletedAtMs }),
    );
    expect(JSON.stringify(fresh)).not.toContain("ana's words");
    expectNoDeletedDigest(storagePath(storage), [followed, fresh]);

    const retried = await browser(h, "ana", "messages", send);
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect((await json(retried)).message).toMatchObject({
      messageId,
      body: null,
      deletedAtMs: deleted.deletedAtMs,
    });
    expect(rowsOf(storage, messageId).map((row) => row.op_kind)).toEqual([
      "chat.message.tombstone",
      "chat.message.delete",
    ]);
  });

  it("keeps a deleted first message as the start of its post in a browser page, and its reply as a reply", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    expect(
      (await push(h, "ana", ana.shareId, memberBatch("ana", "m-reply", "a reply", 0))).status,
    ).toBe(200);
    expect((await deleteMessage(h, OWNER, "msg-team", "t-team")).status).toBe(200);
    const page = await json(
      await browser(h, "ana", `messages?shareId=${ana.shareId}&channelWireId=${GROUP}`),
    );
    const lines = page.messages as Array<Record<string, unknown>>;
    expect(lines.find((line) => line.messageId === "msg-team")).toMatchObject({
      body: null,
      startsPost: true,
    });
    expect(lines.find((line) => line.messageId === "m-reply")).toMatchObject({
      body: "a reply",
      startsPost: false,
    });
  });
});

describe("a member's raw pull", () => {
  type Pulled = {
    ops: Array<{ relaySeq: number; opKind: string; payload: Record<string, unknown> }>;
  };
  const pull = (h: SyncRelayHandler, shareId: string) =>
    h(request("ana", `/sync/shares/${shareId}/log?since=0&limit=500`));

  it("answers with the tombstone when the message is deleted while the page waits on author names", async () => {
    const { storage, h } = await seed();
    await ownerAppend(h, [
      ownerMessage("m-pic", "t-team", "the deleted words"),
      logOp("chat.attachment.add", {
        attachmentId: "att-1",
        messageId: "m-pic",
        threadId: "t-team",
        targetKind: "file",
        targetPath: "docs/plan.md",
        createdAtMs: 5,
      }),
    ]);
    const ana = await member(h, "ana");
    const [append] = rowsOf(storage, "m-pic");
    const names = holdNames();
    const pulling = pull(h, ana.shareId);
    await names.atLookup;
    expect((await deleteMessage(h, OWNER, "m-pic", "t-team")).status).toBe(200);
    names.release();
    const answer = await pulling;
    expect(answer.status, await answer.clone().text()).toBe(200);
    const { ops } = (await json(answer)) as Pulled;
    expect(JSON.stringify(ops)).not.toContain("the deleted words");
    expect(ops.find((op) => op.relaySeq === append!.relay_seq)).toMatchObject({
      opKind: "chat.message.tombstone",
      payload: { messageId: "m-pic", authorDisplayName: "Name owner" },
    });
    expect(ops.filter((op) => op.opKind === "chat.attachment.add")).toEqual([]);
  });

  it("rebuilds when an older message is deleted after a newer one was", async () => {
    const { storage, h } = await seed();
    await ownerAppend(h, [
      ownerMessage("m-old", "t-team", "the older words"),
      ownerMessage("m-new", "t-team", "the newer words"),
    ]);
    expect((await deleteMessage(h, OWNER, "m-new", "t-team")).status).toBe(200);
    const ana = await member(h, "ana");
    const [older] = rowsOf(storage, "m-old");
    const names = holdNames();
    const pulling = pull(h, ana.shareId);
    await names.atLookup;
    expect((await deleteMessage(h, OWNER, "m-old", "t-team")).status).toBe(200);
    names.release();
    const answer = await pulling;
    expect(answer.status, await answer.clone().text()).toBe(200);
    const { ops } = (await json(answer)) as Pulled;
    expect(JSON.stringify(ops)).not.toContain("the older words");
    expect(ops.find((op) => op.relaySeq === older!.relay_seq)?.opKind).toBe(
      "chat.message.tombstone",
    );
  });

  it("answers busy, with nothing from either read, when the rebuild goes stale too", async () => {
    const { h } = await seed();
    await ownerAppend(h, [
      ownerMessage("m-one", "t-team", "the first words"),
      ownerMessage("m-two", "t-team", "the second words"),
    ]);
    const ana = await member(h, "ana");
    const first = holdNames();
    const pulling = pull(h, ana.shareId);
    await first.atLookup;
    expect((await deleteMessage(h, OWNER, "m-one", "t-team")).status).toBe(200);
    first.release();
    const second = holdNames();
    await second.atLookup;
    expect((await deleteMessage(h, OWNER, "m-two", "t-team")).status).toBe(200);
    second.release();
    const answer = await pulling;
    expect(answer.status).toBe(503);
    expect(await answer.text()).not.toMatch(/the (first|second) words/u);
    const next = await pull(h, ana.shareId);
    expect(next.status).toBe(200);
  });
});

describe("the owner's raw pull", () => {
  type Pulled = {
    ops: Array<{ relaySeq: number; opKind: string; payload: Record<string, unknown> }>;
  };
  // The owner route itself, with each reference read running `during` first. The route holds its page across that read.
  function ownerPull(storage: SyncRelayStorage, during: () => void) {
    const reading = new Proxy(storage, {
      get(target, key) {
        if (key === "listWorkReferences")
          return (...args: Parameters<SyncRelayStorage["listWorkReferences"]>) => {
            during();
            return target.listWorkReferences(...args);
          };
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const routes = createWorkspaceReplicationRoutes(
      reading,
      () => 2000,
      { wakeLog() {}, wait: async () => {} },
      { watched: () => false },
    );
    return routes.respondToWorkspaceReplication(
      request(OWNER, `/sync/${WORKSPACE}/log?since=0&limit=500`),
      { route: "log", workspaceId: WORKSPACE },
      { userId: OWNER },
    );
  }
  const remove = (storage: SyncRelayStorage, messageId: string) =>
    expect(
      storage.deleteWorkspaceMessage({
        workspaceId: WORKSPACE,
        threadId: "t-team",
        messageId,
        actor: { kind: "account", userId: OWNER },
        nowMs: 2000,
      }).ok,
    ).toBe(true);

  it("answers with the tombstone when the message is deleted while the page waits on references", async () => {
    const { storage } = await seed();
    const [append] = rowsOf(storage, "msg-team");
    let reads = 0;
    const answer = await ownerPull(storage, () => {
      if (reads++ === 0) remove(storage, "msg-team");
    });
    expect(answer.status, await answer.clone().text()).toBe(200);
    const { ops } = (await json(answer)) as Pulled;
    expect(JSON.stringify(ops)).not.toContain("welcome to the team");
    expect(ops.find((op) => op.relaySeq === append!.relay_seq)?.opKind).toBe(
      "chat.message.tombstone",
    );
    expect(ops.at(-1)).toMatchObject({ opKind: "chat.message.delete" });
  });

  it("answers busy, with nothing from either read, when the rebuild goes stale too", async () => {
    const { storage, h } = await seed();
    await ownerAppend(h, [ownerMessage("m-two", "t-team", "the second words")]);
    const deletes = ["msg-team", "m-two"];
    await expect(
      ownerPull(storage, () => {
        const next = deletes.shift();
        if (next) remove(storage, next);
      }),
    ).rejects.toMatchObject({ code: "server_busy", statusCode: 503 });
  });
});
