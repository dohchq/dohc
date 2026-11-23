import { authorizeShareAction } from "./shareAuthorization";
import { filterProposedChangeForShare } from "./shareFilter";
import { folderMarkerText, parseAccessRule } from "@dohc/security-contract/access-rules";
import { GENERAL_CHANNEL_WIRE_ID } from "@dohc/security-contract/chat-wire-ids";
import type { WorkspaceMembersView } from "@dohc/security-contract/workspace-members";
import { parseListedReach } from "@dohc/security-contract/listed-reach";
import { actorHueSlot } from "@dohc/workspace-contracts/actor-presentation";
import { afterEach, describe, expect, it } from "vitest";
import { DiscussionActivityHub } from "./discussionActivity";
import { createShareReadQueries } from "./shareReadQueries";
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
  writeAfterTransaction,
} from "./testing";

afterEach(closeTestStorages);

const OWNER = "owner";
const WORKSPACE = "workspace-members";
const FOLDER_RULES = `/sync/${WORKSPACE}/members/folder-rules`;
const FOLDER_MARKERS = `/sync/${WORKSPACE}/members/folder-markers`;
const GROUP = "wire-team";
const LATER_GROUP = "wire-later";
const DM = "wire-dm";
const AGENT = "wire-agent";
const UNKNOWN = "wire-never-created";

let ownerSeq = 0;
const ownerHeads = new Map<string, string>();

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
  const before = ownerHeads.get(path) ?? null;
  await ownerAppend(h, [
    logOp("moment.append", {
      momentId: `m-${seq}`,
      versionId: "main",
      objectId: `object-${path}`,
      path,
      recordedAtMs: 1000 + seq,
      operation: "write",
      payloadBeforeBlobSha256: before,
      payloadBeforePath: before ? path : null,
      payloadAfterBlobSha256: sha,
      payloadAfterPath: path,
      metadata: { origin: "user" },
      beforePresent: "null",
    }),
  ]);
  ownerHeads.set(path, sha);
}

async function ownerRename(h: SyncRelayHandler, from: string, to: string): Promise<void> {
  const sha = ownerHeads.get(from)!;
  const seq = ownerSeq++;
  await ownerAppend(h, [
    logOp("moment.append", {
      momentId: `m-${seq}`,
      versionId: "main",
      objectId: `object-${from}`,
      path: to,
      recordedAtMs: 1000 + seq,
      operation: "rename",
      payloadBeforeBlobSha256: sha,
      payloadBeforePath: from,
      beforePath: from,
      payloadAfterBlobSha256: sha,
      payloadAfterPath: to,
      metadata: { origin: "user" },
      beforePresent: "null",
    }),
  ]);
  ownerHeads.delete(from);
  ownerHeads.set(to, sha);
}

async function ownerDelete(h: SyncRelayHandler, path: string): Promise<void> {
  await ownerAppend(h, [
    logOp("moment.append", {
      momentId: `m-${ownerSeq++}`,
      versionId: "main",
      objectId: `object-${path}`,
      path,
      recordedAtMs: 5000,
      operation: "delete",
      payloadBeforeBlobSha256: ownerHeads.get(path),
      payloadBeforePath: path,
      payloadAfterBlobSha256: null,
      payloadAfterPath: null,
      metadata: { origin: "user" },
      beforePresent: "null",
    }),
  ]);
  ownerHeads.delete(path);
}

