
import { insertShare, insertShareGrant } from "./storage/shares";
import type { StorageContext } from "./storage/context";
import { afterEach, expect, it, vi } from "vitest";
import { closeTestStorages, testStorage, testHandler, request, seedLinkGrant, seedDependentGrant,
  closeTestStorage, storagePath, reopenTestStorage } from "./testing";
import { SHARE_REMOVAL_UNDO_MS } from "./storage/shareRemoval";
import { hashLinkBearer } from "./linkSecurity";
import { LINK_KEY } from "./testing";
import { readCurrentShareGrant } from "./storage/currentShareGrant";
import { createNamedLiveBrowserResolver } from "./namedLiveBrowserAuth";

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

it.each([SHARE_REMOVAL_UNDO_MS, SHARE_REMOVAL_UNDO_MS + 1])("refuses undo at or after expiry (%i)", async offset => {
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

it("does not return a single-grant receipt for a no-op whole-share removal", async () => {
  const {storage} = await fixture();
  storage.removeShareAccess({...removal, grantId: "named"});
  storage.removeShareAccess({...removal, grantId: "link"});
  const context = storage as StorageContext;
  const receipts = context.db.prepare("SELECT undo_id FROM sync_relay_share_removals").all();
  const h = testHandler(storage, {nowMs: () => 4000});
  const response = await h(request("owner", "/sync/shares/s/revoke", post()));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ok: true, shareId: "s"});
  expect(context.db.prepare("SELECT undo_id FROM sync_relay_share_removals").all()).toEqual(receipts);
  for (const receipt of receipts) {
    expect(() => storage.undoShareRemoval({...removal, undoId: String(receipt.undo_id)})).not.toThrow();
  }
});

it("retries Stop sharing with the newest whole-share receipt without extending its expiry", async () => {
  const {storage} = await fixture();
  const first = storage.removeShareAccess(removal);
  if (!first.ok || !first.undo) throw Error("removal failed");
  storage.undoShareRemoval({...removal, undoId: first.undo.undoId});
  const latest = storage.removeShareAccess(removal);
  if (!latest.ok || !latest.undo) throw Error("removal failed");
  const h = testHandler(storage, {nowMs: () => 4000});
  const response = await h(request("owner", "/sync/shares/s/revoke", post()));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ok: true, shareId: "s", undo: latest.undo});
  storage.undoShareRemoval({...removal, undoId: latest.undo.undoId, nowMs: 4000});
  expect(storage.getShareGrant("named")?.status).toBe("active");
});

it.each(["expired", "voided", "changed"])("does not return a %s whole-share receipt", async state => {
  const {storage} = await fixture();
  const result = storage.removeShareAccess(removal);
  if (!result.ok || !result.undo) throw Error("removal failed");
  const context = storage as StorageContext;
  if (state === "voided") context.tx(() => context.db.prepare(
    "UPDATE sync_relay_share_removals SET voided = 1").run());
  if (state === "changed") context.tx(() => context.db.prepare(
    "UPDATE sync_relay_share_grants SET generation = generation + 1 WHERE grant_id = 'named'").run());
  expect(storage.removeShareAccess({...removal, nowMs: state === "expired" ? result.undo.expiresAtMs : 4000}))
    .toEqual({ok: true, grant: null});
});

it.each([false, true])("link removal permanently voids an earlier dependent receipt (undo link: %s)", async undoLink => {
  const {storage} = await fixture();
  const dependent = storage.removeShareAccess({...removal, grantId: "dependent"});
  if (!dependent.ok || !dependent.undo) throw Error("removal failed");
  const link = storage.removeShareAccess({...removal, grantId: "link"});
  if (!link.ok || !link.undo) throw Error("removal failed");
  if (undoLink) storage.undoShareRemoval({...removal, undoId: link.undo.undoId});
  expect(() => storage.undoShareRemoval({...removal, undoId: dependent.undo!.undoId})).toThrow("Access changed");
  expect(storage.getShareGrant("dependent")?.status).toBe("revoked");
  const context = storage as StorageContext;
  expect(context.db.prepare("SELECT voided FROM sync_relay_share_removals WHERE undo_id = ?")
    .get(dependent.undo.undoId)).toEqual({voided: 1});
  context.tx(() => context.db.prepare("UPDATE sync_relay_share_removals SET voided = 0 WHERE undo_id = ?")
    .run(dependent.undo!.undoId));
  expect(() => storage.undoShareRemoval({...removal, undoId: dependent.undo!.undoId})).toThrow("Access changed");
});

it("declines open proposals and releases their blobs when stopping an already-empty share", async () => {
  const {storage} = await fixture();
  const sha256 = "c".repeat(64);
  storage.putBlob({workspaceId: "w", sha256, content: Buffer.from("proposal"), createdAtMs: 1});
  storage.insertShareProposal({proposalId: "open", shareId: "s", workspaceId: "w", proposedByUserId: "reader",
    versionId: "version", submitId: "open", createdAtMs: 2,
    ops: [{opIndex: 0, basedOnPath: null, basedOnObjectId: null, basedOnBlobSha256: null, operation: "write",
      afterPath: "private/proposal.txt", afterBlobSha256: sha256, afterContentKind: "text", afterByteLength: 8, recordedAtMs: 2}]});
  storage.removeShareAccess({...removal, grantId: "named"});
  storage.removeShareAccess({...removal, grantId: "link"});
  expect(storage.getShareProposal("open")?.state).toBe("open");
  expect(await storage.collectUnreferencedBlobs("w", {nowMs: 4000})).toMatchObject({removed: 0});
  storage.removeShareAccess({...removal, nowMs: 4000});
  expect(storage.getShareProposal("open")).toMatchObject({state: "declined", settledAtMs: 4000});
  expect(await storage.collectUnreferencedBlobs("w", {nowMs: 4001})).toMatchObject({removed: 1});
});

