import { parseAccessRule } from "@dohc/security-contract/access-rules";
import { GENERAL_CHANNEL_WIRE_ID } from "@dohc/security-contract/chat-wire-ids";
import type { WorkspaceMembersView } from "@dohc/security-contract/workspace-members";
import { linkRefusalBody } from "@dohc/security-contract/link-refusal";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pushMessageAccess, readPushMessage } from "./chatMessageInterest";
import { DiscussionActivityHub } from "./discussionActivity";
import { MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE } from "./namedRecipientChat";
import type { SyncRelayHandler } from "./server";
import { fenceAccount, initializeAccountDeletion } from "./storage/accountDeletion";
import { recordAccountName } from "./storage/accountNames";
import type { StorageContext } from "./storage/context";
import type { SyncRelayStorage } from "./storage";
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
  sha256,
  testHandler,
  testStorage,
} from "./testing";

// A member's workspace in a browser: share-web sends the account's cookie
// with its exchange key, and names the grant. The relay finds the person.

afterEach(() => {
  vi.useRealTimers();
  closeTestStorages();
});

const OWNER = "owner";
const WORKSPACE = "workspace-browser";
const GROUP = "wire-team";
const LATER_GROUP = "wire-later";
const DM = "wire-dm";
const AGENT = "wire-agent";
const limits = {
  maxSessions: 8,
  retentionMs: 60_000,
  maxPendingRequests: 8,
  maxRequestBytes: 100_000,
  maxResponseBytes: 200_000,
  timeoutMs: 1000,
};

let ownerSeq = 0;
const channel = (
  wireId: string,
  name: string,
  kind: "channel" | "dm" | "agent" = "channel",
  type: "posts" | "chat" | "both" = "both",
) =>
  logOp(
    "chat.channel.create",
    chatChannelCreate(wireId, {
      channelId: `chan-${wireId}`,
      name,
      slug: name,
      kind,
      ...(kind === "channel" ? { type, purpose: "", folderPath: name } : {}),
    }).payload,
  );
const thread = (threadId: string, wireId: string) =>
  logOp("chat.thread.create", chatThreadCreate(threadId, wireId, { slug: threadId }).payload);
// A Group's chat: the oldest chat-lane thread is its one conversation.
const laneThread = (threadId: string, wireId: string) =>
  logOp(
    "chat.thread.create",
    chatThreadCreate(threadId, wireId, { slug: threadId, lane: "chat" }).payload,
  );
const message = (messageId: string, threadId: string, body: string) =>
  logOp(
    "chat.message.append",
    chatMessageAppend(messageId, threadId, body, { authorUserId: OWNER }).payload,
  );
const reply = (messageId: string, threadId: string, parentMessageId: string, body: string) =>
  logOp(
    "chat.message.append",
    chatMessageAppend(messageId, threadId, body, { authorUserId: OWNER, parentMessageId }).payload,
  );

async function ownerAppend(h: SyncRelayHandler, ops: unknown[]) {
  const response = await h(
    request(OWNER, `/sync/${WORKSPACE}/log`, jsonBody({ originId: "origin-owner", ops })),
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

// `before` is the content a write replaces.
async function ownerWrite(h: SyncRelayHandler, path: string, text: string, before?: string) {
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
      payloadBeforeBlobSha256: before === undefined ? null : sha256(before),
      payloadBeforePath: before === undefined ? null : path,
      payloadAfterBlobSha256: sha,
      payloadAfterPath: path,
      metadata: { origin: "user" },
      beforePresent: before === undefined ? "null" : "present",
    }),
  ]);
  return sha;
}

// The owner sets, changes or clears a folder's rule as Members settings does.
async function ownerRule(
  h: SyncRelayHandler,
  folder: string,
  text: string | null,
): Promise<string> {
  const covers = (rule: { folders: Array<{ path: string }> }) =>
    rule.folders.some((entry) => entry.path === folder);
  const view = (await json(
    await h(request(OWNER, `/sync/${WORKSPACE}/members`)),
  )) as unknown as WorkspaceMembersView;
  const held = view.folderRules!.find(covers);
  const rule = text === null ? null : parseAccessRule(text)!;
  const response = await post(h, OWNER, `/sync/${WORKSPACE}/members/folder-rules`, {
    ...(held ? { ruleId: held.ruleId, revision: held.revision } : { folder }),
    ...(rule === null
      ? { clear: true }
      : {
          members: rule.members,
          people: [...rule.people].map(([email, level]) => ({ email, level })),
        }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (
    held?.ruleId ??
    ((await response.json()) as WorkspaceMembersView).folderRules!.find(covers)!.ruleId
  );
}

// The cookie names the person, as the account service would. Nothing else does.
function resolveActor(incoming: Request, workspaceId: string) {
  if (incoming.headers.has("cookie")) {
    const match = /^session=(\w+)$/u.exec(incoming.headers.get("cookie") ?? "");
    if (!match) throw new UnauthorizedError();
    return { userId: match[1]!, workspaceId };
  }
  return resolveTestActor(incoming, workspaceId);
}

async function seed(
  activity = new DiscussionActivityHub(),
  overrides: Partial<Parameters<typeof testHandler>[1]> = {},
) {
  resetOpSeq();
  ownerSeq = 0;
  const storage = await testStorage();
  const h = testHandler(storage, {
    lookupUserDisplayName: (userId: string) => `Name ${userId}`,
    discussionActivity: activity,
    namedBrowserSessionLimits: limits,
    relayExchangeKey: RELAY_EXCHANGE_KEY,
    resolveActor,
    ...overrides,
  });
  expect(
    (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
  ).toBe(200);
  await ownerAppend(h, [
    channel(GROUP, "team"),
    thread("t-team", GROUP),
    message("msg-team", "t-team", "welcome to the team"),
    channel(GENERAL_CHANNEL_WIRE_ID, "general"),
    thread("t-general", GENERAL_CHANNEL_WIRE_ID),
    message("msg-general", "t-general", "SENTINEL general"),
    channel(DM, "someone", "dm"),
    thread("t-dm", DM),
    message("msg-dm", "t-dm", "SENTINEL direct message"),
    channel(AGENT, "bot", "agent"),
    thread("t-agent", AGENT),
    message("msg-agent", "t-agent", "SENTINEL agent chat"),
  ]);
  const planSha = await ownerWrite(h, "docs/plan.md", "the plan");
  return { storage, h, planSha, activity };
}

function post(h: SyncRelayHandler, as: string, path: string, body: Record<string, unknown> = {}) {
  return h(request(as, path, jsonBody(body)));
}

async function member(h: SyncRelayHandler, storage: SyncRelayStorage, userId: string) {
  const invite = await post(h, OWNER, `/sync/${WORKSPACE}/members/invites`, {
    email: `${userId}@dohc.test`,
    workspaceName: "Community",
  });
  expect(invite.status, await invite.clone().text()).toBe(200);
  const memberId = (
    (await json(invite)).people as Array<{ memberId: string; email: string | null }>
  ).find((person) => person.email === `${userId}@dohc.test`)!.memberId;
  const shares = await json(await h(request(userId, "/sync/shares")));
  const shareId = (shares.received as Array<Record<string, unknown>>).find(
    (row) => (row.selector as { kind?: string }).kind === "workspace",
  )!.shareId as string;
  const grantId = storage.listActiveShareGrantsForRecipient(shareId, userId)[0]!.grantId;
  return { memberId, shareId, grantId };
}

const setLevel = async (h: SyncRelayHandler, level: "view" | "comment" | "edit") =>
  expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/level`, { level })).status).toBe(200);

function memberRead(
  h: SyncRelayHandler,
  path: string,
  grantId: string,
  userId: string,
  init: RequestInit = {},
) {
  return h(
    new Request(`http://relay.test${path}`, {
      ...init,
      headers: {
        authorization: `DohcMember ${grantId}`,
        cookie: `session=${userId}`,
        origin: SHARE_WEB_ORIGIN,
        "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY,
        "x-dohc-relay-client-ip": "203.0.113.7",
        ...Object.fromEntries(new Headers(init.headers)),
      },
    }),
  );
}

