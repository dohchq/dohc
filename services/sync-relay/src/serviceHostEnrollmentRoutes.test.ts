import {createHash} from "node:crypto";
import {afterEach, expect, it, vi} from "vitest";
import {fixture as ticketFixture, binding, retainServiceActivation, scope} from "./liveTickets.test-helper";
import {readServiceActivationRetirement} from "./storage/serviceActivationRetirement";
import type {StorageContext} from "./storage/context";
import {createLiveJournalHistoryAuthority} from "./storage/liveJournalHistory";
import {createServiceHostEnrollmentRoutes, discoverServiceHostDocuments} from "./serviceHostEnrollmentRoutes";
import {createServiceHostReplication} from "./serviceHostReplication";
import {authorizeServiceHostReplication, deriveServiceHostBearer} from "./serviceHostCredential";
import {relayError} from "./errors";
import {SERVICE_HOST_ENROLLMENTS} from "./storage/serviceHostEnrollment";
import type {ServiceActivationBlock} from "./serviceActivationDriver";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close();});
const key = new Uint8Array(32).fill(17), namespace = "service-route-test";
const serviceReplication = (storage: Parameters<typeof authorizeServiceHostReplication>[0]) => createServiceHostReplication({storage, prefix: "dohc-service-v1.",
  hostedFeed: true, authorize: input => authorizeServiceHostReplication(storage, {key, namespace, ...input})});
