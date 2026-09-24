import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NOTICE_LIST_ROW_LIMIT,
  type RelayNotice,
  type RelayNoticePage,
} from "@dohc/workspace-contracts/relay";
import type { SyncRelayHandler } from "./server";
import type { SyncRelayStorage } from "./storage";
import {
  appendLog,
  closeTestStorage,
  countStorageCalls,
  reopenTestStorage,
  storagePath,
  chatChannelCreate,
  claimWorkspace,
  closeTestStorages,
  createShare,
  json,
  jsonBody,
  logOp,
  request,
  resetOpSeq,
  seedDependentGrant,
  seedLinkGrant,
  sha256,
  testHandler,
  testStorage,
  type HandlerOverrides,
} from "./testing";

afterEach(closeTestStorages);

const WORKSPACE = "workspace-trip";
const CLOCK = 10_000;

async function relay(overrides: HandlerOverrides = {}): Promise<{ h: SyncRelayHandler; storage: SyncRelayStorage }> {
  resetOpSeq();
  const storage = await testStorage();
  const h = testHandler(storage, {
    nowMs: () => CLOCK,
    lookupUserDisplayName: (userId) => `Name ${userId}`,
    ...overrides,
  });
  await claimWorkspace(h, "owner", WORKSPACE);
  return { h, storage };
}

async function notices(h: SyncRelayHandler, userId: string): Promise<RelayNotice[]> {
  const response = await h(request(userId, "/sync/notices"));
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as RelayNoticePage).notices;
}

async function titles(h: SyncRelayHandler, userId: string): Promise<string[]> {
  return (await notices(h, userId)).map((row) => row.title);
}

function channel(wireId: string, name: string, kind: "channel" | "dm") {
  return logOp("chat.channel.create", chatChannelCreate(wireId, {
    channelId: `chan-${wireId}`,
    name,
    slug: name,
    kind,
    ...(kind === "channel" ? { type: "both", purpose: "", folderPath: name } : {}),
  }).payload);
}

