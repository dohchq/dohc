
import type { StorageContext } from "./storage/context";
import { createNamedLiveBrowserResolver } from "./namedLiveBrowserAuth";
import { afterEach, expect, it, vi } from "vitest";
import { closeTestStorages, testStorage, testHandler, request, seedLinkGrant, seedDependentGrant,
  closeTestStorage, storagePath, reopenTestStorage } from "./testing";
import { SHARE_REMOVAL_UNDO_MS } from "./storage/shareRemoval";
import { hashLinkBearer } from "./linkSecurity";
import { LINK_KEY } from "./testing";
import { readCurrentShareGrant } from "./storage/currentShareGrant";

afterEach(closeTestStorages);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const storage = await testStorage({blobGraceMs: 0});
  storage.claimWorkspace({ workspaceId: "w", ownerUserId: "owner", createdAtMs: 1 });
  storage.createShare({ share: { shareId: "s", workspaceId: "w", granterUserId: "owner",
    selectorJson: JSON.stringify({ paths: ["private"], versionId: null }), createdAtMs: 1 },
    grant: { grantId: "named", shareId: "s", principalKind: "user", principalUserId: "reader", principalEmail: null,
      access: "edit", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null } });
  const secret = "a".repeat(43);
  seedLinkGrant(storage, { shareId: "s", grantId: "link", secretHash: hashLinkBearer(secret, LINK_KEY), access: "comment" });
  expect(seedDependentGrant(storage, { shareId: "s", parentGrantId: "link", grantId: "dependent",
    principalUserId: "holder", createdAtMs: 3 }).ok).toBe(true);
  return { storage, secret };
}
const removal = { shareId: "s", actorUserId: "owner", nowMs: 3000 };
const post = (body?: unknown): RequestInit => ({method: "POST", ...(body ? {headers: {"content-type": "application/json"}, body: JSON.stringify(body)} : {})});

it("restores the same named grant and access, across a relay restart", async () => {
  let { storage } = await fixture();
  const result = storage.removeShareAccess({...removal, grantId: "named"});
  if (!result.ok || !result.undo) throw Error("removal failed");
  expect(storage.getShareGrant("named")).toMatchObject({status: "revoked", generation: 2, access: "edit"});
  vi.spyOn(Date, "now").mockReturnValue(4000);
  const path = storagePath(storage); closeTestStorage(storage); storage = reopenTestStorage(path);
  storage.undoShareRemoval({...removal, undoId: result.undo!.undoId, nowMs: 4000});
  expect(storage.getShareGrant("named")).toMatchObject({status: "active", generation: 3, access: "edit", revokedAtMs: null});
  expect(storage.listRemovedSharesForRecipient("reader")).toEqual([]);
  storage.undoShareRemoval({...removal, undoId: result.undo!.undoId});
  expect(storage.getShareGrant("named")?.generation).toBe(3);
});

it("restores the original link secret and its dependent, without restoring old session generations", async () => {
  const {storage, secret} = await fixture();
  const h = testHandler(storage, {nowMs: () => 4000});
  const exchange = () => h(request(null, "/sync/link-exchange", post({secret})));
  expect((await exchange()).status).toBe(200);
  const removed = storage.removeShareAccess({...removal, grantId: "link", expectedDependentGrantIds: ["dependent"]});
  if (!removed.ok || !removed.undo) throw Error("removal failed");
  expect(storage.getShareGrant("dependent")?.status).toBe("revoked");
  expect((await exchange()).status).toBe(404);
  expect(readCurrentShareGrant(storage, {grantId: "link", generation: 1})).toBeNull();
  storage.undoShareRemoval({...removal, undoId: removed.undo.undoId, nowMs: 4000});
  expect(readCurrentShareGrant(storage, {grantId: "link", generation: 1})).toBeNull();
  expect(readCurrentShareGrant(storage, {grantId: "dependent"})?.grant.access).toBe("comment");
  expect((await exchange()).status).toBe(200);
  expect(storage.findLinkGrantByCredentialHash(hashLinkBearer(secret, LINK_KEY))).toMatchObject({credential: {retiredAtMs: null, generation: 3}});
});

it.each([SHARE_REMOVAL_UNDO_MS])("refuses undo at or after expiry (%i)", async offset => {
  const {storage} = await fixture();
  const result = storage.removeShareAccess(removal); if (!result.ok || !result.undo) throw Error("removal failed");
  expect(() => storage.undoShareRemoval({...removal, nowMs: removal.nowMs + offset, undoId: result.undo!.undoId})).toThrow("10-minute");
  expect(storage.getShareGrant("named")?.status).toBe("revoked");
  expect((storage as StorageContext).db.prepare("SELECT * FROM sync_relay_share_removals").all()).toEqual([]);
});