// The owner sets, changes or clears a folder's rule as Members settings does,
// and keeps the relay's marker in `ownerHeads` for later moves and deletes.
async function ownerRule(
  h: SyncRelayHandler,
  folder: string,
  text: string | null,
): Promise<string> {
  const covers = (rule: { folders: Array<{ path: string }> }) =>
    rule.folders.some((entry) => entry.path === folder);
  const held = (await membersView(h, OWNER)).folderRules!.find(covers);
  const rule = text === null ? null : parseAccessRule(text)!;
  const response = await post(h, OWNER, FOLDER_RULES, {
    ...(held ? { ruleId: held.ruleId, revision: held.revision } : { folder }),
    ...(rule === null
      ? { clear: true }
      : {
          members: rule.members,
          people: [...rule.people].map(([email, level]) => ({ email, level })),
        }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const rules = ((await response.json()) as WorkspaceMembersView).folderRules!;
  const ruleId = held?.ruleId ?? rules.find(covers)!.ruleId;
  const now = rules.find((entry) => entry.ruleId === ruleId);
  const marker = `${folder}/.dohc-access`;
  if (now?.folders.some((entry) => entry.path === folder && entry.state === "covered"))
    ownerHeads.set(marker, sha256(folderMarkerText(ruleId, now.revision)));
  else ownerHeads.delete(marker);
  return ruleId;
}

// The owner's workspace: a Group, General, a direct message, an agent chat,
// a message in a channel the log never created, a file, a version fork, and
// a secret. Everything a member must not see says SENTINEL.
async function seed(
  options: { activity?: DiscussionActivityHub; overrides?: Parameters<typeof testHandler>[1] } = {},
) {
  resetOpSeq();
  ownerSeq = 0;
  ownerHeads.clear();
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
      ["folder-rules", "members-folder-rules"],
      ["folder-markers", "members-folder-markers"],
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

  it("refreshes a member's email on feed reads at most once a minute, and keeps it when a lookup fails", async () => {
    let email = "ana@dohc.test",
      now = 10_000,
      lookups = 0,
      failing = false;
    const { h, storage } = await seed({
      overrides: {
        nowMs: () => now,
        lookupVerifiedUserEmail: async (userId) => {
          if (userId !== "ana") return `${userId}@dohc.test`;
          lookups++;
          if (failing) throw new Error("lookup down");
          return email;
        },
      },
    });
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    await ownerRule(h, "docs", "people:\n  ana@dohc.test: edit\n");
    expect(await pulledText(h, "ana", shareId)).toContain("docs/plan.md");
    const signature = storage.memberReach(WORKSPACE, "ana", "member", "comment").signature();
    const counted = lookups;
    email = "another@dohc.test";
    // Within a minute the feed reuses the stored email.
    expect(await pulledText(h, "ana", shareId)).toContain("docs/plan.md");
    expect(lookups).toBe(counted);
    now += 60_000;
    expect(await pulledText(h, "ana", shareId)).not.toContain("docs/plan.md");
    expect(storage.memberReach(WORKSPACE, "ana", "member", "comment").signature()).not.toBe(
      signature,
    );
    // A failed lookup fails the read and leaves the stored email as it was.
    failing = true;
    now += 60_000;
    expect((await pull(h, "ana", shareId)).status).toBe(500);
    expect(
      (storage as StorageContext).db
        .prepare("SELECT verified_email FROM sync_relay_account_emails WHERE user_id = ?")
        .get("ana"),
    ).toMatchObject({ verified_email: "another@dohc.test" });
  });

  // A transaction reads each workspace's rules once, until it writes.
  it("reads a rule written earlier in the same transaction", async () => {
    const { h, storage } = await seed();
    await invited(h, "ana");
    await ownerRule(h, "docs", "members: view\n");
    const context = storage as StorageContext;
    const level = () =>
      storage.memberReach(WORKSPACE, "ana", "member", "edit").levelAt("docs/plan.md");
    context.tx(() => {
      expect(level()).toBe("view");
      context.db
        .prepare(
          "UPDATE sync_relay_access_rules SET rule_text = ? WHERE workspace_id = ? AND folder = 'docs' AND to_seq IS NULL",
        )
        .run("members: comment\n", WORKSPACE);
      expect(level()).toBe("comment");
    });
  });

  // Authorization and the read share one transaction, so a rule change can
  // land before or after both, never between them.
  it("serves a member's read under the rules it was authorized with", async () => {
    const { h, storage } = await seed();
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    // The rule gives members the level they already have, so it hides nothing yet.
    const ruleId = await ownerRule(h, "docs", "members: comment\n");
    const secret = await putBlob(h, OWNER, WORKSPACE, "SENTINEL written after hiding");
    const op = logOp("moment.append", {
      momentId: "hide-docs/plan.md",
      versionId: "main",
      objectId: "object-docs/plan.md",
      path: "docs/plan.md",
      recordedAtMs: 5_000,
      operation: "write",
      payloadBeforeBlobSha256: ownerHeads.get("docs/plan.md")!,
      payloadBeforePath: "docs/plan.md",
      payloadAfterBlobSha256: secret,
      payloadAfterPath: "docs/plan.md",
      metadata: { origin: "user" },
      beforePresent: "null",
    });
    const hideDocsThenWrite = () => {
      const hidden = storage.changeFolderRule({
        workspaceId: WORKSPACE,
        actorUserId: OWNER,
        change: { kind: "change", ruleId, revision: 1, rule: { members: null, people: new Map() } },
        nowMs: 5_000,
      });
      expect(hidden.ok).toBe(true);
      storage.appendLogBatch({
        workspaceId: WORKSPACE,
        originId: "origin-hide",
        ops: [{ ...op, originSeq: 0, payloadJson: JSON.stringify(op.payload) }],
      });
    };
    const page = createShareReadQueries(storage, 500).filteredLogPage(
      WORKSPACE,
      shareId,
      () => {
        const authorized = authorizeShareAction({
          storage,
          actorUserId: "ana",
          shareId,
          action: "read",
        });
        if (!authorized.ok) throw new Error(authorized.reason);
        writeAfterTransaction(storage, hideDocsThenWrite);
        return authorized.effectiveSelector;
      },
      0,
      500,
      "authenticated",
    );
    expect(JSON.stringify(page.ops)).toContain("docs/plan.md");
    expect(JSON.stringify(page.ops)).not.toContain(secret);
    const after = await pulledText(h, "ana", shareId);
    expect(after).not.toContain("docs/plan.md");
    expect(after).not.toContain(secret);
  });

  it("serves a folder marker to neither a member nor an admin", async () => {
    const { h } = await seed();
    const ana = await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    const ruled = await post(h, OWNER, FOLDER_RULES, {
      folder: "secret",
      members: "edit",
      people: [],
    });
    expect(ruled.status, await ruled.clone().text()).toBe(200);
    await ownerWrite(h, "secret/notes.md", "hidden");

    const asMember = await pulledText(h, "ana", shareId);
    expect(asMember).toContain("secret/notes.md");
    expect(asMember).not.toContain(".dohc-access");

    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "admin" })).status,
    ).toBe(200);
    const asAdmin = await pulledText(h, "ana", shareId);
    expect(asAdmin).toContain("secret/notes.md");
    expect(asAdmin).not.toContain(".dohc-access");
  });

  it("filters member ops and blobs, and has no separate reach read", async () => {
    const { h } = await seed();
    const ana = await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    await ownerRule(h, "private", "");
    await ownerWrite(h, "private/deep/secret.md", "PRIVATE CONTENT");
    await ownerWrite(h, "public/deep/hello.md", "PUBLIC CONTENT");
    // A member learns of a reach change from their pages (decision 18A).
    expect((await h(request("ana", `/sync/shares/${shareId}/reach`))).status).toBe(404);
    const listed = async () =>
      (await json(await pull(h, "ana", shareId))).reach as Record<string, unknown>;
    const signature = async () => (await listed()).signature;
    const reach = await listed();
    expect(Object.keys(reach).sort()).toEqual([
      "folders",
      "groupDefault",
      "groups",
      "rootLevel",
      "signature",
      "visibilitySignature",
    ]);
    expect(reach.rootLevel).toBe("comment");
    expect(reach.folders).toEqual([]);
    // The member's copy reads the page's reach as it is.
    expect(parseListedReach(reach)).not.toBeNull();
    const first = reach.signature;
    const body = await pulledText(h, "ana", shareId);
    expect(body).not.toContain("private/");
    expect(body).not.toContain(sha256("PRIVATE CONTENT"));
    expect(body).toContain("public/deep/hello.md");
    const blob = (user: string, text: string) =>
      h(request(user, `/sync/shares/${shareId}/blobs/${sha256(text)}`));
    expect((await blob("ana", "PRIVATE CONTENT")).status).toBe(404);
    expect((await blob("ana", "PUBLIC CONTENT")).status).toBe(200);
    await ownerWrite(h, "public/deep/hello.md", "changed");
    expect(await signature()).toBe(first);
    await ownerRule(h, "private", "members: view\n");
    const opened = await signature();
    expect(opened).not.toBe(first);
    expect(await pulledText(h, "ana", shareId)).toContain("private/deep/secret.md");
    expect((await listed()).folders).toEqual([{ path: "private", level: "view" }]);
    await ownerRule(h, "private", "");
    // The signature is a function of reach, so the same reach signs the same.
    expect(await signature()).toBe(first);
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "admin" })).status,
    ).toBe(200);
    expect(await signature()).not.toBe(first);
    expect((await blob("ana", "PRIVATE CONTENT")).status).toBe(200);
    expect(await pulledText(h, "ana", shareId)).toContain("private/deep/secret.md");
  });

  it("withholds a hidden folder's old names after its rule moves to the renamed folder", async () => {
    const { h } = await seed();
    const ana = await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    const marker = folderMarkerText(await ownerRule(h, "HR", ""), 1);
    await ownerWrite(h, "HR/salaries-2026.md", "PRIVATE CONTENT");
    expect(await pulledText(h, "ana", shareId)).not.toContain("HR/");

    // The engine writes the destination marker before moving files, then removes the old marker.
    await ownerWrite(h, "People/.dohc-access", marker);
    await ownerRename(h, "HR/salaries-2026.md", "People/salaries-2026.md");
    await ownerDelete(h, "HR/.dohc-access");

    const asMember = await pulledText(h, "ana", shareId);
    expect(asMember).not.toContain("HR/");
    expect(asMember).not.toContain("People/");
    expect(asMember).not.toContain(sha256("PRIVATE CONTENT"));
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "admin" })).status,
    ).toBe(200);
    const asAdmin = await pulledText(h, "ana", shareId);
    expect(asAdmin).toContain("HR/salaries-2026.md");
    expect(asAdmin).toContain("People/salaries-2026.md");
  });

  it.each(["delete", "rename"] as const)(
    "serves a move out of a hidden folder as an arrival after the owner %ss the folder",
    async (operation) => {
      const { h } = await seed();
      const ana = await invited(h, "ana");
      const shareId = await shareIdOf(h, "ana");
      const marker = folderMarkerText(await ownerRule(h, "HR", ""), 1);
      await ownerWrite(h, "HR/layoff-plan.md", "published plan");
      await ownerRename(h, "HR/layoff-plan.md", "Public/plan.md");
      const before = await pulledText(h, "ana", shareId);
      expect(before).not.toContain("HR/");
      expect(before).toContain('"reachMove":"arrival"');

      // The folder holds only its marker now; a rename takes it along.
      if (operation === "rename") await ownerWrite(h, "People/.dohc-access", marker);
      await ownerDelete(h, "HR/.dohc-access");
      // A deleted folder keeps its rule; a renamed one takes it along.
      expect((await membersView(h, OWNER)).folderRules![0]!.folders).toEqual([
        operation === "rename"
          ? { path: "People", state: "covered" }
          : { path: "HR", state: "folder-missing" },
      ]);

      const after = await pulledText(h, "ana", shareId);
      expect(after).not.toContain("HR/");
      expect(after).not.toContain("People/");
      expect(after).toBe(before);
      expect(
        (await h(request("ana", `/sync/shares/${shareId}/blobs/${sha256("published plan")}`)))
          .status,
      ).toBe(200);
      expect(
        (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "admin" })).status,
      ).toBe(200);
      const asAdmin = await pulledText(h, "ana", shareId);
      expect(asAdmin).toContain('"operation":"rename"');
      expect(asAdmin).toContain('"payloadBeforePath":"HR/layoff-plan.md"');
      expect(asAdmin).toContain('"payloadAfterPath":"Public/plan.md"');
    },
  );

  it.each(["delete", "rename"] as const)(
    "withholds a published file's hidden drafts from an Edit member after the owner %ss the folder",
    async (operation) => {
      const { h } = await seed();
      await invited(h, "ana");
      const shareId = await shareIdOf(h, "ana");
      await post(h, OWNER, `/sync/${WORKSPACE}/members/level`, { level: "edit" });
      await ownerWrite(h, "Public/notes.md", "notes v1");
      await ownerWrite(h, "Public/notes.md", "notes v2");
      const marker = folderMarkerText(await ownerRule(h, "HR", ""), 1);
      await ownerWrite(h, "HR/layoff-plan.md", "SECRET DRAFT v1");
      await ownerWrite(h, "HR/layoff-plan.md", "published plan");
      await ownerRename(h, "HR/layoff-plan.md", "Public/plan.md");
      // The folder holds only its marker now; a rename takes it along.
      if (operation === "rename") await ownerWrite(h, "People/.dohc-access", marker);
      await ownerDelete(h, "HR/.dohc-access");

      const pulled = await pulledText(h, "ana", shareId);
      expect(pulled).not.toContain("HR/");
      expect(pulled).not.toContain(sha256("SECRET DRAFT v1"));
      expect(pulled).toContain('"reachMove":"arrival"');
      const blob = async (text: string) =>
        (await h(request("ana", `/sync/shares/${shareId}/blobs/${sha256(text)}`))).status;
      expect(await blob("SECRET DRAFT v1")).toBe(404);
      expect(await blob("published plan")).toBe(200);
      // A path the member could see keeps its full history at Edit.
      expect(pulled).toContain(`"payloadBeforeBlobSha256":"${sha256("notes v1")}"`);
      expect(await blob("notes v1")).toBe(200);
    },
  );

  it("gives an Edit member each file once at its current path after the owner opens a hidden folder", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    await post(h, OWNER, `/sync/${WORKSPACE}/members/level`, { level: "edit" });
    await ownerRule(h, "HR", "");
    await ownerWrite(h, "HR/a.md", "kept");
    await ownerRename(h, "HR/a.md", "HR/b.md");
    await ownerRule(h, "HR", null);

    const ops = (await json(await pull(h, "ana", shareId))).ops as Array<{
      opKind: string;
      payload: Record<string, unknown>;
    }>;
    const text = JSON.stringify(ops);
    expect(text).not.toContain("HR/a.md");
    expect(text).toContain('"path":"HR/b.md"');
    // The engine moves an object only on a rename, so a write never names a
    // second path for an object it already holds.
    const held = new Map<unknown, unknown>();
    for (const { opKind, payload } of ops) {
      if (opKind !== "moment.append") continue;
      const path = payload.payloadAfterPath ?? payload.path;
      if (payload.operation === "write" && held.has(payload.objectId))
        expect(held.get(payload.objectId)).toBe(path);
      if (payload.operation === "delete") held.delete(payload.objectId);
      else held.set(payload.objectId, path);
    }
    expect([...held.values()]).toContain("HR/b.md");
  });

  it("serves a readable Group without naming its hidden folder", async () => {
    const { h } = await seed();
    await ownerWrite(h, "team/welcome.md", "welcome");
    await ownerRule(h, "private/restricted", "");
    await ownerAppend(h, [
      logOp(
        "chat.channel.create",
        chatChannelCreate(LATER_GROUP, {
          channelId: "chan-later",
          name: "Discussion",
          slug: "discussion",
          kind: "channel",
          type: "both",
          purpose: "",
          folderPath: "private/restricted",
        }).payload,
      ),
    ]);
    const ana = await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    const asMember = await pulledText(h, "ana", shareId);
    expect(asMember).toContain("Discussion");
    expect(asMember).not.toContain("private/restricted");
    expect(asMember).toContain('"folderPath":"team"');
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "admin" })).status,
    ).toBe(200);
    expect(await pulledText(h, "ana", shareId)).toContain('"folderPath":"private/restricted"');
  });

  it("withholds a Group's obsolete folder path after its hidden folder is renamed", async () => {
    const { h } = await seed();
    const marker = folderMarkerText(await ownerRule(h, "private", ""), 1);
    await ownerWrite(h, "private/secret.md", "PRIVATE CONTENT");
    await ownerAppend(h, [
      logOp(
        "chat.channel.create",
        chatChannelCreate(LATER_GROUP, {
          channelId: "chan-later",
          name: "Discussion",
          slug: "discussion",
          kind: "channel",
          type: "both",
          purpose: "",
          folderPath: "private",
        }).payload,
      ),
    ]);
    const ana = await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    expect(await pulledText(h, "ana", shareId)).not.toContain("private");

    await ownerWrite(h, "team-only/.dohc-access", marker);
    await ownerRename(h, "private/secret.md", "team-only/secret.md");
    await ownerDelete(h, "private/.dohc-access");

    const asMember = await pulledText(h, "ana", shareId);
    expect(asMember).toContain("Discussion");
    expect(asMember).not.toContain("private");
    expect(asMember).not.toContain("team-only");

    const ownerLog = await h(request(OWNER, `/sync/${WORKSPACE}/log?since=0&limit=500`));
    expect(ownerLog.status).toBe(200);
    expect(JSON.stringify((await json(ownerLog)).ops)).toContain('"folderPath":"private"');
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "admin" })).status,
    ).toBe(200);
    expect(await pulledText(h, "ana", shareId)).toContain('"folderPath":"private"');
  });

  it("changes a member's page signature only when their reach changes, and marks moves across it in the pull", async () => {
    const { h, storage } = await seed();
    const ana = await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    await ownerRule(h, "view", "members: view\n");
    await ownerRule(h, "same", "members: comment\n");
    await ownerWrite(h, "docs/a.md", "a");
    await ownerWrite(h, "docs/b.md", "b");
    await ownerWrite(h, "docs/c.md", "c");
    // A rule on a case twin hides `hide/` too.
    await ownerRule(h, "Hide", "");
    await ownerWrite(h, "hide/d.md", "d");
    // Only `Edit/`'s own rule raises its level; its twin `edit/` keeps the default.
    await ownerRule(h, "Edit", "members: edit\n");
    await ownerWrite(h, "Edit/e.md", "e");
    // Each page, a Group pull's included, carries the same signature.
    const read = async () => {
      const [files, group] = await Promise.all([
        pull(h, "ana", shareId),
        pull(h, "ana", shareId, GROUP),
      ]);
      expect(files.status, await files.clone().text()).toBe(200);
      expect(group.status).toBe(200);
      const [body, groupBody] = [await json(files), await json(group)];
      const signature = (body.reach as { signature: string }).signature;
      expect(signature).toMatch(/^[0-9a-f]{64}$/);
      expect((groupBody.reach as { signature: string }).signature).toBe(signature);
      const marks = (body.ops as Array<{ reachMove?: string; payload: { path: string } }>).flatMap(
        (op) => (op.reachMove ? [[op.reachMove, op.payload.path]] : []),
      );
      return { signature, marks };
    };
    let last = await read();
    const expectStep = async (changed: boolean, step: string, mark?: [string, string]) => {
      const next = await read();
      if (changed) expect(next.signature, step).not.toBe(last.signature);
      else expect(next.signature, step).toBe(last.signature);
      expect(next.marks, step).toEqual([...last.marks, ...(mark ? [mark] : [])]);
      last = next;
    };
    await ownerWrite(h, "docs/a.md", "edited");
    await expectStep(false, "content edit");
    await ownerRename(h, "docs/a.md", "docs/moved/a.md");
    await expectStep(false, "move within one rule");
    await ownerRename(h, "docs/b.md", "same/b.md");
    await expectStep(false, "move across rules at the same level");
    await ownerRename(h, "docs/c.md", "view/c.md");
    await expectStep(false, "move across rules to another level");
    await ownerRename(h, "hide/d.md", "docs/d.md");
    await expectStep(false, "move out of a case twin's hidden folder", ["arrival", "docs/d.md"]);
    await ownerRename(h, "Edit/e.md", "edit/e.md");
    await expectStep(false, "move from a ruled folder to its case twin");
    await ownerRename(h, "docs/moved/a.md", "Hide/a.md");
    await expectStep(false, "move into a hidden folder", ["departure", "docs/moved/a.md"]);
    await ownerRule(h, "plain", "members: comment\n");
    await expectStep(false, "a rule that gives the level its folder already has");
    await ownerRule(h, "Hide/inner", "members: edit\n");
    await expectStep(false, "a rule inside a hidden folder");
    // A rename in another Version leaves main's reach alone.
    const context = storage as StorageContext;
    context.tx(() =>
      context.db
        .prepare(
          "INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES (?,?,?,?,?,?)",
        )
        .run(
          WORKSPACE,
          "fork-origin",
          1,
          "moment.append",
          JSON.stringify({
            versionId: "draft",
            operation: "rename",
            objectId: "object-x",
            momentId: "m-fork",
            path: "view/x.md",
            payloadBeforePath: "docs/x.md",
            payloadAfterPath: "view/x.md",
          }),
          1,
        ),
    );
    await expectStep(false, "rename in a fork");
    await ownerRule(h, "view", "members: edit\n");
    await expectStep(true, "a rule that changes a level");
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/level`, { level: "edit" })).status,
    ).toBe(200);
    await expectStep(true, "member level change");
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "admin" })).status,
    ).toBe(200);
    const admin = await read();
    expect(admin.signature, "role change").not.toBe(last.signature);
    // An admin reaches every folder, so no move crosses their edge.
    expect(admin.marks).toEqual([]);
  });

  it("changes the visibility signature only when what a member reaches or where they read History changes, and lists both on every pull page", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    const teamRuleId = await ownerRule(h, "team", "members: comment\n");
    await ownerWrite(h, "team/a.md", "a");
    await ownerRule(h, "view", "members: view\n");
    await ownerWrite(h, "view/b.md", "b");
    await ownerRule(h, "closed", "");
    await ownerRule(h, "shut", "");
    const signatures = async () => {
      // Each page reads the reach in its own transaction, a Group pull's too.
      const [files, group] = await Promise.all(
        [undefined, GROUP].map(async (wireId) => {
          const page = await pull(h, "ana", shareId, wireId);
          expect(page.status).toBe(200);
          return (await json(page)).reach as { signature: string; visibilitySignature: string };
        }),
      );
      expect(group).toEqual(files);
      expect(files!.visibilitySignature).toMatch(/^[0-9a-f]{64}$/);
      return { signature: files!.signature, visibilitySignature: files!.visibilitySignature };
    };
    let last = await signatures();
    const expectChanged = async (step: string, signature: boolean, visibility: boolean) => {
      const next = await signatures();
      expect(next.signature !== last.signature, `${step}: signature`).toBe(signature);
      expect(next.visibilitySignature !== last.visibilitySignature, `${step}: visibility`).toBe(
        visibility,
      );
      last = next;
    };
    await ownerWrite(h, "team/a.md", "edited");
    await expectChanged("content edit", false, false);
    await ownerRule(h, "team", "members: view\n");
    await expectChanged("level-only rule change", true, false);
    // History needs Edit, so the copy rebuilds when Edit starts or stops.
    await ownerRule(h, "team", "members: edit\n");
    await expectChanged("promotion to Edit", true, true);
    await ownerRule(h, "team", "members: view\n");
    await expectChanged("demotion below Edit", true, true);
    await ownerRule(h, "team", "");
    await expectChanged("hiding a folder", true, true);
    await ownerRule(h, "team", "members: edit\n");
    await expectChanged("revealing a folder", true, true);
    await ownerRule(h, "empty", "");
    await expectChanged("hiding a folder with no other files", true, true);
    // A copy of an Edit rule's marker in a hidden folder's case twin changes no
    // reach: the twin hides it.
    await ownerWrite(h, "EMPTY/.dohc-access", folderMarkerText(teamRuleId, 1));
    const twin = await signatures();
    expect(twin.visibilitySignature, "a hidden folder's twin with a rule").toBe(
      last.visibilitySignature,
    );
    last = twin;
    // A move changes no reach: the listed levels already place the moved file,
    // and a move across the edge is marked in the pull.
    await ownerRename(h, "team/a.md", "view/a.md");
    await expectChanged("move between two levels", false, false);
    await ownerRename(h, "view/b.md", "closed/b.md");
    await expectChanged("move into a hidden folder", false, false);
    expect(await pulledText(h, "ana", shareId)).toContain('"reachMove":"departure"');
    await ownerRename(h, "closed/b.md", "shut/b.md");
    await expectChanged("move between hidden folders", false, false);
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/level`, { level: "edit" })).status,
    ).toBe(200);
    await expectChanged("member level change to Edit", true, true);
    // A held read that ends on a changed level lists the reach too.
    const ended = await h(
      request("ana", `/sync/shares/${shareId}/log?since=0&limit=10&hold=5000&level=comment`),
    );
    expect(ended.status).toBe(200);
    expect(await json(ended)).toMatchObject({ levelChanged: true, reach: last });
  });

  it("names the log's head on each member page, past the ops the page holds", async () => {
    const { h, storage } = await seed();
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    await ownerWrite(h, "docs/a.md", "a");
    await ownerWrite(h, "docs/b.md", "b");
    // The member never sees the rule's marker, but the head counts it.
    await ownerRule(h, "closed", "");
    await ownerWrite(h, "closed/c.md", "c");
    const context = storage as StorageContext;
    const head = () =>
      Number(
        context.db
          .prepare("SELECT MAX(relay_seq) AS head FROM sync_relay_log WHERE workspace_id = ?")
          .get(WORKSPACE)!.head,
      );
    const page = async (query: string, channelWireId?: string) => {
      const wire = channelWireId === undefined ? "" : `&channelWireId=${channelWireId}`;
      const response = await h(request("ana", `/sync/shares/${shareId}/log?${query}${wire}`));
      expect(response.status, await response.clone().text()).toBe(200);
      return (await json(response)) as {
        logHead: number;
        nextCursor: number;
        hasMore: boolean;
        ops: Array<{ relaySeq: number }>;
      };
    };
    const first = await page("since=0&limit=1");
    expect(first.hasMore).toBe(true);
    expect(first.logHead).toBe(head());
    expect(first.ops.every((op) => op.relaySeq <= first.logHead)).toBe(true);
    expect(first.nextCursor).toBeLessThan(first.logHead);
    expect((await page("since=0&limit=1", GROUP)).logHead).toBe(head());
    const before = head();
    await ownerWrite(h, "closed/d.md", "d");
    expect(head()).toBeGreaterThan(before);
    expect((await page(`since=${first.nextCursor}&limit=500`)).logHead).toBe(head());
  });

  it("lists the ruled folders where a member's level differs from its parent's, and no hidden one", async () => {
    const { h } = await seed();
    const ana = await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    const ruleIds = new Map<string, string>();
    for (const [folder, rule] of [
      ["same", "members: comment\n"],
      ["view", "members: view\n"],
      ["view/edit", "members: edit\n"],
      ["view/same", "members: view\n"],
      ["private", ""],
      ["private/open", "members: edit\n"],
      ["Team", "members: edit\n"],
      ["Docs", "members: edit\n"],
      // A ruled folder lists with no other file in it.
      ["empty", "members: view\n"],
    ])
      ruleIds.set(folder!, await ownerRule(h, folder!, rule!));
    // A case twin holding a copy of a rule's marker shares that rule, and the
    // two are listed apart.
    await ownerWrite(h, "TEAM/.dohc-access", folderMarkerText(ruleIds.get("Team")!, 1));
    // A twin whose marker names no rule hides, and hides its twin too.
    await ownerWrite(h, "DOCS/.dohc-access", folderMarkerText(`fr_${"0".repeat(32)}`, 1));
    await ownerWrite(h, "team/unruled.md", "a twin with no rule takes its parent's level");
    const inventory = async () => {
      const response = await pull(h, "ana", shareId);
      expect(response.status, await response.clone().text()).toBe(200);
      return (await json(response)).reach as Record<string, unknown>;
    };
    const listed = await inventory();
    expect(listed.rootLevel).toBe("comment");
    expect(listed.folders).toEqual([
      { path: "TEAM", level: "edit" },
      { path: "Team", level: "edit" },
      { path: "empty", level: "view" },
      { path: "view", level: "view" },
      { path: "view/edit", level: "edit" },
    ]);
    expect(JSON.stringify(listed)).not.toContain("private");
    expect(JSON.stringify(listed)).not.toContain("Docs");
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "admin" })).status,
    ).toBe(200);
    const admin = await inventory();
    expect(admin.rootLevel).toBe("edit");
    expect(admin.folders).toEqual([]);
  });

  it("checks proposals, pages and Comments at the folder target, including hidden and folded ancestors", async () => {
    const { h, storage } = await seed();
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    await post(h, OWNER, `/sync/${WORKSPACE}/members/level`, { level: "edit" });
    await ownerRule(h, "private", "");
    await ownerWrite(h, "private/deep/secret.md", "hidden");
    await ownerRule(h, "view", "members: view\n");
    await ownerWrite(h, "view/file.md", "readable");
    await ownerRule(h, "other", "members: edit\n");
    await ownerWrite(h, "other/file.md", "editable");
    const text = "my change",
      hash = sha256(text);
    expect((await uploadBlob(h, "ana", shareId, text)).status).toBe(200);
    const change = (
      before: string | null,
      after: string | null,
      base: string | null = before ? sha256("hidden") : null,
    ) => ({
      basedOnPath: before,
      basedOnBlobSha256: base,
      operation: after === null ? "delete" : "write",
      afterPath: after,
      afterBlobSha256: after === null ? null : hash,
      afterContentKind: after === null ? null : "text",
      afterByteLength: after === null ? null : text.length,
      recordedAtMs: 20,
    });
    const proposal = (op: unknown, id: string) =>
      post(h, "ana", `/sync/shares/${shareId}/proposals`, { submitId: id, ops: [op] });
    const hidden = await proposal(
      change("private/deep/secret.md", "private/deep/secret.md"),
      "hidden",
    );
    const missing = await proposal(change("missing.md", "missing.md"), "missing");
    expect(hidden.status).toBe(403);
    expect(await hidden.text()).toBe(await missing.clone().text());
    expect(
      (await proposal(change("view/file.md", "view/file.md", sha256("readable")), "view")).status,
    ).toBe(403);
    const allowed = await proposal(
      change("docs/plan.md", "docs/plan.md", sha256("the plan")),
      "allowed",
    );
    expect(allowed.status, await allowed.clone().text()).toBe(200);
    const moved = await proposal(
      change("docs/plan.md", "other/moved.md", sha256("the plan")),
      "moved",
    );
    expect(await moved.json()).toMatchObject({
      code: "share_op_rejected",
      error: "Ask the owner to move this.",
    });
    // A ruled folder's case twin is its own boundary.
    const twin = await proposal(
      change("other/file.md", "Other/file.md", sha256("editable")),
      "twin",
    );
    expect(await twin.json()).toMatchObject({
      code: "share_op_rejected",
      error: "Ask the owner to move this.",
    });
    // A move with a hidden end gets the plain refusal, so it can't find where hidden rules are.
    await ownerRule(h, "private/deep", "members: edit\n");
    for (const [from, to] of [
      ["private/x.md", "x.md"],
      ["private/deep/x.md", "private/x.md"],
      ["docs/plan.md", "private/plan.md"],
    ]) {
      const probe = await proposal(change(from, to, sha256("the plan")), `probe-${from}-${to}`);
      expect(probe.status).toBe(403);
      expect(await probe.text()).toBe(await missing.clone().text());
    }
    // A new folder under a reachable one is ordinary work: a proposal may create
    // it, and a page there meets only the existing admin-only folder rule.
    const fresh = await proposal(change(null, "docs/fresh/new.md"), "fresh");
    expect(fresh.status, await fresh.clone().text()).toBe(200);
    const page = await post(h, "ana", `/sync/shares/${shareId}/collection-writes`, {
      submitId: "page",
      changes: [change(null, "docs/fresh/page.md")],
    });
    expect(await page.json()).toMatchObject({ error: "an op is outside this share" });
    for (const path of ["private/new.md", "private/deep/more/new.md", "PRIVATE/deep/new.md"]) {
      const response = await post(h, "ana", `/sync/shares/${shareId}/collection-writes`, {
        submitId: path,
        changes: [change(null, path)],
      });
      expect(response.status, path).toBe(403);
      expect(await response.json()).toMatchObject({ error: "can't create here" });
    }
    for (const path of ["private/deep/secret.md", "missing.md"]) {
      const response = await post(h, "ana", `/sync/shares/${shareId}/log`, {
        originId: `comment-${path}`,
        ops: [
          {
            originSeq: 0,
            opKind: "chat.thread.create",
            recordedAtMs: 20,
            payload: { threadId: path, title: "", createdAtMs: 20, linkedPath: path },
          },
        ],
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "share_op_rejected" });
    }
    for (const path of ["docs/.dohc-access", "docs/.DOHC-ACCESS", ".dohc-access"]) {
      expect((await proposal(change(null, path), path)).status).toBe(403);
    }
    const authorization = authorizeShareAction({
      storage,
      actorUserId: "ana",
      shareId,
      action: "propose",
    });
    expect(authorization.ok).toBe(true);
    if (!authorization.ok) throw new Error("missing member authorization");
    expect(
      filterProposedChangeForShare(
        authorization.effectiveSelector,
        change("other/file.md", "other/file.md", sha256("editable")),
      ).allowed,
    ).toBe(true);
    await ownerRule(h, "other", "");
    expect(() =>
      storage.insertShareProposal({
        proposalId: "late",
        shareId,
        workspaceId: WORKSPACE,
        proposedByUserId: "ana",
        versionId: "main",
        submitId: "late",
        createdAtMs: 30,
        ops: [
          {
            ...change("other/file.md", "other/file.md", sha256("editable")),
            operation: "write",
            afterContentKind: "text",
            opIndex: 0,
            basedOnObjectId: "object-other/file.md",
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "share_op_rejected" }));
  });

  it("lets a folder grant Edit above the workspace default and rate limits create probes per member", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    await ownerRule(h, "docs", "members: edit\n");
    await ownerRule(h, "private", "");
    const text = "a page";
    expect((await uploadBlob(h, "ana", shareId, text)).status).toBe(200);
    const changes = (path: string) => [
      {
        basedOnPath: null,
        basedOnBlobSha256: null,
        operation: "write",
        afterPath: path,
        afterBlobSha256: sha256(text),
        afterContentKind: "text",
        afterByteLength: text.length,
        recordedAtMs: 20,
      },
    ];
    // Allowed creates cost nothing, however many one proposal holds.
    const many = Array.from({ length: 40 }, (_, index) => changes(`docs/new-${index}.md`)[0]);
    const pages = await post(h, "ana", `/sync/shares/${shareId}/proposals`, {
      submitId: "pages",
      ops: many,
    });
    expect(pages.status, await pages.clone().text()).toBe(200);
    for (let index = 0; index < 30; index++) {
      expect(
        (
          await post(h, "ana", `/sync/shares/${shareId}/proposals`, {
            submitId: `probe-${index}`,
            ops: changes("private/page.md"),
          })
        ).status,
      ).toBe(403);
    }
    const limited = await post(h, "ana", `/sync/shares/${shareId}/proposals`, {
      submitId: "limited",
      ops: changes("private/page.md"),
    });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "share_access_rate_limited" });
    // A visible create waits too, so the 429 says nothing about which paths are hidden.
    const visible = await post(h, "ana", `/sync/shares/${shareId}/proposals`, {
      submitId: "visible",
      ops: changes("docs/after.md"),
    });
    expect(visible.status).toBe(429);
    expect(await visible.json()).toMatchObject({ code: "share_access_rate_limited" });
  });

  it("scrubs a workspace notice and downgrades file presence after folder access changes", async () => {
    const { h, storage } = await seed();
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    await post(h, OWNER, `/sync/${WORKSPACE}/members/level`, { level: "edit" });
    const response = await post(h, OWNER, "/sync/notices", {
      noticeId: "mention-folder",
      recipientUserId: "ana",
      workspaceId: WORKSPACE,
      kind: "automation-failed",
      title: "SENTINEL title",
      body: "SENTINEL body",
      target: { path: "docs/plan.md" },
      originInstallId: "owner-install",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const notices = () => h(request("ana", "/sync/notices"));
    expect(await (await notices()).text()).toContain("SENTINEL title");
    const presence = (as: string) =>
      h(request(as, `/sync/shares/${shareId}/presence?topic=docs%2Fplan.md&hold=0`));
    const publish = await post(h, "ana", `/sync/shares/${shareId}/presence?topic=docs%2Fplan.md`, {
      clientId: "ana-client",
      state: { editing: true },
    });
    expect(publish.status).toBe(200);
    await ownerRule(h, "docs", "members: view\n");
    expect((await presence("ana")).status).toBe(200);
    expect((await commentOnFile(h, "ana", shareId)).status).toBe(403);
    await ownerRule(h, "docs", "");
    expect((await presence("ana")).status).toBe(404);
    const scrubbed = await notices();
    expect(await scrubbed.text()).not.toContain("SENTINEL");
    const row = (storage as StorageContext).db
      .prepare(
        "SELECT title,body,target_json FROM sync_relay_notices WHERE recipient_user_id=? AND title='No longer available' AND body='' AND target_json IS NULL",
      )
      .get("ana");
    expect(row).toBeDefined();
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

  it("lists and withdraws only a member's own proposals, though every member holds the same share", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    await invited(h, "ben");
    const shareId = await shareIdOf(h, "ana");
    expect(await shareIdOf(h, "ben")).toBe(shareId);
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/level`, { level: "edit" })).status,
    ).toBe(200);
    expect((await uploadBlob(h, "ana", shareId, "ana's edit")).status).toBe(200);
    const submit = (userId: string) =>
      post(h, userId, `/sync/shares/${shareId}/proposals`, {
        submitId: "submit-ana",
        ops: [
          {
            basedOnPath: "docs/plan.md",
            basedOnBlobSha256: sha256("the plan"),
            operation: "write",
            afterPath: "docs/plan.md",
            afterBlobSha256: sha256("ana's edit"),
            afterContentKind: "text",
            afterByteLength: "ana's edit".length,
            recordedAtMs: 9000,
          },
        ],
      });
    const submitted = await submit("ana");
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    const { proposalId } = (await json(submitted)) as { proposalId: string };

    const listed = async (userId: string) =>
      (
        (await json(await h(request(userId, `/sync/shares/${shareId}/proposals`))))
          .proposals as Array<{
          proposalId: string;
        }>
      ).map((proposal) => proposal.proposalId);
    expect(await listed("ana")).toEqual([proposalId]);
    expect(await listed("ben")).toEqual([]);
    // Ana's submit id from Ben is not a resend of Ana's proposal.
    expect((await submit("ben")).status).toBe(409);

    const withdrawn = (userId: string) =>
      post(h, userId, `/sync/shares/${shareId}/proposals/${proposalId}/withdraw`);
    expect((await withdrawn("ben")).status).toBe(404);
    expect(await listed("ana")).toEqual([proposalId]);
    expect((await withdrawn("ana")).status).toBe(200);
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
    // A member reaches Members by the workspace's id, as the owner does.
    expect(await json(response)).toMatchObject({
      shareId,
      workspaceId: WORKSPACE,
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

  // The owner's own listing, which About's Access and `dohc access object` read, names each member's role as the Members page does.
  it("names each membership's role in the owner's listing", async () => {
    const { h } = await seed();
    const ana = await invited(h, "ana");
    await invited(h, "ben");
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "admin" })).status,
    ).toBe(200);
    const listing = await json(await h(request(OWNER, `/sync/shares?workspaceId=${WORKSPACE}`)));
    const memberships = (listing.granted as Array<Record<string, unknown>>).filter(
      (row) => (row.selector as { kind?: string } | null)?.kind === "workspace",
    );
    expect(
      memberships.map((row) => [row.recipientUserId, row.selector, row.access]).sort(),
    ).toEqual([
      ["ana", { kind: "workspace", role: "admin" }, "edit"],
      ["ben", { kind: "workspace", role: "member" }, "comment"],
    ]);
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
    // Each person keeps the colour their account has in presence and direct messages.
    const anaEntry = member.people[1]!;
    expect(anaEntry.memberId).not.toBe("ana");
    expect(member.people.map((person) => person.paletteSlot)).toEqual([
      actorHueSlot(OWNER),
      actorHueSlot("ana"),
    ]);
    // An invite has no account yet, so its colour comes from its entry.
    const pendingEntry = (await membersView(h, OWNER)).people.find(
      (person) => person.state === "invited",
    )!;
    expect(pendingEntry.paletteSlot).toBe(actorHueSlot(pendingEntry.memberId));

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

  it("answers an admin's Members read with the role they hold when it ends, not when it began", async () => {
    // The admin's read pauses at its first email lookup while the owner acts.
    let pause: (() => Promise<void>) | null = null;
    const { h } = await seed({
      overrides: {
        lookupUserEmail: async (userId: string) => {
          const wait = pause;
          pause = null;
          await wait?.();
          return `${userId}@dohc.test`;
        },
      },
    });
    const ana = await invited(h, "ana");
    await invited(h, "ben");
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "admin" })).status,
    ).toBe(200);
    expect(await inviteLink(h, "ana", "turn-on")).not.toBeNull();

    async function readWhile(change: () => Promise<Response>): Promise<Response> {
      let reached!: () => void;
      const paused = new Promise<void>((resolve) => (reached = resolve));
      let resume!: () => void;
      pause = () => {
        reached();
        return new Promise<void>((resolve) => (resume = resolve));
      };
      const read = h(request("ana", `/sync/${WORKSPACE}/members`));
      await paused;
      expect((await change()).status).toBe(200);
      resume();
      return read;
    }

    const demoted = await readWhile(() =>
      post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "member" }),
    );
    expect(demoted.status).toBe(200);
    const view = (await demoted.json()) as WorkspaceMembersView;
    expect(view.viewer.role).toBe("member");
    expect(view.inviteLink).toBeNull();
    expect(view.people.every((person) => person.email === null)).toBe(true);

    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "admin" })).status,
    ).toBe(200);
    const removed = await readWhile(() =>
      post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/remove`),
    );
    expect(removed.status).toBe(404);
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

describe("a Group's rule", () => {
  function setRule(h: SyncRelayHandler, as: string, wireId: string, body: unknown) {
    return h(
      request(as, `/sync/${WORKSPACE}/members/groups/${wireId}/rule`, {
        ...jsonBody(body),
        method: "PUT",
      }),
    );
  }
  async function ruled(h: SyncRelayHandler, as: string, wireId: string, level: unknown) {
    const response = await setRule(h, as, wireId, { level });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as WorkspaceMembersView;
  }
  async function admin(h: SyncRelayHandler, userId: string) {
    const memberId = await invited(h, userId);
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${memberId}/role`, { role: "admin" }))
        .status,
    ).toBe(200);
    return memberId;
  }
  async function visibility(h: SyncRelayHandler, userId: string, shareId: string) {
    const page = await pull(h, userId, shareId);
    expect(page.status).toBe(200);
    return ((await json(page)).reach as { visibilitySignature: string }).visibilitySignature;
  }

  it("is set by the owner and an admin, never a member, and only on an ordinary Group", async () => {
    const { h } = await seed();
    await admin(h, "ben");
    await invited(h, "ana");
    expect((await ruled(h, OWNER, GROUP, "view")).groupRules).toEqual([
      { channelWireId: GROUP, level: "view" },
    ]);
    expect((await ruled(h, "ben", GROUP, "none")).groupRules).toEqual([
      { channelWireId: GROUP, level: "none" },
    ]);
    // A member is refused as a missing Group is, so a refusal confirms nothing.
    const refused = await setRule(h, "ana", GROUP, { level: "comment" });
    expect(refused.status).toBe(404);
    for (const wireId of [GENERAL_CHANNEL_WIRE_ID, DM, AGENT, UNKNOWN]) {
      expect((await setRule(h, OWNER, wireId, { level: "view" })).status, wireId).toBe(404);
    }
    // A rule names one level for every member, never a person.
    for (const body of [
      { level: "edit" },
      { level: "ana@dohc.test" },
      { level: "view", people: { "ana@dohc.test": "edit" } },
      { rule: "members: view\npeople:\n  ana@dohc.test: edit\n" },
    ]) {
      expect((await setRule(h, OWNER, GROUP, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await membersView(h, OWNER)).groupRules).toEqual([
      { channelWireId: GROUP, level: "none" },
    ]);
    // It names hidden Groups, so a member never reads it.
    expect((await membersView(h, "ana")).groupRules).toBeNull();
    // Clearing keeps the row, and the Group takes the member level again.
    expect((await ruled(h, OWNER, GROUP, null)).groupRules).toEqual([]);
  });

  it("withholds a hidden Group from a member's pull, posts, and presence, and View refuses only that Group's posts", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    await ownerAppend(h, [
      channel(LATER_GROUP, "later"),
      thread("t-later", LATER_GROUP, "later"),
      message("msg-later", "t-later", "another group"),
    ]);
    await ruled(h, OWNER, GROUP, "view");
    const viewOnly = await postInGroup(h, "ana", shareId, "m-view");
    // The member posts elsewhere, so the filter refuses this Group's op.
    expect(viewOnly.status).toBe(403);
    expect(await code(viewOnly)).toBe("share_op_rejected");
    const elsewhere = await post(h, "ana", `/sync/shares/${shareId}/log`, {
      originId: "origin-ana-later",
      ops: [
        {
          ...logOp(
            "chat.message.append",
            chatMessageAppend("m-later", "t-later", "hello", { authorUserId: "ana" }).payload,
          ),
          originSeq: 0,
        },
      ],
    });
    expect(elsewhere.status, await elsewhere.clone().text()).toBe(200);

    await ruled(h, OWNER, GROUP, "none");
    const all = await pulledText(h, "ana", shareId);
    expect(all).not.toContain(GROUP);
    expect(all).not.toContain("t-team");
    expect(all).not.toContain("welcome to the team");
    expect(all).toContain("another group");
    expect((await pull(h, "ana", shareId, GROUP)).status).toBe(404);
    expect((await postInGroup(h, "ana", shareId, "m-none", 1)).status).toBe(403);
    for (const topic of [GROUP, "chat:thread:t-team"]) {
      const presence = await h(
        request(
          "ana",
          `/sync/shares/${shareId}/presence?topic=${encodeURIComponent(topic)}&hold=0`,
        ),
      );
      expect(presence.status, topic).toBe(404);
    }
  });

  it("never serves a Group created as No access, and clearing its rule rebuilds a member's copy with its history", async () => {
    const { h } = await seed();
    await admin(h, "ben");
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    const before = await visibility(h, "ana", shareId);
    const created = await post(h, "ben", "/sync/members/groups", {
      shareId: await shareIdOf(h, "ben"),
      name: "Staff",
      level: "none",
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const { channelWireId } = (await json(created)) as { channelWireId: string };
    await ownerAppend(h, [
      thread("t-staff", channelWireId, "staff"),
      message("msg-staff", "t-staff", "STAFF ONLY"),
    ]);
    // The member pulls past the Group without it, and creating it hidden rebuilds nothing.
    const page = await pull(h, "ana", shareId);
    const pulled = await json(page);
    expect(JSON.stringify(pulled.ops)).not.toContain(channelWireId);
    expect(JSON.stringify(pulled.ops)).not.toContain("STAFF ONLY");
    expect(await visibility(h, "ana", shareId)).toBe(before);
    expect(
      (
        await h(
          request(
            "ana",
            `/sync/shares/${shareId}/log?since=${pulled.nextCursor as number}&limit=500`,
          ),
        )
      ).status,
    ).toBe(200);

    // Clearing the rule shows the Group: the signature changes, so the copy
    // pulls fresh and gets the create and messages its cursor passed.
    await ruled(h, "ben", channelWireId, null);
    expect(await visibility(h, "ana", shareId)).not.toBe(before);
    const rebuilt = await pulledText(h, "ana", shareId);
    expect(rebuilt).toContain(channelWireId);
    expect(rebuilt).toContain("STAFF ONLY");
  });

  it("lets the owner create a hidden Group before anyone is invited, and refuses anyone else", async () => {
    const { h } = await seed();
    expect(
      (await post(h, "zed", "/sync/members/groups", { workspaceId: WORKSPACE, name: "Board" }))
        .status,
    ).toBe(404);
    const created = await post(h, OWNER, "/sync/members/groups", {
      workspaceId: WORKSPACE,
      name: "Board",
      level: "none",
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const { channelWireId } = (await json(created)) as { channelWireId: string };
    await invited(h, "ana");
    expect(await pulledText(h, "ana", await shareIdOf(h, "ana"))).not.toContain(channelWireId);
  });

  it("wakes held reads when a rule changes", async () => {
    const activity = new DiscussionActivityHub();
    const woken: string[] = [];
    const wakeLog = activity.wakeLog.bind(activity);
    activity.wakeLog = (workspaceId: string) => {
      woken.push(workspaceId);
      wakeLog(workspaceId);
    };
    const { h } = await seed({ activity });
    await invited(h, "ana");
    // The invite wakes them too, so only wakes after it count.
    woken.length = 0;
    await ruled(h, OWNER, GROUP, "none");
    expect(woken).toContain(WORKSPACE);
  });
});

describe("the invite link", () => {
  it("lets people join, and resetting or turning it off keeps everyone who joined", async () => {
    const { h, storage } = await seed();
    const first = await inviteLink(h, OWNER, "turn-on");
    expect(first).not.toBeNull();

    const preview = await post(h, "cara", "/sync/members/join-preview", { token: first });
    expect(await json(preview)).toEqual({
      workspaceName: "Community",
      ownerName: "Name owner",
      alreadyMember: false,
      grantId: null,
    });
    const joined = await join(h, "cara", first!);
    expect(joined.status).toBe(200);
    const caraShare = await shareIdOf(h, "cara");
    // The answer names the person's own grant, which opens the workspace in a browser.
    const caraGrant = storage.listActiveShareGrantsForRecipient(caraShare, "cara")[0]!.grantId;
    expect(await json(joined)).toEqual({
      workspaceId: WORKSPACE,
      shareId: caraShare,
      workspaceName: "Community",
      grantId: caraGrant,
    });
    expect(await json(await join(h, "cara", first!))).toMatchObject({ grantId: caraGrant });
    expect(
      await json(await post(h, "cara", "/sync/members/join-preview", { token: first })),
    ).toEqual({
      workspaceName: "Community",
      ownerName: "Name owner",
      alreadyMember: true,
      grantId: caraGrant,
    });
    expect(
      await json(await post(h, OWNER, "/sync/members/join-preview", { token: first })),
    ).toMatchObject({ alreadyMember: true, grantId: null });

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
      // The access check that follows names who changed it.
      expect(await json(await h(request("ana", `/sync/shares/${shareId}/access`)))).toEqual({
        status: "current",
        access: "view",
        role: "member",
        levelChangedBy: `Name ${OWNER}`,
      });
      const after = await pull(h, "ana", shareId);
      expect(after.status).toBe(200);
      expect(await json(after)).not.toHaveProperty("levelChanged");
    } finally {
      controller.abort();
      await held.catch(() => undefined);
    }
  });

  it("reads a held levelChanged answer's reach and log head in one transaction", async () => {
    const activity = new DiscussionActivityHub();
    const { h, storage } = await seed({ activity });
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    const first = await json(await pull(h, "ana", shareId));
    const context = storage as StorageContext;
    const inTransaction: boolean[] = [];
    const shareLogHead = storage.shareLogHead.bind(storage);
    storage.shareLogHead = (workspaceId) => {
      inTransaction.push(context.db.isTransaction === true);
      return shareLogHead(workspaceId);
    };
    const controller = new AbortController();
    const held = h(
      request("ana", `/sync/shares/${shareId}/log?limit=500&since=${first.nextCursor}&hold=30000`, {
        signal: controller.signal,
      }),
    );
    try {
      await expect.poll(() => activity.stats().waiters).toBe(1);
      inTransaction.length = 0;
      expect(
        (await post(h, OWNER, `/sync/${WORKSPACE}/members/level`, { level: "view" })).status,
      ).toBe(200);
      const answer = await json(await held);
      expect(answer).toMatchObject({ levelChanged: true, logHead: expect.any(Number) });
      expect(inTransaction.length).toBeGreaterThan(0);
      expect(inTransaction).not.toContain(false);
    } finally {
      controller.abort();
      await held.catch(() => undefined);
    }
  });

  // A level change that lands while no read waits: the next held read says
  // the level it knew, and the relay compares that with its own record.
  it("answers a held read at once when the level it knew is not the stored level", async () => {
    const activity = new DiscussionActivityHub();
    const { h } = await seed({ activity });
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    const first = await json(await pull(h, "ana", shareId));
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/level`, { level: "edit" })).status,
    ).toBe(200);
    const read = (knew: string) =>
      h(
        request(
          "ana",
          `/sync/shares/${shareId}/log?limit=500&since=${first.nextCursor}&hold=30000&level=${knew}`,
        ),
      );
    const response = await read("comment");
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      ops: [],
      hasMore: false,
      nextCursor: first.nextCursor,
      levelChanged: true,
    });
    expect(activity.stats().waiters).toBe(0);
  });

  it.each([
    ["the stored level", "edit"],
    ["an unknown level", "owner"],
  ])("holds a read that knew %s", async (_case, knew) => {
    const activity = new DiscussionActivityHub();
    const { h } = await seed({ activity });
    await invited(h, "ana");
    const shareId = await shareIdOf(h, "ana");
    const first = await json(await pull(h, "ana", shareId));
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/level`, { level: "edit" })).status,
    ).toBe(200);
    const controller = new AbortController();
    const held = h(
      request(
        "ana",
        `/sync/shares/${shareId}/log?limit=500&since=${first.nextCursor}&hold=30000&level=${knew}`,
        { signal: controller.signal },
      ),
    );
    try {
      await expect.poll(() => activity.stats().waiters).toBe(1);
    } finally {
      controller.abort();
      await held.catch(() => undefined);
    }
  });

  it("names who changed the level from its own record, never from the request", async () => {
    const { h } = await seed();
    await invited(h, "ana");
    const kai = await invited(h, "kai");
    const shareId = await shareIdOf(h, "ana");
    const access = async () => json(await h(request("ana", `/sync/shares/${shareId}/access`)));
    // No one has changed the level yet.
    expect(await access()).toEqual({ status: "current", access: "comment", role: "member" });
    expect(
      (
        await post(h, OWNER, `/sync/${WORKSPACE}/members/level`, {
          level: "view",
          levelChangedBy: "Mallory",
          actorUserId: "kai",
        })
      ).status,
    ).toBe(200);
    expect(await access()).toEqual({
      status: "current",
      access: "view",
      role: "member",
      levelChangedBy: `Name ${OWNER}`,
    });
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${kai}/role`, { role: "admin" })).status,
    ).toBe(200);
    await shareIdOf(h, "kai");
    expect(
      (await post(h, "kai", `/sync/${WORKSPACE}/members/level`, { level: "edit" })).status,
    ).toBe(200);
    expect(await access()).toEqual({
      status: "current",
      access: "edit",
      role: "member",
      levelChangedBy: "Name kai",
    });
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

