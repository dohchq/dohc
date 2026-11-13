import { GENERAL_CHANNEL_WIRE_ID } from "@dohc/security-contract/chat-wire-ids";
import type { WorkspaceMembersView } from "@dohc/security-contract/workspace-members";
import { afterEach, describe, expect, it } from "vitest";
import { DiscussionActivityHub } from "./discussionActivity";
import {
  fenceAccount,
  initializeAccountDeletion,
  purgeAccountRows,
} from "./storage/accountDeletion";
import type { StorageContext } from "./storage/context";
import { parseRoute } from "./relayRoute";
import { parseWorkspaceMemberRoute } from "./workspaceMemberRoutes";
import type { SyncRelayHandler } from "./server";
import {
  chatChannelCreate,
  chatMessageAppend,
  chatThreadCreate,
  closeTestStorages,
  json,
  jsonBody,
  logOp,
  putBlob,
  request,
  resetOpSeq,
  SHARE_WEB_ORIGIN,
  sha256,
  testHandler,
  testStorage,
} from "./testing";

afterEach(closeTestStorages);

const OWNER = "owner";
const WORKSPACE = "workspace-members";
const GROUP = "wire-team";
const LATER_GROUP = "wire-later";
const DM = "wire-dm";
const AGENT = "wire-agent";
const UNKNOWN = "wire-never-created";

let ownerSeq = 0;

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

function message(messageId: string, threadId: string, body: string) {
  return logOp(
    "chat.message.append",
    chatMessageAppend(messageId, threadId, body, { authorUserId: OWNER }).payload,
  );
}