it("restores only this removal, leaves earlier revoked grants ended, and never accepts another owner", async () => {
  const {storage} = await fixture();
  storage.revokeShareGrant({shareId: "s", grantId: "named", revokedAtMs: 2500});
  const result = storage.removeShareAccess(removal); if (!result.ok || !result.undo) throw Error("removal failed");
  expect(() => storage.undoShareRemoval({...removal, actorUserId: "reader", undoId: result.undo!.undoId})).toThrow("not found");
  expect(() => storage.undoShareRemoval({...removal, shareId: "other", undoId: result.undo!.undoId})).toThrow("not found");
  storage.undoShareRemoval({...removal, undoId: result.undo!.undoId});
  expect(storage.getShareGrant("named")?.status).toBe("revoked");
  expect(storage.getShareGrant("link")?.status).toBe("active");
});

it("returns an owner-only undo receipt and minimal removed-recipient facts over HTTP", async () => {
  const {storage} = await fixture(); const h = testHandler(storage, {nowMs: () => 3000});
  const ended = await h(request("owner", "/sync/shares/s/revoke", post()));
  expect(ended.status).toBe(200);
  const body = await ended.json() as {undo: {undoId: string; expiresAtMs: number}};
  expect(body.undo.expiresAtMs).toBe(3000 + SHARE_REMOVAL_UNDO_MS);
  const named = await h(request("reader", "/sync/shares/s"));
  expect(named.status).toBe(404);
  expect(await named.json()).toMatchObject({code: "share_access_removed", error: "The owner removed your access."});
  const listed = await (await h(request("reader", "/sync/shares"))).json();
  expect(listed).toMatchObject({received: [], removed: [{shareId: "s", grantId: "named", message: "The owner removed your access.", removedAtMs: 3000}]});
  expect(JSON.stringify(listed)).not.toContain("private");
  const stranger = await h(request("stranger", "/sync/shares/s"));
  const missing = await h(request("stranger", "/sync/shares/missing"));
  expect(stranger.status).toBe(missing.status); expect(await stranger.text()).toBe(await missing.text());
  expect((await h(request(null, "/sync/shares/s"))).status).toBe(401);
  expect((await h(request("reader", "/sync/shares/s/undo", post({undoId: body.undo.undoId})))).status).toBe(404);
  expect((await h(request("owner", "/sync/shares/s/undo", post({undoId: body.undo.undoId})))).status).toBe(200);
  expect((await h(request("reader", "/sync/shares/s"))).status).toBe(200);
});

it("only explains a browser revocation after verifying the named account and exact scope", async () => {
  const {storage} = await fixture(); storage.removeShareAccess({...removal, grantId: "named"});
  const scope = {workspaceId: "w", shareId: "s", grantId: "named"};
  for (const userId of ["reader", "stranger"]) {
    const resolve = createNamedLiveBrowserResolver({storage, explainRemoval: true, resolveActor: (_request, workspaceId) => ({userId, workspaceId})});
    if (userId === "reader") await expect(resolve(new Request("https://relay.test"), scope)).rejects.toThrow("owner removed your access");
    else expect(await resolve(new Request("https://relay.test"), scope)).toBeNull();
    expect(await resolve(new Request("https://relay.test"), {...scope, shareId: "other"})).toBeNull();
  }
});

it("retries each removal with the same receipt and cannot replay an older Undo after another removal", async () => {
  const {storage} = await fixture(); const h = testHandler(storage, {nowMs: () => 3000});
  for (const path of ["/sync/shares/s/grants/named/revoke", "/sync/shares/s/revoke"]) {
    const body = path.includes("grants") ? {workspaceId: "w"} : {workspaceId: "w", grantId: "link", expectedDependentGrantIds: ["dependent"]};
    const first = await (await h(request("owner", path, post(body)))).json() as {undo: {undoId: string; expiresAtMs: number}};
    const retry = await (await h(request("owner", path, post(body)))).json() as {undo: unknown};
    expect(retry.undo).toEqual(first.undo);
    storage.undoShareRemoval({...removal, undoId: first.undo.undoId});
    const grantId = path.includes("grants") ? "named" : "link";
    const next = storage.removeShareAccess({...removal, grantId}); expect(next.ok).toBe(true);
    expect(() => storage.undoShareRemoval({...removal, undoId: first.undo.undoId})).toThrow("Access changed");
  }
});