async function fixture() {
  const f = await ticketFixture(); cleanup.push(f.close);
  f.storage.claimWorkspaceIdentity({workspaceId: scope.workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
  f.raw.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq) VALUES (?,'owner',0,'moment.append','{}',1,1)").run(scope.workspaceId);
  f.raw.prepare("INSERT INTO sync_relay_current_files VALUES (?,'main',?,?,'text',1)").run(scope.workspaceId, binding.currentPath, "b".repeat(64));
  const history = createLiveJournalHistoryAuthority({namespace, reconciled: true});
  // The documents the session host blocked until their owner tries again.
  const blocked = new Map<string, ServiceActivationBlock>();
  const host = {ready: vi.fn(() => false), reconcile: vi.fn(), unavailable: false,
    blocked: vi.fn((document: {objectId: string}) => blocked.get(document.objectId)),
    unblock: vi.fn((document: {objectId: string}) => blocked.delete(document.objectId)),
    diverged: vi.fn((_row: {workspaceId: string; replicationEpoch: string; streamIdentity: string}) => false),
    block(objectId: string, why: ServiceActivationBlock = "refused") {blocked.set(objectId, why);}};
  let actor = {workspaceId: scope.workspaceId, userId: "owner-1"};
  const resolveActor = vi.fn(async () => actor);
  const handle = createServiceHostEnrollmentRoutes({storage: f.storage, history, host, resolveActor});
  const input = {workspaceId: scope.workspaceId, ownerUserId: "owner-1", shareId: scope.shareId, path: binding.currentPath, nowMs: 10, guard() {}};
  const request = (method = "GET", body?: unknown, headers: Record<string,string> = {}, suffix = "") => new Request(`https://relay.test/sync/${scope.workspaceId}/live-host${suffix}`,
    {method, headers: {authorization: "Bearer account-token", ...(body === undefined ? {} : {"content-type": "application/json"}), ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const seed = (path: string, objectId: string, contentKind = "text") => {
    f.raw.prepare("INSERT INTO sync_relay_current_files VALUES (?,'main',?,?,?,1)").run(scope.workspaceId, path, "b".repeat(64), contentKind);
    f.raw.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
      VALUES (?,?,1,?,'main',?,?,?,1,1)`).run(scope.workspaceId, objectId, `moment-${objectId}`, path, "b".repeat(64), contentKind);
  };
  // What the service host does once it no longer holds the document.
  const release = (objectId: string) => f.storage.releaseServiceHostEnrollment({workspaceId: scope.workspaceId, objectId, nowMs: 20});
  return {...f, history, host, resolveActor, handle, input, request, seed, release, setActor(value: typeof actor) {actor = value;}};
}

it("requires bearer owner authority, rejects ambient credentials and rejects unknown parameters", async () => {
  const f = await fixture();
  for (const headers of [{authorization: ""}, {cookie: "session=browser"}, {authorization: "Basic x"}] as Record<string,string>[]) {
    expect((await f.handle(f.request("GET", undefined, headers))).status).toBe(404);
  }
  expect(f.resolveActor).not.toHaveBeenCalled();
  f.setActor({workspaceId: scope.workspaceId, userId: "other"});
  expect((await f.handle(f.request())).status).toBe(404);
  f.setActor({workspaceId: "other", userId: "owner-1"});
  expect((await f.handle(f.request())).status).toBe(404);
  f.setActor({workspaceId: scope.workspaceId, userId: "owner-1"});
  expect((await f.handle(f.request("GET", undefined, {}, "?unknown=1"))).status).toBe(404);
  expect((await f.handle(f.request("POST", {shareId: scope.shareId, path: binding.currentPath, root: "/etc"}))).status).toBe(400);
  expect((await f.handle(f.request("DELETE", {path: binding.currentPath, workspaceId: scope.workspaceId}))).status).toBe(400);
  expect((await f.handle(f.request("POST", {shareId: scope.shareId}, {"content-type": "text/plain"}))).status).toBe(400);
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
});

it("discovers rich documents in folders, skips other content, and preserves a paused enrollment", async () => {
  const f = await fixture(); f.seed("docs/b.md", "object-b"); f.seed("docs/data.csv", "object-c"); f.seed("docs/image.md", "object-d", "binary");
  discoverServiceHostDocuments(f.storage);
  expect(f.storage.listServiceHostEnrollments().map(row => row.path)).toEqual(["docs/a.md", "docs/b.md"]);
  expect(await (await f.handle(f.request("DELETE", {path: binding.currentPath}))).json()).toEqual({ok: true, path: binding.currentPath, status: "paused"});
  discoverServiceHostDocuments(f.storage);
  expect(f.storage.listServiceHostEnrollments()[0]!.ownerStop).toBe("pause");
  f.release(binding.objectId);
  discoverServiceHostDocuments(f.storage);
  expect(f.storage.listServiceHostEnrollments()[0]!.enabled).toBe(false);
  expect((await f.handle(f.request("POST", {shareId: scope.shareId}))).status).toBe(202);
  expect(f.storage.listServiceHostEnrollments().every(row => row.enabled && !row.ownerStop)).toBe(true);
  await f.handle(f.request("DELETE", {path: binding.currentPath}));
  await f.handle(f.request("DELETE", {path: "docs/b.md", retire: true, restoreFenceGeneration: 0}));
  f.release("object-b");
  f.seed("docs/retry.md", "retry-object");
  expect((await f.handle(f.request("POST", {shareId: scope.shareId, retry: true}))).status).toBe(202);
  expect(f.storage.listServiceHostEnrollments()[0]!.ownerStop).toBe("pause");
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/b.md")).toMatchObject({retired: true, enabled: false});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/retry.md")).toMatchObject({enabled: true});
  expect((await f.handle(f.request("POST", {shareId: scope.shareId, retry: true, path: binding.currentPath}))).status).toBe(400);
});

it("reports ready only with completed retained activation and the current native runtime", async () => {
  const f = await fixture(), enrolled = f.storage.enrollServiceHostDocument(f.input);
  const state = async () => {
    const response = await f.handle(f.request());
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    const text = await response.text();
    for (const secret of [deriveServiceHostBearer(enrolled, {key, namespace}), "account-token", "owner-1", "replicationEpoch", "streamIdentity"]) expect(text).not.toContain(secret);
    return JSON.parse(text).documents[0];
  };
  f.host.ready.mockReturnValue(true);
  expect(await state()).toEqual({path: binding.currentPath, status: "preparing"});
  retainServiceActivation(f.raw, namespace);
  expect((await state()).status).toBe("preparing");
  f.raw.exec("UPDATE sync_relay_service_activations SET completion_json='{}'");
  f.host.ready.mockReturnValue(false);
  expect((await state()).status).toBe("preparing");
  f.host.ready.mockReturnValue(true);
  expect(await state()).toEqual({path: binding.currentPath, status: "ready", document: {binding, relayDatabaseNamespace: namespace, shareId: scope.shareId}});
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false});
  expect((await state()).status).toBe("paused");
});

// Proves: a document the session host blocked reads as refused until its
// owner's Resume, which gives it exactly one more attempt. Enrolling its share
// again is not a Resume, and a reading never clears the block.
it("reports a document the session host refused until the owner resumes it", async () => {
  const f = await fixture(), enrolled = f.storage.enrollServiceHostDocument(f.input);
  const documents = async () => (await (await f.handle(f.request())).json()).documents;
  const refused = {path: binding.currentPath, status: "unavailable", reason: "session-host-refused"};
  f.host.ready.mockReturnValue(true);
  f.host.block(enrolled.objectId);
  expect(await documents()).toEqual([refused]);
  expect(await documents()).toEqual([refused]);
  expect((await f.handle(f.request("POST", {shareId: scope.shareId}))).status).toBe(202);
  expect(await documents()).toEqual([refused]);
  expect(f.host.unblock).not.toHaveBeenCalled();
  const resumed = await f.handle(f.request("POST", {path: binding.currentPath}));
  expect(resumed.status).toBe(202);
  expect(await resumed.json()).toEqual({ok: true, path: binding.currentPath, status: "preparing"});
  expect(f.host.unblock).toHaveBeenCalledTimes(1);
  expect(f.host.unblock).toHaveBeenCalledWith(expect.objectContaining({workspaceId: scope.workspaceId, objectId: enrolled.objectId}));
  expect(f.host.unblock.mock.invocationCallOrder[0]).toBeLessThan(f.host.reconcile.mock.invocationCallOrder.at(-1)!);
  expect(await documents()).toEqual([{path: binding.currentPath, status: "preparing"}]);
  // Its one attempt failed, so the host blocked it again.
  f.host.block(enrolled.objectId);
  expect(await documents()).toEqual([refused]);
  expect(f.host.unblock).toHaveBeenCalledTimes(1);
});

// Proves: a document blocked for having no live-editing history reads as its
// own reason, so its owner learns to open it before Resume, which still unblocks it.
it("reports a document without live-editing history apart from other refusals", async () => {
  const f = await fixture(), enrolled = f.storage.enrollServiceHostDocument(f.input);
  const documents = async () => (await (await f.handle(f.request())).json()).documents;
  f.host.block(enrolled.objectId, "without-lineage");
  expect(await documents()).toEqual([{path: binding.currentPath, status: "unavailable", reason: "live-document-without-lineage"}]);
  expect((await f.handle(f.request("POST", {path: binding.currentPath}))).status).toBe(202);
  expect(f.host.unblock).toHaveBeenCalledTimes(1);
  expect(await documents()).toEqual([{path: binding.currentPath, status: "preparing"}]);
  f.host.block(enrolled.objectId, "refused");
  expect(await documents()).toEqual([{path: binding.currentPath, status: "unavailable", reason: "session-host-refused"}]);
});

// Proves: a document whose host copy misses an edit made while live editing
// was off reads as its own reason. A Resume still asks for one more attempt,
// which blocks it again with the same reason.
it("reports a document edited while live editing was off apart from other refusals", async () => {
  const f = await fixture(), enrolled = f.storage.enrollServiceHostDocument(f.input);
  const documents = async () => (await (await f.handle(f.request())).json()).documents;
  const unadmitted = {path: binding.currentPath, status: "unavailable", reason: "live-edit-unadmitted"};
  f.host.block(enrolled.objectId, "live-edit-unadmitted");
  expect(await documents()).toEqual([unadmitted]);
  expect((await f.handle(f.request("POST", {path: binding.currentPath}))).status).toBe(202);
  expect(f.host.unblock).toHaveBeenCalledTimes(1);
  f.host.block(enrolled.objectId, "live-edit-unadmitted");
  expect(await documents()).toEqual([unadmitted]);
});

// Proves: Resume of a document held for an unadmitted live edit records the
// retirement of its exact prepared activation, completed or a successor still
// pending, in the enrollment transaction, before the host may try it again. A
// hold that ended before that transaction changes nothing, and the Resume does
// not reopen the document's admission.
it.each([["completed", true], ["pending", false]])("retires the held %s activation when its owner resumes a document edited while live editing was off", async (_state, completed) => {
  const f = await fixture(), enrolled = f.storage.enrollServiceHostDocument(f.input);
  const activationId = retainServiceActivation(f.raw, namespace, completed);
  const retirement = () => readServiceActivationRetirement(f.storage as StorageContext, enrolled);
  f.host.block(enrolled.objectId, "live-edit-unadmitted");
  f.host.blocked.mockReturnValueOnce("live-edit-unadmitted").mockReturnValueOnce(undefined);
  expect((await f.handle(f.request("POST", {path: binding.currentPath}))).status).toBe(409);
  expect(retirement()).toBeNull();
  expect(f.host.unblock).not.toHaveBeenCalled();
  expect((await f.handle(f.request("POST", {path: binding.currentPath}))).status).toBe(202);
  expect(retirement()).toEqual({relayDatabaseNamespace: namespace, activationId, workspaceId: scope.workspaceId, mainVersionId: "main",
    objectId: binding.objectId, lineageClaimId: binding.lineageClaimId, path: binding.currentPath, restoreFenceGeneration: 7, acceptedThrough: 0,
    requestedAtMs: expect.any(Number)});
  expect(f.host.unblock).toHaveBeenCalledTimes(1);
  expect(f.storage.serviceHostDocumentEnabled(enrolled)).toBe(false);
});

// Proves: a document whose hosted replica diverged reads as its own reason
// ahead of a block, a Resume cannot change that, and the owner learns nothing
// of the store. A workspace that changed identity still reads as changed.
it("reports a document whose hosted replica diverged, and nothing about its store", async () => {
  const f = await fixture(), enrolled = f.storage.enrollServiceHostDocument(f.input);
  const diverged = {path: binding.currentPath, status: "unavailable", reason: "session-host-diverged"};
  f.host.ready.mockReturnValue(true);
  f.host.block(enrolled.objectId);
  f.host.diverged.mockImplementation(row => row.workspaceId === scope.workspaceId && row.replicationEpoch === "epoch" && row.streamIdentity === "stream");
  const response = await f.handle(f.request());
  expect(await response.json()).toEqual({ok: true, diverged: true, documents: [diverged]});
  const resumed = await f.handle(f.request("POST", {path: binding.currentPath}));
  expect(resumed.status).toBe(202);
  expect(await resumed.json()).toEqual({ok: true, ...diverged});
  f.raw.prepare("UPDATE sync_relay_workspaces SET replication_epoch='rotated' WHERE workspace_id=?").run(scope.workspaceId);
  expect(await (await f.handle(f.request())).json()).toEqual({ok: true, diverged: false, documents: [{path: binding.currentPath, status: "unavailable", reason: "workspace-changed"}]});
});

// Proves: an owner's Pause or Stop records their intent but cannot hide a
// diverged server copy. The paused and the retired document both keep the
// reason, and the workspace still reads as diverged once no document is active.
it("keeps a diverged document's reason after its owner pauses or stops it", async () => {
  const f = await fixture(); f.seed("docs/b.md", "object-b");
  f.storage.enrollServiceHostDocument(f.input); f.storage.enrollServiceHostDocument({...f.input, path: "docs/b.md"});
  f.host.diverged.mockImplementation(row => row.workspaceId === scope.workspaceId && row.replicationEpoch === "epoch" && row.streamIdentity === "stream");
  const reason = "session-host-diverged";
  expect(await (await f.handle(f.request("DELETE", {path: binding.currentPath}))).json()).toEqual({ok: true, path: binding.currentPath, status: "unavailable", reason});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)).toMatchObject({ownerStop: "pause"});
  const stopped = await f.handle(f.request("DELETE", {path: "docs/b.md", retire: true, restoreFenceGeneration: 0}));
  expect(await stopped.json()).toMatchObject({ok: true, path: "docs/b.md", status: "retired"});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/b.md")).toMatchObject({ownerStop: "retire", retired: true});
  expect(await (await f.handle(f.request())).json()).toEqual({ok: true, diverged: true, documents: [{path: binding.currentPath, status: "unavailable", reason}]});
  expect(await (await f.handle(f.request("GET", undefined, {}, "?retired=1"))).json()).toEqual({ok: true, documents: [{path: "docs/b.md", status: "retired", reason}], nextCursor: null});
  expect((await f.handle(f.request("DELETE", {path: binding.currentPath, retire: true, restoreFenceGeneration: binding.restoreFenceGeneration}))).status).toBe(200);
  expect(await (await f.handle(f.request())).json()).toEqual({ok: true, diverged: true, documents: []});
  expect((await (await f.handle(f.request("GET", undefined, {}, "?retired=1"))).json()).documents).toEqual([
    {path: binding.currentPath, status: "retired", reason}, {path: "docs/b.md", status: "retired", reason}]);
});

it("lists automatic enrollment refusals without enrolling documents or exposing other workspaces", async () => {
  const f = await fixture();
  const response = await f.handle(f.request("GET", undefined, {}, "?refusals=1"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ok: true, refusals: [], nextCursor: null});
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
  f.raw.exec("DELETE FROM sync_relay_object_moments");
  const before = f.raw.prepare("SELECT total_changes() AS changes").get();
  const refused = await (await f.handle(f.request("GET", undefined, {}, "?refusals=1"))).json();
  expect(refused).toMatchObject({ok: true, refusals: [{shareId: scope.shareId, paths: ["docs"], code: "conflict"}], nextCursor: null});
  expect(f.raw.prepare("SELECT total_changes() AS changes").get()).toEqual(before);
  expect(f.host.reconcile).not.toHaveBeenCalled();
  f.setActor({workspaceId: scope.workspaceId, userId: "recipient"});
  expect((await f.handle(f.request("GET", undefined, {}, "?refusals=1"))).status).toBe(404);
  f.setActor({workspaceId: "other", userId: "owner-1"});
  expect((await f.handle(f.request("GET", undefined, {}, "?refusals=1"))).status).toBe(404);
  f.setActor({workspaceId: scope.workspaceId, userId: "owner-1"});
  expect((await f.handle(f.request("GET", undefined, {}, "?retired=1&refusals=1"))).status).toBe(404);
});

it("clears derived capacity refusals when an owner frees space and retries enrollment", async () => {
  const f = await fixture();
  f.storage.enrollServiceHostDocument(f.input);
  for (let index = 1; index < 64; index++) {
    const path = `docs/capacity-${index}.md`; f.seed(path, `capacity-${index}`);
    f.storage.enrollServiceHostDocument({...f.input, path});
  }
  f.raw.prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id=?").run(JSON.stringify({paths: [binding.currentPath], versionId: null}), scope.shareId);
  f.seed("pending/a.md", "pending-object");
  f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES ('pending-share',?,'owner-1',?,1)").run(scope.workspaceId, JSON.stringify({paths: ["pending"], versionId: null}));
  f.raw.prepare("INSERT INTO sync_relay_share_grants SELECT 'pending-grant','pending-share',principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id FROM sync_relay_share_grants WHERE grant_id=?").run(scope.grantId);
  const read = async () => (await f.handle(f.request("GET", undefined, {}, "?refusals=1"))).json();
  expect(await read()).toMatchObject({refusals: [{shareId: "pending-share", code: "quota_exceeded"}], nextCursor: null});
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true, restoreFenceGeneration: binding.restoreFenceGeneration});
  expect(await read()).toEqual({ok: true, refusals: [], nextCursor: null});
  expect((await f.handle(f.request("POST", {shareId: "pending-share"}))).status).toBe(202);
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "pending/a.md")).toMatchObject({enabled: true});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)).toMatchObject({retired: true, enabled: false});
});

it("advances refusal pages past healthy shares to an oversized share", async () => {
  const f = await fixture();
  f.storage.enrollServiceHostDocument(f.input);
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true, restoreFenceGeneration: binding.restoreFenceGeneration});
  f.release(binding.objectId);
  for (let index = 0; index < 65; index++) {
    const shareId = `page-${String(index).padStart(3, "0")}`;
    f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) SELECT ?,workspace_id,granter_user_id,selector_json,created_at_ms FROM sync_relay_shares WHERE share_id=?").run(shareId, scope.shareId);
    f.raw.prepare("INSERT INTO sync_relay_share_grants SELECT ?,?,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id FROM sync_relay_share_grants WHERE grant_id=?").run(`page-grant-${index}`, shareId, scope.grantId);
  }
  const first = await (await f.handle(f.request("GET", undefined, {}, "?refusals=1"))).json();
  expect(first.refusals).toEqual([]); expect(first.nextCursor).toBe("page-063");
  for (let index = 0; index < 65; index++) f.seed(`large/${index}.md`, `large-${index}`);
  f.raw.prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id='page-064'").run(JSON.stringify({paths: ["large"], versionId: null}));
  const second = await (await f.handle(f.request("GET", undefined, {}, `?refusals=1&after=${first.nextCursor}`))).json();
  expect(second).toMatchObject({refusals: [{shareId: "page-064", paths: ["large"], code: "bad_request"}], nextCursor: null});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)).toMatchObject({retired: true, enabled: false});
});

it("counts only missing documents when a share contains more than 64 stopped documents", async () => {
  const f = await fixture();
  // Stop and release have their own lifecycle tests, so one transaction seeds the stopped documents.
  f.raw.exec("BEGIN");
  for (let index = 0; index < 65; index++) {
    const path = `docs/stopped-${index}.md`; f.seed(path, `stopped-${index}`);
    f.raw.prepare(`INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,owner_stop,enabled,retired,created_at_ms,updated_at_ms,accounted_bytes)
      VALUES (?,?,?,'owner-1',?,'epoch','stream','retire',0,1,10,20,1)`).run(scope.workspaceId, `stopped-${index}`, path, scope.shareId);
  }
  f.raw.exec("COMMIT");
  expect(await (await f.handle(f.request("GET", undefined, {}, "?refusals=1"))).json()).toEqual({ok: true, refusals: [], nextCursor: null});
  expect((await f.handle(f.request("POST", {shareId: scope.shareId, retry: true}))).status).toBe(202);
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(1);
  expect(f.storage.listServiceHostEnrollments()[0]!.path).toBe(binding.currentPath);
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/stopped-0.md")).toMatchObject({retired: true, enabled: false});
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true, restoreFenceGeneration: binding.restoreFenceGeneration});
  f.release(binding.objectId);
  expect(await (await f.handle(f.request("GET", undefined, {}, "?refusals=1"))).json()).toEqual({ok: true, refusals: [], nextCursor: null});
  expect((await f.handle(f.request("POST", {shareId: scope.shareId, retry: true}))).status).toBe(200);
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
});

it("keeps full Unicode refusal selectors within the client byte budget and resumes at the unreturned share", async () => {
  const f = await fixture();
  const paths = Array.from({length: 100}, (_, index) => `${String(index).padStart(3, "0")}/${"界".repeat(1016)}`);
  for (let index = 0; index < 5; index++) {
    const shareId = `large-selector-${index}`;
    f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,'owner-1',?,1)").run(shareId, scope.workspaceId, JSON.stringify({paths, versionId: null}));
    f.raw.prepare("INSERT INTO sync_relay_share_grants SELECT ?,?,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id FROM sync_relay_share_grants WHERE grant_id=?").run(`large-grant-${index}`, shareId, scope.grantId);
  }
  vi.spyOn(f.storage, "checkServiceHostDocuments").mockImplementation(input => {
    if (input.shareId.startsWith("large-selector-")) throw relayError("quota_exceeded", "No room for live documents.");
  });
  const firstResponse = await f.handle(f.request("GET", undefined, {}, "?refusals=1"));
  const text = await firstResponse.text(); expect(Buffer.byteLength(text)).toBeLessThan(1024 * 1024);
  const first = JSON.parse(text);
  expect(first.refusals).toHaveLength(3); expect(first.refusals[0].paths).toEqual(paths);
  expect(first.nextCursor).toBe("large-selector-2");
  const second = await (await f.handle(f.request("GET", undefined, {}, `?refusals=1&after=${first.nextCursor}`))).json();
  expect(second.refusals.map((row: {shareId: string}) => row.shareId)).toEqual(["large-selector-3", "large-selector-4"]);
  expect(second.nextCursor).toBeNull();
});

it("rolls back every folder enrollment when a later current file lacks a live document", async () => {
  const f = await fixture();
  f.raw.prepare("INSERT INTO sync_relay_current_files VALUES (?,'main','docs/z.md',?,'text',1)").run(scope.workspaceId, "b".repeat(64));
  const response = await f.handle(f.request("POST", {shareId: scope.shareId}));
  expect(response.status).toBe(409);
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
  expect(f.host.reconcile).not.toHaveBeenCalled();
});

it("continues discovery past an unsupported document without re-enabling paused documents", async () => {
  const f = await fixture();
  f.raw.prepare("INSERT INTO sync_relay_current_files VALUES (?,'main','docs/0.md',?,'text',1)").run(scope.workspaceId, "b".repeat(64));
  const refused = vi.fn();
  discoverServiceHostDocuments(f.storage, refused);
  expect(refused).toHaveBeenCalledOnce();
  expect(f.storage.listServiceHostEnrollments().map(row => row.path)).toEqual([binding.currentPath]);
});

function deferredBody(method: string, url: string, headers: Record<string,string>) {
  let start!: () => void;
  const started = new Promise<void>(resolve => {start = resolve;});
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({start(value) {controller = value;}, pull() {start();}});
  const request = new Request(url, {method, headers, body: stream, duplex: "half"} as RequestInit);
  return {request, started, finish(body: Uint8Array) {controller.enqueue(body); controller.close();}};
}

it("rechecks ownership after an enrollment request body finishes", async () => {
  const f = await fixture();
  const pending = deferredBody("POST", f.request().url, {authorization: "Bearer account-token", "content-type": "application/json"});
  const result = f.handle(pending.request); await pending.started;
  await vi.waitFor(() => expect(f.resolveActor).toHaveBeenCalled());
  f.raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id='other' WHERE workspace_id=?").run(scope.workspaceId);
  pending.finish(new TextEncoder().encode(JSON.stringify({shareId: scope.shareId, path: binding.currentPath})));
  expect((await result).status).toBe(404); expect(f.storage.listServiceHostEnrollments()).toEqual([]);
});

it("service replication refuses foreign workspaces and account administration", async () => {
  const f = await fixture(), bearer = deriveServiceHostBearer(f.storage.enrollServiceHostDocument(f.input), {key, namespace});
  const handler = serviceReplication(f.storage);
  for (const path of ["/sync/workspaces", "/sync/foreign/hosted/bootstrap", `/sync/${scope.workspaceId}/epoch`, `/sync/${scope.workspaceId}/live-host`,
    `/sync/${scope.workspaceId}/hosted/live-host`]) {
    expect((await handler(new Request(`https://relay.test${path}`, {method: "POST", headers: {authorization: `Bearer ${bearer}`}}))).status).toBe(404);
  }
  const response = await handler(new Request(`https://relay.test/sync/${scope.workspaceId}/hosted/bootstrap`, {headers: {authorization: `Bearer ${bearer}`}}));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({replicationEpoch: "epoch", streamIdentity: "stream"});
});

it.each(["blob", "log"] as const)("a service token revoked during the %s body cannot mutate storage", async kind => {
  const f = await fixture(), bearer = deriveServiceHostBearer(f.storage.enrollServiceHostDocument(f.input), {key, namespace});
  const handler = serviceReplication(f.storage);
  const bytes = new TextEncoder().encode("unpublished"), digest = createHash("sha256").update(bytes).digest("hex");
  const pending = deferredBody(kind === "blob" ? "PUT" : "POST", `https://relay.test/sync/${scope.workspaceId}/hosted/${kind === "blob" ? `blobs/${digest}` : "log"}`,
    {authorization: `Bearer ${bearer}`, "content-type": kind === "blob" ? "application/octet-stream" : "application/json"});
  const result = handler(pending.request); await pending.started;
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false});
  f.release(binding.objectId);
  pending.finish(kind === "blob" ? bytes : new TextEncoder().encode(JSON.stringify({replicationEpoch: "epoch", streamIdentity: "stream", originId: "service-host:native", ops: [
    {originSeq: 0, opKind: "moment.append", recordedAtMs: 10, payload: {operation: "write"}}]})));
  expect((await result).status).toBe(404);
  expect(f.storage.getBlob(scope.workspaceId, digest)).toBeNull();
  expect(f.storage.fetchLogCoordinate({workspaceId: scope.workspaceId, originId: "service-host:native", originSeq: 0})).toBeNull();
});

