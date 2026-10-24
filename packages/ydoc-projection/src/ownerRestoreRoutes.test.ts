import {afterEach, expect, it, vi} from "vitest";
import {registered, cleanupLiveDeliveryFixtures} from "./liveCommittedDeliveryTestSupport.js";
import {attachLiveJournalHistory, createLiveJournalHistoryAuthority} from "../../../services/sync-relay/src/storage/liveJournalHistory.js";
import type {StorageContext} from "../../../services/sync-relay/src/storage/context.js";
import {testHandler} from "../../../services/sync-relay/src/testing/index.js";
import type {OwnerRestoreHost} from "../../../services/sync-relay/src/ownerRestoreRoutes.js";
import {SyncRelayQuotaExceededError} from "../../../services/sync-relay/src/storage/errors.js";

afterEach(cleanupLiveDeliveryFixtures);
function fixture() {
  const f = registered();
  attachLiveJournalHistory(f.storage as StorageContext, createLiveJournalHistoryAuthority({namespace: "restore-history", reconciled: true}));
  const host: OwnerRestoreHost = {
    restoreConfigured: true,
    prepareRestore: vi.fn<OwnerRestoreHost["prepareRestore"]>().mockRejectedValue(Error("host offline")),
    reviewRestore: vi.fn<OwnerRestoreHost["reviewRestore"]>().mockImplementation(async () => ({
      review: null, close: vi.fn(), invalidated: new AbortController().signal, maxOutputBytes: 100_000,
    })),
    confirmRestore: vi.fn<OwnerRestoreHost["confirmRestore"]>().mockRejectedValue(Error("proposal missing")),
  };
  const handler = testHandler(f.storage, {ownerRestoreHost: () => host, newId: () => "restore"});
  const request = (suffix: string, body?: unknown, user = "owner", workspace = "workspace") => handler(new Request(
    `https://relay.test/sync/${workspace}/live-restores${suffix}`, {method: body === undefined ? "GET" : "POST",
      headers: {authorization: `Bearer user:${user}`, "content-type": "application/json"},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})}));
  const planInput = {document: f.input.evidence.document, shareId: "share", grantId: "grant", restorePointCursor: 0,
    restorePointReceiptDigest: f.input.evidence.checkpoint.updateDigest};
  const plan = async () => {const r = await request("/plan", planInput); expect(r.status).toBe(200); return r.json();};
  return {...f, host, request, planInput, plan};
}

it("previews exact access without mutating it, then stops access without replacing content", async () => {
  const f = fixture();
  try {
    const before = f.rows(), plan = await f.plan();
    expect(plan.recipients).toEqual([{grantId: "grant", principalKind: "user", userId: "reader", email: null}]);
    expect(plan.intent).not.toHaveProperty("ownerUserId");
    expect(f.rows()).toEqual(before);
    const stopped = await f.request("", {intent: plan.intent});
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({operationId: "restore", phase: "authority-invalidated"});
    expect(f.storage.getShareGrant("grant")).toMatchObject({status: "revoked"});
    expect(f.rows().documents).toEqual(before.documents);
    expect(f.host.prepareRestore).not.toHaveBeenCalled();
    expect(f.host.confirmRestore).not.toHaveBeenCalled();
    expect((await f.request("", {intent: plan.intent})).status).toBe(200);
    expect(await (await f.request("/restore")).json()).toMatchObject({phase: "authority-invalidated"});
  } finally {f.close();}
});

it.each(["plan", "begin", "status", "prepare", "review", "confirm", "decline", "unfinished"])("refuses a recipient at the %s boundary", async action => {
  const f = fixture();
  try {
    const plan = await f.plan(); await f.request("", {intent: plan.intent});
    const suffix = action === "plan" ? "/plan" : action === "begin" ? "" : action === "status" ? "/restore" : action === "unfinished" ? "/unfinished" : `/restore/${action}`;
    const body = action === "status" || action === "unfinished" ? undefined : action === "plan" ? f.planInput : action === "begin" ? {intent: plan.intent}
      : action === "confirm" ? {proposalDigest: "a".repeat(64)} : {};
    expect((await f.request(suffix, body, "reader")).status).toBe(404);
    expect(f.host.prepareRestore).not.toHaveBeenCalled(); expect(f.host.reviewRestore).not.toHaveBeenCalled(); expect(f.host.confirmRestore).not.toHaveBeenCalled();
    expect(f.storage.readStopRestore({workspaceId: "workspace", ownerUserId: "owner", operationId: "restore"})?.phase).toBe("authority-invalidated");
  } finally {f.close();}
});