async function ownerAppend(h: SyncRelayHandler, ops: unknown[]): Promise<void> {
  const response = await h(
    request(OWNER, `/sync/${WORKSPACE}/log`, jsonBody({ originId: "origin-owner", ops })),
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

async function ownerWrite(h: SyncRelayHandler, path: string, text: string): Promise<void> {
  const sha = await putBlob(h, OWNER, WORKSPACE, text);
  const seq = ownerSeq++;
  await ownerAppend(h, [
    logOp("moment.append", {
      momentId: `m-${seq}`,
      versionId: "main",
      objectId: `object-${path}`,
      path,
      recordedAtMs: 1000 + seq,
      operation: "write",
      payloadBeforeBlobSha256: null,
      payloadBeforePath: null,
      payloadAfterBlobSha256: sha,
      payloadAfterPath: path,
      metadata: { origin: "user" },
      beforePresent: "null",
    }),
  ]);
}

// The owner's workspace: a Group, General, a direct message, an agent chat,
// a message in a channel the log never created, a file, a version fork, and
// a secret. Everything a member must not see says SENTINEL.
async function seed(
  options: { activity?: DiscussionActivityHub; overrides?: Parameters<typeof testHandler>[1] } = {},
) {
  resetOpSeq();
  ownerSeq = 0;
  const storage = await testStorage();
  const h = testHandler(storage, {
    lookupUserDisplayName: (userId: string) => `Name ${userId}`,
    ...(options.activity ? { discussionActivity: options.activity } : {}),
    ...options.overrides,
  });
  expect(
    (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
  ).toBe(200);
  await ownerAppend(h, [
    channel(GROUP, "team"),
    thread("t-team", GROUP, "team"),
    message("msg-team", "t-team", "welcome to the team"),
    channel(GENERAL_CHANNEL_WIRE_ID, "general"),
    thread("t-general", GENERAL_CHANNEL_WIRE_ID, "general"),
    message("msg-general", "t-general", "SENTINEL general"),
    channel(DM, "someone", "dm"),
    thread("t-dm", DM, "someone"),
    message("msg-dm", "t-dm", "SENTINEL direct message"),
    channel(AGENT, "bot", "agent"),
    thread("t-agent", AGENT, "bot"),
    message("msg-agent", "t-agent", "SENTINEL agent chat"),
    thread("t-unknown", UNKNOWN, "ghost"),
    message("msg-unknown", "t-unknown", "SENTINEL unknown channel"),
    logOp("secret.file.put", {
      versionId: "main",
      path: "notes/.env.local",
      metadata: { origin: "user" },
      ivBase64: "AA==",
      authTagBase64: "AA==",
      ciphertextSha256: null,
      byteLength: 0,
    }),
  ]);
  await ownerWrite(h, "docs/plan.md", "the plan");
  return { storage, h };
}

function post(
  h: SyncRelayHandler,
  as: string,
  path: string,
  body: Record<string, unknown> = {},
  init: RequestInit = {},
) {
  const base = jsonBody(body);
  return h(
    request(as, path, {
      ...base,
      ...init,
      headers: {
        ...(base.headers as Record<string, string>),
        ...(init.headers as Record<string, string> | undefined),
      },
    }),
  );
}

async function invite(
  h: SyncRelayHandler,
  as: string,
  email: string,
  workspaceName: string | null = "Community",
) {
  return post(h, as, `/sync/${WORKSPACE}/members/invites`, {
    email,
    ...(workspaceName === null ? {} : { workspaceName }),
  });
}

/** Invites an account and answers its member id, from the view the invite answers. */
async function invited(h: SyncRelayHandler, userId: string, as = OWNER): Promise<string> {
  const response = await invite(h, as, `${userId}@dohc.test`);
  expect(response.status, await response.clone().text()).toBe(200);
  return memberIdOf((await response.json()) as WorkspaceMembersView, userId)!;
}

function memberIdOf(view: WorkspaceMembersView, userId: string): string | undefined {
  return view.people.find((person) => person.name === `Name ${userId}`)?.memberId;
}

async function membersView(h: SyncRelayHandler, as: string): Promise<WorkspaceMembersView> {
  const response = await h(request(as, `/sync/${WORKSPACE}/members`));
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as WorkspaceMembersView;
}

/** The workspace share a person received, or undefined. */
async function workspaceShare(
  h: SyncRelayHandler,
  userId: string,
): Promise<Record<string, unknown> | undefined> {
  const response = await h(request(userId, "/sync/shares"));
  expect(response.status).toBe(200);
  return ((await json(response)).received as Array<Record<string, unknown>>).find(
    (row) => (row.selector as { kind?: string } | undefined)?.kind === "workspace",
  );
}

async function shareIdOf(h: SyncRelayHandler, userId: string): Promise<string> {
  const row = await workspaceShare(h, userId);
  expect(row).toBeDefined();
  return row!.shareId as string;
}

function pull(h: SyncRelayHandler, userId: string, shareId: string, channelWireId?: string) {
  const query = channelWireId === undefined ? "" : `&channelWireId=${channelWireId}`;
  return h(request(userId, `/sync/shares/${shareId}/log?since=0&limit=500${query}`));
}

async function pulledText(
  h: SyncRelayHandler,
  userId: string,
  shareId: string,
  channelWireId?: string,
): Promise<string> {
  const response = await pull(h, userId, shareId, channelWireId);
  expect(response.status, await response.clone().text()).toBe(200);
  return JSON.stringify((await json(response)).ops);
}

function postInGroup(
  h: SyncRelayHandler,
  userId: string,
  shareId: string,
  messageId: string,
  seq = 0,
) {
  return post(h, userId, `/sync/shares/${shareId}/log`, {
    originId: `origin-${userId}`,
    ops: [
      {
        ...logOp(
          "chat.message.append",
          chatMessageAppend(messageId, "t-team", "hello", { authorUserId: userId }).payload,
        ),
        originSeq: seq,
      },
    ],
  });
}

function commentOnFile(h: SyncRelayHandler, userId: string, shareId: string, seq = 0) {
  return post(h, userId, `/sync/shares/${shareId}/log`, {
    originId: `origin-file-${userId}`,
    ops: [
      {
        originSeq: seq,
        opKind: "chat.thread.create",
        recordedAtMs: 5000 + seq,
        payload: {
          threadId: `thread-${userId}-${seq}`,
          title: "A question",
          createdAtMs: 5000,
          linkedAtMs: 5000,
          linkedPath: "docs/plan.md",
        },
      },
    ],
  });
}

function uploadBlob(h: SyncRelayHandler, userId: string, shareId: string, text: string) {
  return h(
    request(userId, `/sync/shares/${shareId}/blobs/${sha256(text)}`, {
      method: "PUT",
      body: new TextEncoder().encode(text),
    }),
  );
}

async function code(response: Response): Promise<unknown> {
  return (await json(response)).code;
}

async function inviteLink(h: SyncRelayHandler, as: string, action: string): Promise<string | null> {
  const response = await post(h, as, `/sync/${WORKSPACE}/members/invite-link`, {
    action,
    workspaceName: "Community",
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const url = ((await response.json()) as WorkspaceMembersView).inviteLink!.url;
  if (url === null) return null;
  expect(url.startsWith(`${SHARE_WEB_ORIGIN}/join#`)).toBe(true);
  return url.slice(`${SHARE_WEB_ORIGIN}/join#`.length);
}

function join(h: SyncRelayHandler, userId: string, token: string) {
  return post(h, userId, "/sync/members/join", { token });
}

describe("workspace member routes", () => {
  it("parses every member path, and only those", () => {
    const parse = (path: string) => parseWorkspaceMemberRoute(path.split("/").filter(Boolean));
    expect(parseRoute({ url: "http://relay.test/sync/members/join" })).toEqual({
      route: "members-join",
    });
    expect(parseRoute({ url: "http://relay.test/sync/members/join-preview" })).toEqual({
      route: "members-join-preview",
    });
    expect(parseRoute({ url: `http://relay.test/sync/${WORKSPACE}/members` })).toEqual({
      route: "members",
      workspaceId: WORKSPACE,
    });
    for (const [tail, route] of [
      ["invites", "members-invite"],
      ["level", "members-level"],
      ["invite-link", "members-invite-link"],
      ["leave", "members-leave"],
      ["end", "members-end"],
    ]) {
      expect(parse(`/sync/${WORKSPACE}/members/${tail}`)).toEqual({
        route,
        workspaceId: WORKSPACE,
      });
    }
    for (const [tail, route] of [
      ["role", "members-role"],
      ["remove", "members-remove"],
      ["let-back-in", "members-let-back-in"],
    ]) {
      expect(parse(`/sync/${WORKSPACE}/members/m-1/${tail}`)).toEqual({
        route,
        workspaceId: WORKSPACE,
        memberId: "m-1",
      });
    }
    expect(parse(`/sync/${WORKSPACE}/members/unknown`)).toBeNull();
    expect(parse(`/sync/${WORKSPACE}/members/m-1/unknown`)).toBeNull();
    expect(parse("/sync/members/other")).toBeNull();
    expect(parseRoute({ url: "http://relay.test/sync/members/groups" })).toEqual({
      route: "members-group-create",
    });
    // A workspace may be called "members".
    expect(parseRoute({ url: "http://relay.test/sync/members/members" })).toEqual({
      route: "members",
      workspaceId: "members",
    });
    expect(parse("/sync/members/members/level")).toEqual({
      route: "members-level",
      workspaceId: "members",
    });
  });
});

describe("what a member reaches", () => {
  it("reaches every file on main and ordinary Groups, including new ones, and never General, direct messages, agent chats, unknown channels, or secrets", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    const row = await workspaceShare(h, "ana");
    expect(row).toMatchObject({
      selector: { kind: "workspace", role: "member" },
      access: "comment",
    });
    const shareId = row!.shareId as string;

    const files = await pulledText(h, "ana", shareId);
    expect(files).toContain("docs/plan.md");
    expect(files).not.toContain("SENTINEL");
    expect(files).not.toContain(".env.local");

    expect(await pulledText(h, "ana", shareId, GROUP)).toContain("welcome to the team");
    for (const wireId of [GENERAL_CHANNEL_WIRE_ID, DM, AGENT, UNKNOWN]) {
      expect((await pull(h, "ana", shareId, wireId)).status, wireId).toBe(404);
    }

    // Work the owner adds after the invite is reachable without another grant.
    await ownerWrite(h, "later/new.md", "new work");
    await ownerAppend(h, [
      channel(LATER_GROUP, "later"),
      thread("t-later", LATER_GROUP, "later"),
      message("msg-later", "t-later", "a new group"),
    ]);
    expect(await pulledText(h, "ana", shareId)).toContain("later/new.md");
    expect(await pulledText(h, "ana", shareId, LATER_GROUP)).toContain("a new group");
  });

  it("joins presence for Groups and files, and never for General, direct messages, or agent chats", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    const presence = (topic: string) =>
      h(
        request(
          "ana",
          `/sync/shares/${shareId}/presence?topic=${encodeURIComponent(topic)}&hold=0`,
        ),
      );
    for (const topic of [GROUP, "chat:thread:t-team", "docs/plan.md"]) {
      expect((await presence(topic)).status, topic).toBe(200);
    }
    // Agent chats the relay has not seen yet are refused too: their ids are known in advance.
    for (const topic of [
      GENERAL_CHANNEL_WIRE_ID,
      DM,
      AGENT,
      "channel_wire_agent_v1",
      "channel_wire_agent_v1_helper",
      "chat:thread:t-general",
      "chat:thread:t-dm",
    ]) {
      expect((await presence(topic)).status, topic).toBe(404);
    }
  });

  it("lets Comment post and comment but not edit, View only read, and Edit change files", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");

    expect((await postInGroup(h, "ana", shareId, "m-1")).status).toBe(200);
    expect((await commentOnFile(h, "ana", shareId)).status).toBe(200);
    const readOnly = await uploadBlob(h, "ana", shareId, "an edit");
    expect(readOnly.status).toBe(403);
    expect(await code(readOnly)).toBe("share_read_only");

    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/level`, { level: "view" })).status,
    ).toBe(200);
    expect(await workspaceShare(h, "ana")).toMatchObject({ access: "view" });
    expect(await pulledText(h, "ana", shareId)).toContain("docs/plan.md");
    for (const refused of [
      await postInGroup(h, "ana", shareId, "m-2", 1),
      await commentOnFile(h, "ana", shareId, 1),
    ]) {
      expect(refused.status).toBe(403);
      expect(await code(refused)).toBe("share_read_only");
    }

    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/level`, { level: "edit" })).status,
    ).toBe(200);
    expect((await uploadBlob(h, "ana", shareId, "an edit")).status).toBe(200);
  });

  it("lets Comment and Edit post, reply and react in a Group, never in General, a direct message or an agent chat", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    let seq = 0;
    // A refused batch takes no sequence numbers.
    const append = async (ops: Array<{ opKind: string; payload: Record<string, unknown> }>) => {
      const response = await post(h, "ana", `/sync/shares/${shareId}/log`, {
        originId: "origin-ana-matrix",
        ops: ops.map((op, index) => ({
          ...op,
          originSeq: seq + index,
          recordedAtMs: 7000 + seq + index,
        })),
      });
      if (response.status === 200) seq += ops.length;
      return response;
    };
    const reply = (messageId: string, threadId: string, parentMessageId: string) =>
      chatMessageAppend(messageId, threadId, "a reply", { authorUserId: "ana", parentMessageId });
    const react = (threadId: string, messageId: string) => ({
      opKind: "chat.reaction.set",
      payload: {
        reactionId: `r-${threadId}-${seq}`,
        messageId,
        threadId,
        emoji: "👍",
        authorId: "ana",
        authorKind: "human",
        authorDisplayName: "Ana",
        state: "added",
        atMs: 7000,
      },
    });
    for (const level of ["comment", "edit"] as const) {
      expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/level`, { level })).status).toBe(
        200,
      );
      const posted = await append([
        chatMessageAppend(`m-${level}`, "t-team", "hello", { authorUserId: "ana" }),
      ]);
      expect(posted.status, await posted.clone().text()).toBe(200);
      const replied = await append([reply(`m-${level}-reply`, "t-team", "msg-team")]);
      expect(replied.status, await replied.clone().text()).toBe(200);
      const reacted = await append([react("t-team", "msg-team")]);
      expect(reacted.status, await reacted.clone().text()).toBe(200);
      for (const [threadId, messageId] of [
        ["t-general", "msg-general"],
        ["t-dm", "msg-dm"],
        ["t-agent", "msg-agent"],
      ] as const) {
        for (const ops of [
          [chatMessageAppend(`m-${level}-${threadId}`, threadId, "hello", { authorUserId: "ana" })],
          [reply(`m-${level}-${threadId}-reply`, threadId, messageId)],
          [react(threadId, messageId)],
        ]) {
          const refused = await append(ops);
          expect(refused.status, `${level} ${threadId} ${ops[0]!.opKind}`).toBe(403);
          expect(await code(refused)).toBe("share_op_rejected");
        }
      }
    }
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/level`, { level: "view" })).status,
    ).toBe(200);
    for (const ops of [
      [chatMessageAppend("m-view", "t-team", "hello", { authorUserId: "ana" })],
      [reply("m-view-reply", "t-team", "msg-team")],
      [react("t-team", "msg-team")],
    ]) {
      const refused = await append(ops);
      expect(refused.status).toBe(403);
      expect(await code(refused)).toBe("share_read_only");
    }
  });

  it("starts a thread with its first message in one batch, on a file or in a Group", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    const startThread = (threadId: string, seq: number, create: Record<string, unknown>) =>
      post(h, "ana", `/sync/shares/${shareId}/log`, {
        originId: "origin-ana-batch",
        ops: [
          {
            originSeq: seq,
            opKind: "chat.thread.create",
            recordedAtMs: 6000 + seq,
            payload: { threadId, title: "A question", createdAtMs: 6000, ...create },
          },
          {
            ...logOp(
              "chat.message.append",
              chatMessageAppend(`${threadId}-first`, threadId, "first", { authorUserId: "ana" })
                .payload,
            ),
            originSeq: seq + 1,
          },
        ],
      });
    const onFile = await startThread("t-file", 0, { linkedAtMs: 6000, linkedPath: "docs/plan.md" });
    expect(onFile.status, await onFile.clone().text()).toBe(200);
    const inGroup = await startThread("t-group", 2, { channelWireId: GROUP, channelSlug: "team" });
    expect(inGroup.status, await inGroup.clone().text()).toBe(200);
    for (const [index, linkedPath] of ["notes/.env.local", "docs/missing.md"].entries()) {
      const refused = await startThread(`t-out-${index}`, 4, { linkedAtMs: 6000, linkedPath });
      expect(refused.status, linkedPath).toBe(403);
      expect(await code(refused)).toBe("share_op_rejected");
    }
  });

  it("refuses the share's generic owner controls; membership changes on the Members page", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    const revoke = await post(h, OWNER, `/sync/shares/${shareId}/revoke`);
    expect(revoke.status).toBe(409);
    expect(await code(revoke)).toBe("workspace_share_managed");
    const link = await post(h, OWNER, `/sync/${WORKSPACE}/shares/${shareId}/links`, {
      access: "view",
    });
    expect(link.status).toBe(409);
    // Anyone else learns nothing about the share.
    for (const as of ["ana", "stranger"])
      expect((await post(h, as, `/sync/shares/${shareId}/revoke`)).status).toBe(404);
    expect(await pulledText(h, "ana", shareId)).toContain("docs/plan.md");
  });

  it("tells the person who added them and to which workspace", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    const response = await h(request("ana", "/sync/notices"));
    expect(response.status).toBe(200);
    const titles = ((await json(response)).notices as Array<{ title: string }>).map(
      (row) => row.title,
    );
    expect(titles.some((title) => title.endsWith("added you to Community"))).toBe(true);
  });

  it("names the owner to a member without the owner's email", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    const row = await workspaceShare(h, "ana");
    expect(row).toMatchObject({ granterEmail: null, sharerName: "Name owner" });
    const detail = await h(request("ana", `/sync/shares/${row!.shareId as string}`));
    expect(detail.status).toBe(200);
    expect(await json(detail)).toMatchObject({ granterEmail: null, sharerName: "Name owner" });
    const notices = await h(request("ana", "/sync/notices"));
    const text = JSON.stringify(await json(notices));
    expect(text).toContain("Name owner added you to Community");
    expect(text).not.toContain(`${OWNER}@`);
  });
});