describe("folder rules", () => {
  async function created(h: SyncRelayHandler, folder: string, members: string | null) {
    const response = await post(h, OWNER, FOLDER_RULES, { folder, members, people: [] });
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as WorkspaceMembersView).folderRules!.at(-1)!;
  }

  it("lets the owner and admins set a folder's rule, and lists it for them only", async () => {
    const { h } = await seed();
    const ana = await invited(h, "ana");
    const first = await post(h, OWNER, FOLDER_RULES, {
      folder: "/docs/",
      members: "view",
      people: [{ email: "Ben@Dohc.test", level: "edit" }],
    });
    expect(first.status, await first.clone().text()).toBe(200);
    const [rule] = ((await first.json()) as WorkspaceMembersView).folderRules!;
    expect(rule).toEqual({
      ruleId: expect.stringMatching(/^fr_[0-9a-f]{32}$/u),
      revision: 1,
      members: "view",
      people: [{ email: "ben@dohc.test", level: "edit" }],
      folders: [{ path: "docs", state: "covered" }],
    });

    expect((await membersView(h, "ana")).folderRules).toBeNull();
    const refused = await post(h, "ana", FOLDER_RULES, {
      folder: "else",
      members: null,
      people: [],
    });
    expect(refused.status).toBe(403);
    expect(await code(refused)).toBe("members_forbidden");

    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "admin" })).status,
    ).toBe(200);
    const change = { ruleId: rule!.ruleId, revision: 1, members: "comment", people: [] };
    const changed = await post(h, "ana", FOLDER_RULES, change);
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(((await changed.json()) as WorkspaceMembersView).folderRules).toMatchObject([
      { revision: 2, members: "comment", people: [] },
    ]);

    // A change made from an older read would drop what the admin just set.
    const stale = await post(h, OWNER, FOLDER_RULES, change);
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({
      code: "conflict",
      error: expect.stringMatching(/changed/),
    });
    const twin = await post(h, OWNER, FOLDER_RULES, { folder: "DOCS", members: null, people: [] });
    expect(twin.status).toBe(409);
    expect(await json(twin)).toMatchObject({
      code: "conflict",
      error: expect.stringMatching(/already/),
    });
    for (const bad of [
      { folder: "../docs", members: null, people: [] },
      { folder: "docs", members: "owner", people: [] },
      { folder: "docs", members: null, people: [{ email: "nobody", level: "view" }] },
      { ruleId: "fr_1", revision: 2, clear: true },
    ]) {
      expect((await post(h, OWNER, FOLDER_RULES, bad)).status, JSON.stringify(bad)).toBe(400);
    }

    const cleared = await post(h, OWNER, FOLDER_RULES, {
      ruleId: rule!.ruleId,
      revision: 2,
      clear: true,
    });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect(((await cleared.json()) as WorkspaceMembersView).folderRules).toEqual([]);
    expect((await post(h, OWNER, FOLDER_RULES, { ...change, revision: 3 })).status).toBe(404);
  });

  it("writes each change as the relay's own moment, with its own place in the owner's log", async () => {
    const { h, storage } = await seed();
    const context = storage as unknown as StorageContext;
    const rule = await created(h, "docs", "view");
    const changed = await post(h, OWNER, FOLDER_RULES, {
      ruleId: rule.ruleId,
      revision: 1,
      members: null,
      people: [],
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    const markers = context.db
      .prepare(
        `SELECT payload_json FROM sync_relay_log
         WHERE workspace_id = ? AND origin_id = 'relay:folder-access' ORDER BY relay_seq`,
      )
      .all(WORKSPACE)
      .map((row) => JSON.parse(String(row.payload_json)) as Record<string, unknown>);
    expect(markers.map((payload) => [payload.path, payload.author ?? null])).toEqual([
      ["docs/.dohc-access", null],
      ["docs/.dohc-access", null],
    ]);
    const spans = context.db
      .prepare(
        "SELECT rule_text, to_seq FROM sync_relay_access_rules WHERE folder = 'docs' ORDER BY from_seq",
      )
      .all()
      .map((row) => [row.rule_text, row.to_seq === null]);
    expect(spans).toEqual([
      ["members: view\n", false],
      ["", true],
    ]);
  });

  it("refuses a folder marker from an admin's share", async () => {
    const { h } = await seed();
    const ana = await invited(h, "ana");
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "admin" })).status,
    ).toBe(200);
    const shareId = await shareIdOf(h, "ana");
    const text = `rule fr_${"0".repeat(32)}\n`;
    await uploadBlob(h, "ana", shareId, text);
    const write = await post(h, "ana", `/sync/shares/${shareId}/log`, {
      originId: "origin-ana-marker",
      ops: [
        logOp("moment.append", {
          momentId: "m-ana-marker",
          versionId: "main",
          objectId: "object-ana-marker",
          path: "docs/.dohc-access",
          recordedAtMs: 5000,
          operation: "write",
          payloadBeforeBlobSha256: null,
          payloadBeforePath: null,
          payloadAfterBlobSha256: sha256(text),
          payloadAfterPath: "docs/.dohc-access",
          metadata: { origin: "user" },
          beforePresent: "null",
        }),
      ],
    });
    expect(write.status, await write.clone().text()).not.toBe(200);
    expect((await membersView(h, OWNER)).folderRules).toEqual([]);
  });

  it("hides a folder whose marker names no rule until an admin removes the marker", async () => {
    const { h, storage } = await seed();
    const context = storage as unknown as StorageContext;
    await ownerWrite(h, "docs/.dohc-access", `rule fr_${"0".repeat(32)}\n`);
    const open = () =>
      context.db
        .prepare(
          "SELECT rule_text FROM sync_relay_access_rules WHERE folder = 'docs' AND to_seq IS NULL",
        )
        .all()
        .map((row) => row.rule_text);
    expect(open()).toEqual([null]);
    expect((await post(h, OWNER, FOLDER_MARKERS, { folder: "else" })).status).toBe(404);
    const removed = await post(h, OWNER, FOLDER_MARKERS, { folder: "docs" });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(open()).toEqual([]);
  });

  it("preserves a marker that names a rule", async () => {
    const { h } = await seed();
    await created(h, "docs", "view");
    expect((await post(h, OWNER, FOLDER_MARKERS, { folder: "docs" })).status).toBe(404);
    expect((await membersView(h, OWNER)).folderRules).toMatchObject([
      { folders: [{ path: "docs", state: "covered" }] },
    ]);
  });

  it("keeps a rule whose folder was deleted, and writes it no new marker", async () => {
    const { h, storage } = await seed();
    const context = storage as unknown as StorageContext;
    const rule = await created(h, "trip", "view");
    const marker = context.db
      .prepare(
        "SELECT blob_sha256 FROM sync_relay_current_files WHERE workspace_id = ? AND path = 'trip/.dohc-access'",
      )
      .get(WORKSPACE)!.blob_sha256;
    await ownerAppend(h, [
      logOp("moment.append", {
        momentId: "m-trip-gone",
        versionId: "main",
        objectId: "object-trip-gone",
        path: "trip/.dohc-access",
        recordedAtMs: 6000,
        operation: "delete",
        payloadBeforeBlobSha256: marker,
        payloadBeforePath: "trip/.dohc-access",
        payloadAfterBlobSha256: null,
        payloadAfterPath: null,
        metadata: { origin: "user" },
        beforePresent: "present",
      }),
    ]);
    expect((await membersView(h, OWNER)).folderRules).toMatchObject([
      { folders: [{ path: "trip", state: "folder-missing" }] },
    ]);
    const changed = await post(h, OWNER, FOLDER_RULES, {
      ruleId: rule.ruleId,
      revision: 1,
      members: "edit",
      people: [],
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(((await changed.json()) as WorkspaceMembersView).folderRules).toMatchObject([
      { revision: 2, folders: [{ path: "trip", state: "folder-missing" }] },
    ]);
  });

  it("keeps rules and their spans when the workspace's sync identity rotates", async () => {
    const { h, storage } = await seed();
    const context = storage as unknown as StorageContext;
    await created(h, "docs", "view");
    expect(
      storage.rotateWorkspaceIdentity({
        workspaceId: WORKSPACE,
        ownerUserId: OWNER,
        replicationEpoch: "epoch-2",
        streamIdentity: "stream-2",
        rotatedAtMs: 7000,
      }),
    ).toBe("rotated");
    expect(
      context.db
        .prepare("SELECT folder, rule_text FROM sync_relay_access_rules WHERE to_seq IS NULL")
        .all()
        .map((row) => ({ ...row })),
    ).toEqual([{ folder: "docs", rule_text: "members: view\n" }]);
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

  it("keeps the folder rules a deleted admin changed, without their account", async () => {
    const { h, storage } = await seed();
    const ana = await invited(h, "ana");
    expect(
      (await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/role`, { role: "admin" })).status,
    ).toBe(200);
    const made = await post(h, "ana", FOLDER_RULES, {
      folder: "docs",
      members: "view",
      people: [],
    });
    expect(made.status, await made.clone().text()).toBe(200);
    deleteAccount(storage, "ana");
    expect(
      (storage as unknown as StorageContext).db
        .prepare("SELECT rule_text, changed_by_user_id FROM sync_relay_folder_rules")
        .all()
        .map((row) => ({ ...row })),
    ).toEqual([{ rule_text: "members: view\n", changed_by_user_id: null }]);
  });

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

  it("gives a new account at a deleted account's address no level a rule gave that address, above or below the member level", async () => {
    const SAM = "sam@elsewhere.example";
    const { h, storage } = await seed({
      overrides: {
        lookupVerifiedUserEmail: async (userId) =>
          userId.startsWith("sam-") ? SAM : `${userId}@dohc.test`,
      },
    });
    await ownerRule(h, "docs", `members: view\npeople:\n  ${SAM}: edit\n`);
    await ownerRule(h, "notes", `members: edit\npeople:\n  ${SAM}: view\n`);
    await ownerWrite(h, "notes/todo.md", "the todo");
    const token = (await inviteLink(h, OWNER, "turn-on"))!;
    const levels = async (userId: string) => {
      // A pull stores the account's verified email.
      await pulledText(h, userId, await shareIdOf(h, userId));
      const reach = storage.memberReach(WORKSPACE, userId, "member", "comment");
      return [reach.folderLevel("docs"), reach.folderLevel("notes")];
    };
    expect((await join(h, "sam-old", token)).status).toBe(200);
    expect(await levels("sam-old")).toEqual(["edit", "view"]);

    const context = storage as unknown as StorageContext;
    initializeAccountDeletion(context, KEY);
    const { manifest } = fenceAccount(context, KEY, "sam-old", SAM);
    purgeAccountRows(context, "sam-old", SAM, manifest!);

    expect((await join(h, "sam-new", token)).status).toBe(200);
    // Not matching would leave the member level, Edit in notes, so each rule hides.
    expect(await levels("sam-new")).toEqual([null, null]);
    const pulled = await pulledText(h, "sam-new", await shareIdOf(h, "sam-new"));
    expect(pulled).not.toContain("docs/plan.md");
    expect(pulled).not.toContain("notes/todo.md");
    // Another account keeps the level the rules give everyone they don't name.
    expect((await join(h, "ana", token)).status).toBe(200);
    expect(await levels("ana")).toEqual(["view", "edit"]);
  });

  it("leaves the address's rules for its real holder when a deleted account never verified it", async () => {
    const SAM = "sam@elsewhere.example";
    const { h, storage } = await seed({
      overrides: {
        lookupVerifiedUserEmail: async (userId) =>
          userId === "squatter" ? null : userId === "sam" ? SAM : `${userId}@dohc.test`,
      },
    });
    await ownerRule(h, "docs", `members: view\npeople:\n  ${SAM}: edit\n`);
    const token = (await inviteLink(h, OWNER, "turn-on"))!;
    const level = async (userId: string) => {
      await pulledText(h, userId, await shareIdOf(h, userId));
      return storage.memberReach(WORKSPACE, userId, "member", "comment").folderLevel("docs");
    };
    expect((await join(h, "squatter", token)).status).toBe(200);
    expect(await level("squatter")).toBe("view");

    const context = storage as unknown as StorageContext;
    initializeAccountDeletion(context, KEY);
    const { manifest } = fenceAccount(context, KEY, "squatter", SAM);
    purgeAccountRows(context, "squatter", SAM, manifest!);

    expect((await join(h, "sam", token)).status).toBe(200);
    expect(await level("sam")).toBe("edit");
  });
});