const refusalBytes = async (response: Response) => `${response.status}:${await response.text()}`;

describe("a member reads the workspace through the link read routes", () => {
  it("reads the workspace's name, reached files, and log at View, Comment and Edit", async () => {
    const { h, storage, planSha } = await seed();
    const ana = await member(h, storage, "ana");
    for (const level of ["view", "comment", "edit"] as const) {
      await setLevel(h, level);
      const share = await memberRead(h, "/sync/link/share", ana.grantId, "ana");
      expect(share.status, await share.clone().text()).toBe(200);
      expect(await json(share)).toMatchObject({
        ok: true,
        access: level,
        subjectName: "Community",
      });
      const current = await memberRead(h, "/sync/link/current", ana.grantId, "ana");
      expect(current.status).toBe(200);
      const body = await json(current);
      expect(body).toMatchObject({
        access: level,
        subjectName: "Community",
        files: [expect.objectContaining({ path: "docs/plan.md", blobSha256: planSha })],
      });
      expect(JSON.stringify(body)).not.toContain("SENTINEL");
      const blob = await memberRead(h, `/sync/link/blobs/${planSha}`, ana.grantId, "ana");
      expect(blob.status).toBe(200);
      expect(await blob.text()).toBe("the plan");
      const currentLog = await memberRead(
        h,
        "/sync/link/log?since=0&limit=500&current=true",
        ana.grantId,
        "ana",
      );
      expect(currentLog.status).toBe(200);
      const log = await memberRead(h, "/sync/link/log?since=0&limit=500", ana.grantId, "ana");
      expect(log.status, level).toBe(200);
    }
  });

  it("names who last set the members' level in the share's answer, from the relay's own record", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, storage, "ana");
    const share = async () => json(await memberRead(h, "/sync/link/share", ana.grantId, "ana"));
    expect(await share()).not.toHaveProperty("levelChangedBy");
    await setLevel(h, "view");
    expect(await share()).toMatchObject({ access: "view", levelChangedBy: `Name ${OWNER}` });
    // The page reads the files again after a level change, and takes the name from that answer.
    expect(await json(await memberRead(h, "/sync/link/current", ana.grantId, "ana"))).toMatchObject(
      { access: "view", levelChangedBy: `Name ${OWNER}` },
    );
  });

  // A rule's folder names stay on the relay, and a new account email reaches
  // browser reads within a minute, as it does the feed.
  it("never names a hidden folder in a share's answer, and follows the member's account email", async () => {
    let email = "ana@dohc.test",
      now = 10_000;
    const { h, storage } = await seed(undefined, {
      nowMs: () => now,
      lookupVerifiedUserEmail: async (userId: string) =>
        userId === "ana" ? email : `${userId}@dohc.test`,
    });
    const ana = await member(h, storage, "ana");
    await ownerRule(h, "Hidden Plans", "people:\n  ben@dohc.test: edit\n");
    await ownerRule(h, "docs", "people:\n  ana@dohc.test: edit\n");
    const paths = async () =>
      (
        (await json(await memberRead(h, "/sync/link/current", ana.grantId, "ana"))).files as Array<{
          path: string;
        }>
      ).map((file) => file.path);
    for (const route of ["/sync/link/share", "/sync/link/current"]) {
      const body = await memberRead(h, route, ana.grantId, "ana");
      expect(body.status).toBe(200);
      const text = await body.text();
      expect(text).not.toContain("Hidden Plans");
      expect(JSON.parse(text).effectiveSelector).not.toHaveProperty("reach");
    }
    expect(await paths()).toEqual(["docs/plan.md"]);
    email = "another@dohc.test";
    expect(await paths()).toEqual(["docs/plan.md"]);
    now += 60_000;
    expect(await paths()).toEqual([]);
  });

  it("serves files the owner adds after the member joined", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, storage, "ana");
    await ownerWrite(h, "later/new.md", "new work");
    const body = await json(await memberRead(h, "/sync/link/current", ana.grantId, "ana"));
    expect((body.files as Array<{ path: string }>).map((file) => file.path)).toEqual([
      "docs/plan.md",
      "later/new.md",
    ]);
  });

  // A browser offers the editor and the composer by the file's own level, and reads its files again when its reach changes.
  it("names each listed file's own level and a reach that changes with the folder rules", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, storage, "ana");
    await setLevel(h, "comment");
    await ownerRule(h, "open", "members: edit\n");
    await ownerWrite(h, "open/a.md", "open");
    await ownerRule(h, "view", "members: view\n");
    await ownerWrite(h, "view/b.md", "view");
    const read = async () => {
      const current = await json(await memberRead(h, "/sync/link/current", ana.grantId, "ana"));
      const share = await json(await memberRead(h, "/sync/link/share", ana.grantId, "ana"));
      expect(typeof current.reach).toBe("string");
      expect(share.reach).toBe(current.reach);
      return {
        reach: current.reach as string,
        levels: Object.fromEntries(
          (current.files as Array<{ path: string; access: string }>).map((file) => [
            file.path,
            file.access,
          ]),
        ),
      };
    };
    const before = await read();
    expect(before.levels).toEqual({
      "docs/plan.md": "comment",
      "open/a.md": "edit",
      "view/b.md": "view",
    });
    await ownerRule(h, "open", "members: view\n");
    const after = await read();
    expect(after.levels).toMatchObject({ "open/a.md": "view" });
    expect(after.reach).not.toBe(before.reach);
    // An admin edits every file, and no folder marker is listed.
    const role = await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana.memberId}/role`, {
      role: "admin",
    });
    expect(role.status, await role.clone().text()).toBe(200);
    const admin = await read();
    expect(admin.levels).toMatchObject({ "open/a.md": "edit" });
    expect(Object.keys(admin.levels).filter((path) => path.endsWith(".dohc-access"))).toEqual([]);
  });

  // A browser tells a workspace too large to list apart from a lost membership, and names the desktop app.
  it("refuses a workspace over the file limit with its own code, and a removed member with an unknown grant's bytes", async () => {
    const { h, storage } = await seed(undefined, { linkCurrentFileLimit: 1 });
    const ana = await member(h, storage, "ana");
    const ben = await member(h, storage, "ben");
    await ownerWrite(h, "later/new.md", "new work");
    const large = await memberRead(h, "/sync/link/current", ana.grantId, "ana");
    expect(large.status).toBe(413);
    expect(await json(large)).toEqual(linkRefusalBody("link_too_many_files"));
    // The grant still opens, so the browser can tell the two apart.
    expect((await memberRead(h, "/sync/link/share", ana.grantId, "ana")).status).toBe(200);
    const unknown = await refusalBytes(
      await memberRead(h, "/sync/link/current", "grant-never", "ana"),
    );
    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/${ben.memberId}/remove`)).status).toBe(
      200,
    );
    expect(await refusalBytes(await memberRead(h, "/sync/link/current", ben.grantId, "ben"))).toBe(
      unknown,
    );
  });

  // The size answer must not tell a member how much work is hidden from them.
  it("counts only a member's readable files against the file limit, and refuses a scan past its cap generically", async () => {
    const { h, storage } = await seed(undefined, { linkCurrentFileLimit: 1 });
    const ana = await member(h, storage, "ana");
    const ben = await member(h, storage, "ben");
    await ownerRule(h, "hidden", "people:\n  ben@dohc.test: edit\n");
    await ownerWrite(h, "hidden/x.md", "private");
    const one = await memberRead(h, "/sync/link/current", ana.grantId, "ana");
    expect(one.status, await one.clone().text()).toBe(200);
    expect(((await json(one)).files as Array<{ path: string }>).map((file) => file.path)).toEqual([
      "docs/plan.md",
    ]);
    // Ben reads the hidden folder too, so his own list is over the limit.
    const many = await memberRead(h, "/sync/link/current", ben.grantId, "ben");
    expect(many.status).toBe(413);
    expect(await json(many)).toEqual(linkRefusalBody("link_too_many_files"));
    // Past the cap on what the relay reads, a member gets an unknown grant's answer, whatever they can read.
    for (let index = 0; index < 8; index++) await ownerWrite(h, `hidden/${index}.md`, "private");
    const unknown = await refusalBytes(
      await memberRead(h, "/sync/link/current", "grant-never", "ana"),
    );
    expect(await refusalBytes(await memberRead(h, "/sync/link/current", ana.grantId, "ana"))).toBe(
      unknown,
    );
  });

  it("refuses a removed member, an ended membership, a fenced owner and a forged person with the bytes of an unknown grant", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, storage, "ana");
    const ben = await member(h, storage, "ben");
    const unknown = await refusalBytes(
      await memberRead(h, "/sync/link/current", "grant-never", "ana"),
    );
    expect(unknown.startsWith("404:")).toBe(true);

    // Another member's cookie with Ana's grant: the person comes from the session.
    expect(await refusalBytes(await memberRead(h, "/sync/link/current", ana.grantId, "ben"))).toBe(
      unknown,
    );
    expect(
      await refusalBytes(await memberRead(h, "/sync/link/current", ana.grantId, "mallory")),
    ).toBe(unknown);
    // A claimed person in the request changes nothing.
    expect(
      await refusalBytes(
        await memberRead(h, "/sync/link/current", ana.grantId, "mallory", {
          headers: { "x-dohc-user-id": "ana", authorization: `DohcMember ${ana.grantId}` },
        }),
      ),
    ).toBe(unknown);
    // No exchange key, no cookie, or a link capability with it.
    for (const headers of [
      { "x-dohc-relay-exchange-key": "wrong-key-wrong-key-wrong-key-wrong" },
      { cookie: "" },
      { "x-dohc-link-profile-secret": "x" },
    ] as Record<string, string>[]) {
      expect(
        await refusalBytes(
          await memberRead(h, "/sync/link/current", ana.grantId, "ana", { headers }),
        ),
        JSON.stringify(headers),
      ).toBe(unknown);
    }
    // A workspace grant never reads as a link holder.
    expect(
      await refusalBytes(
        await h(
          request(null, "/sync/link/current", {
            headers: { authorization: `LinkCapability ${ana.grantId}` },
          }),
        ),
      ),
    ).toBe(unknown);

    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/${ben.memberId}/remove`)).status).toBe(
      200,
    );
    for (const route of [
      "/sync/link/share",
      "/sync/link/current",
      "/sync/link/log?since=0&limit=500&current=true",
    ]) {
      expect(await refusalBytes(await memberRead(h, route, ben.grantId, "ben")), route).toBe(
        unknown,
      );
    }

    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/end`)).status).toBe(200);
    expect(await refusalBytes(await memberRead(h, "/sync/link/current", ana.grantId, "ana"))).toBe(
      unknown,
    );
  });

  it("refuses a fenced owner's workspace and a fenced member like an unknown grant", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, storage, "ana");
    const ben = await member(h, storage, "ben");
    const unknown = await refusalBytes(
      await memberRead(h, "/sync/link/current", "grant-never", "ana"),
    );
    const key = "account-deletion-key-at-least-32-bytes";
    const context = storage as unknown as StorageContext;
    initializeAccountDeletion(context, key);
    fenceAccount(context, key, "ben", "ben@dohc.test");
    expect(await refusalBytes(await memberRead(h, "/sync/link/current", ben.grantId, "ben"))).toBe(
      unknown,
    );
    expect((await memberRead(h, "/sync/link/current", ana.grantId, "ana")).status).toBe(200);
    fenceAccount(context, key, OWNER, `${OWNER}@dohc.test`);
    expect(await refusalBytes(await memberRead(h, "/sync/link/current", ana.grantId, "ana"))).toBe(
      unknown,
    );
  });

  it("refuses a blob outside the workspace's files", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, storage, "ana");
    const unknown = await refusalBytes(
      await memberRead(h, "/sync/link/current", "grant-never", "ana"),
    );
    expect(
      (await h(request("other", "/sync/workspaces", jsonBody({ workspaceId: "elsewhere" }))))
        .status,
    ).toBe(200);
    const elsewhere = await putBlob(h, "other", "elsewhere", "another workspace");
    expect(
      await refusalBytes(await memberRead(h, `/sync/link/blobs/${elsewhere}`, ana.grantId, "ana")),
    ).toBe(unknown);
    expect(
      await refusalBytes(
        await memberRead(h, `/sync/link/blobs/${sha256("never stored")}`, ana.grantId, "ana"),
      ),
    ).toBe(unknown);
  });

  // docs/engineering/security-boundaries.md, "Share history needs Edit".
  it("reads a file's earlier versions only where the member has Edit on it, on every route", async () => {
    const { h, storage, planSha } = await seed();
    const ana = await member(h, storage, "ana");
    await ownerWrite(h, "docs/plan.md", "the new plan", "the plan");
    await ownerRule(h, "view", "members: view\n");
    const viewOld = await ownerWrite(h, "view/a.md", "view old");
    const viewCurrent = await ownerWrite(h, "view/a.md", "view current", "view old");
    const routes = {
      named: (path: string) => h(request("ana", `/sync/shares/${ana.shareId}/${path}`)),
      link: (path: string) => memberRead(h, `/sync/link/${path}`, ana.grantId, "ana"),
    };
    const reads = async () =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(routes).map(async ([name, read]) => {
            const log = await read("log?since=0&limit=500");
            expect(log.status, name).toBe(200);
            const text = await log.text();
            const blobs = [];
            for (const sha of [planSha, viewOld, viewCurrent])
              blobs.push((await read(`blobs/${sha}`)).status);
            return [name, { old: text.includes(planSha), viewOld: text.includes(viewOld), blobs }];
          }),
        ),
      );
    const history = { old: true, viewOld: false, blobs: [200, 404, 200] };
    const current = { old: false, viewOld: false, blobs: [404, 404, 200] };
    await setLevel(h, "edit");
    expect(await reads()).toEqual({ named: history, link: history });
    await setLevel(h, "view");
    expect(await reads()).toEqual({ named: current, link: current });
    const role = await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana.memberId}/role`, {
      role: "admin",
    });
    expect(role.status, await role.clone().text()).toBe(200);
    expect((await reads()).named).toMatchObject({ old: true, blobs: [200, 200, 200] });
  });

  // A workspace label is read with its reader's reach. A folder marker stays
  // out of it for everyone but the owner.
  it("keeps the file links its reader reaches in the workspace's label", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, storage, "ana");
    await ownerRule(h, "hidden", "people:\n  ben@dohc.test: edit\n");
    await ownerWrite(h, "hidden/x.md", "hidden work");
    storage.setShareLabels(
      ana.shareId,
      {
        subjectName: "Community @[docs/plan.md] @[hidden] @[hidden/x.md] @[hidden/.dohc-access]",
      },
      0,
    );
    const subject = async () =>
      (await json(await memberRead(h, "/sync/link/share", ana.grantId, "ana"))).subjectName;
    expect(await subject()).toBe(
      "Community @[docs/plan.md] (a file not shared here) (a file not shared here) (a file not shared here)",
    );
    const role = await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana.memberId}/role`, {
      role: "admin",
    });
    expect(role.status, await role.clone().text()).toBe(200);
    expect(await subject()).toBe(
      "Community @[docs/plan.md] @[hidden] @[hidden/x.md] (a file not shared here)",
    );
  });
});

