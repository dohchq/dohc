import {afterEach, describe, expect, it, vi} from "vitest";
import {listRosterGrants, ownerRoster} from "@dohc/automation-executor/roster-listing";
import type {SyncRelayStorage} from "./storage";
import {closeTestStorages, inspectDatabase, interceptStorage, request, storagePath, testHandler, testStorage} from "./testing";

afterEach(closeTestStorages);
interface InventoryBody {
  granted: Array<{shareId: string; grantId: string; fileScope?: string; damaged?: boolean}>;
  nextCursor?: string;
  received?: unknown;
}
async function inventory(response: Response): Promise<InventoryBody> {
  expect(response.status).toBe(200);
  return response.json();
}
const OWNER = "owner";
const WORKSPACE = "workspace-a";
function seed(storage: SyncRelayStorage, id: string, workspaceId = WORKSPACE, selector: unknown = {paths: ["Trip"], versionId: null}) {
  storage.createShare({
    share: {shareId: id, workspaceId, granterUserId: OWNER, selectorJson: JSON.stringify(selector), createdAtMs: 1},
    grant: {grantId: `grant-${id}`, shareId: id, principalKind: "user", principalUserId: "recipient", principalEmail: null,
      access: typeof selector === "object" && selector !== null && "kind" in selector ? "read-write" : "edit",
      generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null},
  });
}
function claim(storage: SyncRelayStorage, workspaceId = WORKSPACE, ownerUserId = OWNER) {
  storage.claimWorkspace({workspaceId, ownerUserId, createdAtMs: 1});
}
function seedInventory(storage: SyncRelayStorage, count: number, ended = false) {
  const db = inspectDatabase(storagePath(storage));
  try {
    const share = db.prepare(`INSERT INTO sync_relay_shares (share_id, workspace_id, granter_user_id, selector_json, created_at_ms)
      VALUES (?, ?, ?, ?, 1)`);
    const grant = db.prepare(`INSERT INTO sync_relay_share_grants
      (grant_id, share_id, principal_kind, principal_user_id, principal_email, access, generation, status, created_at_ms, revoked_at_ms, parent_grant_id)
      VALUES (?, ?, 'user', 'recipient', NULL, 'edit', ?, ?, 1, ?, NULL)`);
    db.exec("BEGIN");
    for (let i = 0; i < count; i++) {
      const id = `${ended ? "ended" : "share"}-${String(i).padStart(4, "0")}`;
      share.run(id, WORKSPACE, OWNER, JSON.stringify({ paths: ["Trip"], versionId: null }));
      grant.run(`grant-${id}`, id, ended ? 2 : 1, ended ? "revoked" : "active", ended ? i + 2 : null);
    }
    db.exec("COMMIT");
  } finally { db.close(); }
}

