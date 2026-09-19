import {createHash} from "node:crypto";
import {afterEach, expect, it, vi} from "vitest";
import {fixture as ticketFixture, binding, scope} from "./liveTickets.test-helper";
import {createLiveJournalHistoryAuthority} from "./storage/liveJournalHistory";
import {createServiceHostEnrollmentRoutes, discoverServiceHostDocuments} from "./serviceHostEnrollmentRoutes";
import {createServiceHostReplication} from "./serviceHostReplication";
import {deriveServiceHostBearer} from "./serviceHostCredential";
import {relayError} from "./errors";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close();});
const key = new Uint8Array(32).fill(17), namespace = "service-route-test";
async function fixture() {
  const f = await ticketFixture(); cleanup.push(f.close);
  f.storage.claimWorkspaceIdentity({workspaceId: scope.workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
  f.raw.prepare("INSERT INTO sync_relay_log VALUES (?,'owner',0,'moment.append','{}',1,1)").run(scope.workspaceId);
  f.raw.prepare("INSERT INTO sync_relay_current_files VALUES (?,'main',?,?,'text',1)").run(scope.workspaceId, binding.currentPath, "b".repeat(64));
  const history = createLiveJournalHistoryAuthority({namespace, reconciled: true});
  const host = {ready: vi.fn(() => false), reconcile: vi.fn(), unavailable: false};
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
  return {...f, history, host, resolveActor, handle, input, request, seed, setActor(value: typeof actor) {actor = value;}};
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
  expect((await f.handle(f.request("DELETE", {path: binding.currentPath}))).status).toBe(200);
  discoverServiceHostDocuments(f.storage);
  expect(f.storage.listServiceHostEnrollments()[0]!.enabled).toBe(false);
  expect((await f.handle(f.request("POST", {shareId: scope.shareId}))).status).toBe(202);
  expect(f.storage.listServiceHostEnrollments().every(row => row.enabled)).toBe(true);
  await f.handle(f.request("DELETE", {path: binding.currentPath}));
  await f.handle(f.request("DELETE", {path: "docs/b.md", retire: true}));
  f.seed("docs/retry.md", "retry-object");
  expect((await f.handle(f.request("POST", {shareId: scope.shareId, retry: true}))).status).toBe(202);
  expect(f.storage.listServiceHostEnrollments()[0]!.enabled).toBe(false);
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
    for (const secret of [enrolled.credentialNonce, "account-token", "owner-1", "replicationEpoch", "streamIdentity"]) expect(text).not.toContain(secret);
    return JSON.parse(text).documents[0];
  };
  f.host.ready.mockReturnValue(true);
  expect(await state()).toEqual({path: binding.currentPath, status: "preparing"});
  const source = {version: 1, relayDatabaseNamespace: namespace, workspaceId: scope.workspaceId, mainVersionId: "main", objectId: binding.objectId,
    lineageClaimId: binding.lineageClaimId, currentPath: binding.currentPath, replicationEpoch: "epoch", streamIdentity: "stream", committedCursor: 1,
    baseOriginId: "origin", baseOriginSeq: 0, baseRelaySeq: 1, sourceMomentId: "moment-1", sourceDigest: "b".repeat(64), sourceByteLength: 1,
    nativeHeadSequence: 0, fullStateDigest: binding.lineageClaimId, fullStateByteLength: 2};
  // Stored metadata exercises route readiness; native activation is covered by the engine integration suite.
  f.raw.prepare(`INSERT INTO sync_relay_service_activations VALUES (?,?,?,?,?,?,?, ?,?,x'0000','owner-1',?,NULL,1)`)
    .run(namespace, `ordinary-activation-${"a".repeat(64)}`, scope.workspaceId, "main", binding.objectId, binding.lineageClaimId,
      JSON.stringify(source), JSON.stringify(binding), binding.lineageClaimId, scope.shareId);
  expect((await state()).status).toBe("preparing");
  f.raw.exec("UPDATE sync_relay_service_activations SET completion_json='{}'");
  f.host.ready.mockReturnValue(false);
  expect((await state()).status).toBe("preparing");
  f.host.ready.mockReturnValue(true);
  expect(await state()).toEqual({path: binding.currentPath, status: "ready", document: {binding, relayDatabaseNamespace: namespace, shareId: scope.shareId}});
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false});
  expect((await state()).status).toBe("paused");
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
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true});
  expect(await read()).toEqual({ok: true, refusals: [], nextCursor: null});
  expect((await f.handle(f.request("POST", {shareId: "pending-share"}))).status).toBe(202);
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "pending/a.md")).toMatchObject({enabled: true});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)).toMatchObject({retired: true, enabled: false});
});

