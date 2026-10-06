import {afterEach, describe, expect, it} from "vitest";
import {listRosterGrants, ownerRoster} from "@dohc/automation-executor/roster-listing";
import type {SyncRelayStorage} from "./storage";
import {closeTestStorages, interceptStorage, request, testHandler, testStorage} from "./testing";

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

describe("workspace granted pages", () => {
  it("filters before paging, uses immutable ascending keys, and keeps revoked grants", async () => {
    const storage = await testStorage();
    claim(storage); claim(storage, "workspace-b");
    for (let i = 0; i < 1001; i++) seed(storage, `share-${String(i).padStart(4, "0")}`);
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
