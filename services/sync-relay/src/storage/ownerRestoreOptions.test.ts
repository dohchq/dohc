import {afterEach, describe, expect, it, vi} from "vitest";
import {fixture as ticketFixture, binding, scope, host} from "../liveTickets.test-helper";
import {createLiveJournalHistoryAuthority} from "./liveJournalHistory";
import type {StorageContext} from "./context";
import {MAX_LOG_PAGE_SIZE, MAX_PAYLOAD_JSON_BYTES} from "../wireLimits";
import {createOwnerRestoreRoutes} from "../ownerRestoreRoutes";
import {createSyncRelayHandler} from "../server";
import {advanceStopRestoreFence} from "./liveRestoreOperation";
import {restoreDigest} from "./liveRestoreCheckpoint";

const ownerUserId = "owner-1", namespace = "restore-options-history";
const document = {workspaceId: binding.workspaceId, mainVersionId: binding.mainVersionId,
  objectId: binding.objectId, lineageClaimId: binding.lineageClaimId};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close();});
async function fixture() {
  const f = await ticketFixture(); cleanups.push(f.close);
  const context = f.storage as StorageContext;
  const store = f.storage.createLiveCommittedDeliveryStore(createLiveJournalHistoryAuthority({namespace, reconciled: true}));
  const input = {workspaceId: scope.workspaceId, ownerUserId, path: binding.currentPath};
  const read = (beforeCursor?: number) => f.storage.readOwnerRestoreOptions({...input, ...(beforeCursor === undefined ? {} : {beforeCursor})});
  const point = (cursor: number, receivedAtMs = cursor, objectId = binding.objectId) => {
    // These rows exercise metadata paging. Native admission proofs have separate tests.
    f.raw.prepare(`INSERT INTO sync_relay_live_update_journal
      (journal_cursor,delivery_id,update_digest,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,
       selector_paths_json,restore_fence_generation,principal_kind,principal_id,grant_id,grant_generation,
       accepting_host_epoch,received_at_ms,update_bytes,relay_database_namespace,accepted_event_count,accepted_evidence_digest,accepted_metadata_bytes)
      VALUES (?, ?, ?, ?, 'main', ?, ?, ?, '["docs"]', 7, 'named', 'reader-1', 'edit-1', 4, 1, ?, x'0000', ?, ?, ?, 1)`)
      .run(cursor, `delivery-${cursor}`, "c".repeat(64), scope.workspaceId, objectId, binding.lineageClaimId,
        binding.currentPath, receivedAtMs, namespace, cursor, "d".repeat(64));
  };
  const begin = () => {
    const plan = f.storage.readStopRestorePlan({operationId: "restore", ownerUserId, document,
      shareId: scope.shareId, grantId: scope.grantId, restorePointCursor: 0,
      restorePointReceiptDigest: binding.lineageClaimId, maxOutputBytes: MAX_PAYLOAD_JSON_BYTES});
    return f.storage.beginStopRestore(plan.intent, 100);
  };
  return {...f, context, input, read, point, begin, store};
}

function nativeFenced(f: Awaited<ReturnType<typeof fixture>>) {
  f.begin();
  const lookup = {workspaceId: scope.workspaceId, ownerUserId, operationId: "restore"};
  advanceStopRestoreFence(f.context, lookup, 110);
  const input = {...lookup, host}, opened = f.store.openStopRestoreCut(input);
  if (opened.kind !== "ready") throw new Error("Expected a stop cut.");
  const next = f.store.nextStopRestoreCut(opened.capture);
  if (next.kind !== "bootstrap") throw new Error("Expected the initial bootstrap.");
  f.store.acknowledgeStopRestoreBootstrap(opened.capture, {bootstrapId: next.baseline.bootstrapId,
    bootstrapMomentId: next.baseline.bootstrapMomentId, baselineDigest: next.baseline.baselineDigest,
    baselineMomentRelaySequence: next.baseline.baselineMomentRelaySequence, localYDocSequence: 0, bootstrapReplayed: false});
  f.store.completeStopRestoreCut(opened.capture); f.store.closeStopRestoreCut(opened.capture);
  const operation = f.store.pendingStopRestoreFence(input).operation;
  const fence = f.store.acknowledgeStopRestoreFence(input, {operation, localHeadSequence: 0, recordedAtMs: 120});
  return {lookup, fence};
}