describe("a member's share view", () => {
  // The owner's computer names a person with no profile name "You".
  async function ownerPostsAsYou(h: SyncRelayHandler) {
    await ownerAppend(h, [
      logOp(
        "chat.message.append",
        chatMessageAppend("msg-you", "t-team", "from the owner", {
          authorUserId: OWNER,
          authorDisplayName: "You",
        }).payload,
      ),
      logOp("chat.message.append", {
        ...chatMessageAppend("msg-agent-you", "t-team", "from the owner's agent", {
          authorUserId: OWNER,
          authorDisplayName: "Helper",
        }).payload,
        authorKind: "agent",
        authorOwnerDisplayName: "You",
      }),
    ]);
  }
  function served(ops: unknown, messageId: string): Record<string, unknown> {
    const op = (ops as Array<{ opKind: string; payload: Record<string, unknown> }>).find(
      (entry) => entry.opKind === "chat.message.append" && entry.payload.messageId === messageId,
    );
    expect(op, messageId).toBeDefined();
    return op!.payload;
  }

  it("names every person by their account, never as the owner's computer named them", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    await ownerPostsAsYou(h);
    const { ops } = await json(await pull(h, "ana", shareId));
    expect(served(ops, "msg-you")).toMatchObject({
      authorKind: "human",
      authorDisplayName: "Name owner",
    });
    expect(served(ops, "msg-agent-you")).toMatchObject({
      authorKind: "agent",
      authorDisplayName: "Helper",
      authorOwnerDisplayName: "Name owner",
    });
    expect(served(ops, "msg-team")).toMatchObject({ authorDisplayName: "Name owner" });
  });

  it("names a person with no account name as the Members page does", async () => {
    const { h } = await seed({
      overrides: {
        lookupUserDisplayName: (userId: string) => (userId === OWNER ? null : `Name ${userId}`),
      },
    });
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    await ownerPostsAsYou(h);
    const { ops } = await json(await pull(h, "ana", shareId));
    expect(served(ops, "msg-you")).toMatchObject({ authorDisplayName: "No name" });
    expect(served(ops, "msg-agent-you")).toMatchObject({ authorOwnerDisplayName: "No name" });
    expect(JSON.stringify(ops)).not.toContain(`${OWNER}@`);
  });

  async function info(h: SyncRelayHandler, userId: string, shareId: string) {
    return h(request(userId, `/sync/shares/${shareId}`));
  }
  async function access(h: SyncRelayHandler, userId: string, shareId: string) {
    return h(request(userId, `/sync/shares/${shareId}/access`));
  }

  it("names the workspace, the role and the level for a member", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    const response = await info(h, "ana", shareId);
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      shareId,
      subjectName: "Community",
      selector: { kind: "workspace", role: "member" },
      access: "comment",
    });
    expect(await json(await access(h, "ana", shareId))).toEqual({
      status: "current",
      access: "comment",
      role: "member",
    });
  });

  it("names the admin role with Edit", async () => {
    const { h } = await seed();
    const ana = await invited(h, "ana");
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "admin" })).status,
    ).toBe(200);
    const shareId = await shareIdOf(h, "ana");
    expect(await json(await info(h, "ana", shareId))).toMatchObject({
      subjectName: "Community",
      selector: { kind: "workspace", role: "admin" },
      access: "edit",
    });
    expect(await json(await access(h, "ana", shareId))).toEqual({
      status: "current",
      access: "edit",
      role: "admin",
    });
  });

  it("says a removed member's access was removed", async () => {
    const { h } = await seed();
    const ana = await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/remove`)).status).toBe(200);
    for (const response of [await info(h, "ana", shareId), await access(h, "ana", shareId)]) {
      expect(response.status).toBe(404);
      expect(await code(response)).toBe("share_access_removed");
    }
    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/let-back-in`)).status).toBe(
      200,
    );
    expect((await info(h, "ana", shareId)).status).toBe(200);
  });

  it("says access was removed when the owner ends the membership", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/end`)).status).toBe(200);
    for (const response of [await info(h, "ana", shareId), await access(h, "ana", shareId)]) {
      expect(response.status).toBe(404);
      expect(await code(response)).toBe("share_access_removed");
    }
  });
});

describe("who may change members", () => {
  it("needs a workspace name before the first invite", async () => {
    const { h } = await seed();
    const response = await invite(h, OWNER, "ana@dohc.test", null);
    expect(response.status).toBe(400);
    expect(await code(response)).toBe("workspace_name_required");
    expect((await invite(h, OWNER, "ana@dohc.test", "x".repeat(161))).status).toBe(400);
  });

  it("gives admins Edit and the member controls, and keeps roles and ending with the owner", async () => {
    const { h } = await seed();
    const ana = await invited(h, "ana");
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "admin" })).status,
    ).toBe(200);
    expect(await workspaceShare(h, "ana")).toMatchObject({ access: "edit" });

    const ben = await invited(h, "ben", "ana");
    const admin = await membersView(h, "ana");
    expect(admin.viewer).toEqual({ memberId: ana, role: "admin" });
    expect(admin.people.find((person) => person.memberId === ben)?.email).toBe("ben@dohc.test");
    expect(
      (await post(h, "ana", `/sync/${WORKSPACE}/members/level`, { level: "view" })).status,
    ).toBe(200);
    expect(await inviteLink(h, "ana", "turn-on")).not.toBeNull();

    for (const [path, body] of [
      [`/sync/${WORKSPACE}/members/${ben}/role`, { role: "admin" }],
      [`/sync/${WORKSPACE}/members/end`, {}],
    ] as const) {
      const refused = await post(h, "ana", path, body);
      expect(refused.status, path).toBe(403);
      expect(await code(refused)).toBe("members_forbidden");
    }
    expect((await post(h, "ana", `/sync/${WORKSPACE}/members/owner/remove`)).status).toBe(404);
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ben}/role`, { role: "admin" })).status,
    ).toBe(200);
    expect((await post(h, "ana", `/sync/${WORKSPACE}/members/${ben}/remove`)).status).toBe(403);
    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/${ben}/remove`)).status).toBe(200);
    expect(await workspaceShare(h, "ben")).toBeUndefined();

    // Back to member: the grant follows the level, not Edit.
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "member" })).status,
    ).toBe(200);
    expect(await workspaceShare(h, "ana")).toMatchObject({ access: "view" });
  });

  it("shows members only active people, with no emails, invites, or link, and lets them change nothing", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    const pending = await invite(h, OWNER, "someone@elsewhere.example");
    expect(pending.status).toBe(200);
    const removed = await invited(h, "ben");
    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/${removed}/remove`)).status).toBe(200);

    const member = await membersView(h, "ana");
    expect(member.viewer.role).toBe("member");
    expect(member.inviteLink).toBeNull();
    expect(member.people.map((person) => person.name)).toEqual(["Name owner", "Name ana"]);
    expect(
      member.people.every((person) => person.email === null && person.state === "active"),
    ).toBe(true);
    expect(JSON.stringify(member)).not.toContain("elsewhere.example");

    for (const [path, body] of [
      [`/sync/${WORKSPACE}/members/invites`, { email: "carl@dohc.test" }],
      [`/sync/${WORKSPACE}/members/level`, { level: "edit" }],
      [`/sync/${WORKSPACE}/members/invite-link`, { action: "turn-on" }],
      [`/sync/${WORKSPACE}/members/${removed}/let-back-in`, {}],
    ] as const) {
      expect((await post(h, "ana", path, body)).status, path).toBe(403);
    }
    expect((await h(request("stranger", `/sync/${WORKSPACE}/members`))).status).toBe(404);
  });

  it("turns an email invite into a member when that address signs up", async () => {
    const { h, storage } = await seed();
    expect((await invite(h, OWNER, "New@Elsewhere.example")).status).toBe(200);
    const owner = await membersView(h, OWNER);
    expect(owner.people.find((person) => person.state === "invited")?.email).toBe(
      "new@elsewhere.example",
    );
    expect(storage.hasPendingInvite("new@elsewhere.example")).toBe(true);

    storage.claimPendingSharesForEmail("new@elsewhere.example", "newcomer");
    expect(await workspaceShare(h, "newcomer")).toMatchObject({ access: "comment" });
    expect(
      (await membersView(h, OWNER)).people.find((person) => person.name === "Name newcomer")?.state,
    ).toBe("active");
  });

  it("gives no authority through a revoked grant, even while its entry is still active", async () => {
    const { h, storage } = await seed();
    const ana = await invited(h, "ana");
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "admin" })).status,
    ).toBe(200);
    expect((await h(request("ana", `/sync/${WORKSPACE}/members`))).status).toBe(200);
    (storage as unknown as StorageContext).db
      .prepare(
        `UPDATE sync_relay_share_grants SET status = 'revoked', generation = generation + 1, revoked_at_ms = 1
       WHERE grant_id = (SELECT grant_id FROM sync_relay_workspace_members WHERE member_id = ?)`,
      )
      .run(ana);
    expect((await h(request("ana", `/sync/${WORKSPACE}/members`))).status).toBe(404);
    expect(
      (await post(h, "ana", `/sync/${WORKSPACE}/members/level`, { level: "edit" })).status,
    ).toBe(404);
  });

  // No trigger keeps grants and entries in step, so this check is the only
  // guard: an active grant its entry does not back gives no access.
  it.each([
    ["its entry is gone", `DELETE FROM sync_relay_workspace_members WHERE member_id = :member`],
    [
      "its entry was removed",
      `UPDATE sync_relay_workspace_members SET state = 'removed', ended_at_ms = 1 WHERE member_id = :member`,
    ],
    [
      "its access is above the role's",
      `UPDATE sync_relay_share_grants SET access = 'edit' WHERE grant_id = :grant`,
    ],
    [
      "it is a child grant",
      `UPDATE sync_relay_share_grants SET parent_grant_id = grant_id WHERE grant_id = :grant`,
    ],
    [
      "it names another account",
      `UPDATE sync_relay_share_grants SET principal_user_id = 'ben' WHERE grant_id = :grant`,
    ],
  ])("gives no authority through an active grant when %s", async (_case, sql) => {
    const { h, storage } = await seed();
    const ana = await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    expect((await pull(h, "ana", shareId)).status).toBe(200);
    const db = (storage as unknown as StorageContext).db;
    const grant = (
      db
        .prepare(`SELECT grant_id FROM sync_relay_workspace_members WHERE member_id = ?`)
        .get(ana) as { grant_id: string }
    ).grant_id;
    db.prepare(sql).run(sql.includes(":member") ? { member: ana } : { grant });
    expect((await pull(h, "ana", shareId)).status).not.toBe(200);
    expect((await h(request("ana", `/sync/${WORKSPACE}/members`))).status).toBe(404);
  });

  it("refuses browser cookies from any origin but the share site", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    const foreign = await h(
      request("ana", `/sync/${WORKSPACE}/members`, {
        headers: { cookie: "session=x", origin: "https://evil.example" },
      }),
    );
    expect(foreign.status).toBe(404);
    const share = await h(
      request("ana", `/sync/${WORKSPACE}/members`, {
        headers: { cookie: "session=x", origin: SHARE_WEB_ORIGIN },
      }),
    );
    expect(share.status).toBe(200);
  });
});