it("reports a renamed enrolled document as unavailable and retains its original enrollment", async () => {
  const f = await fixture(), enrolled = f.storage.enrollServiceHostDocument(f.input);
  f.raw.prepare("UPDATE sync_relay_object_moments SET path='docs/renamed.md' WHERE workspace_id=? AND object_id=?").run(scope.workspaceId, binding.objectId);
  f.host.ready.mockReturnValue(true);
  const response = await f.handle(f.request());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ok: true, documents: [{path: binding.currentPath, status: "unavailable"}]});
  expect(f.storage.listServiceHostEnrollments()).toEqual([enrolled]);
});

it("retires an owner document, lists it separately, and resumes its retained identity without a supplied share", async () => {
  const f = await fixture(), first = f.storage.enrollServiceHostDocument(f.input);
  const bearer = deriveServiceHostBearer(first, {key, namespace});
  const stop = await f.handle(f.request("DELETE", {path: first.path, retire: true, restoreFenceGeneration: binding.restoreFenceGeneration}));
  expect(await stop.json()).toEqual({ok: true, path: first.path, objectId:first.objectId, status: "retired", acceptedCursor: 0});
  expect(await (await f.handle(f.request())).json()).toEqual({ok: true, diverged: false, documents: []});
  discoverServiceHostDocuments(f.storage);
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
  expect(await (await f.handle(f.request("GET", undefined, {}, "?retired=1"))).json()).toEqual({ok: true, documents: [{path: first.path, status: "retired"}], nextCursor: null});
  // Stopped but undrained: the host's credential still reads the empty scope, and its release ends it.
  const replication = serviceReplication(f.storage);
  const bootstrap = () => replication(new Request(`https://relay.test/sync/${scope.workspaceId}/hosted/bootstrap`, {headers: {authorization: `Bearer ${bearer}`}}));
  expect(await (await bootstrap()).json()).toMatchObject({hasContent: false});
  f.release(first.objectId);
  expect((await bootstrap()).status).toBe(404);
  expect((await f.handle(f.request("POST", {path: first.path}))).status).toBe(202);
  expect(f.storage.listServiceHostEnrollments()[0]).toMatchObject({objectId: first.objectId, shareId: first.shareId, retired: false, enabled: true});
  expect((await f.handle(f.request("POST", {path: "docs/missing.md"}))).status).toBe(404);
  expect((await f.handle(f.request("GET", undefined, {}, "?retired=1&retired=1"))).status).toBe(404);
});

