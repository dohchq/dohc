import { getCookies } from "better-auth/cookies";
import { afterEach, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import type { SyncRelayHandler } from "../../sync-relay/src/server";
import type { SyncRelayStorage } from "../../sync-relay/src/storage";
import { DiscussionActivityHub } from "../../sync-relay/src/discussionActivity";
import {
  RELAY_EXCHANGE_KEY,
  SHARE_WEB_ORIGIN,
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
  resolveTestActor,
  testHandler,
  testStorage,
} from "../../sync-relay/src/testing";
import { createShareWebApplication } from "./server";

// A workspace member reads the workspace in a browser through share-web's
// view routes and follows every Group it reaches in one request. The account
// cookie names the person; the page names only the grant.

const HOST = new URL(SHARE_WEB_ORIGIN).host;
const cookieName = getCookies({ baseURL: SHARE_WEB_ORIGIN }).sessionToken.name;
const WORKSPACE = "workspace-members-web";
const OWNER = "owner";
const limits = {
  maxPendingRequests: 4,
  maxRequestBytes: 8192,
  maxResponseBytes: 65536,
  timeoutMs: 1000,
};
afterEach(async () => {
  vi.useRealTimers();
  await closeTestStorages();
});

function resolveActor(incoming: Request, workspaceId: string) {
  const cookie = incoming.headers.get("cookie");
  if (cookie !== null) {
    const userId = cookie.startsWith(`${cookieName}=`) ? cookie.slice(cookieName.length + 1) : "";
    if (!/^\w+$/u.test(userId)) throw new UnauthorizedError();
    return { userId, workspaceId };
  }
  return resolveTestActor(incoming, workspaceId);
}

async function ownerAppend(h: SyncRelayHandler, ops: unknown[]) {
  const response = await h(
    request(OWNER, `/sync/${WORKSPACE}/log`, jsonBody({ originId: "origin-owner", ops })),
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

let fileSeq = 0;
async function ownerWrite(h: SyncRelayHandler, path: string, text: string) {
  const sha = await putBlob(h, OWNER, WORKSPACE, text);
  const seq = fileSeq++;
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
  return sha;
}

const group = (wireId: string, name: string) =>
  logOp(
    "chat.channel.create",
    chatChannelCreate(wireId, {
      channelId: `chan-${wireId}`,
      name,
      slug: name,
      kind: "channel",
      type: "both",
      purpose: "",
      folderPath: name,
    }).payload,
  );

async function fixture(level: "view" | "comment" | "edit" = "comment") {
  resetOpSeq();
  fileSeq = 0;
  const storage: SyncRelayStorage = await testStorage();
  const relay = testHandler(storage, {
    resolveActor,
    lookupUserDisplayName: (userId: string) => `Name ${userId}`,
    discussionActivity: new DiscussionActivityHub(),
    namedBrowserSessionLimits: { ...limits, maxSessions: 8, retentionMs: 60_000 },
    relayExchangeKey: RELAY_EXCHANGE_KEY,
  });
  expect(
    (await relay(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
  ).toBe(200);
  await ownerAppend(relay, [
    group("wire-plans", "plans"),
    logOp(
      "chat.thread.create",
      chatThreadCreate("t-plans", "wire-plans", { slug: "t-plans" }).payload,
    ),
    logOp(
      "chat.message.append",
      chatMessageAppend("m-plans", "t-plans", "Plans start here", { authorUserId: OWNER }).payload,
    ),
    group("wire-food", "food"),
    logOp(
      "chat.thread.create",
      chatThreadCreate("t-food", "wire-food", { slug: "t-food" }).payload,
    ),
    logOp(
      "chat.message.append",
      chatMessageAppend("m-food", "t-food", "Bring snacks", { authorUserId: OWNER }).payload,
    ),
  ]);
  const planSha = await ownerWrite(relay, "trip/plan.md", "# Plan\n\nLeave at nine.");
  const invite = await relay(
    request(
      OWNER,
      `/sync/${WORKSPACE}/members/invites`,
      jsonBody({ email: "sam@dohc.test", workspaceName: "Trip" }),
    ),
  );
  expect(invite.status, await invite.clone().text()).toBe(200);
  const memberId = (
    (await json(invite)).people as Array<{ memberId: string; email: string | null }>
  ).find((person) => person.email === "sam@dohc.test")!.memberId;
  if (level !== "comment") {
    const changed = await relay(
      request(OWNER, `/sync/${WORKSPACE}/members/level`, jsonBody({ level })),
    );
    expect(changed.status, await changed.clone().text()).toBe(200);
  }
  const received = await json(await relay(request("sam", "/sync/shares")));
  const shareId = (received.received as Array<Record<string, unknown>>).find(
    (row) => (row.selector as { kind?: string }).kind === "workspace",
  )!.shareId as string;
  const grantId = storage.listActiveShareGrantsForRecipient(shareId, "sam")[0]!.grantId;
  const forwarded: Request[] = [];
  const web = createShareWebApplication({
    relayUrl: "http://relay.invalid",
    publicRelayUrl: "https://relay.test",
    publicHosts: new Set([HOST]),
    accountAuth: { upstreamUrl: "http://auth.invalid", publicOrigin: SHARE_WEB_ORIGIN },
    relayExchangeKey: RELAY_EXCHANGE_KEY,
    namedBrowserSessionLimits: limits,
    fetchRelay: (incoming) => {
      forwarded.push(incoming.clone());
      return relay(incoming);
    },
  });
  const view = (
    path: string,
    user = "sam",
    token = `member.${grantId}`,
    headers: Record<string, string> = {},
  ) =>
    web.handle(
      new Request(`${SHARE_WEB_ORIGIN}${path}`, {
        headers: {
          host: HOST,
          cookie: `${cookieName}=${user}`,
          "x-dohc-link-session": token,
          ...headers,
        },
      }),
    );
  const chat = (path: string, user = "sam", init: RequestInit = {}) =>
    web.handle(
      new Request(`${SHARE_WEB_ORIGIN}/api/named-chat/${path}`, {
        ...init,
        headers: {
          host: HOST,
          origin: SHARE_WEB_ORIGIN,
          cookie: `${cookieName}=${user}`,
          "content-type": "application/json",
          ...init.headers,
        },
      }),
    );
  return { storage, relay, web, view, chat, grantId, shareId, memberId, planSha, forwarded };
}

it("reads the workspace's files for a member, sending the grant, the account cookie and nothing the page could forge", async () => {
  const f = await fixture();
  const meta = await f.view("/api/view/meta");
  expect(meta.status, await meta.clone().text()).toBe(200);
  expect(await meta.json()).toMatchObject({ access: "comment" });
  const current = (await (await f.view("/api/view/current")).json()) as {
    files: Array<{ path: string; blobSha256: string }>;
  };
  expect(current.files).toEqual([
    expect.objectContaining({ path: "trip/plan.md", blobSha256: f.planSha }),
  ]);
  expect((await f.view("/api/view/log?since=0&limit=500&current=true")).status).toBe(200);
  const blob = await f.web.handle(
    new Request(`${SHARE_WEB_ORIGIN}/api/view/blob/${f.planSha}?session=member.${f.grantId}`, {
      headers: { host: HOST, cookie: `${cookieName}=sam` },
    }),
  );
  expect(await blob.text()).toBe("# Plan\n\nLeave at nine.");
  for (const sent of f.forwarded) {
    expect(sent.headers.get("authorization")).toBe(`DohcMember ${f.grantId}`);
    expect(sent.headers.get("cookie")).toBe(`${cookieName}=sam`);
    expect(sent.headers.get("origin")).toBe(SHARE_WEB_ORIGIN);
    expect(sent.headers.get("x-dohc-relay-exchange-key")).toBe(RELAY_EXCHANGE_KEY);
  }
});

it("refuses another account, a signed-out browser, another site, and a removed member, as it refuses an unknown grant", async () => {
  const f = await fixture();
  const unknown = await f.view("/api/view/meta", "sam", "member.no-such-grant");
  expect(unknown.status).toBe(404);
  const refusal = await unknown.text();
  for (const response of [
    await f.view("/api/view/meta", "someone"),
    await f.web.handle(
      new Request(`${SHARE_WEB_ORIGIN}/api/view/meta`, {
        headers: { host: HOST, "x-dohc-link-session": `member.${f.grantId}` },
      }),
    ),
    await f.view("/api/view/meta", "sam", `member.${f.grantId}`, {
      "sec-fetch-site": "cross-site",
    }),
  ]) {
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(refusal);
  }
  expect(
    (await f.relay(request(OWNER, `/sync/${WORKSPACE}/members/${f.memberId}/remove`, jsonBody({}))))
      .status,
  ).toBe(200);
  const removed = await f.view("/api/view/current");
  expect(removed.status).toBe(404);
  expect(await removed.text()).toBe(refusal);
});

it("reads the owner's own workspace with the owner's session, sending the workspace and the account cookie", async () => {
  const f = await fixture();
  const before = f.forwarded.length;
  const token = `owner.${WORKSPACE}`;
  const meta = await f.view("/api/view/meta", OWNER, token);
  expect(meta.status, await meta.clone().text()).toBe(200);
  expect(await meta.json()).toMatchObject({ access: "edit" });
  const current = (await (await f.view("/api/view/current", OWNER, token)).json()) as {
    files: Array<{ path: string; blobSha256: string }>;
  };
  expect(current.files).toEqual([
    expect.objectContaining({ path: "trip/plan.md", blobSha256: f.planSha }),
  ]);
  const blob = await f.web.handle(
    new Request(`${SHARE_WEB_ORIGIN}/api/view/blob/${f.planSha}?session=${token}`, {
      headers: { host: HOST, cookie: `${cookieName}=${OWNER}` },
    }),
  );
  expect(await blob.text()).toBe("# Plan\n\nLeave at nine.");
  for (const sent of f.forwarded.slice(before)) {
    expect(sent.headers.get("authorization")).toBe(`DohcOwner ${WORKSPACE}`);
    expect(sent.headers.get("cookie")).toBe(`${cookieName}=${OWNER}`);
    expect(sent.headers.get("origin")).toBe(SHARE_WEB_ORIGIN);
    expect(sent.headers.get("x-dohc-relay-exchange-key")).toBe(RELAY_EXCHANGE_KEY);
  }
  // A member, another site, or a malformed workspace reads as an unknown grant.
  const refusal = await (await f.view("/api/view/meta", "sam", "member.no-such-grant")).text();
  for (const response of [
    await f.view("/api/view/meta", "sam", token),
    await f.view("/api/view/meta", OWNER, token, { "sec-fetch-site": "cross-site" }),
    await f.view("/api/view/meta", OWNER, "owner./"),
    await f.view("/api/view/meta", OWNER, `admin.${WORKSPACE}`),
  ]) {
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(refusal);
  }
  // Only a dot ends the account's prefix; a link's session never reads as an account's.
  for (const session of [`owner/${WORKSPACE}`, `ownerA${WORKSPACE}`]) {
    const before = f.forwarded.length;
    expect((await f.view("/api/view/meta", OWNER, session)).status, session).not.toBe(200);
    expect(
      f.forwarded
        .slice(before)
        .some((sent) => sent.headers.get("authorization")?.startsWith("DohcOwner")),
      session,
    ).toBe(false);
  }
});

it("lists the workspaces an account owns and joined, only for its own cookie on this site", async () => {
  const f = await fixture();
  const list = (user: string | null, headers: Record<string, string> = {}) =>
    f.web.handle(
      new Request(`${SHARE_WEB_ORIGIN}/api/workspaces`, {
        headers: {
          host: HOST,
          ...(user === null ? {} : { cookie: `${cookieName}=${user}` }),
          ...headers,
        },
      }),
    );
  const owner = await list(OWNER);
  expect(owner.status, await owner.clone().text()).toBe(200);
  expect(owner.headers.get("cache-control")).toBe("private, no-store");
  expect(await owner.json()).toEqual({
    ok: true,
    owned: [{ workspaceId: WORKSPACE, name: null }],
    joined: [],
  });
  expect(await (await list("sam")).json()).toEqual({
    ok: true,
    owned: [],
    joined: [{ workspaceId: WORKSPACE, name: "Trip", grantId: f.grantId }],
  });
  expect((await list(null)).status).toBe(401);
  expect((await list(OWNER, { "sec-fetch-site": "cross-site" })).status).toBe(404);
  expect((await list(OWNER, { host: "elsewhere.test" })).status).toBe(404);
  expect(
    (
      await f.web.handle(
        new Request(`${SHARE_WEB_ORIGIN}/api/workspaces?user=sam`, {
          headers: { host: HOST, cookie: `${cookieName}=${OWNER}` },
        }),
      )
    ).status,
  ).toBe(404);
});

it("lists every Group and follows them all in one request, each message naming its Group", async () => {
  const f = await fixture();
  const channels = await f.chat(`channels?grantId=${f.grantId}`);
  expect(channels.status, await channels.clone().text()).toBe(200);
  expect(((await channels.json()) as { channels: unknown[] }).channels).toEqual([
    {
      channelWireId: "wire-plans",
      name: "plans",
      kind: "channel",
      type: "both",
      access: "read-write",
    },
    {
      channelWireId: "wire-food",
      name: "food",
      kind: "channel",
      type: "both",
      access: "read-write",
    },
  ]);
  const follow = await f.chat(`messages?shareId=${f.shareId}&since=0`);
  expect(follow.status, await follow.clone().text()).toBe(200);
  const page = (await follow.json()) as {
    messages: Array<{
      body: string;
      channelWireId: string;
      threadId: string;
      lane: string;
      parentMessageId: string | null;
      startsPost: boolean;
    }>;
    channelWireId?: string;
  };
  expect(page.channelWireId).toBeUndefined();
  expect(
    page.messages.map(({ body, channelWireId, lane, parentMessageId, startsPost }) => ({
      body,
      channelWireId,
      lane,
      parentMessageId,
      startsPost,
    })),
  ).toEqual([
    {
      body: "Plans start here",
      channelWireId: "wire-plans",
      lane: "posts",
      parentMessageId: null,
      startsPost: true,
    },
    {
      body: "Bring snacks",
      channelWireId: "wire-food",
      lane: "posts",
      parentMessageId: null,
      startsPost: true,
    },
  ]);
  const posted = await f.chat("messages", "sam", {
    method: "POST",
    body: JSON.stringify({
      shareId: f.shareId,
      channelWireId: "wire-food",
      id: "post-1",
      lane: "posts",
      body: "Count me in",
      authorKind: "human",
    }),
  });
  expect(posted.status, await posted.clone().text()).toBe(200);
  // A reply joins the post it answers.
  const replied = await f.chat("messages", "sam", {
    method: "POST",
    body: JSON.stringify({
      shareId: f.shareId,
      channelWireId: "wire-food",
      id: "post-2",
      threadId: page.messages[1]!.threadId,
      body: "Crisps",
      authorKind: "human",
    }),
  });
  expect(replied.status, await replied.clone().text()).toBe(200);
  expect(((await replied.json()) as { message: unknown }).message).toMatchObject({
    threadId: page.messages[1]!.threadId,
    lane: "posts",
    parentMessageId: null,
    startsPost: false,
  });
});

it("reads one Group's history for a member, newest first, with the cursor that follows every Group", async () => {
  const f = await fixture();
  const history = await f.chat(`messages?shareId=${f.shareId}&channelWireId=wire-food&limit=50`);
  expect(history.status, await history.clone().text()).toBe(200);
  const page = (await history.json()) as {
    channelWireId: string;
    messages: Array<{ body: string }>;
    nextCursor: number;
    olderCursor: number | null;
  };
  expect(page.channelWireId).toBe("wire-food");
  expect(page.messages.map((message) => message.body)).toEqual(["Bring snacks"]);
  const follow = (await (
    await f.chat(`messages?shareId=${f.shareId}&since=${page.nextCursor}`)
  ).json()) as { messages: unknown[] };
  expect(follow.messages).toEqual([]);
});

it("shows a View member every Group read-only and refuses a post", async () => {
  const f = await fixture("view");
  const channels = (await (await f.chat(`channels?grantId=${f.grantId}`)).json()) as {
    channels: Array<{ access: string }>;
  };
  expect(channels.channels.map((channel) => channel.access)).toEqual(["read-only", "read-only"]);
  const posted = await f.chat("messages", "sam", {
    method: "POST",
    body: JSON.stringify({
      shareId: f.shareId,
      channelWireId: "wire-food",
      id: "post-1",
      body: "Count me in",
      authorKind: "human",
    }),
  });
  expect(posted.status).toBe(403);
});

it("reads, follows and posts on a file's Comments for a member, and keeps them read-only at View", async () => {
  const f = await fixture();
  await ownerAppend(f.relay, [
    logOp("chat.thread.create", {
      threadId: "c-plan",
      title: "",
      createdAtMs: 2,
      linkedObjectId: "object-trip/plan.md",
      linkedAtMs: 2,
      linkedPathHint: "trip/plan.md",
    }),
    logOp(
      "chat.message.append",
      chatMessageAppend("m-comment", "c-plan", "Nine is early", { authorUserId: OWNER }).payload,
    ),
  ]);
  const query = (extra: Record<string, string> = {}) =>
    `messages?${new URLSearchParams({ shareId: f.shareId, path: "trip/plan.md", limit: "50", ...extra })}`;
  const history = await f.chat(query());
  expect(history.status, await history.clone().text()).toBe(200);
  const page = (await history.json()) as {
    path: string;
    messages: Array<{ body: string }>;
    nextCursor: number;
  };
  expect(page.path).toBe("trip/plan.md");
  expect(page.messages.map((message) => message.body)).toEqual(["Nine is early"]);
  const posted = await f.chat("messages", "sam", {
    method: "POST",
    body: JSON.stringify({
      shareId: f.shareId,
      path: "trip/plan.md",
      id: "comment-1",
      body: "Ten, then",
      authorKind: "human",
    }),
  });
  expect(posted.status, await posted.clone().text()).toBe(200);
  expect(await posted.json()).toMatchObject({
    shareId: f.shareId,
    path: "trip/plan.md",
    message: { body: "Ten, then", authorUserId: "sam" },
  });
  const follow = await f.chat(query({ since: String(page.nextCursor) }));
  expect(follow.status, await follow.clone().text()).toBe(200);
  expect(await follow.json()).toMatchObject({
    path: "trip/plan.md",
    hasMore: false,
    messages: [expect.objectContaining({ body: "Ten, then" })],
  });
  // An answer for another file, or a Group, is not this file's.
  const unknown = await f.chat(query({ path: "trip/missing.md" }));
  expect(unknown.status).toBe(404);

  const view = await fixture("view");
  const read = await view.chat(
    `messages?${new URLSearchParams({ shareId: view.shareId, path: "trip/plan.md", limit: "50" })}`,
  );
  expect(read.status, await read.clone().text()).toBe(200);
  const refused = await view.chat("messages", "sam", {
    method: "POST",
    body: JSON.stringify({
      shareId: view.shareId,
      path: "trip/plan.md",
      id: "comment-1",
      body: "Ten, then",
      authorKind: "human",
    }),
  });
  expect(refused.status).toBe(403);
});

it("wakes the owner's remembering computer when the owner names an agent from the browser, and never for a member", async () => {
  const f = await fixture();
  for (const [installId, memory] of [
    ["laptop", true],
    ["mac", false],
  ] as const)
    f.storage.replaceChatRunners({
      accountId: OWNER,
      workspaceId: WORKSPACE,
      installId,
      computerLabel: installId,
      runners: [
        { agentId: "claude", handle: "claude", displayName: "Claude", enabled: true, memory },
      ],
      nowMs: 2_000,
    });
  const waiting = (installId: string) =>
    f.storage.listWaitingChatWakes({ accountId: OWNER, installId, since: 0, nowMs: 2_000 }).wakes;
  const post = (user: string, shareId: string, id: string) =>
    f.chat("messages", user, {
      method: "POST",
      body: JSON.stringify({
        shareId,
        channelWireId: "wire-plans",
        id,
        lane: "posts",
        body: "@claude plan the route",
        authorKind: "human",
      }),
    });
  const member = await post("sam", f.shareId, "member-1");
  expect(member.status, await member.clone().text()).toBe(200);
  expect(JSON.stringify(await member.json())).not.toContain("wake");
  expect(waiting("laptop")).toEqual([]);

  const owner = await post(OWNER, `owner:${WORKSPACE}`, "owner-1");
  expect(owner.status, await owner.clone().text()).toBe(200);
  expect(waiting("laptop")).toHaveLength(1);
  expect(waiting("mac")).toEqual([]);
});