// Proves: the owner finds each unfinished restore of the workspace, can end
// one before its fence without the host, and access stays stopped. A
// declined restore is no longer listed and no later step reopens it.
it("lists an unfinished restore and declines it before its fence", async () => {
  const f = fixture();
  try {
    const plan = await f.plan(); await f.request("", {intent: plan.intent});
    expect(await (await f.request("/unfinished")).json()).toEqual({restores: [{operationId: "restore", path: plan.path,
      phase: "authority-invalidated", proposalDigest: null}], unreadable: 0, nextCursor: null});
    const declined = await f.request("/restore/decline", {});
    expect(declined.status).toBe(200);
    expect(await declined.json()).toMatchObject({operationId: "restore", phase: "declined"});
    expect(f.storage.getShareGrant("grant")).toMatchObject({status: "revoked", generation: 5});
    expect(await (await f.request("/unfinished")).json()).toEqual({restores: [], unreadable: 0, nextCursor: null});
    const prepared = await f.request("/restore/prepare", {});
    expect(prepared.status).toBe(409);
    expect(await prepared.json()).toMatchObject({status: {phase: "declined"}, result: {kind: "pending"}});
    expect(f.host.prepareRestore).not.toHaveBeenCalled();
    expect(f.rows().documents[0]).toMatchObject({admission_state: "open", restore_fence_generation: 1});
  } finally {f.close();}
});

// Proves: once live editing of the file stopped for the restore, Decline says
// why it is refused and changes nothing.
it("refuses Decline after the fence with a conflict that says why", async () => {
  const f = fixture();
  try {
    const plan = await f.plan(); await f.request("", {intent: plan.intent});
    expect((await f.request("/restore/prepare", {})).status).toBe(409);
    const before = f.rows();
    const declined = await f.request("/restore/decline", {});
    expect(declined.status).toBe(409);
    expect(await declined.json()).toEqual({ok: false, code: "conflict",
      error: "Live editing of this file stopped for the restore, so it can no longer be declined. Retry to finish it."});
    expect(f.rows()).toEqual(before);
    expect(await (await f.request("/unfinished")).json()).toMatchObject({restores: [{operationId: "restore", phase: "fenced"}]});
  } finally {f.close();}
});

// Proves: a full workspace is the one cause a waiting restore names, at
// preparation and at admission.
it("names a full workspace when preparation or admission runs out of quota", async () => {
  const f = fixture();
  try {
    const plan = await f.plan(); await f.request("", {intent: plan.intent});
    const full = new SyncRelayQuotaExceededError("workspace storage quota exceeded");
    vi.mocked(f.host.prepareRestore).mockRejectedValueOnce(full);
    vi.mocked(f.host.confirmRestore).mockRejectedValueOnce(full);
    expect(await (await f.request("/restore/prepare", {})).json()).toMatchObject({result: {kind: "pending", cause: "quota"}});
    expect(await (await f.request("/restore/confirm", {proposalDigest: "a".repeat(64)})).json()).toMatchObject({result: {kind: "review-required", cause: "quota"}});
    expect(await (await f.request("/restore/prepare", {})).json()).toEqual({status: expect.anything(), result: {kind: "pending"}});
  } finally {f.close();}
});

it("refuses owner injection and document substitution without revocation", async () => {
  const f = fixture();
  try {
    const plan = await f.plan();
    for (const intent of [
      {...plan.intent, ownerUserId: "owner"},
      {...plan.intent, document: {...plan.intent.document, workspaceId: "other"}},
      {...plan.intent, document: {...plan.intent.document, objectId: "other"}},
    ]) expect((await f.request("", {intent})).status).not.toBe(200);
    expect(f.storage.getShareGrant("grant")).toMatchObject({status: "active", generation: 4});
    expect(f.host.confirmRestore).not.toHaveBeenCalled();
  } finally {f.close();}
});

it("shows every dependent and refuses a changed set before stopping the link", async () => {
  const f = fixture();
  try {
    f.write(db => {
      db.exec("UPDATE sync_relay_share_grants SET principal_kind='link',principal_user_id=NULL WHERE grant_id='grant'");
      db.exec("INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id) VALUES('dependent','share','user','reader',NULL,'edit',2,'active',0,NULL,'grant')");
    });
    const plan = await f.plan();
    expect(plan.recipients.map((r: {grantId: string}) => r.grantId)).toEqual(["grant", "dependent"]);
    expect(plan.intent.expectedDependentGrantIds).toEqual(["dependent"]);
    f.write(db => db.exec("INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,access,generation,status,created_at_ms,parent_grant_id) VALUES('later','share','user','later-reader','edit',1,'active',0,'grant')"));
    expect((await f.request("", {intent: plan.intent})).status).not.toBe(200);
    expect(f.storage.getShareGrant("grant")).toMatchObject({status: "active"});
  } finally {f.close();}
});