describe("workspace granted pages", () => {
  it("pins the legacy Settings bytes without looking up the owner", async () => {
    const storage = await testStorage(); claim(storage); seed(storage, "one");
    const lookupUserEmail = vi.fn((id: string) => {
      if (id === OWNER) throw new Error("owner directory unavailable");
      return "recipient@dohc.test";
    });
    const h = testHandler(storage, { lookupUserEmail });
    const response = await h(request(OWNER, "/sync/shares"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify({ ok: true, granted: [{
      shareId: "one", subjectName: null, sharerName: null,
      selector: { paths: ["Trip"], versionId: null }, access: "edit", grantId: "grant-one",
      principalKind: "user", generation: 1, createdAtMs: 1, workspaceId: WORKSPACE,
      recipientUserId: "recipient", recipientEmail: "recipient@dohc.test", revokedAtMs: null, automationsGeneration: null,
    }], received: [], removed: [] }));
    expect(lookupUserEmail).toHaveBeenCalledExactlyOnceWith("recipient");
  });

  it("looks up the owner once for a 1,000-row granted page and fails acquisition on error", async () => {
    const storage = await testStorage(); claim(storage);
    seedInventory(storage, 1000);
    let unavailable = false;
    const lookupUserEmail = vi.fn((id: string) => {
      if (id === OWNER && unavailable) throw new Error("owner directory unavailable");
      return `${id}@dohc.test`;
    });
    const h = testHandler(storage, { lookupUserEmail });
    const path = `/sync/shares?workspaceId=${WORKSPACE}`;
    const response = await h(request(OWNER, path));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.granted).toHaveLength(1000);
    expect(body.granted[0]).toMatchObject({ granterUserId: OWNER, granterEmail: "owner@dohc.test", status: "active" });
    expect(lookupUserEmail.mock.calls.filter(([id]) => id === OWNER)).toHaveLength(1);
    unavailable = true;
    expect((await h(request(OWNER, path))).status).toBe(500);
    expect(await listRosterGrants(WORKSPACE, h.readOwnerShares.bind(h, OWNER))).toMatchObject({ kind: "unanswered" });
  });

  it("answers link inventory without owner lookups when the directory is unavailable", async () => {
    const storage = await testStorage(); claim(storage); seedInventory(storage, 1000);
    const db = inspectDatabase(storagePath(storage));
    try { db.prepare("UPDATE sync_relay_share_grants SET principal_kind = 'link', principal_user_id = NULL").run(); }
    finally { db.close(); }
    const lookupUserEmail = vi.fn(() => { throw new Error("directory unavailable"); });
    const h = testHandler(storage, { lookupUserEmail });
    const response = await h(request(OWNER, `/sync/${WORKSPACE}/shares/links`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.links).toHaveLength(1000);
    expect(lookupUserEmail).not.toHaveBeenCalled();
    for (const link of body.links) {
      expect(link).not.toHaveProperty("granterUserId");
      expect(link).not.toHaveProperty("granterEmail");
    }
    const healthy = testHandler(storage);
    const answer = await listRosterGrants(WORKSPACE, healthy.readOwnerShares.bind(healthy, OWNER));
    expect(answer.kind).toBe("answered");
    if (answer.kind !== "answered" || answer.listing.grants === null) throw new Error("unusable listing");
    expect(answer.listing.links).toHaveLength(1000);
    expect(answer.listing.links[0].grant).toMatchObject({ granterUserId: OWNER, granterEmail: "owner@dohc.test" });
  });

  it("filters before paging, uses immutable ascending keys, and keeps revoked grants", async () => {
    const storage = await testStorage();
    claim(storage); claim(storage, "workspace-b");
    seedInventory(storage, 1001);
    seed(storage, "other", "workspace-b");
    storage.revokeShare("share-0000", 2);
    const h = testHandler(storage);
    const first = await inventory(await h(request(OWNER, `/sync/shares?workspaceId=${WORKSPACE}`)));
    expect(first.granted).toHaveLength(1000);
    expect(first.granted[0]).toMatchObject({shareId: "share-0000", revokedAtMs: 2});
    expect(first.granted[999]).toMatchObject({shareId: "share-0999"});
    expect(first.nextCursor).toBeTypeOf("string");
    const last = await inventory(await h(request(OWNER, `/sync/shares?workspaceId=${WORKSPACE}&cursor=${encodeURIComponent(first.nextCursor!)}`)));
    expect(last.granted.map((row: {shareId: string}) => row.shareId)).toEqual(["share-1000"]);
    expect(last.nextCursor).toBeUndefined();
    expect(first.received).toBeUndefined();
    const roster = await listRosterGrants(WORKSPACE, h.readOwnerShares.bind(h, OWNER));
    expect(roster.kind === "answered" && roster.listing.grants?.length).toBe(1000);
  });

  it("keeps owner checks on every page and after asynchronous serialization", async () => {
    const storage = await testStorage(); claim(storage); seed(storage, "one");
    const h = testHandler(storage);
    expect((await h(request("stranger", `/sync/shares?workspaceId=${WORKSPACE}`))).status).toBe(404);
    expect((await h(request(OWNER, "/sync/shares?workspaceId=missing"))).status).toBe(404);
    let owned = true;
    const raced = testHandler(interceptStorage(storage, {workspaceIsOwnedBy: () => owned}), {
      lookupUserEmail: async () => {owned = false; return "recipient@dohc.test";},
    });
    expect((await raced(request(OWNER, `/sync/shares?workspaceId=${WORKSPACE}`))).status).toBe(404);
  });

  it("rejects duplicate, malformed, and unscoped page coordinates", async () => {
    const storage = await testStorage(); claim(storage);
    const h = testHandler(storage);
    for (const query of ["workspaceId=workspace-a&workspaceId=workspace-a", "workspaceId=", "workspaceId=workspace-a&cursor=nope", "workspaceId=workspace-a&cursor=a&cursor=b", "cursor=nope"]) {
      expect((await h(request(OWNER, `/sync/shares?${query}`))).status, query).toBe(400);
    }
  });
});

describe("Group file scope observations", () => {
  it.each(["channel", "dm", "agent", null] as const)("keeps the owner's Group row when the channel kind is %s", async (kind) => {
    const storage = await testStorage(); claim(storage);
    const selector = {kind: "group", channelWireId: "wire-trip", paths: ["Trip"], versionId: null};
    seed(storage, "group", WORKSPACE, selector);
    const h = testHandler(interceptStorage(storage, {findChannelCreateKind: () => kind}), {lookupUserEmail: () => "recipient@dohc.test"});
    for (const path of ["/sync/shares", `/sync/shares?workspaceId=${WORKSPACE}`]) {
      const listing = await inventory(await h(request(OWNER, path)));
      expect(listing.granted).toHaveLength(1);
      expect(listing.granted[0]).toMatchObject({grantId: "grant-group", selector, fileScope: kind === "channel" ? "served" : "not-served"});
      expect(listing.granted[0].damaged).toBeUndefined();
    }
    const answer = await listRosterGrants(WORKSPACE, h.readOwnerShares.bind(h, OWNER));
    expect(answer.kind).toBe("answered");
    if (answer.kind !== "answered") throw new Error("expected an answer");
    const roster = ownerRoster(OWNER, answer.listing, "");
    expect(roster.kind).toBe("owner");
    if (roster.kind !== "owner") throw new Error("expected a usable roster");
    expect(roster.grants[0]?.files).toEqual(kind === "channel" ? {paths: ["Trip"], versionId: null, access: "edit"} : null);
    expect((await h(request(OWNER, "/sync/shares/group/revoke", {method: "POST"}))).status).toBe(200);
  });

  it("checks the channel after asynchronous recipient lookup", async () => {
    const storage = await testStorage(); claim(storage);
    seed(storage, "group", WORKSPACE, {kind: "group", channelWireId: "wire-trip", paths: ["Trip"], versionId: null});
    let ordinary = true;
    const h = testHandler(interceptStorage(storage, {findChannelCreateKind: () => ordinary ? "channel" : "dm"}), {
      lookupUserEmail: async () => {ordinary = false; return "recipient@dohc.test";},
    });
    const listing = await inventory(await h(request(OWNER, `/sync/shares?workspaceId=${WORKSPACE}`)));
    expect(listing.granted[0].fileScope).toBe("not-served");
  });
});

describe("account received pages", () => {
  it("pages by share above 1,000 and leaves the Settings and Chats account lane unchanged", async () => {
    const storage = await testStorage(); claim(storage);
    seedInventory(storage, 1001);
    const db = inspectDatabase(storagePath(storage));
    try {
      db.prepare("UPDATE sync_relay_share_grants SET access = 'view' WHERE share_id = 'share-0999'").run();
      const insert = db.prepare(`INSERT INTO sync_relay_share_grants
        (grant_id, share_id, principal_kind, principal_user_id, principal_email, access, generation, status, created_at_ms, revoked_at_ms, parent_grant_id)
        VALUES (?, 'share-0999', 'user', ?, NULL, ?, 1, 'active', 1, NULL, NULL)`);
      insert.run("extra-own", "recipient", "comment");
      insert.run("another-person", "other", "edit");
    } finally {
      db.close();
    }
    storage.revokeShare("share-0000", 2);
    const h = testHandler(storage);
    const first = await (await h(request("recipient", "/sync/shares?received=true"))).json();
    expect(first.granted).toBeUndefined();
    expect(first.received).toHaveLength(999);
    expect(first.received.filter((row: {shareId: string}) => row.shareId === "share-0999"))
      .toMatchObject([{ grantId: "extra-own", access: "comment" }]);
    expect(first.removed).toMatchObject([{ shareId: "share-0000", removedAtMs: 2 }]);
    expect(first.nextCursor).toBeTypeOf("string");
    const last = await (await h(request("recipient", `/sync/shares?received=true&cursor=${encodeURIComponent(first.nextCursor)}`))).json();
    expect(last.received.map((row: {shareId: string}) => row.shareId)).toEqual(["share-1000"]);
    expect(last.nextCursor).toBeUndefined();
    const legacy = await (await h(request("recipient", "/sync/shares"))).json();
    expect(legacy.granted).toEqual([]);
    expect(legacy.received).toHaveLength(1000);
    expect(legacy.nextCursor).toBeUndefined();
  });

  it("omits account identity from cursors, scopes replay to the caller, and rejects ambiguous coordinates", async () => {
    const storage = await testStorage(); claim(storage);
    seedInventory(storage, 1001);
    const h = testHandler(storage);
    const first = await (await h(request("recipient", "/sync/shares?received=true"))).json();
    expect(JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8"))).toEqual({ version: 1, shareId: "share-0999" });
    const replay = await h(request("other", `/sync/shares?received=true&cursor=${encodeURIComponent(first.nextCursor)}`));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, received: [], removed: [] });
    for (const query of ["received=true&received=true", "received=false", "received=true&workspaceId=workspace-a",
      "received=true&cursor=nope", "received=true&cursor=a&cursor=b"]) {
      expect((await h(request("recipient", `/sync/shares?${query}`))).status, query).toBe(400);
    }
    expect((await (await h(request("other", "/sync/shares?received=true"))).json()).received).toEqual([]);
  });

  it("bounds removal identities to the legacy latest 1,000 while paging all active shares", async () => {
    const storage = await testStorage(); claim(storage);
    seedInventory(storage, 1001, true);
    seed(storage, "active"); seed(storage, "zz-active");
    const h = testHandler(storage);
    const received: Array<{ shareId: string }> = [], removed: Array<{ shareId: string }> = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const response = await h(request("recipient", `/sync/shares?received=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
      expect(response.status).toBe(200);
      const body = await response.json();
      received.push(...body.received); removed.push(...body.removed); cursor = body.nextCursor;
      expect(++pages).toBeLessThanOrEqual(2);
    } while (cursor);
    expect(received.map(row => row.shareId)).toEqual(["active", "zz-active"]);
    expect(removed).toHaveLength(1000);
    expect(removed.some(row => row.shareId === "ended-0000")).toBe(false);
    expect(removed.map(row => row.shareId).sort()).toEqual(storage.listRemovedSharesForRecipient("recipient").map(row => row.shareId).sort());
    expect(storage.listReceivedShareIdsPage("recipient").shareIds).not.toContain("ended-0000");
  });

  it("uses immutable share keys when shares change between pages", async () => {
    const storage = await testStorage(); claim(storage);
    seedInventory(storage, 1001);
    const h = testHandler(storage);
    const first = await (await h(request("recipient", "/sync/shares?received=true"))).json();
    storage.revokeShare("share-0100", 2);
    seed(storage, "share-0000-new");
    seed(storage, "share-1001-new");
    const last = await (await h(request("recipient", `/sync/shares?received=true&cursor=${encodeURIComponent(first.nextCursor)}`))).json();
    expect(last.received.map((row: {shareId: string}) => row.shareId)).toEqual(["share-1000", "share-1001-new"]);
    expect(last.removed).toEqual([]);
  });
});

it("returns one source per recipient and source only on admitted detail, never inventories or refusals", async () => {
  const storage=await testStorage(); claim(storage); claim(storage,"workspace-b");
  seed(storage,"one"); seed(storage,"two"); seed(storage,"other","workspace-b");
  const h=testHandler(storage);
  const details=await Promise.all(["one","two","other"].map(async id=>(await h(request("recipient","/sync/shares/"+id))).json()));
  expect(details[0].receivedSource).toMatch(/^share-source:v1:[0-9a-f]{64}$/u);
  expect(details[0].receivedSource).toBe(details[1].receivedSource); expect(details[0].receivedSource).not.toBe(details[2].receivedSource);
  expect(JSON.stringify(details)).not.toContain(WORKSPACE);
  expect(await (await h(request("recipient","/sync/shares?received=true"))).text()).not.toContain("receivedSource");
  const withoutKey=testHandler(storage,{linkKey:undefined});
  const body=await (await withoutKey(request("recipient","/sync/shares/one"))).json();
  expect(body).not.toHaveProperty("receivedSource"); expect(body).not.toHaveProperty("workspaceId");
  const stranger=await h(request("stranger","/sync/shares/one"));
  storage.revokeShareGrant({shareId:"one",grantId:"grant-one",revokedAtMs:2});
  const revoked=await h(request("recipient","/sync/shares/one"));
  expect([revoked.status,await revoked.text()]).toEqual([stranger.status,await stranger.text()]);
  expect((await h(request("recipient","/sync/"+details[0].receivedSource+"/log?since=0&limit=100"))).status).toBe(404);
});