function retainedLifecycle(f: Awaited<ReturnType<typeof fixture>>, phase: "relay-admitted" | "resumed") {
  const {lookup, fence} = nativeFenced(f), proposalDigest = "e".repeat(64), candidateDigest = "c".repeat(64);
  const nextBinding = {...fence.operation.oldBinding, restoreFenceGeneration: fence.operation.newFence};
  const receipt = {deliveryId: "restore-delivery", updateDigest: candidateDigest, journalCursor: 1, acceptingHostEpoch: host.hostEpoch};
  const admitted = {accepted: {receipt, binding: nextBinding,
    authority: {principalKind: "owner", principalId: ownerUserId, grantId: null, grantGeneration: null}, receivedAtMs: 130}, firstSeen: []};
  const point = {journalCursor: 0, receiptDigest: binding.lineageClaimId, markdownDigest: "b".repeat(64), projectionDigest: "f".repeat(64)};
  const admission = {proposalDigest, candidateDigest, preparation: {fence, point}, nativeSourceManifestDigest: "a".repeat(64),
    admitted, checkpointDigest: "d".repeat(64), sourceRanges: [], recordedAtMs: 130};
  const application = phase === "resumed" ? {fence, candidateDigest, nativeSourceManifestDigest: admission.nativeSourceManifestDigest,
    admitted, localHeadSequence: 1, hostCoordinate: {hostId: host.hostId, hostEpoch: host.hostEpoch, instanceId: host.instanceId,
      connectionId: host.connectionId}, recordedAtMs: 140} : null;
  const settlement = phase === "resumed" ? {settlementId: "settlement", previousCursor: 0, terminalCursor: 1,
    applicationCount: 1, localYDocSequence: 1, momentId: "restored-moment", markdownDigest: point.markdownDigest,
    materialized: true, collectionReconcileRequired: false} : null;
  const resume = phase === "resumed" ? {relayDatabaseNamespace: namespace, operationId: lookup.operationId, binding: nextBinding,
    applicationReceipt: receipt, settlementId: settlement!.settlementId, momentId: settlement!.momentId,
    markdownDigest: point.markdownDigest, localHeadSequence: 1, recordedAtMs: 150} : null;
  // Synthetic retained receipts isolate metadata authentication from native execution.
  f.raw.prepare(`INSERT INTO sync_relay_live_restore_proposals VALUES (?,?,?,x'00',?,?,?,130,1)`)
    .run(lookup.operationId, namespace, scope.workspaceId, proposalDigest, candidateDigest, "f".repeat(64));
  const json = JSON.stringify(admission), hash = restoreDigest(admission), limit = MAX_PAYLOAD_JSON_BYTES;
  const receiptJson = [application, settlement, resume].map(value => value === null ? null : JSON.stringify(value));
  const bytes = Buffer.byteLength(JSON.stringify([namespace, lookup.operationId, scope.workspaceId, limit, json, hash])) +
    receiptJson.reduce<number>((sum, value) => sum + (value === null ? 0 : Buffer.byteLength(value)), 0);
  f.raw.prepare(`INSERT INTO sync_relay_live_restore_lifecycles
    (relay_database_namespace,operation_id,workspace_id,max_evidence_bytes,admission_json,admission_sha256,
     application_json,settlement_json,resume_json,receipt_reservation_bytes,accounted_bytes) VALUES (?,?,?,?,?,?,?,?,?,0,?)`)
    .run(namespace, lookup.operationId, scope.workspaceId, limit, json, hash, ...receiptJson, bytes);
  f.raw.prepare("UPDATE sync_relay_live_restore_operations SET phase=? WHERE operation_id=?").run(phase, lookup.operationId);
  return {lookup, proposalDigest};
}