it("advances refusal pages past healthy shares to an oversized share", async () => {
  const f = await fixture();
  f.storage.enrollServiceHostDocument(f.input);
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true});
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
  for (let index = 0; index < 65; index++) {
    const path = `docs/stopped-${index}.md`; f.seed(path, `stopped-${index}`);
    f.storage.enrollServiceHostDocument({...f.input, path});
    f.storage.setServiceHostEnrollmentEnabled({...f.input, path, enabled: false, retire: true});
  }
  expect(await (await f.handle(f.request("GET", undefined, {}, "?refusals=1"))).json()).toEqual({ok: true, refusals: [], nextCursor: null});
  expect((await f.handle(f.request("POST", {shareId: scope.shareId, retry: true}))).status).toBe(202);
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(1);
  expect(f.storage.listServiceHostEnrollments()[0]!.path).toBe(binding.currentPath);
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/stopped-0.md")).toMatchObject({retired: true, enabled: false});
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true});
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
  const handler = createServiceHostReplication({storage: f.storage, key, namespace});
  for (const path of ["/sync/workspaces", "/sync/foreign/bootstrap", `/sync/${scope.workspaceId}/epoch`, `/sync/${scope.workspaceId}/live-host`]) {
    expect((await handler(new Request(`https://relay.test${path}`, {method: "POST", headers: {authorization: `Bearer ${bearer}`}}))).status).toBe(404);
  }
  const response = await handler(new Request(`https://relay.test/sync/${scope.workspaceId}/bootstrap`, {headers: {authorization: `Bearer ${bearer}`}}));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({replicationEpoch: "epoch", streamIdentity: "stream"});
});

it.each(["blob", "log"] as const)("a service token revoked during the %s body cannot mutate storage", async kind => {
  const f = await fixture(), bearer = deriveServiceHostBearer(f.storage.enrollServiceHostDocument(f.input), {key, namespace});
  const handler = createServiceHostReplication({storage: f.storage, key, namespace});
  const bytes = new TextEncoder().encode("unpublished"), digest = createHash("sha256").update(bytes).digest("hex");
  const pending = deferredBody(kind === "blob" ? "PUT" : "POST", `https://relay.test/sync/${scope.workspaceId}/${kind === "blob" ? `blobs/${digest}` : "log"}`,
    {authorization: `Bearer ${bearer}`, "content-type": kind === "blob" ? "application/octet-stream" : "application/json"});
  const result = handler(pending.request); await pending.started;
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false});
  pending.finish(kind === "blob" ? bytes : new TextEncoder().encode(JSON.stringify({replicationEpoch: "epoch", streamIdentity: "stream", originId: "service", ops: [
    {originSeq: 0, opKind: "moment.append", recordedAtMs: 10, payload: {operation: "write"}}]})));
  expect((await result).status).toBe(404);
  expect(f.storage.getBlob(scope.workspaceId, digest)).toBeNull();
  expect(f.storage.fetchLogCoordinate({workspaceId: scope.workspaceId, originId: "service", originSeq: 0})).toBeNull();
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
  const stop = await f.handle(f.request("DELETE", {path: first.path, retire: true}));
  expect(await stop.json()).toEqual({ok: true, path: first.path, status: "retired"});
  expect(await (await f.handle(f.request())).json()).toEqual({ok: true, documents: []});
  discoverServiceHostDocuments(f.storage);
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
  expect(await (await f.handle(f.request("GET", undefined, {}, "?retired=1"))).json()).toEqual({ok: true, documents: [{path: first.path, status: "retired"}], nextCursor: null});
  const replication = createServiceHostReplication({storage: f.storage, key, namespace});
  expect((await replication(new Request(`https://relay.test/sync/${scope.workspaceId}/bootstrap`, {headers: {authorization: `Bearer ${bearer}`}}))).status).toBe(404);
  expect((await f.handle(f.request("POST", {path: first.path}))).status).toBe(202);
  expect(f.storage.listServiceHostEnrollments()[0]).toMatchObject({objectId: first.objectId, shareId: first.shareId, retired: false, enabled: true});
  expect((await f.handle(f.request("POST", {path: "docs/missing.md"}))).status).toBe(404);
  expect((await f.handle(f.request("GET", undefined, {}, "?retired=1&retired=1"))).status).toBe(404);
});

it("discovers a new document after more than 64 prior shares without reviving retired enrollment", async () => {
  const f = await fixture(); f.storage.enrollServiceHostDocument(f.input);
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true});
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