function chat(h: SyncRelayHandler, path: string, userId: string, init: RequestInit = {}) {
  return h(
    new Request(`http://relay.test/sync/named-chat/${path}`, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        cookie: `session=${userId}`,
        origin: SHARE_WEB_ORIGIN,
        "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY,
      },
    }),
  );
}

describe("a member's Chats in a browser", () => {
  it("lists every Group the membership reaches, and never General, a direct message or an agent chat", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, storage, "ana");
    const listed = await chat(h, `channels?grantId=${ana.grantId}`, "ana");
    expect(listed.status, await listed.clone().text()).toBe(200);
    expect(await json(listed)).toMatchObject({
      shareId: ana.shareId,
      userId: "ana",
      channels: [{ channelWireId: GROUP, name: "team", kind: "channel", access: "read-write" }],
    });
    await setLevel(h, "view");
    expect(await json(await chat(h, `channels?grantId=${ana.grantId}`, "ana"))).toMatchObject({
      channels: [{ channelWireId: GROUP, access: "read-only" }],
    });
    expect((await chat(h, `channels?grantId=${ana.grantId}`, "ben")).status).toBe(404);
  });

  it("follows every reached Group in one request, tags each message with its channel, and picks up a Group created later", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, storage, "ana");
    const first = await chat(h, `messages?shareId=${ana.shareId}&since=0&limit=50`, "ana");
    expect(first.status, await first.clone().text()).toBe(200);
    const page = await json(first);
    expect(page).toMatchObject({
      shareId: ana.shareId,
      hasMore: false,
      messages: [expect.objectContaining({ messageId: "msg-team", channelWireId: GROUP })],
    });
    expect(JSON.stringify(page)).not.toContain("SENTINEL");

    const held = chat(
      h,
      `messages?shareId=${ana.shareId}&since=${page.nextCursor}&hold=30000&limit=50`,
      "ana",
    );
    await ownerAppend(h, [
      channel(LATER_GROUP, "later"),
      thread("t-later", LATER_GROUP),
      message("msg-later", "t-later", "a new group"),
      message("msg-general-2", "t-general", "SENTINEL general again"),
    ]);
    const next = await json(await held);
    expect(next.messages).toEqual([
      expect.objectContaining({
        messageId: "msg-later",
        channelWireId: LATER_GROUP,
        body: "a new group",
      }),
    ]);
    // One follow covers every Group: a workspace share never follows one by name.
    expect(
      (await chat(h, `messages?shareId=${ana.shareId}&channelWireId=${GROUP}&since=0`, "ana"))
        .status,
    ).toBe(404);
  });

  it("names each person by their account, not by the name their computer wrote", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, storage, "ana");
    // An owner's desktop with no profile name writes its own messages as "You".
    await ownerAppend(h, [
      logOp(
        "chat.message.append",
        chatMessageAppend("msg-you", "t-team", "tickets booked", {
          authorUserId: OWNER,
          authorDisplayName: "You",
        }).payload,
      ),
    ]);
    const page = await json(
      await chat(h, `messages?shareId=${ana.shareId}&since=0&limit=50`, "ana"),
    );
    expect(page.messages).toContainEqual(
      expect.objectContaining({ messageId: "msg-you", authorDisplayName: `Name ${OWNER}` }),
    );
    expect(JSON.stringify(page)).not.toContain('"You"');
  });

  it("ends a held follow when the member is removed", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, storage, "ana");
    const page = await json(
      await chat(h, `messages?shareId=${ana.shareId}&since=0&limit=50`, "ana"),
    );
    const held = chat(
      h,
      `messages?shareId=${ana.shareId}&since=${page.nextCursor}&hold=30000&limit=50`,
      "ana",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana.memberId}/remove`)).status).toBe(
      200,
    );
    expect((await held).status).toBe(404);
  });

  it("posts in a Group at Comment, and refuses a post at View", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, storage, "ana");
    const posted = await chat(
      h,
      "messages",
      "ana",
      jsonBody({
        shareId: ana.shareId,
        channelWireId: GROUP,
        id: "r-1",
        lane: "posts",
        body: "hello team",
        authorKind: "human",
      }),
    );
    expect(posted.status, await posted.clone().text()).toBe(200);
    expect(await json(posted)).toMatchObject({
      shareId: ana.shareId,
      channelWireId: GROUP,
      message: { body: "hello team", authorUserId: "ana" },
    });
    for (const wireId of [GENERAL_CHANNEL_WIRE_ID, DM, AGENT]) {
      expect(
        (
          await chat(
            h,
            "messages",
            "ana",
            jsonBody({
              shareId: ana.shareId,
              channelWireId: wireId,
              id: `r-${wireId}`,
              lane: "posts",
              body: "x",
              authorKind: "human",
            }),
          )
        ).status,
        wireId,
      ).toBe(404);
    }
    await setLevel(h, "view");
    expect(
      (
        await chat(
          h,
          "messages",
          "ana",
          jsonBody({
            shareId: ana.shareId,
            channelWireId: GROUP,
            id: "r-2",
            lane: "posts",
            body: "x",
            authorKind: "human",
          }),
        )
      ).status,
    ).toBe(403);
  });

  it("lists each Group's type, and reads each message's lane and the message it replies to", async () => {
    const { h, storage } = await seed();
    await ownerAppend(h, [
      channel("wire-posts", "news", "channel", "posts"),
      thread("t-news", "wire-posts"),
      laneThread("t-team-chat", GROUP),
      message("msg-chat", "t-team-chat", "anyone free?"),
      reply("msg-chat-reply", "t-team-chat", "msg-chat", "me"),
    ]);
    const ana = await member(h, storage, "ana");
    expect((await json(await chat(h, `channels?grantId=${ana.grantId}`, "ana"))).channels).toEqual([
      expect.objectContaining({ channelWireId: GROUP, type: "both" }),
      expect.objectContaining({ channelWireId: "wire-posts", type: "posts" }),
    ]);
    const page = await json(
      await chat(h, `messages?shareId=${ana.shareId}&since=0&limit=50`, "ana"),
    );
    expect(page.messages).toEqual([
      expect.objectContaining({ messageId: "msg-team", lane: "posts", parentMessageId: null }),
      expect.objectContaining({ messageId: "msg-chat", lane: "chat", parentMessageId: null }),
      expect.objectContaining({
        messageId: "msg-chat-reply",
        lane: "chat",
        parentMessageId: "msg-chat",
      }),
    ]);
  });

  it("withholds a Group name's link to a folder the member can't see, in the list and a push", async () => {
    const { h, storage } = await seed();
    await ownerRule(h, "hidden", "people:\n  ben@dohc.test: edit\n");
    await ownerWrite(h, "hidden/x.md", "hidden work");
    await ownerAppend(h, [
      logOp(
        "chat.channel.create",
        chatChannelCreate("wire-plans", {
          channelId: "chan-plans",
          name: "Plans @[hidden] @[hidden/x.md] @[docs/plan.md]",
          slug: "plans",
          kind: "channel",
          type: "both",
          purpose: "",
          folderPath: "plans",
        }).payload,
      ),
      laneThread("t-plans", "wire-plans"),
      message("msg-plans", "t-plans", "hello"),
    ]);
    const ana = await member(h, storage, "ana");
    const named = "Plans (a file not shared here) (a file not shared here) @[docs/plan.md]";
    const listed = await json(await chat(h, `channels?grantId=${ana.grantId}`, "ana"));
    expect(listed.channels).toContainEqual(
      expect.objectContaining({ channelWireId: "wire-plans", name: named }),
    );
    const context = storage as unknown as StorageContext;
    const row = context.db
      .prepare(
        "SELECT relay_seq FROM sync_relay_log WHERE op_kind = 'chat.message.append' AND json_extract(payload_json, '$.messageId') = 'msg-plans'",
      )
      .get();
    const pushed = readPushMessage(context, Number(row!.relay_seq))!;
    expect(pushMessageAccess(context, pushed, "ana")?.place).toBe(named);
    expect(pushMessageAccess(context, pushed, OWNER)?.place).toContain("@[hidden]");
  });

  it("withholds a link to a folder the member can't see from their Notice's title and body", async () => {
    const { h, storage } = await seed();
    await member(h, storage, "ana");
    await ownerRule(h, "hidden", "people:\n  ben@dohc.test: edit\n");
    await ownerWrite(h, "hidden/x.md", "hidden work");
    recordAccountName(storage as unknown as StorageContext, "ana", "Ana");
    await ownerAppend(h, [
      channel("wire-notice", "Team @[hidden]"),
      thread("t-notice", "wire-notice"),
      message("msg-notice", "t-notice", "@Ana see @[hidden] and @[docs/plan.md]"),
    ]);
    const response = await h(request("ana", "/sync/notices"));
    expect(response.status, await response.clone().text()).toBe(200);
    const { notices } = (await response.json()) as { notices: { title: string }[] };
    expect(notices.find((row) => row.title.includes("mentioned you"))).toMatchObject({
      title: expect.stringContaining("#Team (a file not shared here)"),
      body: "@Ana see (a file not shared here) and @[docs/plan.md]",
    });
  });

  it("withholds a Group message's link to a folder the member can't see", async () => {
    const { h, storage } = await seed();
    await ownerRule(h, "hidden", "people:\n  ben@dohc.test: edit\n");
    await ownerWrite(h, "hidden/x.md", "hidden work");
    await ownerAppend(h, [
      laneThread("t-links", GROUP),
      message("msg-links", "t-links", "see @[hidden] and @[docs/plan.md]"),
    ]);
    const ana = await member(h, storage, "ana");
    const page = await json(
      await chat(h, `messages?shareId=${ana.shareId}&since=0&limit=50`, "ana"),
    );
    expect(page.messages).toContainEqual(
      expect.objectContaining({
        messageId: "msg-links",
        body: "see (a file not shared here) and @[docs/plan.md]",
      }),
    );
  });

  it("starts a post, replies in a reached Group's threads, and refuses a reply to a thread outside the Group", async () => {
    const { h, storage } = await seed();
    await ownerAppend(h, [
      laneThread("t-team-chat", GROUP),
      message("msg-chat", "t-team-chat", "anyone free?"),
      commentThread("c-plan", "docs/plan.md"),
      message("msg-plan", "c-plan", "a comment"),
    ]);
    const ana = await member(h, storage, "ana");
    const send = (body: Record<string, unknown>) =>
      chat(
        h,
        "messages",
        "ana",
        jsonBody({ shareId: ana.shareId, channelWireId: GROUP, authorKind: "human", ...body }),
      );

    const started = await send({ id: "p-1", lane: "posts", body: "new post" });
    expect(started.status, await started.clone().text()).toBe(200);
    const post = (await json(started)).message as { threadId: string };
    expect(post).toMatchObject({ lane: "posts", parentMessageId: null, startsPost: true });
    expect(post.threadId).not.toBe("t-team");

    const replied = await send({ id: "p-2", threadId: "t-team", body: "a reply" });
    expect(replied.status, await replied.clone().text()).toBe(200);
    expect((await json(replied)).message).toMatchObject({
      threadId: "t-team",
      lane: "posts",
      parentMessageId: null,
      body: "a reply",
      startsPost: false,
    });

    // The Group's chat is one conversation: a new chat message joins it, and a reply names the message it answers.
    const chatted = await send({ id: "p-3", lane: "chat", body: "I am" });
    expect(chatted.status, await chatted.clone().text()).toBe(200);
    expect((await json(chatted)).message).toMatchObject({
      threadId: "t-team-chat",
      lane: "chat",
      parentMessageId: null,
    });
    const answered = await send({
      id: "p-4",
      threadId: "t-team-chat",
      parentMessageId: "msg-chat",
      body: "same",
    });
    expect(answered.status, await answered.clone().text()).toBe(200);
    expect((await json(answered)).message).toMatchObject({
      threadId: "t-team-chat",
      parentMessageId: "msg-chat",
    });

    // A thread in General, a direct message, an agent chat or a file's Comments is outside this Group.
    for (const threadId of ["t-general", "t-dm", "t-agent", "c-plan", "t-missing"]) {
      expect((await send({ id: `x-${threadId}`, threadId, body: "x" })).status, threadId).toBe(404);
    }
    // A post's replies stay in its thread; only the chat answers one message.
    expect(
      (await send({ id: "x-parent", threadId: "t-team", parentMessageId: "msg-team", body: "x" }))
        .status,
    ).toBe(400);
    expect((await send({ id: "x-lane", lane: "feed", body: "x" })).status).toBe(400);
    expect(
      (await send({ id: "x-both", threadId: "t-team", lane: "posts", body: "x" })).status,
    ).toBe(400);
  });

  // A page ends wherever its limit falls, so a post's replies can arrive a page before the message that starts it.
  it("names the message that starts each post, on whichever page it falls", async () => {
    const { h, storage } = await seed();
    await ownerAppend(h, [
      message("msg-team-reply", "t-team", "a reply"),
      laneThread("t-team-chat", GROUP),
      message("msg-chat", "t-team-chat", "anyone free?"),
    ]);
    const ana = await member(h, storage, "ana");
    const pages: Array<Array<Record<string, unknown>>> = [];
    let before = "";
    do {
      const page = await json(
        await chat(
          h,
          `messages?shareId=${ana.shareId}&channelWireId=${GROUP}&limit=1${before}`,
          "ana",
        ),
      );
      pages.push(page.messages as Array<Record<string, unknown>>);
      before = page.olderCursor === null ? "" : `&before=${String(page.olderCursor)}`;
    } while (before);
    expect(pages.map((page) => page.map((item) => [item.messageId, item.startsPost]))).toEqual([
      [["msg-chat", false]],
      [["msg-team-reply", false]],
      [["msg-team", true]],
    ]);
    // A follow of every Group names it too.
    const followed = await json(
      await chat(h, `messages?shareId=${ana.shareId}&since=0&limit=50`, "ana"),
    );
    expect(
      (followed.messages as Array<Record<string, unknown>>).map((item) => [
        item.messageId,
        item.startsPost,
      ]),
    ).toEqual([
      ["msg-team", true],
      ["msg-team-reply", false],
      ["msg-chat", false],
    ]);
  });

  it("starts only the lanes a Group's type has, and the first chat message starts its conversation", async () => {
    const { h, storage } = await seed();
    await ownerAppend(h, [
      channel("wire-posts", "news", "channel", "posts"),
      channel("wire-chat", "lounge", "channel", "chat"),
    ]);
    const ana = await member(h, storage, "ana");
    const send = (channelWireId: string, lane: string, id: string) =>
      chat(
        h,
        "messages",
        "ana",
        jsonBody({ shareId: ana.shareId, channelWireId, authorKind: "human", id, lane, body: "x" }),
      );
    expect((await send("wire-posts", "chat", "a")).status).toBe(400);
    expect((await send("wire-chat", "posts", "b")).status).toBe(400);
    expect((await send("wire-posts", "posts", "c")).status).toBe(200);
    const first = (await json(await send("wire-chat", "chat", "d"))).message as {
      threadId: string;
    };
    const second = (await json(await send("wire-chat", "chat", "e"))).message as {
      threadId: string;
    };
    expect(second.threadId).toBe(first.threadId);
    const log = await json(await h(request(OWNER, `/sync/${WORKSPACE}/log?since=0&limit=500`)));
    const creates = (
      log.ops as Array<{ opKind: string; payload?: Record<string, unknown>; payloadJson?: string }>
    )
      .filter((op) => op.opKind === "chat.thread.create")
      .map((op) => op.payload ?? (JSON.parse(op.payloadJson ?? "{}") as Record<string, unknown>))
      .filter((payload) => payload.threadId === first.threadId);
    expect(creates).toEqual([
      expect.objectContaining({ channelWireId: "wire-chat", lane: "chat" }),
    ]);
  });

  it("caps browser follows at 512 per workspace", () => {
    expect(MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE).toBe(512);
  });
});

// A file's Comments are threads whose first create binds the file. The owner's
// desktop and every member read the same threads.
const commentThread = (threadId: string, path: string) =>
  logOp("chat.thread.create", {
    threadId,
    title: "",
    createdAtMs: 2,
    linkedObjectId: `object-${path}`,
    linkedAtMs: 2,
    linkedPathHint: path,
  });
const comments = (shareId: string, path: string, query: Record<string, string> = {}) =>
  `messages?${new URLSearchParams({ shareId, path, limit: "50", ...query })}`;

async function commented() {
  const seeded = await seed();
  await ownerWrite(seeded.h, "docs/other.md", "another file");
  await ownerAppend(seeded.h, [
    commentThread("c-plan", "docs/plan.md"),
    message("msg-plan", "c-plan", "Is the hotel near the river?"),
    commentThread("c-other", "docs/other.md"),
    message("msg-other", "c-other", "SENTINEL another file's comment"),
  ]);
  return seeded;
}

describe("a member's file Comments in a browser", () => {
  it("reads a file's Comments at View, Comment and Edit, and no other file's or Group's", async () => {
    const { h, storage } = await commented();
    const ana = await member(h, storage, "ana");
    for (const level of ["view", "comment", "edit"] as const) {
      await setLevel(h, level);
      const read = await chat(h, comments(ana.shareId, "docs/plan.md"), "ana");
      expect(read.status, await read.clone().text()).toBe(200);
      const page = await json(read);
      expect(page).toMatchObject({
        shareId: ana.shareId,
        path: "docs/plan.md",
        olderCursor: null,
        messages: [
          expect.objectContaining({ messageId: "msg-plan", body: "Is the hotel near the river?" }),
        ],
      });
      expect(page.messages).toHaveLength(1);
      expect(JSON.stringify(page)).not.toContain("SENTINEL");
    }
  });

  it("follows a file's Comments and wakes for a new one on that file only", async () => {
    const { h, storage } = await commented();
    const ana = await member(h, storage, "ana");
    const page = await json(await chat(h, comments(ana.shareId, "docs/plan.md"), "ana"));
    const held = chat(
      h,
      comments(ana.shareId, "docs/plan.md", { since: String(page.nextCursor), hold: "30000" }),
      "ana",
    );
    await ownerAppend(h, [
      message("msg-other-2", "c-other", "SENTINEL still the other file"),
      message("msg-plan-2", "c-plan", "Yes, five minutes away."),
    ]);
    const next = await held;
    expect(next.status, await next.clone().text()).toBe(200);
    expect(await json(next)).toMatchObject({
      shareId: ana.shareId,
      path: "docs/plan.md",
      hasMore: false,
      messages: [
        expect.objectContaining({ messageId: "msg-plan-2", body: "Yes, five minutes away." }),
      ],
    });
  });

  it("posts a Comment on the file at Comment and Edit that the owner reads on the file, and refuses one at View", async () => {
    const { h, storage } = await commented();
    const ana = await member(h, storage, "ana");
    for (const level of ["comment", "edit"] as const) {
      await setLevel(h, level);
      const posted = await chat(
        h,
        "messages",
        "ana",
        jsonBody({
          shareId: ana.shareId,
          path: "docs/plan.md",
          id: `r-${level}`,
          body: `from ${level}`,
          authorKind: "human",
        }),
      );
      expect(posted.status, await posted.clone().text()).toBe(200);
      expect(await json(posted)).toMatchObject({
        shareId: ana.shareId,
        path: "docs/plan.md",
        message: { body: `from ${level}`, authorUserId: "ana", authorDisplayName: "Name ana" },
      });
    }
    // The owner's log binds each new thread to the file's object, as the desktop's own Comments do.
    const log = await json(await h(request(OWNER, `/sync/${WORKSPACE}/log?since=0&limit=500`)));
    const ops = (
      log.ops as Array<{ opKind: string; payload?: Record<string, unknown>; payloadJson?: string }>
    ).map((op) => ({
      opKind: op.opKind,
      payload: op.payload ?? (JSON.parse(op.payloadJson ?? "{}") as Record<string, unknown>),
    }));
    const post = ops.find(
      (op) => op.opKind === "chat.message.append" && op.payload.body === "from comment",
    )!;
    expect(
      ops.find(
        (op) => op.opKind === "chat.thread.create" && op.payload.threadId === post.payload.threadId,
      )?.payload,
    ).toMatchObject({ linkedObjectId: "object-docs/plan.md" });
    const read = await json(await chat(h, comments(ana.shareId, "docs/plan.md"), "ana"));
    expect((read.messages as Array<{ body: string }>).map((item) => item.body)).toEqual([
      "from edit",
      "from comment",
      "Is the hotel near the river?",
    ]);
    // A reply joins a thread on this file.
    const reply = await chat(
      h,
      "messages",
      "ana",
      jsonBody({
        shareId: ana.shareId,
        path: "docs/plan.md",
        id: "r-reply",
        threadId: "c-plan",
        body: "thanks",
        authorKind: "human",
      }),
    );
    expect(reply.status, await reply.clone().text()).toBe(200);
    expect(await json(reply)).toMatchObject({ message: { threadId: "c-plan", body: "thanks" } });

    await setLevel(h, "view");
    const refused = await chat(
      h,
      "messages",
      "ana",
      jsonBody({
        shareId: ana.shareId,
        path: "docs/plan.md",
        id: "r-view",
        body: "x",
        authorKind: "human",
      }),
    );
    expect(refused.status).toBe(403);
  });

  it("refuses a removed member, an ended membership, a fenced owner, a forged person and a path outside reach like an unknown share", async () => {
    const { h, storage } = await commented();
    const ana = await member(h, storage, "ana");
    const ben = await member(h, storage, "ben");
    const read = (shareId: string, userId: string, path = "docs/plan.md") =>
      chat(h, comments(shareId, path), userId);
    const write = (shareId: string, userId: string, fields: Record<string, unknown> = {}) =>
      chat(
        h,
        "messages",
        userId,
        jsonBody({
          shareId,
          path: "docs/plan.md",
          id: "r-refused",
          body: "x",
          authorKind: "human",
          ...fields,
        }),
      );
    const unknown = await refusalBytes(await read("share-never", "ana"));
    expect(unknown.startsWith("404:")).toBe(true);
    expect(await refusalBytes(await write("share-never", "ana"))).toBe(unknown);

    // The person comes from the session: a stranger's cookie with Ana's share, or a claimed author.
    expect(await refusalBytes(await read(ana.shareId, "mallory"))).toBe(unknown);
    expect(await refusalBytes(await write(ana.shareId, "mallory"))).toBe(unknown);
    expect((await write(ana.shareId, "ana", { authorUserId: "ben" })).status).not.toBe(200);
    // A path the workspace share does not reach: a missing file, a secret, another file's thread, a Group's thread.
    for (const path of ["docs/missing.md", ".env", "../docs/plan.md"]) {
      expect(await refusalBytes(await read(ana.shareId, "ana", path)), path).toBe(unknown);
      expect(
        await refusalBytes(
          await chat(
            h,
            "messages",
            "ana",
            jsonBody({
              shareId: ana.shareId,
              path,
              id: `r-${path}`,
              body: "x",
              authorKind: "human",
            }),
          ),
        ),
        path,
      ).toBe(unknown);
    }
    for (const threadId of ["c-other", "t-team"]) {
      expect(await refusalBytes(await write(ana.shareId, "ana", { threadId })), threadId).toBe(
        unknown,
      );
    }
    // A path and a Group together name nothing.
    expect(
      await refusalBytes(
        await chat(h, comments(ana.shareId, "docs/plan.md", { channelWireId: GROUP }), "ana"),
      ),
    ).toBe(unknown);

    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/${ben.memberId}/remove`)).status).toBe(
      200,
    );
    expect(await refusalBytes(await read(ben.shareId, "ben"))).toBe(unknown);
    expect(await refusalBytes(await write(ben.shareId, "ben"))).toBe(unknown);

    const key = "account-deletion-key-at-least-32-bytes";
    const context = storage as unknown as StorageContext;
    initializeAccountDeletion(context, key);
    fenceAccount(context, key, OWNER, `${OWNER}@dohc.test`);
    expect(await refusalBytes(await read(ana.shareId, "ana"))).toBe(unknown);
    expect(await refusalBytes(await write(ana.shareId, "ana"))).toBe(unknown);
  });

  it("refuses an ended membership like an unknown share", async () => {
    const { h, storage } = await commented();
    const ana = await member(h, storage, "ana");
    const unknown = await refusalBytes(
      await chat(h, comments("share-never", "docs/plan.md"), "ana"),
    );
    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/end`)).status).toBe(200);
    expect(await refusalBytes(await chat(h, comments(ana.shareId, "docs/plan.md"), "ana"))).toBe(
      unknown,
    );
    expect(
      await refusalBytes(
        await chat(
          h,
          "messages",
          "ana",
          jsonBody({
            shareId: ana.shareId,
            path: "docs/plan.md",
            id: "r-ended",
            body: "x",
            authorKind: "human",
          }),
        ),
      ),
    ).toBe(unknown);
  });

  it("ends a held Comments follow when the member is removed", async () => {
    const { h, storage } = await commented();
    const ana = await member(h, storage, "ana");
    const page = await json(await chat(h, comments(ana.shareId, "docs/plan.md"), "ana"));
    const held = chat(
      h,
      comments(ana.shareId, "docs/plan.md", { since: String(page.nextCursor), hold: "30000" }),
      "ana",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana.memberId}/remove`)).status).toBe(
      200,
    );
    expect((await held).status).toBe(404);
  });
});