it("discovers a new document after more than 64 prior shares without reviving retired enrollment", async () => {
  const f = await fixture(); f.storage.enrollServiceHostDocument(f.input);
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true, restoreFenceGeneration: binding.restoreFenceGeneration});
  f.release(binding.objectId);
  for (let index = 0; index < 65; index++) {
    const shareId = `old-${String(index).padStart(3, "0")}`;
    f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) SELECT ?,workspace_id,granter_user_id,selector_json,created_at_ms FROM sync_relay_shares WHERE share_id=?").run(shareId, scope.shareId);
    f.raw.prepare("INSERT INTO sync_relay_share_grants SELECT ?,?,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id FROM sync_relay_share_grants WHERE grant_id=?")
      .run(`grant-${index}`, shareId, scope.grantId);
  }
  const cursor = discoverServiceHostDocuments(f.storage);
  expect(cursor).not.toBeNull(); expect(f.storage.listServiceHostEnrollments()).toEqual([]);
  f.seed("docs/b.md", "object-b");
  const last = discoverServiceHostDocuments(f.storage, undefined, cursor!);
  expect(last).toBeNull();
  expect(f.storage.listServiceHostEnrollments().map(row => row.path)).toEqual(["docs/b.md"]);
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)?.retired).toBe(true);
});