it("returns a missing proposal to review and preserves offline preparation for retry", async () => {
  const f = fixture();
  try {
    const plan = await f.plan(); await f.request("", {intent: plan.intent});
    const prepared = await f.request("/restore/prepare", {});
    expect(prepared.status).toBe(409);
    expect(await prepared.json()).toMatchObject({status: {operationId: "restore", phase: "fenced"}, result: {kind: "pending"}});
    const confirmed = await f.request("/restore/confirm", {proposalDigest: "a".repeat(64)});
    expect(confirmed.status).toBe(409);
    expect(await confirmed.json()).toMatchObject({result: {kind: "review-required"}});
    expect(f.host.confirmRestore).toHaveBeenCalledWith({workspaceId: "workspace", ownerUserId: "owner", operationId: "restore"}, "a".repeat(64), expect.any(AbortSignal));
    expect(f.storage.getShareGrant("grant")).toMatchObject({status: "revoked"});
  } finally {f.close();}
});

it("closes admission before host preparation and preserves the same cut on retry", async () => {
  const f = fixture();
  try {
    const plan = await f.plan(); await f.request("", {intent: plan.intent});
    const lookup = {workspaceId: "workspace", ownerUserId: "owner", operationId: "restore"};
    let cut: unknown;
    vi.mocked(f.host.prepareRestore).mockImplementation(async () => {
      const operation = f.storage.readStopRestore(lookup)!;
      expect(operation.phase).toBe("fenced");
      expect(operation.newFence).toBe(operation.oldFence + 1);
      if (cut) expect(operation).toEqual(cut);
      else {
        cut = operation;
        throw Error("Host disconnected after admission closed");
      }
      return {kind: "pending", reason: "Host unavailable"};
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await f.request("/restore/prepare", {});
      expect(response.status).toBe(attempt === 0 ? 409 : 200);
      expect(await response.json()).toMatchObject({status: {phase: "fenced"}, result: {kind: "pending"}});
      expect(f.storage.readStopRestore(lookup)).toEqual(cut);
    }
    expect(f.host.prepareRestore).toHaveBeenCalledTimes(2);
  } finally {f.close();}
});

// Proves: while live editing of the document is still stopping, plan and begin
// answer a retryable conflict that says why, and access stays as it was.
it("refuses a restore while live editing is still stopping with a conflict that says why", async () => {
  const f = fixture();
  try {
    const plan = await f.plan(), document = f.input.evidence.document;
    f.write(db => db.prepare(`INSERT INTO sync_relay_service_activations(relay_database_namespace,activation_id,workspace_id,main_version_id,object_id,lineage_claim_id,
        source_json,binding_json,state_digest,state_bytes,owner_user_id,share_id,completion_json,accounted_bytes,retire_requested_at_ms,retire_restore_generation,retire_accepted_cursor)
        VALUES ('restore-history',?,?,'main',?,?,'{}','{}',?,x'0000','owner','share','{}',1,10,1,0)`)
      .run(`ordinary-activation-${"d".repeat(64)}`, document.workspaceId, document.objectId, document.lineageClaimId, document.lineageClaimId));
    for (const [suffix, body] of [["/plan", f.planInput], ["", {intent: plan.intent}]] as const) {
      const response = await f.request(suffix, body);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ok: false, code: "conflict", error: "Live editing is still stopping. Try again in a moment."});
    }
    expect(f.storage.getShareGrant("grant")).toMatchObject({status: "active", generation: 4});
  } finally {f.close();}
});

it("refuses an incomplete affected-access preview without changing authority", () => {
  const f = fixture();
  try {
    const input = {...f.planInput, operationId: "restore", ownerUserId: "owner", maxOutputBytes: 100_000};
    const plan = f.storage.readStopRestorePlan(input), exact = Buffer.byteLength(JSON.stringify(plan)), before = f.rows();
    expect(f.storage.readStopRestorePlan({...input, maxOutputBytes: exact})).toEqual(plan);
    expect(() => f.storage.readStopRestorePlan({...input, maxOutputBytes: exact - 1})).toThrow(/output budget/);
    expect(f.rows()).toEqual(before);
  } finally {f.close();}
});
