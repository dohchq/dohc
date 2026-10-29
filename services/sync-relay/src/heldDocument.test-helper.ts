import {binding as ticketBinding, fixture as ticketFixture, scope as ticketScope} from "./liveTickets.test-helper";
import {createServiceHostEnrollmentRoutes} from "./serviceHostEnrollmentRoutes";
import {createLiveJournalHistoryAuthority} from "./storage/liveJournalHistory";

/** A held document's Stop, through the real enrollment route and relay store. */
export async function heldDocumentFixture(workspaceId = ticketScope.workspaceId, effectIndex: 0 | 1 = 0) {
  const f = await ticketFixture(undefined, {workspaceId, objectId: ticketBinding.objectId, userId: "reader-1", grantId: "edit-1"});
  try {
    const binding = {...ticketBinding, workspaceId};
    f.storage.claimWorkspaceIdentity({workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
    const insert = f.raw.prepare(`INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq)
      VALUES (?,'owner',?,?,?,?,?)`);
    // The route reads retained metadata; native application of these effects is tested in the engine.
    const effects = effectIndex === 0 ? [{momentId: "resolved-moment"}] : [{momentId: "deleted-moment"}, {momentId: "resolved-moment"}];
    insert.run(workspaceId, 0, "conflict.resolve", JSON.stringify({conflictId: "conflict-1", targetVersionId: "main", effects}), 1, 1);
    for (const [index, effect] of effects.entries()) insert.run(workspaceId, index + 1, "moment.append", JSON.stringify({
      objectId: index === effectIndex ? binding.objectId : "another-object", versionId: "main", path: binding.currentPath,
      momentId: effect.momentId, conflictId: "conflict-1", conflictEffectIndex: index}), 1, index + 2);
    f.raw.prepare("INSERT INTO sync_relay_current_files VALUES (?,'main',?,?,'text',1)").run(workspaceId, binding.currentPath, "b".repeat(64));
    const enrollment = f.storage.enrollServiceHostDocument({workspaceId, path: binding.currentPath, ownerUserId: "owner-1",
      shareId: ticketScope.shareId, nowMs: 10, guard() {}});
    let held = true;
    const host = {
      firstOpenRefusal: () => undefined, ready: () => false, unavailable: false, blocked: () => undefined, unblock: () => false, diverged: () => false,
      holdReason: () => held ? "hosted-conflict-parent-withheld" as const : undefined,
      reconcile() {if (f.storage.readServiceHostEnrollment(workspaceId, binding.currentPath)?.retired) held = false;},
      keptEdits: {async page() {return null;}, async retry() {return "unavailable" as const;}, async copied() {}},
    };
    const handle = createServiceHostEnrollmentRoutes({storage: f.storage,
      history: createLiveJournalHistoryAuthority({namespace: "held-document-test", reconciled: true}), host,
      resolveActor: async () => ({workspaceId, userId: "owner-1"})});
    const request = (method = "GET", suffix = "", body?: unknown) => new Request(`https://relay.test/sync/${workspaceId}/live-host${suffix}`, {
      method, headers: {authorization: "Bearer owner-token", ...(body === undefined ? {} : {"content-type": "application/json"})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    const stop = () => handle(request("DELETE", "", {path: binding.currentPath, objectId: binding.objectId, retire: true,
      restoreFenceGeneration: binding.restoreFenceGeneration}));
    return {...f, binding, enrollment, host, handle, request, stop};
  } catch (error) {await f.close(); throw error;}
}
