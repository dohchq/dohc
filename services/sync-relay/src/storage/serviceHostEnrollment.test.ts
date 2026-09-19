import {afterEach, expect, it} from "vitest";
import {fixture as ticketFixture, binding, scope} from "../liveTickets.test-helper";
import {openSyncRelayStorage} from "../storage";
import {authorizeServiceHostReplication, deriveServiceHostBearer, serviceHostReplicationRoute} from "../serviceHostCredential";
import {serviceHostDocumentEnabled, SERVICE_HOST_ENROLLMENTS} from "./serviceHostEnrollment";
import type {StorageContext} from "./context";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanups.splice(0).reverse()) await close();});
const key = {key: new Uint8Array(32).fill(17), namespace: "relay-enrollment-test"};
const document = {workspaceId: binding.workspaceId, mainVersionId: binding.mainVersionId, objectId: binding.objectId, lineageClaimId: binding.lineageClaimId};
async function fixture(quota?: number) {
  const f = await ticketFixture(quota === undefined ? undefined : {workspaceQuotaBytes: quota}); cleanups.push(f.close);
  f.storage.claimWorkspaceIdentity({workspaceId: scope.workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
  const input = {workspaceId: scope.workspaceId, path: binding.currentPath, shareId: scope.shareId, ownerUserId: "owner-1", nowMs: 10, guard() {}};
  const enroll = (changes = {}) => f.storage.enrollServiceHostDocument({...input, ...changes});
  const setEnabled = (enabled: boolean) => f.storage.setServiceHostEnrollmentEnabled({...input, enabled, nowMs: 20});
  const authorize = (bearer: string, changes = {}) => authorizeServiceHostReplication(f.storage, {...key, workspaceId: scope.workspaceId,
    bearer, method: "GET", pathname: `/sync/${scope.workspaceId}/log`, ...changes});
  function seed(workspaceId: string, objectId: string, path: string, shareId: string) {
    f.storage.claimWorkspace({workspaceId, ownerUserId: "owner-1", createdAtMs: 0});
    f.storage.claimWorkspaceIdentity({workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
    f.raw.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
      VALUES (?,?,1,?,'main',?,?,'text',1,1)`).run(workspaceId, objectId, `moment-${objectId}`, path, "b".repeat(64));
    f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,'owner-1',?,0)")
      .run(shareId, workspaceId, JSON.stringify({paths: ["docs"], versionId: null}));
  }
  return {...f, input, enroll, setEnabled, authorize, seed};
}

it("retains original document, share and credential across pause, new invitation and reopen", async () => {
  const f = await fixture(), first = f.enroll(), bearer = deriveServiceHostBearer(first, key);
  expect(first.objectId).toBe(binding.objectId);
  expect(f.authorize(bearer)).toBe("owner-1");
  expect(f.setEnabled(false)?.enabled).toBe(false);
  expect(f.authorize(bearer)).toBeNull();
  f.raw.prepare("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=20 WHERE share_id=?").run(scope.shareId);
  f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) SELECT 'replacement',workspace_id,granter_user_id,selector_json,30 FROM sync_relay_shares WHERE share_id=?").run(scope.shareId);
  const resumed = f.enroll({shareId: "replacement", nowMs: 30});
  expect(resumed).toEqual({...first, enabled: true, updatedAtMs: 30});
  expect(deriveServiceHostBearer(resumed, key)).toBe(bearer);
  const reopened = openSyncRelayStorage(f.path, f.config);
  try {expect(reopened.listServiceHostEnrollments()).toEqual([resumed]);} finally {reopened.close();}
});

it("refuses foreign owners, foreign or non-covering shares, side versions and noncanonical paths", async () => {
  const f = await fixture();
  expect(() => f.enroll({ownerUserId: "attacker"})).toThrow("not found");
  for (const path of ["docs/../a.md", "other.md", "docs/data.csv", "docs/missing.md"]) expect(() => f.enroll({path})).toThrow();
  f.raw.prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id=?").run(JSON.stringify({paths: ["docs"], versionId: "branch"}), scope.shareId);
  expect(() => f.enroll()).toThrow("owner edit share");
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
});

it("fences native live authorization and service credentials immediately on pause, owner or epoch changes", async () => {
  const f = await fixture(), first = f.enroll(), bearer = deriveServiceHostBearer(first, key);
  const enabled = () => serviceHostDocumentEnabled(f.storage as StorageContext, binding);
  expect(enabled()).toBe(true);
  expect(f.storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: "owner-1", shareId: scope.shareId}}).kind).toBe("current");
  f.setEnabled(false);
  expect(enabled()).toBe(false);
  expect(f.storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: "owner-1", shareId: scope.shareId}})).toEqual({kind: "refused", reason: "host-unavailable"});
  f.setEnabled(true);
  f.raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id='other' WHERE workspace_id=?").run(scope.workspaceId);
  expect(enabled()).toBe(false); expect(f.authorize(bearer)).toBeNull();
  f.raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id='owner-1',replication_epoch='new-epoch' WHERE workspace_id=?").run(scope.workspaceId);
  expect(enabled()).toBe(false); expect(f.authorize(bearer)).toBeNull();
  expect(() => f.enroll()).toThrow("obsolete");
  expect(() => f.setEnabled(true)).toThrow("obsolete");
  expect(f.setEnabled(false)?.enabled).toBe(false);
});

it("checks guards inside the transaction and charges quota exactly once", async () => {
  const f = await fixture();
  const usage = () => Number(f.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id=?").get(scope.workspaceId)!.usage_bytes);
  const before = usage();
  expect(() => f.enroll({guard() {throw new Error("retired");}})).toThrow("retired");
  expect(usage()).toBe(before);
  f.enroll(); const charged = usage(); expect(charged).toBeGreaterThan(before);
  f.enroll(); f.setEnabled(false); f.setEnabled(true); expect(usage()).toBe(charged);
  f.seed(scope.workspaceId, "quota-object", "docs/quota.md", "quota-share");
  (f.storage as StorageContext).options.workspaceQuotaBytes = usage();
  expect(() => f.enroll({path: "docs/quota.md", shareId: "quota-share"})).toThrow("quota");
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(1);
});

it("bounds retained documents at 64 including paused rows", async () => {
  const f = await fixture(); f.enroll(); f.setEnabled(false);
  for (let i = 1; i <= 64; i++) {
    const path = `docs/${i}.md`, shareId = `share-${i+1}`;
    f.seed(scope.workspaceId, `object-${i+1}`, path, shareId);
    if (i === 64) expect(() => f.enroll({path, shareId})).toThrow("capacity");
    else f.enroll({path, shareId});
  }
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(64);
});

it("bounds workspace fanout at 16", async () => {
  const f = await fixture(); f.enroll();
  for (let i = 2; i <= 17; i++) {
    const workspaceId = `workspace-${i}`, shareId = `share-${i}`;
    f.seed(workspaceId, `object-${i}`, binding.currentPath, shareId);
    if (i === 17) expect(() => f.enroll({workspaceId, shareId})).toThrow("capacity");
    else f.enroll({workspaceId, shareId});
  }
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(16);
});

it("service tokens are workspace, deployment and key bound and never authorize administration", async () => {
  const f = await fixture(), bearer = deriveServiceHostBearer(f.enroll(), key);
  expect(f.authorize(bearer, {workspaceId: "foreign", pathname: "/sync/foreign/log"})).toBeNull();
  expect(f.authorize(bearer, {namespace: "other"})).toBeNull();
  expect(f.authorize(bearer, {key: new Uint8Array(32).fill(18)})).toBeNull();
  expect(f.authorize(`${bearer.slice(0,-1)}!`)).toBeNull();
  for (const suffix of ["epoch", "shares", "presence", "key-envelope", "maintenance/gc", "live-host", "log/owner/0/admin"]) {
    expect(f.authorize(bearer, {pathname: `/sync/${scope.workspaceId}/${suffix}`, method: "POST"})).toBeNull();
  }
  expect(f.authorize(bearer, {pathname: "/sync/workspaces", method: "POST"})).toBeNull();
  const routes = [["GET","bootstrap"],["GET","log"],["POST","log"],["GET","log/owner/0"],
    ["GET",`blobs/${"a".repeat(64)}`],["PUT",`blobs/${"a".repeat(64)}`],["POST","blobs/have"]];
  for (const [method,suffix] of routes) expect(f.authorize(bearer, {method, pathname: `/sync/${scope.workspaceId}/${suffix}`})).toBe("owner-1");
  expect(serviceHostReplicationRoute({workspaceId: scope.workspaceId, pathname: `/sync/${scope.workspaceId}/blobs/have`, method: "PUT"})).toBe(false);
  expect(JSON.stringify(f.raw.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS}`).all())).not.toContain(bearer);
});

it("discovers only current owner main-path edit shares and leaves paused enrollments paused", async () => {
  const f = await fixture();
  f.enroll(); f.setEnabled(false);
  expect(f.storage.scanServiceHostCandidateShares().shares.map(row => row.shareId)).toEqual([scope.shareId]);
  expect(f.storage.listServiceHostEnrollments()[0]!.enabled).toBe(false);
  f.raw.prepare("UPDATE sync_relay_share_grants SET access='read' WHERE share_id=?").run(scope.shareId);
  expect(f.storage.scanServiceHostCandidateShares().shares).toEqual([]);
  f.raw.prepare("UPDATE sync_relay_share_grants SET access='edit',status='revoked',revoked_at_ms=20 WHERE share_id=?").run(scope.shareId);
  expect(f.storage.scanServiceHostCandidateShares().shares).toEqual([]);
  f.raw.prepare("UPDATE sync_relay_share_grants SET status='active',revoked_at_ms=NULL WHERE share_id=?").run(scope.shareId);
  f.raw.prepare("UPDATE sync_relay_shares SET granter_user_id='other' WHERE share_id=?").run(scope.shareId);
  expect(f.storage.scanServiceHostCandidateShares().shares).toEqual([]);
  f.raw.prepare("UPDATE sync_relay_shares SET granter_user_id='owner-1',selector_json=? WHERE share_id=?").run(JSON.stringify({paths: ["docs"], versionId: "branch"}), scope.shareId);
  expect(f.storage.scanServiceHostCandidateShares().shares).toEqual([]);
});

it("does not replace a retained object when its path is reused or follow its rename implicitly", async () => {
  const f = await fixture(); f.enroll();
  f.raw.prepare("UPDATE sync_relay_object_moments SET path='docs/moved.md' WHERE workspace_id=? AND object_id=?").run(scope.workspaceId, binding.objectId);
  expect(() => f.enroll({path: "docs/moved.md"})).toThrow("moved");
  f.seed(scope.workspaceId, "replacement-object", binding.currentPath, "replacement-share");
  expect(() => f.enroll({shareId: "replacement-share"})).toThrow("another document");
  expect(f.storage.listServiceHostEnrollments()[0]!.objectId).toBe(binding.objectId);
});

it("checks updated authority inside write guards without opening a nested transaction", async () => {
  const f = await fixture(), bearer = deriveServiceHostBearer(f.enroll(), key);
  (f.storage as StorageContext).tx(() => {
    expect(f.authorize(bearer)).toBe("owner-1");
    f.raw.prepare("SELECT 1").get();
    (f.storage as StorageContext).db.prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET enabled=0 WHERE workspace_id=?`).run(scope.workspaceId);
    expect(f.authorize(bearer)).toBeNull();
  });
  expect(() => f.enroll({guard() {
    (f.storage as StorageContext).db.prepare("UPDATE sync_relay_workspaces SET owner_user_id='other' WHERE workspace_id=?").run(scope.workspaceId);
  }})).toThrow("not found");
  expect(f.storage.workspaceIsOwnedBy(scope.workspaceId, "owner-1")).toBe(true);
});

it("keeps another document's service credential valid when the selected document is paused", async () => {
  const f = await fixture(), first = f.enroll();
  f.seed(scope.workspaceId, "second-object", "docs/b.md", "second-share");
  const second = f.enroll({path: "docs/b.md", shareId: "second-share"});
  f.setEnabled(false);
  expect(f.authorize(deriveServiceHostBearer(first, key))).toBeNull();
  expect(f.authorize(deriveServiceHostBearer(second, key))).toBe("owner-1");
  expect(f.storage.listCurrentServiceHostEnrollments(scope.workspaceId)).toEqual([second]);
});

it("refuses altered enrollment schema on reopen", async () => {
  const f = await fixture(); f.enroll();
  f.raw.exec(`CREATE TRIGGER unexpected_enrollment_trigger AFTER UPDATE ON ${SERVICE_HOST_ENROLLMENTS} BEGIN SELECT 1; END`);
  expect(() => openSyncRelayStorage(f.path, f.config)).toThrow("constraints are damaged");
});

it("retirement frees capacity beyond 64 lifetime documents while preserving every canonical enrollment", async () => {
  const f = await fixture(), first = f.enroll(), bearer = deriveServiceHostBearer(first, key);
  const retire = (path: string) => f.storage.setServiceHostEnrollmentEnabled({...f.input, path, enabled: false, retire: true});
  for (let i = 1; i <= 63; i++) {
    const path = `docs/retirement-${i}.md`, shareId = `retirement-${i}`;
    f.seed(scope.workspaceId, `retirement-${i}`, path, shareId); f.enroll({path, shareId});
  }
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(64);
  expect(retire(first.path)).toMatchObject({retired: true, enabled: false});
  expect(f.authorize(bearer)).toBeNull();
  expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding)).toBe(false);
  expect(f.storage.hasServiceHostEnrollment(scope.workspaceId, first.path)).toBe(true);
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(63);
  f.seed(scope.workspaceId, "sixty-fifth", "docs/sixty-fifth.md", "sixty-fifth");
  f.enroll({path: "docs/sixty-fifth.md", shareId: "sixty-fifth"});
  expect(f.raw.prepare(`SELECT count(*) AS count FROM ${SERVICE_HOST_ENROLLMENTS}`).get()!.count).toBe(65);
  expect(() => f.enroll()).toThrow("capacity");
  expect(() => f.setEnabled(true)).toThrow("capacity");
  expect(f.authorize(bearer)).toBeNull();
  retire("docs/sixty-fifth.md");
  expect(f.enroll()).toEqual(first);
  expect(f.authorize(bearer)).toBe("owner-1");
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(64);
});

it("retired rows stay hidden until an explicit reactivation and still reject foreign identities", async () => {
  const f = await fixture(), first = f.enroll();
  expect(f.storage.hasServiceHostEnrollment(scope.workspaceId, first.path)).toBe(true);
  expect(f.storage.hasServiceHostEnrollment(scope.workspaceId, "docs/absent.md")).toBe(false);
  expect(() => f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: true, retire: true})).toThrow("Invalid");
  expect(f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true, ownerUserId: "other"})).toBeNull();
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, first.path)).toMatchObject({shareId: first.shareId, retired: true, enabled: false});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/absent.md")).toBeNull();
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
  expect(f.storage.listServiceHostEnrollments(scope.workspaceId)).toEqual([]);
  expect(f.storage.listCurrentServiceHostEnrollments(scope.workspaceId)).toEqual([]);
  expect(f.setEnabled(false)).toMatchObject({retired: true, enabled: false});
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
  expect(f.setEnabled(true)).toMatchObject({retired: false, enabled: true});
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(1);
});

it("retiring the last enrollment in a workspace frees its workspace slot", async () => {
  const f = await fixture(); f.enroll();
  for (let i = 2; i <= 17; i++) {
    const workspaceId = `workspace-${i}`, shareId = `share-${i}`;
    f.seed(workspaceId, `object-${i}`, binding.currentPath, shareId);
    if (i < 17) f.enroll({workspaceId, shareId});
  }
  f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true});
  f.enroll({workspaceId: "workspace-17", shareId: "share-17"});
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(16);
  expect(() => f.enroll()).toThrow("capacity");
  expect(f.raw.prepare(`SELECT count(*) AS count FROM ${SERVICE_HOST_ENROLLMENTS}`).get()!.count).toBe(17);
});

it("pages retired documents by path without mixing workspaces or active rows", async () => {
  const f = await fixture(); f.enroll();
  for (let i = 0; i < 65; i++) {
    const path = `docs/retired-${String(i).padStart(2, "0")}.md`, shareId = `retired-page-${i}`;
    f.seed(scope.workspaceId, shareId, path, shareId); f.enroll({path, shareId});
    f.storage.setServiceHostEnrollmentEnabled({...f.input, path, enabled: false, retire: true});
  }
  const first = f.storage.listRetiredServiceHostEnrollments(scope.workspaceId);
  expect(first.documents).toHaveLength(64); expect(first.nextCursor).toBe("docs/retired-63.md");
  expect(first.documents.every(row => row.retired && !row.enabled)).toBe(true);
  const second = f.storage.listRetiredServiceHostEnrollments(scope.workspaceId, first.nextCursor!);
  expect(second.documents.map(row => row.path)).toEqual(["docs/retired-64.md"]); expect(second.nextCursor).toBeNull();
  expect(f.storage.listRetiredServiceHostEnrollments("other")).toEqual({documents: [], nextCursor: null});
  expect(() => f.storage.listRetiredServiceHostEnrollments(scope.workspaceId, "docs/../bad.md")).toThrow();
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(1);
});

it("candidate scanning advances past a full page of noncanonical shares", async () => {
  const f = await fixture();
  for (let i = 0; i < 65; i++) {
    const shareId = `candidate-${String(i).padStart(2,"0")}`;
    f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,'owner-1',?,0)")
      .run(shareId, scope.workspaceId, JSON.stringify({paths: ["docs"], versionId: i < 64 ? "branch" : null}));
    f.raw.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
      VALUES (?,?,'user','reader',NULL,'edit',1,'active',0,NULL,NULL)`).run(`grant-${shareId}`, shareId);
  }
  const first = f.storage.scanServiceHostCandidateShares();
  expect(first.shares).toEqual([]);
  expect(first.nextCursor).toEqual({workspaceId: scope.workspaceId, shareId: "candidate-63"});
  const second = f.storage.scanServiceHostCandidateShares(first.nextCursor!);
  expect(second.shares.map(share => share.shareId)).toEqual(["candidate-64", scope.shareId]);
  expect(second.nextCursor).toBeNull();
});