describe("an admin's new Group", () => {
  function createGroup(
    h: SyncRelayHandler,
    as: string,
    shareId: string,
    body: Record<string, unknown> = { name: "Events" },
  ) {
    return post(h, as, "/sync/members/groups", { shareId, ...body });
  }
  async function admin(h: SyncRelayHandler, userId: string) {
    const memberId = await invited(h, userId);
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${memberId}/role`, { role: "admin" }))
        .status,
    ).toBe(200);
    return { memberId, shareId: await shareIdOf(h, userId) };
  }

  it("writes the Group into the owner's log from a relay origin, and every member reaches it", async () => {
    const { h } = await seed();
    const ana = await admin(h, "ana");
    await invited(h, "ben");
    const created = await createGroup(h, "ana", ana.shareId, {
      name: "Events",
      type: "chat",
      purpose: "Plan the fair",
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const { channelWireId, name } = (await json(created)) as {
      channelWireId: string;
      name: string;
    };
    expect(name).toBe("Events");
    const ownerLog = await json(await h(request(OWNER, `/sync/${WORKSPACE}/log?since=0`)));
    const op = (
      ownerLog.ops as Array<{ opKind: string; originId: string; payload: Record<string, unknown> }>
    ).find(
      (entry) => entry.opKind === "chat.channel.create" && entry.payload.wireId === channelWireId,
    );
    expect(op).toBeDefined();
    expect(op!.originId).toBe(`relay:workspace-admin:${ana.memberId}`);
    expect(op!.payload).toEqual({
      channelId: channelWireId,
      wireId: channelWireId,
      name: "Events",
      slug: "events",
      kind: "channel",
      type: "chat",
      purpose: "Plan the fair",
      createdAtMs: expect.any(Number),
    });
    // An ordinary Group: no invite, and a member posts in it.
    expect(await pulledText(h, "ben", await shareIdOf(h, "ben"))).toContain(channelWireId);
  });

  it("refuses a member, a removed admin, and an admin whose owner's account is fenced", async () => {
    const { h, storage } = await seed();
    const ana = await admin(h, "ana");
    const cara = await admin(h, "cara");
    await invited(h, "ben");
    const refusedMember = await createGroup(h, "ben", await shareIdOf(h, "ben"));
    expect(refusedMember.status).toBe(403);
    expect(await code(refusedMember)).toBe("members_forbidden");
    // Another person's share names no workspace of theirs.
    expect((await createGroup(h, "ben", ana.shareId)).status).toBe(403);

    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${cara.memberId}/remove`)).status,
    ).toBe(200);
    expect((await createGroup(h, "cara", cara.shareId)).status).toBe(404);
    const ownerLog = await json(await h(request(OWNER, `/sync/${WORKSPACE}/log?since=0`)));
    expect(JSON.stringify(ownerLog)).not.toContain("relay:workspace-admin:");

    const key = "account-deletion-key-at-least-32-bytes";
    const context = storage as unknown as StorageContext;
    initializeAccountDeletion(context, key);
    fenceAccount(context, key, OWNER, `${OWNER}@dohc.test`);
    expect((await createGroup(h, "ana", ana.shareId)).status).toBe(404);
  });

  it("refuses a name no Group can have", async () => {
    const { h } = await seed();
    const ana = await admin(h, "ana");
    for (const name of [
      "",
      "   ",
      "x".repeat(81),
      "line\nbreak",
      "My agent",
      "my-agent-helper",
      "!!!",
      7,
    ]) {
      expect(
        (await createGroup(h, "ana", ana.shareId, { name })).status,
        JSON.stringify(name),
      ).toBe(400);
    }
    expect(
      (await createGroup(h, "ana", ana.shareId, { name: "Events", type: "files" })).status,
    ).toBe(400);
    expect(
      (await createGroup(h, "ana", ana.shareId, { name: "Events", purpose: "a\nb" })).status,
    ).toBe(400);
  });
});