it("hosts a document retired by revocation again for a new Edit share, but leaves an owner's Pause or Stop", async () => {
  const f = await fixture(); f.seed("docs/paused.md", "paused-object"); f.seed("docs/stopped.md", "stopped-object");
  discoverServiceHostDocuments(f.storage);
  await f.handle(f.request("DELETE", {path: "docs/paused.md"}));
  await f.handle(f.request("DELETE", {path: "docs/stopped.md", retire: true}));
  expect(f.storage.revokeShareGrant({shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 30}).ok).toBe(true);
  for (const objectId of [binding.objectId, "paused-object"]) expect(f.release(objectId)).toMatchObject({enabled: false, retired: true});
  discoverServiceHostDocuments(f.storage);
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
  // A new Edit share covering the folder; nobody presses Resume.
  f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES ('new-share',?,'owner-1',?,40)")
    .run(scope.workspaceId, JSON.stringify({paths: ["docs"], versionId: null}));
  f.raw.prepare("INSERT INTO sync_relay_share_grants SELECT 'new-grant','new-share',principal_kind,principal_user_id,principal_email,access,generation,'active',40,NULL,parent_grant_id FROM sync_relay_share_grants WHERE grant_id=?").run(scope.grantId);
  expect(await (await f.handle(f.request("GET", undefined, {}, "?refusals=1"))).json()).toEqual({ok: true, refusals: [], nextCursor: null});
  discoverServiceHostDocuments(f.storage);
  expect(f.storage.listServiceHostEnrollments().map(row => [row.path, row.enabled, row.ownerStop, row.shareId])).toEqual([[binding.currentPath, true, null, scope.shareId]]);
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/paused.md")).toMatchObject({retired: true, ownerStop: "pause"});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/stopped.md")).toMatchObject({retired: true, ownerStop: "retire"});
  // The owner's Resume brings back their paused document.
  expect((await f.handle(f.request("POST", {path: "docs/paused.md"}))).status).toBe(202);
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/paused.md")).toMatchObject({retired: false, enabled: true, ownerStop: null});
});