it("filters member browser feeds and blobs and stops an open download when folder reach changes", async () => {
  const { h, storage, planSha } = await seed();
  const ana = await member(h, storage, "ana");
  const download = await memberRead(h, `/sync/link/blobs/${planSha}`, ana.grantId, "ana");
  expect(download.status).toBe(200);
  const context = storage as StorageContext;
  context.tx(() =>
    context.db
      .prepare(
        `INSERT INTO sync_relay_access_rules (workspace_id,folder,rule_text,from_seq,to_seq) VALUES (?,'docs','',100,NULL)`,
      )
      .run(WORKSPACE),
  );
  await expect(download.text()).rejects.toThrow();
  const current = await json(await memberRead(h, "/sync/link/current", ana.grantId, "ana"));
  expect(current.files).toEqual([]);
  const feed = await json(
    await memberRead(h, "/sync/link/log?since=0&limit=500", ana.grantId, "ana"),
  );
  expect(JSON.stringify(feed)).not.toContain("docs/plan.md");
  const hidden = await memberRead(h, `/sync/link/blobs/${planSha}`, ana.grantId, "ana");
  const missing = await memberRead(h, `/sync/link/blobs/${sha256("missing")}`, ana.grantId, "ana");
  expect(await refusalBytes(hidden)).toBe(await refusalBytes(missing));
});