describe("the invite link", () => {
  it("lets people join, and resetting or turning it off keeps everyone who joined", async () => {
    const { h } = await seed();
    const first = await inviteLink(h, OWNER, "turn-on");
    expect(first).not.toBeNull();

    const preview = await post(h, "cara", "/sync/members/join-preview", { token: first });
    expect(await json(preview)).toEqual({
      workspaceName: "Community",
      ownerName: "Name owner",
      alreadyMember: false,
    });
    const joined = await join(h, "cara", first!);
    expect(joined.status).toBe(200);
    expect(await json(joined)).toMatchObject({
      workspaceId: WORKSPACE,
      workspaceName: "Community",
    });
    expect((await join(h, "cara", first!)).status).toBe(200);
    const caraShare = await shareIdOf(h, "cara");

    const second = await inviteLink(h, OWNER, "reset");
    expect(second).not.toBe(first);
    expect((await join(h, "dan", first!)).status).toBe(404);
    expect(await pulledText(h, "cara", caraShare)).toContain("docs/plan.md");

    expect(await inviteLink(h, OWNER, "turn-off")).toBeNull();
    expect((await join(h, "dan", second!)).status).toBe(404);
    expect(await pulledText(h, "cara", caraShare)).toContain("docs/plan.md");

    // Turning it back on brings back the same link.
    expect(await inviteLink(h, OWNER, "turn-on")).toBe(second);
    expect((await join(h, "dan", second!)).status).toBe(200);
    const owns = await join(h, OWNER, second!);
    expect(await code(owns)).toBe("member_exists");
    expect((await join(h, "erin", "not-a-real-token-at-all")).status).toBe(404);
  });

  it("keeps a removed account out until someone lets it back in; another account still joins", async () => {
    const { h } = await seed();
    const token = await inviteLink(h, OWNER, "turn-on");
    expect((await join(h, "cara", token!)).status).toBe(200);
    const cara = (await membersView(h, OWNER)).people.find(
      (person) => person.name === "Name cara",
    )!.memberId;
    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/${cara}/remove`)).status).toBe(200);

    const again = await join(h, "cara", token!);
    expect(again.status).toBe(409);
    expect(await code(again)).toBe("member_removed");
    expect(await workspaceShare(h, "cara")).toBeUndefined();
    expect((await join(h, "dan", token!)).status).toBe(200);

    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/${cara}/let-back-in`)).status).toBe(
      200,
    );
    expect(await workspaceShare(h, "cara")).toMatchObject({ access: "comment" });
  });

  it("forgets a person who leaves, and lets them back as a new member through the link or an invite", async () => {
    const { h } = await seed();
    const token = await inviteLink(h, OWNER, "turn-on");
    expect((await join(h, "cara", token!)).status).toBe(200);
    const first = memberIdOf(await membersView(h, OWNER), "cara")!;
    expect((await post(h, "cara", `/sync/${WORKSPACE}/members/leave`)).status).toBe(200);
    expect(await workspaceShare(h, "cara")).toBeUndefined();
    expect((await membersView(h, OWNER)).people.map((person) => person.memberId)).toEqual([
      "owner",
    ]);
    expect((await h(request("cara", `/sync/${WORKSPACE}/members`))).status).toBe(404);
    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/leave`)).status).toBe(403);

    expect((await join(h, "cara", token!)).status).toBe(200);
    expect(await workspaceShare(h, "cara")).toMatchObject({ access: "comment" });
    const second = memberIdOf(await membersView(h, OWNER), "cara")!;
    expect(second).not.toBe(first);

    expect((await post(h, "cara", `/sync/${WORKSPACE}/members/leave`)).status).toBe(200);
    const third = await invited(h, "cara");
    expect([first, second]).not.toContain(third);
    expect(await workspaceShare(h, "cara")).toMatchObject({ access: "comment" });
  });
});

describe("ending access", () => {
  async function heldRead(
    end: (h: SyncRelayHandler, memberId: string) => Promise<Response>,
    afterwards = 404,
  ) {
    const activity = new DiscussionActivityHub();
    const { h } = await seed({ activity });
    const ana = await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    const first = await json(await pull(h, "ana", shareId));
    const controller = new AbortController();
    const held = h(
      request("ana", `/sync/shares/${shareId}/log?limit=500&since=${first.nextCursor}&hold=30000`, {
        signal: controller.signal,
      }),
    );
    try {
      await expect.poll(() => activity.stats().waiters).toBe(1);
      expect((await end(h, ana)).status).toBe(200);
      expect((await held).status).toBe(404);
      expect((await pull(h, "ana", shareId)).status).toBe(afterwards);
    } finally {
      controller.abort();
      await held.catch(() => undefined);
    }
  }

  it("ends a held read when the member is removed", async () => {
    await heldRead((h, memberId) =>
      post(h, OWNER, `/sync/${WORKSPACE}/members/${memberId}/remove`),
    );
  });

  it("ends a held read when the member leaves", async () => {
    await heldRead((h) => post(h, "ana", `/sync/${WORKSPACE}/members/leave`));
  });

  it("answers a held read with one empty page marked levelChanged when the level changes", async () => {
    const activity = new DiscussionActivityHub();
    const { h } = await seed({ activity });
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    const first = await json(await pull(h, "ana", shareId));
    const controller = new AbortController();
    const held = h(
      request("ana", `/sync/shares/${shareId}/log?limit=500&since=${first.nextCursor}&hold=30000`, {
        signal: controller.signal,
      }),
    );
    try {
      await expect.poll(() => activity.stats().waiters).toBe(1);
      expect(
        (await post(h, OWNER, `/sync/${WORKSPACE}/members/level`, { level: "view" })).status,
      ).toBe(200);
      const response = await held;
      expect(response.status).toBe(200);
      expect(await json(response)).toMatchObject({
        ops: [],
        hasMore: false,
        nextCursor: first.nextCursor,
        levelChanged: true,
      });
      expect(await json(await h(request("ana", `/sync/shares/${shareId}/access`)))).toEqual({
        status: "current",
        access: "view",
        role: "member",
      });
      const after = await pull(h, "ana", shareId);
      expect(after.status).toBe(200);
      expect(await json(after)).not.toHaveProperty("levelChanged");
    } finally {
      controller.abort();
      await held.catch(() => undefined);
    }
  });

  it("ends everyone's access when the owner ends the membership", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    const token = await inviteLink(h, OWNER, "turn-on");
    const ended = await post(h, OWNER, `/sync/${WORKSPACE}/members/end`);
    expect(ended.status).toBe(200);
    expect(
      ((await ended.json()) as WorkspaceMembersView).people.map((person) => person.memberId),
    ).toEqual(["owner"]);
    expect((await pull(h, "ana", shareId)).status).toBe(404);
    expect(await workspaceShare(h, "ana")).toBeUndefined();
    expect((await h(request("ana", `/sync/${WORKSPACE}/members`))).status).toBe(404);
    expect((await join(h, "cara", token!)).status).toBe(404);
    expect((await membersView(h, OWNER)).people).toHaveLength(1);
  });

  it("shows the owner alone after ending membership, and sets the level again from there", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/end`)).status).toBe(200);
    const after = await membersView(h, OWNER);
    expect(after).toMatchObject({
      workspaceName: "",
      memberLevel: "comment",
      inviteLink: { enabled: false, url: null },
    });
    expect(after.people.map((person) => person.memberId)).toEqual(["owner"]);
    const level = await post(h, OWNER, `/sync/${WORKSPACE}/members/level`, {
      level: "edit",
      workspaceName: "Community",
    });
    expect(level.status).toBe(200);
    expect(await json(level)).toMatchObject({ workspaceName: "Community", memberLevel: "edit" });
  });
});