it("compares the restore generation before retirement and accepts a repeat", async () => {
  const f = await fixture(); f.storage.enrollServiceHostDocuments([f.input]);
  const request = (generation: number) => f.handle(f.request("DELETE", {path: binding.currentPath, retire: true, restoreFenceGeneration: generation}));
  const mismatch = await request(binding.restoreFenceGeneration + 1);
  expect(mismatch.status).toBe(409);
  expect(await mismatch.json()).toMatchObject({code: "restore-fenced", restoreFenceGeneration: binding.restoreFenceGeneration});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)).toMatchObject({enabled: true, retired: false});
  expect((await request(binding.restoreFenceGeneration)).status).toBe(200);
  expect((await request(binding.restoreFenceGeneration)).status).toBe(200);
});

it("retires an unenrolled desktop without a generation and resolves a moved target by object",async () => {
  const f=await fixture();f.storage.enrollServiceHostDocument(f.input);
  f.raw.prepare("UPDATE sync_relay_service_host_enrollments SET path='docs/moved.md'").run();
  const response=await f.handle(f.request("DELETE",{path:binding.currentPath,objectId:binding.objectId,retire:true}));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ok:true,path:"docs/moved.md",objectId:binding.objectId,status:"retired",acceptedCursor:0});
  expect((await f.handle(f.request("DELETE",{path:binding.currentPath,objectId:"wrong-object",retire:true}))).status).toBe(404);
});

it("rejects invalid generations and a stale repeat after the generation moves", async () => {
  const f = await fixture();f.storage.enrollServiceHostDocument(f.input);
  for (const generation of [-1, 0.5, "7"]) {
    expect((await f.handle(f.request("DELETE", {path: binding.currentPath, retire: true, restoreFenceGeneration: generation}))).status).toBe(400);
  }
  const retire = (generation: number) => f.handle(f.request("DELETE", {path: binding.currentPath, retire: true, restoreFenceGeneration: generation}));
  expect((await retire(7)).status).toBe(200);
  f.raw.prepare("UPDATE sync_relay_live_documents SET restore_fence_generation=8").run();
  expect((await retire(7)).status).toBe(409);
  expect((await retire(8)).status).toBe(200);
});