describe("a notice when a share reaches a person", () => {
  it("comes from the granter and names what was shared", async () => {
    const { h } = await relay();
    const shareId = await createShare(h, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana" });

    expect(await notices(h, "ana")).toEqual([expect.objectContaining({
      noticeId: "from:owner:share-received:grant-0",
      kind: "share-received",
      senderKind: "person",
      senderUserId: "owner",
      senderLabel: "Name owner",
      title: "Name owner shared trip with you",
      body: "",
      target: { share: shareId },
      workspaceId: null,
      recipientShareId: shareId,
      originInstallId: "relay",
      createdAtMs: CLOCK,
    })]);
    expect(await notices(h, "owner")).toEqual([]);
  });

  it("reaches an account shared with by email", async () => {
    const { h } = await relay();
    await createShare(h, "owner", WORKSPACE, { paths: ["trip"], recipientEmail: "ana@dohc.test" });
    expect(await titles(h, "ana")).toEqual(["Name owner shared trip with you"]);
  });

  it("reaches an address with no account once its account claims the share, once", async () => {
    const { h } = await relay({
      lookupVerifiedUserEmail: (userId) => (userId === "newbie" ? "newbie@elsewhere.test" : `${userId}@dohc.test`),
    });
    await createShare(h, "owner", WORKSPACE, { paths: ["trip"], recipientEmail: "newbie@elsewhere.test" });
    expect(await titles(h, "ana")).toEqual([]);

    // A pull does not claim the share, and listing shares does.
    expect(await titles(h, "newbie")).toEqual([]);
    expect((await h(request("newbie", "/sync/shares"))).status).toBe(200);
    expect(await titles(h, "newbie")).toEqual(["Name owner shared trip with you"]);
    expect(await titles(h, "newbie")).toEqual(["Name owner shared trip with you"]);
  });

  it("names several paths, a version, a folder with a chat, a channel, and a message request", async () => {
    const { h } = await relay();
    await appendLog(h, "owner", WORKSPACE, [channel("wire-team", "team", "channel"), channel("wire-dm", "ana-dm", "dm")]);
    await createShare(h, "owner", WORKSPACE, { paths: ["trip", "budget", "notes"], recipientUserId: "ana" });
    await createShare(h, "owner", WORKSPACE, { paths: [], versionId: "draft", recipientUserId: "ana" });
    await createShare(h, "owner", WORKSPACE, { channelWireId: "wire-team", paths: ["team"], access: "read-write", recipientUserId: "ana" });
    await createShare(h, "owner", WORKSPACE, { channelWireId: "wire-team", access: "read-write", recipientUserId: "ben" });
    await createShare(h, "owner", WORKSPACE, { channelWireId: "wire-dm", access: "read-write", recipientUserId: "cy" });

    expect(await titles(h, "ana")).toEqual([
      "Name owner shared 3 items with you",
      "Name owner shared a version with you",
      "Name owner shared team with you",
    ]);
    expect(await titles(h, "ben")).toEqual(["Name owner shared a channel with you"]);
    expect(await titles(h, "cy")).toEqual(["Name owner sent you a message request"]);
  });

  it("shortens a long name to fit the title", async () => {
    const { h } = await relay();
    await createShare(h, "owner", WORKSPACE, { paths: [`trip/${"a".repeat(200)}`], recipientUserId: "ana" });
    const [title] = await titles(h, "ana");
    expect([...title!]).toHaveLength(120);
    expect(title).toMatch(/^Name owner shared a+… with you$/u);
  });

  it("names a granter with no display name by the email the recipient already sees", async () => {
    const { h } = await relay({ lookupUserDisplayName: () => null });
    await createShare(h, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana" });
    expect(await notices(h, "ana")).toEqual([expect.objectContaining({
      senderLabel: "owner@dohc.test",
      title: "owner@dohc.test shared trip with you",
    })]);

    const long = await relay({ lookupUserDisplayName: () => null, lookupUserEmail: (userId) => `${userId}${"x".repeat(40)}@dohc.test` });
    await createShare(long.h, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana" });
    expect(await titles(long.h, "ana")).toEqual(["Someone shared trip with you"]);
  });

  it("sends nothing for a grant opened from a public link", async () => {
    const { h, storage } = await relay();
    const shareId = await createShare(h, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana" });
    seedLinkGrant(storage, { grantId: "link-1", shareId, secretHash: sha256("secret") });
    seedDependentGrant(storage, { shareId, parentGrantId: "link-1", grantId: "from-link-lee", principalUserId: "lee", createdAtMs: CLOCK });
    storage.noticeShareReceived({ grantId: "from-link-lee", senderLabel: "Owner", nowMs: CLOCK });
    storage.noticeShareReceived({ grantId: "link-1", senderLabel: "Owner", nowMs: CLOCK });
    expect(await notices(h, "lee")).toEqual([]);
  });

  it("keeps the notice and drops its target when the share ends", async () => {
    const { h, storage } = await relay();
    const shareId = await createShare(h, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana" });
    expect((await notices(h, "ana"))[0]?.target).toEqual({ share: shareId });
    expect(storage.revokeShare(shareId, CLOCK)).toBe(true);
    expect(await notices(h, "ana")).toEqual([expect.objectContaining({
      title: "Name owner shared trip with you", target: null,
    })]);
  });

  it("still makes the share when the person's list has no room", async () => {
    const { h, storage } = await relay();
    for (let index = 0; index < NOTICE_LIST_ROW_LIMIT; index += 1) {
      storage.postNotice({
        noticeId: `own-${index}`, recipientUserId: "ana", reach: { workspaceId: "ana-work" }, kind: "mention",
        title: "Mentioned", body: "", target: {}, originInstallId: "install-a",
        senderUserId: "ana", senderLabel: "Ana", nowMs: CLOCK,
      });
    }
    const response = await h(request("owner", `/sync/${WORKSPACE}/shares`, jsonBody({
      paths: ["trip"], access: "view", recipientUserId: "ana",
    })));
    expect(response.status).toBe(200);
    expect((await notices(h, "ana")).some((row) => row.kind === "share-received")).toBe(false);
  });

  it("is written only by the relay", async () => {
    const { h } = await relay();
    const response = await h(request("ana", "/sync/notices", jsonBody({
      noticeId: "share-received:x", recipientUserId: "ana", workspaceId: "ana-work", kind: "share-received",
      title: "Someone shared trip with you", body: "", target: {}, originInstallId: "install-a",
    })));
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ code: "bad_request" });
  });

  it("answers the share before the notice is written, so the answer does not depend on the recipient", async () => {
    let finish = (_name: string | null) => {};
    const name = new Promise<string | null>((resolve) => { finish = resolve; });
    const { h, storage } = await relay({ lookupUserDisplayName: () => name });
    await createShare(h, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana" });
    expect(storage.pendingShareNotices("ana")).toHaveLength(1);
    finish("Owner");
    // The title names the granter, or past the name lookup's deadline, the
    // email the recipient already sees.
    expect(await titles(h, "ana")).toEqual([expect.stringMatching(/ shared trip with you$/u)]);
    expect(storage.pendingShareNotices("ana")).toEqual([]);
  });

  it("delivers a notice the relay stopped before writing, on the recipient's next pull", async () => {
    const { storage } = await relay();
    made(storage, { paths: ["trip"] }, "ana");
    // The relay restarts before any delivery runs.
    const path = storagePath(storage);
    closeTestStorage(storage);
    const reopened = reopenTestStorage(path);
    const h = testHandler(reopened, { nowMs: () => CLOCK, lookupUserDisplayName: (userId) => `Name ${userId}` });
    expect(await titles(h, "ana")).toEqual(["Name owner shared trip with you"]);
    expect(reopened.pendingShareNotices("ana")).toEqual([]);
  });

  it("settles the delivery without a notice when the grant ends first", async () => {
    const { h, storage } = await relay();
    const shareId = made(storage, { paths: ["trip"] }, "ana");
    expect(storage.revokeShare(shareId, CLOCK)).toBe(true);
    expect(await notices(h, "ana")).toEqual([]);
    expect(storage.pendingShareNotices("ana")).toEqual([]);
  });

  it("waits to deliver a channel share until the owner's log names the channel", async () => {
    const { h, storage } = await relay();
    made(storage, { kind: "chat-channel", channelWireId: "wire-later" }, "ana", "read-write");
    expect(await notices(h, "ana")).toEqual([]);
    expect(storage.pendingShareNotices("ana")).toHaveLength(1);

    await appendLog(h, "owner", WORKSPACE, [channel("wire-later", "ana-dm", "dm")]);
    expect(await titles(h, "ana")).toEqual(["Name owner sent you a message request"]);
    expect(storage.pendingShareNotices("ana")).toEqual([]);
  });

  it("does not claim email invites on a pull", async () => {
    const setup = await relay();
    const counted = countStorageCalls(setup.storage, "claimPendingSharesForEmail");
    const h = testHandler(counted.storage, { nowMs: () => CLOCK });
    await notices(h, "ana");
    expect(counted.calls).toEqual([]);
  });

  it("checks only the grant behind notices that point at a share, without the access digest", async () => {
    const { h, storage } = await relay();
    const shareId = await createShare(h, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana" });
    await notices(h, "ana");
    const digests = vi.spyOn(storage, "listSharesReceivedBy");
    await notices(h, "ana");
    expect(storage.revokeShare(shareId, CLOCK)).toBe(true);
    expect((await notices(h, "ana"))[0]?.target).toBeNull();
    expect(digests).not.toHaveBeenCalled();
  });
});

let made_ = 0;
// A named share made in storage: the grant and its waiting delivery commit
// together, and nothing delivers it until a pull.
function made(
  storage: SyncRelayStorage,
  selector: Record<string, unknown>,
  recipientUserId: string,
  access = "view",
): string {
  made_ += 1;
  const shareId = `stored-share-${made_}`;
  storage.createShare({
    share: {
      shareId, workspaceId: WORKSPACE, granterUserId: "owner",
      selectorJson: JSON.stringify("kind" in selector ? selector : { versionId: null, ...selector }),
      createdAtMs: CLOCK,
    },
    grant: {
      grantId: `stored-grant-${made_}`, shareId, principalKind: "user", principalUserId: recipientUserId,
      principalEmail: null, access, generation: 1, status: "active", createdAtMs: CLOCK,
      revokedAtMs: null, parentGrantId: null,
    },
  });
  return shareId;
}