describe("account deletion", () => {
  const KEY = "account-deletion-key-at-least-32-bytes";
  function deleteAccount(storage: unknown, userId: string): void {
    const context = storage as StorageContext;
    initializeAccountDeletion(context, KEY);
    const { manifest } = fenceAccount(context, KEY, userId, `${userId}@dohc.test`);
    purgeAccountRows(
      context,
      userId,
      `${userId}@dohc.test`,
      manifest ?? { workspaces: [], shareIds: [], datasets: [], grantIds: [], publicationIds: [] },
    );
  }

  it("removes a deleted admin's entry and keeps everyone they invited", async () => {
    const { h, storage } = await seed();
    const ana = await invited(h, "ana");
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "admin" })).status,
    ).toBe(200);
    await invited(h, "ben", "ana");
    expect((await invite(h, "ana", "carl@elsewhere.example")).status).toBe(200);

    deleteAccount(storage, "ana");
    const people = (await membersView(h, OWNER)).people;
    expect(people.map((person) => person.name)).toEqual(["Name owner", "Name ben", null]);
    expect(people[2]).toMatchObject({ state: "invited", email: "carl@elsewhere.example" });
    expect(await workspaceShare(h, "ben")).toMatchObject({ access: "comment" });
  });

  it("ends a member's access as soon as their account is fenced, through the check on their entry", async () => {
    const { h, storage } = await seed();
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    const context = storage as unknown as StorageContext;
    initializeAccountDeletion(context, KEY);
    fenceAccount(context, KEY, "ana", "ana@dohc.test");
    // Her entry still reads active until the purge; her grant authorizes nothing.
    expect(
      context.db
        .prepare("SELECT state FROM sync_relay_workspace_members WHERE user_id = 'ana'")
        .get(),
    ).toEqual({ state: "active" });
    expect((await pull(h, "ana", shareId)).status).toBe(404);
    expect((await h(request("ana", `/sync/${WORKSPACE}/members`))).status).toBe(404);
    expect(
      storage.workspaceMemberGrantIsCurrent(
        shareId,
        String(
          context.db
            .prepare("SELECT grant_id FROM sync_relay_workspace_members WHERE user_id = 'ana'")
            .get()!.grant_id,
        ),
      ),
    ).toBe(false);
  });

  it("ends every member's access when the owner's account is deleted", async () => {
    const { h, storage } = await seed();
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    deleteAccount(storage, OWNER);
    expect((await pull(h, "ana", shareId)).status).toBe(404);
    expect(await workspaceShare(h, "ana")).toBeUndefined();
  });

  it("ends admin and member authority as soon as the owner's account is fenced, before any purge", async () => {
    const { h, storage } = await seed();
    const ana = await invited(h, "ana");
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "admin" })).status,
    ).toBe(200);
    const ben = await invited(h, "ben");
    expect(await inviteLink(h, "ana", "turn-on")).not.toBeNull();

    const context = storage as unknown as StorageContext;
    initializeAccountDeletion(context, KEY);
    fenceAccount(context, KEY, OWNER, `${OWNER}@dohc.test`);

    for (const as of ["ana", "ben"]) {
      expect((await h(request(as, `/sync/${WORKSPACE}/members`))).status, as).toBe(404);
      for (const [path, body] of [
        [`/sync/${WORKSPACE}/members/invites`, { email: "carl@dohc.test" }],
        [`/sync/${WORKSPACE}/members/level`, { level: "edit" }],
        [`/sync/${WORKSPACE}/members/invite-link`, { action: "reset" }],
        [`/sync/${WORKSPACE}/members/${ben}/remove`, {}],
        [`/sync/${WORKSPACE}/members/${ana}/let-back-in`, {}],
      ] as const) {
        expect((await post(h, as, path, body)).status, `${as} ${path}`).toBe(404);
      }
    }
  });

  it("drops an email invite when the account at that address is deleted, freeing its seat for a new invite", async () => {
    const { h, storage } = await seed();
    expect((await invite(h, OWNER, "dee@elsewhere.example")).status).toBe(200);
    const context = storage as unknown as StorageContext;
    initializeAccountDeletion(context, KEY);
    fenceAccount(context, KEY, "dee-old", "dee@elsewhere.example");
    expect((await membersView(h, OWNER)).people).toHaveLength(1);
    expect((await invite(h, OWNER, "dee@elsewhere.example")).status).toBe(200);
  });

  it("does not let a new account at a deleted account's address take over its ended invite", async () => {
    const { h, storage } = await seed();
    expect((await invite(h, OWNER, "dee@elsewhere.example")).status).toBe(200);
    const context = storage as unknown as StorageContext;
    initializeAccountDeletion(context, KEY);
    const { manifest } = fenceAccount(context, KEY, "dee-old", "dee@elsewhere.example");
    purgeAccountRows(
      context,
      "dee-old",
      "dee@elsewhere.example",
      manifest ?? { workspaces: [], shareIds: [], datasets: [], grantIds: [], publicationIds: [] },
    );
    storage.claimPendingSharesForEmail("dee@elsewhere.example", "dee-new");
    expect(await workspaceShare(h, "dee-new")).toBeUndefined();
    expect((await membersView(h, OWNER)).people).toHaveLength(1);
  });
});
