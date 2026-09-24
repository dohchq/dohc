import { afterEach, describe, expect, it } from "vitest";
import {
  NOTICE_LIST_ROW_LIMIT,
  type RelayNotice,
  type RelayNoticePage,
} from "@dohc/workspace-contracts/relay";
import type { SyncRelayHandler } from "./server";
import type { SyncRelayStorage } from "./storage";
import {
  appendLog,
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

    // The first pull after the address is verified claims the share.
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
});