it("refuses a dependent Undo if the owner narrowed its parent link", async () => {
  const {storage} = await fixture();
  const result = storage.removeShareAccess({...removal, grantId: "dependent"}); if (!result.ok || !result.undo) throw Error("failed");
  expect(storage.retuneShareGrant({shareId: "s", grantId: "link", access: "view", changedAtMs: 3100,
    expectedDependentGrantIds: [], guard: storage.captureStanding()})).toMatchObject({ok: true});
  expect(() => storage.undoShareRemoval({...removal, undoId: result.undo!.undoId})).toThrow("parent link no longer allows");
  expect(storage.getShareGrant("dependent")?.status).toBe("revoked");
});

it("claims a revoked email invitation only after Undo and email verification", async () => {
  const {storage} = await fixture();
  storage.createShare({share: {...storage.getShare("s")!, shareId: "pending"}, grant: {...storage.getShareGrant("named")!,
    shareId: "pending", grantId: "pending-grant", principalKind: "email", principalUserId: null, principalEmail: "invited@dohc.test"}});
  const removed = storage.removeShareAccess({...removal, shareId: "pending"});
  if (!removed.ok || !removed.undo) throw Error("removal failed");
  const unverified = testHandler(storage, {lookupVerifiedUserEmail: () => null});
  expect((await (await unverified(request("invited", "/sync/shares"))).json() as {removed: unknown[]}).removed).toEqual([]);
  const verified = testHandler(storage, {nowMs: () => 4000});
  expect((await (await verified(request("invited", "/sync/shares"))).json() as {removed: unknown[]}).removed)
    .toEqual([]);
  expect(storage.getShareGrant("pending-grant")).toMatchObject({principalKind: "email", principalUserId: null});
  storage.undoShareRemoval({...removal, shareId: "pending", undoId: removed.undo.undoId, nowMs: 4000});
  await unverified(request("invited", "/sync/shares"));
  expect(storage.getShareGrant("pending-grant")?.principalKind).toBe("email");
  const listed = await (await verified(request("invited", "/sync/shares"))).json();
  expect(listed).toMatchObject({received: [{shareId: "pending"}], removed: []});
  expect(storage.getShareGrant("pending-grant")).toMatchObject({principalKind: "user", principalUserId: "invited"});
});

it.each([false, true])("whole-share removal prevents an earlier link Undo, even after its own Undo (%s)", async undoWhole => {
  const {storage, secret} = await fixture();
  const link = storage.removeShareAccess({...removal, grantId: "link"});
  if (!link.ok || !link.undo) throw Error("removal failed");
  const whole = storage.removeShareAccess(removal);
  if (!whole.ok || !whole.undo) throw Error("removal failed");
  if (undoWhole) storage.undoShareRemoval({...removal, undoId: whole.undo.undoId});
  expect(() => storage.undoShareRemoval({...removal, undoId: link.undo!.undoId})).toThrow("Access changed");
  expect(storage.getShareGrant("link")?.status).toBe("revoked");
  expect(storage.getShareGrant("dependent")?.status).toBe("revoked");
  expect(storage.findLinkGrantByCredentialHash(hashLinkBearer(secret, LINK_KEY))?.credential.retiredAtMs).not.toBeNull();
  const h = testHandler(storage, {nowMs: () => 4000});
  expect((await h(request(null, "/sync/link-exchange", post({secret})))).status).toBe(404);
});

it("checks for later covering receipts independently of the void marker", async () => {
  const {storage} = await fixture();
  const link = storage.removeShareAccess({...removal, grantId: "link"});
  if (!link.ok || !link.undo) throw Error("removal failed");
  storage.removeShareAccess(removal);
  (storage as StorageContext).tx(() => (storage as StorageContext).db.prepare(
    "UPDATE sync_relay_share_removals SET voided = 0 WHERE undo_id = ?").run(link.undo!.undoId));
  expect(() => storage.undoShareRemoval({...removal, undoId: link.undo!.undoId})).toThrow("Access changed");
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

it("deduplicates multiple removed grants on the same share", async () => {
  const {storage} = await fixture();
  insertShareGrant(storage as StorageContext, {...storage.getShareGrant("named")!, grantId: "second"});
  storage.removeShareAccess(removal);
  expect(storage.listRemovedSharesForRecipient("reader")).toHaveLength(1);
});

it("bounds the removed list without hiding an exact removed-share lookup", async () => {
  const {storage} = await fixture();
  const context = storage as StorageContext;
  context.tx(() => {
    for (let index = 0; index < 1001; index++) {
      insertShare(context, {...storage.getShare("s")!, shareId: "removed-" + index});
      insertShareGrant(context, {...storage.getShareGrant("named")!, grantId: "removed-grant-" + index,
        shareId: "removed-" + index, status: "revoked", revokedAtMs: 5000 + index, generation: 2});
    }
  });
  expect(storage.listRemovedSharesForRecipient("reader")).toHaveLength(1000);
  expect(storage.listRemovedSharesForRecipient("reader", "removed-0")).toHaveLength(1);
});