it("refuses Bob's Undo after Stop sharing an empty share that had only Bob's access", async () => {
  const {storage} = await fixture();
  storage.createShare({
    share: {...storage.getShare("s")!, shareId: "bob-share"},
    grant: {...storage.getShareGrant("named")!, shareId: "bob-share", grantId: "bob", principalUserId: "bob"},
  });
  const input = {...removal, shareId: "bob-share"};
  const removed = storage.removeShareAccess({...input, grantId: "bob"});
  if (!removed.ok || !removed.undo) throw Error("removal failed");
  expect(storage.removeShareAccess({...input, nowMs: 4000})).toEqual({ok: true, grant: null});
  expect(() => storage.undoShareRemoval({...input, nowMs: 4000, undoId: removed.undo!.undoId})).toThrow("Access changed");
  expect(storage.getShareGrant("bob")?.status).toBe("revoked");
});

it("refuses a dependent Undo if the owner narrowed its parent link", async () => {
  const {storage} = await fixture();
  const result = storage.removeShareAccess({...removal, grantId: "dependent"}); if (!result.ok || !result.undo) throw Error("failed");
  expect(storage.retuneShareGrant({shareId: "s", grantId: "link", access: "view", changedAtMs: 3100,
    expectedDependentGrantIds: [], guard: storage.captureStanding()})).toMatchObject({ok: true});
  expect(() => storage.undoShareRemoval({...removal, undoId: result.undo!.undoId})).toThrow("parent link no longer allows");
  expect(storage.getShareGrant("dependent")?.status).toBe("revoked");
});

it.each(["startup", "sweep", "failed removal", "failed guard"])("purges expired receipts on %s", async action => {
  let {storage} = await fixture();
  storage.removeShareAccess({...removal, grantId: "named"});
  const nowMs = removal.nowMs + SHARE_REMOVAL_UNDO_MS;
  const retained = storage.removeShareAccess({...removal, grantId: "link", nowMs: removal.nowMs + 1});
  if (!retained.ok || !retained.undo) throw Error("removal failed");
  if (action === "startup") {
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const path = storagePath(storage); closeTestStorage(storage); storage = reopenTestStorage(path);
  } else if (action === "sweep") storage.purgeExpiredShareRemovals(nowMs);
  else if (action === "failed guard") {
    expect(() => storage.removeShareAccess({...removal, nowMs, guard: () => {throw Error("guard failed");}})).toThrow("guard failed");
  } else expect(() => storage.removeShareAccess({...removal, nowMs, grantId: "missing"})).toThrow("not found");
  expect((storage as StorageContext).db.prepare("SELECT undo_id FROM sync_relay_share_removals").all())
    .toEqual([{undo_id: retained.undo.undoId}]);
});

it.each([false, true])("retains proposal content for Undo and releases it at expiry (%s)", async expire => {
  let {storage} = await fixture();
  const sha256 = "b".repeat(64);
  storage.putBlob({workspaceId: "w", sha256, content: Buffer.from("proposal"), createdAtMs: 1});
  for (const proposalId of ["open", "declined", "accepted", "withdrawn"]) {
    storage.insertShareProposal({proposalId, shareId: "s", workspaceId: "w", proposedByUserId: "reader",
      versionId: "version", submitId: proposalId, createdAtMs: 2,
      ops: [{opIndex: 0, basedOnPath: null, basedOnObjectId: null, basedOnBlobSha256: null, operation: "write",
        afterPath: "private/proposal.txt", afterBlobSha256: sha256, afterContentKind: "text", afterByteLength: 8, recordedAtMs: 2}]});
    if (proposalId !== "open") storage.settleShareProposal(proposalId, proposalId as "declined" | "accepted" | "withdrawn", 3);
  }
  const removed = storage.removeShareAccess(removal);
  if (!removed.ok || !removed.undo) throw Error("removal failed");
  expect(storage.getShareProposal("open")).toMatchObject({state: "declined", settledAtMs: 3000});
  expect(await storage.collectUnreferencedBlobs("w", {nowMs: 4000})).toMatchObject({removed: 0});
  if (expire) {
    expect(await storage.collectUnreferencedBlobs("w", {nowMs: removed.undo.expiresAtMs})).toMatchObject({removed: 1});
    expect(storage.getShareProposal("open")?.state).toBe("declined");
  } else {
    vi.spyOn(Date, "now").mockReturnValue(4000);
    const path = storagePath(storage); closeTestStorage(storage); storage = reopenTestStorage(path, {blobGraceMs: 0});
    storage.undoShareRemoval({...removal, undoId: removed.undo.undoId, nowMs: 4000});
    expect(storage.getShareProposal("open")).toMatchObject({state: "open", settledAtMs: null});
    expect(await storage.collectUnreferencedBlobs("w", {nowMs: removed.undo.expiresAtMs})).toMatchObject({removed: 0});
    expect(storage.getBlob("w", sha256)).toEqual(Buffer.from("proposal"));
  }
  for (const state of ["declined", "accepted", "withdrawn"]) expect(storage.getShareProposal(state)?.state).toBe(state);
});