describe("owner restore options", () => {
  it("returns the current document and baseline without inventing a receipt time", async () => {
    const f = await fixture();
    expect(f.read()).toEqual({document, path: binding.currentPath, grants: [{shareId: scope.shareId,
      grantId: scope.grantId, generation: 4, principalKind: "user", userId: scope.userId, email: null}],
      points: [{cursor: 0, receivedAtMs: null, kind: "baseline", receiptDigest: binding.lineageClaimId}],
      nextBeforeCursor: null, pendingOperation: null});
  });

  it("checks the trusted workspace owner before document or grant reads", async () => {
    const f = await fixture(), query = vi.spyOn(f.context.db, "prepare");
    expect(() => f.storage.readOwnerRestoreOptions({...f.input, ownerUserId: "reader-1"})).toThrow("not found");
    expect(query.mock.calls.some(([sql]) => /live_documents|share_grants|live_restore_operations/.test(sql))).toBe(false);
  });

  it("keeps cursor order when receipt timestamps run backwards and rejects a foreign cursor", async () => {
    const f = await fixture(); f.point(2, 300); f.point(5, 100); f.point(8, 200, "other-object");
    expect(f.read().points.map(p => [p.cursor, p.receivedAtMs])).toEqual([[5, 100], [2, 300], [0, null]]);
    expect(f.read(5).points.map(p => p.cursor)).toEqual([2, 0]);
    expect(() => f.read(8)).toThrow("no longer retained");
    f.raw.prepare("DELETE FROM sync_relay_live_update_journal WHERE journal_cursor=5").run();
    expect(() => f.read(5)).toThrow("no longer retained");
  });

  it("pages every accepted point and baseline within the existing page limit", async () => {
    const f = await fixture();
    f.raw.exec("BEGIN");
    try {for (let cursor = 1; cursor <= MAX_LOG_PAGE_SIZE + 1; cursor++) f.point(cursor); f.raw.exec("COMMIT");}
    catch (error) {f.raw.exec("ROLLBACK"); throw error;}
    const first = f.read(); expect(first.points).toHaveLength(MAX_LOG_PAGE_SIZE); expect(first.nextBeforeCursor).toBe(2);
    const last = f.read(first.nextBeforeCursor!); expect(last.points.map(p => p.cursor)).toEqual([1, 0]);
    expect(last.nextBeforeCursor).toBeNull();
  });

  it("keeps baseline on the next page when accepted points exactly fill a page", async () => {
    const f = await fixture();
    f.raw.exec("BEGIN");
    try {for (let cursor = 1; cursor <= MAX_LOG_PAGE_SIZE; cursor++) f.point(cursor); f.raw.exec("COMMIT");}
    catch (error) {f.raw.exec("ROLLBACK"); throw error;}
    const first = f.read(); expect(first.nextBeforeCursor).toBe(1);
    expect(f.read(1).points.map(p => p.cursor)).toEqual([0]);
  });

  it("excludes read-only, historical, nonmatching, and revoked grants", async () => {
    const f = await fixture();
    for (const [id, selector, access, status] of [
      ["read", {paths: ["docs"], versionId: null}, "read", "active"],
      ["history", {paths: ["docs"], versionId: "old"}, "edit", "active"],
      ["other-path", {paths: ["elsewhere"], versionId: null}, "edit", "active"],
      ["revoked", {paths: ["docs"], versionId: null}, "edit", "revoked"],
    ] as const) {
      f.raw.prepare("INSERT INTO sync_relay_shares (share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,?, ?,0)")
        .run(id, scope.workspaceId, ownerUserId, JSON.stringify(selector));
      f.raw.prepare(`INSERT INTO sync_relay_share_grants (grant_id,share_id,principal_kind,principal_user_id,access,generation,status,created_at_ms,revoked_at_ms)
        VALUES (?,?,'user','another',?,1,?,0,?)`).run(id, id, access, status, status === "revoked" ? 1 : null);
    }
    expect(f.read().grants.map(g => g.grantId)).toEqual([scope.grantId]);
  });

  it("returns safe link and email recipient summaries without credentials", async () => {
    const f = await fixture();
    f.raw.prepare(`INSERT INTO sync_relay_share_grants (grant_id,share_id,principal_kind,principal_email,access,generation,status,created_at_ms)
      VALUES ('email',?,'email','person@example.test','edit',1,'active',0)`).run(scope.shareId);
    f.raw.prepare(`INSERT INTO sync_relay_share_grants (grant_id,share_id,principal_kind,access,generation,status,created_at_ms)
      VALUES ('link',?,'link','edit',1,'active',0)`).run(scope.shareId);
    expect(f.read().grants).toContainEqual({shareId: scope.shareId, grantId: "email", generation: 1,
      principalKind: "email", userId: null, email: "person@example.test"});
    expect(f.read().grants).toContainEqual({shareId: scope.shareId, grantId: "link", generation: 1,
      principalKind: "link", userId: null, email: null});
  });

  it("refuses an oversized recipient list before copying oversized metadata", async () => {
    const f = await fixture();
    f.raw.prepare(`UPDATE sync_relay_share_grants SET principal_kind='email',principal_user_id=NULL,principal_email=? WHERE grant_id=?`)
      .run("a".repeat(MAX_PAYLOAD_JSON_BYTES + 1), scope.grantId);
    const query = vi.spyOn(f.context.db, "prepare");
    expect(() => f.read()).toThrow("metadata limit");
    expect(query.mock.calls.some(([sql]) => sql.includes("WHERE g.rowid=?"))).toBe(false);
  });

  it("does not load baseline, update, or proposal blobs for options", async () => {
    const f = await fixture(); f.point(1);
    const query = vi.spyOn(f.context.db, "prepare"); f.read();
    expect(query.mock.calls.some(([sql]) => /baseline_bytes|update_bytes|proposal_bytes/.test(sql))).toBe(false);
  });

  it("refuses a stale current path and a retired baseline", async () => {
    const f = await fixture();
    f.raw.prepare("UPDATE sync_relay_object_moments SET path='moved.md' WHERE object_id=?").run(binding.objectId);
    expect(() => f.read()).toThrow("no longer retained");
    f.raw.prepare("UPDATE sync_relay_live_documents SET lineage_state='retired',admission_state='closed',retired_at_ms=10 WHERE object_id=?")
      .run(binding.objectId);
    expect(() => f.read()).toThrow("not found");
  });

  it("recovers the pending operation even after its grant is revoked", async () => {
    const f = await fixture(); f.begin();
    expect(f.read().pendingOperation).toEqual({operationId: "restore", phase: "authority-invalidated", proposalDigest: null});
    expect(f.read().grants).toEqual([]);
    const status = f.storage.readOwnerRestoreStatus({workspaceId: scope.workspaceId, ownerUserId, operationId: "restore"});
    expect(status.phase).toBe("authority-invalidated"); expect(status.proposalDigest).toBeNull();
    expect(status.intent).not.toHaveProperty("ownerUserId");
    expect(() => f.storage.readOwnerRestoreStatus({workspaceId: scope.workspaceId, ownerUserId: scope.userId, operationId: "restore"})).toThrow("not found");
  });

  it("does not report resumed when the retained lifecycle cannot authenticate it", async () => {
    const f = await fixture(), {lookup} = nativeFenced(f);
    f.raw.prepare("UPDATE sync_relay_live_restore_operations SET phase='resumed' WHERE operation_id='restore'").run();
    expect(() => f.storage.readOwnerRestoreStatus(lookup))
      .toThrow("could not be verified");
  });

  it.each(["relay-admitted", "resumed"] as const)("authenticates bounded %s receipts without reading blobs", async phase => {
    const f = await fixture(), {lookup, proposalDigest} = retainedLifecycle(f, phase);
    const query = vi.spyOn(f.context.db, "prepare");
    expect(f.storage.readOwnerRestoreStatus(lookup)).toMatchObject({phase, proposalDigest, document});
    expect(query.mock.calls.some(([sql]) => /baseline_bytes|update_bytes|proposal_bytes/.test(sql))).toBe(false);
    if (phase === "relay-admitted") expect(f.read().pendingOperation).toEqual({operationId: lookup.operationId, phase, proposalDigest});
  });

  it.each(["admission hash", "resume binding", "unmaterialized", "oversized"])("refuses %s damage in retained lifecycle metadata", async damage => {
    const f = await fixture(), {lookup} = retainedLifecycle(f, "resumed");
    if (damage === "admission hash") f.raw.prepare("UPDATE sync_relay_live_restore_lifecycles SET admission_sha256=?").run("0".repeat(64));
    else if (damage === "resume binding") f.raw.prepare("UPDATE sync_relay_live_restore_lifecycles SET resume_json=json_set(resume_json,'$.binding.objectId','wrong-object')").run();
    else if (damage === "unmaterialized") f.raw.prepare("UPDATE sync_relay_live_restore_lifecycles SET settlement_json=json_set(settlement_json,'$.materialized',json('false'))").run();
    else f.raw.prepare("UPDATE sync_relay_live_restore_lifecycles SET admission_json=?").run(JSON.stringify({padding: "x".repeat(MAX_PAYLOAD_JSON_BYTES)}));
    expect(() => f.storage.readOwnerRestoreStatus(lookup)).toThrow();
  });

  it("refuses oversized status metadata before loading an operation", async () => {
    const f = await fixture(); f.begin();
    f.raw.prepare("UPDATE sync_relay_live_restore_operations SET intent_json=? WHERE operation_id='restore'")
      .run(JSON.stringify({padding: "a".repeat(MAX_PAYLOAD_JSON_BYTES)}));
    const query = vi.spyOn(f.context.db, "prepare");
    expect(() => f.storage.readOwnerRestoreStatus({workspaceId: scope.workspaceId, ownerUserId, operationId: "restore"})).toThrow("metadata limit");
    expect(query.mock.calls.some(([sql]) => /SELECT \* FROM sync_relay_live_restore_operations/.test(sql))).toBe(false);
  });

  it("routes options using server-derived owner identity and rejects body impersonation", async () => {
    const f = await fixture();
    const host = {restoreConfigured: true} as never;
    const handler = createSyncRelayHandler({storage: f.storage, ownerRestoreHost: () => host,
      resolveActor: async () => ({userId: ownerUserId, workspaceId: scope.workspaceId})});
    const response = await handler(new Request(`http://relay.test/sync/${scope.workspaceId}/live-restores/options`, {
      method: "POST", body: JSON.stringify({path: binding.currentPath}), headers: {"content-type": "application/json"}}));
    expect(response.status).toBe(200); expect((await response.json()).document).toEqual(document);
    const direct = createOwnerRestoreRoutes({storage: f.storage, host: () => host, newId: () => "unused", nowMs: () => 1});
    await expect(direct(new Request("http://relay.test", {method: "POST", body: JSON.stringify({path: binding.currentPath, ownerUserId})}),
      {route: "owner-restore", action: "options", workspaceId: scope.workspaceId}, ownerUserId)).rejects.toThrow();
  });

  it("binds plan selection to the displayed point digest and refuses changed or missing choices", async () => {
    const f = await fixture(); f.point(1);
    const selected = f.read().points[0]!;
    const direct = createOwnerRestoreRoutes({storage: f.storage, host: () => ({restoreConfigured: true}) as never,
      newId: () => "unused", nowMs: () => 1});
    const plan = (digest?: string) => direct(new Request("http://relay.test", {method: "POST", body: JSON.stringify({
      document, shareId: scope.shareId, grantId: scope.grantId, restorePointCursor: selected.cursor,
      ...(digest === undefined ? {} : {restorePointReceiptDigest: digest})})}),
      {route: "owner-restore", action: "plan", workspaceId: scope.workspaceId}, ownerUserId);
    expect((await (await plan(selected.receiptDigest)).json()).intent.restorePointReceiptDigest).toBe(selected.receiptDigest);
    await expect(plan()).rejects.toThrow();
    f.raw.prepare("UPDATE sync_relay_live_update_journal SET update_digest=? WHERE journal_cursor=1").run("e".repeat(64));
    await expect(plan(selected.receiptDigest)).rejects.toThrow("conflicts with current authority");
    expect(f.raw.prepare("SELECT COUNT(*) AS count FROM sync_relay_live_restore_operations").get()!.count).toBe(0);
  });
});
