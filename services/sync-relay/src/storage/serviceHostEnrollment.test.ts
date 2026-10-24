import {afterEach, expect, it} from "vitest";
import {fixture as ticketFixture, binding, retainServiceActivation, scope} from "../liveTickets.test-helper";
import {openSyncRelayStorage} from "../storage";
import {authorizeServiceHostReplication, deriveServiceHostBearer, serviceHostReplicationRoute} from "../serviceHostCredential";
import {serviceHostDocumentEnabled, SERVICE_HOST_ENROLLMENTS, SERVICE_HOST_MAX_WORKSPACES} from "./serviceHostEnrollment";
import {readServiceActivationRetirement} from "./serviceActivationRetirement";
import {fenceAccount, initializeAccountDeletion} from "./accountDeletion";
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
  // What the service host does once it no longer holds the document.
  const release = (objectId = binding.objectId) => f.storage.releaseServiceHostEnrollment({workspaceId: scope.workspaceId, objectId, nowMs: 25});
  const pause = () => {setEnabled(false); return release();};
  const stop = (changes = {}) => {
    const row = f.storage.setServiceHostEnrollmentEnabled({...input, enabled: false, retire: true, nowMs: 20, ...changes});
    if (row) f.storage.releaseServiceHostEnrollment({workspaceId: row.workspaceId, objectId: row.objectId, nowMs: 25});
    return row && f.storage.readServiceHostEnrollment(row.workspaceId, row.path);
  };
  const authorize = (bearer: string, changes = {}) => authorizeServiceHostReplication(f.storage, {...key, workspaceId: scope.workspaceId,
    bearer, method: "GET", pathname: `/sync/${scope.workspaceId}/hosted/log`, ...changes});
  function seed(workspaceId: string, objectId: string, path: string, shareId: string) {
    f.storage.claimWorkspace({workspaceId, ownerUserId: "owner-1", createdAtMs: 0});
    f.storage.claimWorkspaceIdentity({workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
    f.raw.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
      VALUES (?,?,1,?,'main',?,?,'text',1,1)`).run(workspaceId, objectId, `moment-${objectId}`, path, "b".repeat(64));
    f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,'owner-1',?,0)")
      .run(shareId, workspaceId, JSON.stringify({paths: ["docs"], versionId: null}));
  }
  return {...f, input, enroll, setEnabled, release, pause, stop, authorize, seed};
}

it("retains original document, share and credential across pause, new invitation and reopen", async () => {
  const f = await fixture(), first = f.enroll(), bearer = deriveServiceHostBearer(first, key);
  expect(first.objectId).toBe(binding.objectId);
  expect(f.authorize(bearer)).toBe("owner-1");
  expect(f.pause()?.enabled).toBe(false);
  expect(f.authorize(bearer)).toBeNull();
  f.raw.prepare("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=20 WHERE share_id=?").run(scope.shareId);
  f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) SELECT 'replacement',workspace_id,granter_user_id,selector_json,30 FROM sync_relay_shares WHERE share_id=?").run(scope.shareId);
  const resumed = f.enroll({shareId: "replacement", nowMs: 30});
  expect(resumed).toEqual({...first, enabled: true, ownerStop: null, updatedAtMs: 30});
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

it("fences a paused document's admission at once, keeps its credential until its release, and fences owner or epoch changes immediately", async () => {
  const f = await fixture(), first = f.enroll(), bearer = deriveServiceHostBearer(first, key);
  const enabled = () => serviceHostDocumentEnabled(f.storage as StorageContext, binding);
  expect(enabled()).toBe(true);
  expect(f.storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: "owner-1", shareId: scope.shareId}}).kind).toBe("current");
  expect(f.setEnabled(false)).toMatchObject({enabled: true, ownerStop: "pause"});
  // The host keeps its credential while applied work settles, but nothing new is admitted.
  expect(enabled()).toBe(false); expect(f.authorize(bearer)).toBe("owner-1");
  expect(f.storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: "owner-1", shareId: scope.shareId}})).toEqual({kind: "refused", reason: "host-unavailable"});
  expect(f.release()).toMatchObject({enabled: false, retired: false, ownerStop: "pause"});
  expect(enabled()).toBe(false); expect(f.authorize(bearer)).toBeNull();
  f.setEnabled(true);
  f.raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id='other' WHERE workspace_id=?").run(scope.workspaceId);
  expect(enabled()).toBe(false); expect(f.authorize(bearer)).toBeNull();
  f.raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id='owner-1',replication_epoch='new-epoch' WHERE workspace_id=?").run(scope.workspaceId);
  expect(enabled()).toBe(false); expect(f.authorize(bearer)).toBeNull();
  expect(() => f.enroll()).toThrow("obsolete");
  expect(() => f.setEnabled(true)).toThrow("obsolete");
  expect(f.setEnabled(false)?.ownerStop).toBe("pause");
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
  const f = await fixture(); f.enroll(); f.pause();
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
  expect(f.authorize(bearer, {workspaceId: "foreign", pathname: "/sync/foreign/hosted/log"})).toBeNull();
  expect(f.authorize(bearer, {namespace: "other"})).toBeNull();
  expect(f.authorize(bearer, {key: new Uint8Array(32).fill(18)})).toBeNull();
  expect(f.authorize(`${bearer.slice(0,-1)}!`)).toBeNull();
  for (const suffix of ["epoch", "shares", "presence", "key-envelope", "maintenance/gc", "live-host", "log/owner/0/admin", "hosted/live-host"]) {
    expect(f.authorize(bearer, {pathname: `/sync/${scope.workspaceId}/${suffix}`, method: "POST"})).toBeNull();
  }
  expect(f.authorize(bearer, {pathname: "/sync/workspaces", method: "POST"})).toBeNull();
  const routes = [["GET","bootstrap"],["GET","log"],["POST","log"],["GET","log/owner/0"],
    ["GET",`blobs/${"a".repeat(64)}`],["PUT",`blobs/${"a".repeat(64)}`],["POST","blobs/have"]];
  for (const [method,suffix] of routes) {
    expect(f.authorize(bearer, {method, pathname: `/sync/${scope.workspaceId}/hosted/${suffix}`})).toBe("owner-1");
    // The same route outside the scoped feed is the workspace's ordinary replication.
    expect(f.authorize(bearer, {method, pathname: `/sync/${scope.workspaceId}/${suffix}`})).toBeNull();
  }
  expect(serviceHostReplicationRoute({workspaceId: scope.workspaceId, pathname: `/sync/${scope.workspaceId}/blobs/have`, method: "PUT"})).toBe(false);
  expect(JSON.stringify(f.raw.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS}`).all())).not.toContain(bearer);
});

it("discovers only current owner main-path edit shares and leaves paused enrollments paused", async () => {
  const f = await fixture();
  f.enroll(); f.pause();
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
    (f.storage as StorageContext).db.prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET owner_stop='pause',enabled=0,host_drained_at_ms=11 WHERE workspace_id=?`).run(scope.workspaceId);
    expect(f.authorize(bearer)).toBeNull();
  });
  expect(() => f.enroll({guard() {
    (f.storage as StorageContext).db.prepare("UPDATE sync_relay_workspaces SET owner_user_id='other' WHERE workspace_id=?").run(scope.workspaceId);
  }})).toThrow("not found");
  expect(f.storage.workspaceIsOwnedBy(scope.workspaceId, "owner-1")).toBe(true);
});

it("keeps one workspace service credential while any of its documents stays enabled", async () => {
  const f = await fixture(), first = f.enroll();
  f.seed(scope.workspaceId, "second-object", "docs/b.md", "second-share");
  const second = f.enroll({path: "docs/b.md", shareId: "second-share"});
  const bearer = deriveServiceHostBearer(first, key);
  expect(deriveServiceHostBearer(second, key)).toBe(bearer);
  const workspace = {workspaceId: scope.workspaceId, ownerUserId: "owner-1", replicationEpoch: "epoch", streamIdentity: "stream"};
  expect(f.storage.currentServiceHostWorkspace(scope.workspaceId)).toEqual(workspace);
  expect(deriveServiceHostBearer(workspace, key)).toBe(bearer);
  // The document that attached the workspace leaves; the credential stays valid for its sibling.
  f.pause();
  expect(f.authorize(bearer)).toBe("owner-1");
  f.storage.setServiceHostEnrollmentEnabled({...f.input, path: second.path, enabled: false, nowMs: 20});
  expect(f.authorize(bearer)).toBe("owner-1");
  f.release(second.objectId);
  expect(f.authorize(bearer)).toBeNull();
  expect(f.storage.currentServiceHostWorkspace(scope.workspaceId)).toBeNull();
});

it("lists the enrollments the host has not drained, including stopped ones, active rows first", async () => {
  const f = await fixture(), active = f.enroll();
  for (const [objectId, path, shareId] of [["paused-object", "docs/paused.md", "paused-share"], ["stopped-object", "docs/0.md", "stopped-share"],
    ["released-object", "docs/released.md", "released-share"]] as const) {
    f.seed(scope.workspaceId, objectId, path, shareId);
    f.enroll({path, shareId});
  }
  f.storage.setServiceHostEnrollmentEnabled({...f.input, path: "docs/paused.md", enabled: false, nowMs: 20});
  f.storage.setServiceHostEnrollmentEnabled({...f.input, path: "docs/0.md", enabled: false, retire: true, nowMs: 20});
  f.storage.setServiceHostEnrollmentEnabled({...f.input, path: "docs/released.md", enabled: false, nowMs: 20});
  f.release("released-object");
  expect(f.storage.listUndrainedServiceHostEnrollments().documents.map(row => [row.path, row.enabled, row.retired, row.ownerStop]))
    .toEqual([[active.path, true, false, null], ["docs/paused.md", true, false, "pause"], ["docs/0.md", false, true, "retire"]]);
  f.release("stopped-object");
  expect(f.storage.listUndrainedServiceHostEnrollments().documents.map(row => row.path)).toEqual([active.path, "docs/paused.md"]);
});

// Proves: retired rows come a page at a time after every active row. A page
// names no more workspaces than capacity allows active ones, so the host,
// which opens one engine handle for each, stays within the engine's 64.
it("pages retired undrained enrollments after the active ones, a bounded number of workspaces at a time", async () => {
  const f = await fixture(), active = f.enroll();
  const stopped = f.raw.prepare(`INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,owner_stop,enabled,retired,created_at_ms,updated_at_ms,accounted_bytes)
    VALUES (?,?,?,'owner-1',?,'epoch','stream','retire',0,1,1,1,1)`);
  // More workspaces than eight pages, each with a document stopped while the host was down. The first has three.
  const workspaces = Array.from({length: 130}, (_, index) => `workspace-${String(index).padStart(3, "0")}`);
  for (const workspaceId of workspaces) {f.seed(workspaceId, "object", "docs/a.md", `share-${workspaceId}`); stopped.run(workspaceId, "object", "docs/a.md", `share-${workspaceId}`);}
  for (const index of [1, 2]) stopped.run(workspaces[0], `object-${index}`, `docs/${index}.md`, `share-${workspaces[0]}`);
  const pages = [f.storage.listUndrainedServiceHostEnrollments()];
  while (pages.at(-1)!.nextCursor) pages.push(f.storage.listUndrainedServiceHostEnrollments(pages.at(-1)!.nextCursor!));
  expect(pages).toHaveLength(9);
  for (const {documents} of pages) {
    expect(documents[0]).toMatchObject({workspaceId: active.workspaceId, path: active.path, retired: false});
    expect(new Set(documents.slice(1).map(row => row.workspaceId)).size).toBeLessThanOrEqual(SERVICE_HOST_MAX_WORKSPACES);
  }
  expect(pages[0]!.documents.slice(1).map(row => [row.workspaceId, row.path])).toEqual([[workspaces[0], "docs/1.md"], [workspaces[0], "docs/2.md"],
    ...workspaces.slice(0, 16).map(workspaceId => [workspaceId, "docs/a.md"])]);
  expect(pages[0]!.nextCursor).toEqual({workspaceId: workspaces[15], path: "docs/a.md"});
  expect(pages.at(-1)).toMatchObject({documents: [{workspaceId: active.workspaceId}, {workspaceId: workspaces[128]}, {workspaceId: workspaces[129]}], nextCursor: null});
  expect(pages.flatMap(page => page.documents.slice(1).map(row => `${row.workspaceId}/${row.path}`))).toEqual(
    [`${workspaces[0]}/docs/1.md`, `${workspaces[0]}/docs/2.md`, ...workspaces.map(workspaceId => `${workspaceId}/docs/a.md`)]);
});

it("refuses altered enrollment schema on reopen", async () => {
  const f = await fixture(); f.enroll();
  f.raw.exec(`CREATE TRIGGER unexpected_enrollment_trigger AFTER UPDATE ON ${SERVICE_HOST_ENROLLMENTS} BEGIN SELECT 1; END`);
  expect(() => openSyncRelayStorage(f.path, f.config)).toThrow("constraints are damaged");
});

// The enrollment table as relays created it before `owner_stop`.
const V1_SQL = `CREATE TABLE ${SERVICE_HOST_ENROLLMENTS} (
  workspace_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  path TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  replication_epoch TEXT NOT NULL,
  stream_identity TEXT NOT NULL,
  credential_nonce TEXT NOT NULL CHECK (length(credential_nonce)=64 AND credential_nonce NOT GLOB '*[^0-9a-f]*'),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0,1) AND (retired=0 OR enabled=0)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (workspace_id, object_id),
  UNIQUE (workspace_id, path),
  FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (share_id) REFERENCES sync_relay_shares(share_id)
) STRICT`;
const V2_SQL = `CREATE TABLE ${SERVICE_HOST_ENROLLMENTS} (
  workspace_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  path TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  replication_epoch TEXT NOT NULL,
  stream_identity TEXT NOT NULL,
  owner_stop TEXT CHECK (owner_stop IN ('pause','retire')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0,1) AND (retired=0 OR enabled=0)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND 9007199254740991),
  CHECK (enabled=1 OR retired=1 OR owner_stop='pause'),
  PRIMARY KEY (workspace_id, object_id),
  UNIQUE (workspace_id, path),
  FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (share_id) REFERENCES sync_relay_shares(share_id)
) STRICT`;
/** Rewrites the fixture's enrollments into the v1 layout, keeping each row's enabled and retired state. */
function downgradeToV1(f: Awaited<ReturnType<typeof fixture>>, sql = V1_SQL, marker: string | null = "service-host-enrollments-v1") {
  f.raw.exec(`BEGIN;
    ALTER TABLE ${SERVICE_HOST_ENROLLMENTS} RENAME TO enrollments_v2;
    ${sql};
    INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,credential_nonce,enabled,retired,created_at_ms,updated_at_ms,accounted_bytes)
      SELECT workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,'${"a".repeat(64)}',enabled,retired,created_at_ms,updated_at_ms,accounted_bytes FROM enrollments_v2;
    DROP TABLE enrollments_v2;
    CREATE INDEX idx_sync_relay_service_host_enrollments_active ON ${SERVICE_HOST_ENROLLMENTS}(workspace_id,path) WHERE retired=0;
    CREATE INDEX idx_sync_relay_service_host_enrollments_retired ON ${SERVICE_HOST_ENROLLMENTS}(workspace_id,path) WHERE retired=1;
    DELETE FROM sync_relay_migrations WHERE migration_id='service-host-enrollments-v2';
    DELETE FROM sync_relay_migrations WHERE migration_id='service-host-enrollments-v3';
    COMMIT;`);
  if (marker) f.raw.prepare("INSERT INTO sync_relay_migrations (migration_id,completed_at_ms) VALUES (?,1)").run(marker);
}

function downgradeToV2(f: Awaited<ReturnType<typeof fixture>>) {
  f.raw.exec(`BEGIN;
    ALTER TABLE ${SERVICE_HOST_ENROLLMENTS} RENAME TO enrollments_v3;
    ${V2_SQL};
    INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,owner_stop,enabled,retired,created_at_ms,updated_at_ms,accounted_bytes)
      SELECT workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,owner_stop,enabled,retired,created_at_ms,updated_at_ms,accounted_bytes FROM enrollments_v3;
    DROP TABLE enrollments_v3;
    CREATE INDEX idx_sync_relay_service_host_enrollments_active ON ${SERVICE_HOST_ENROLLMENTS}(workspace_id,path) WHERE retired=0;
    CREATE INDEX idx_sync_relay_service_host_enrollments_retired ON ${SERVICE_HOST_ENROLLMENTS}(workspace_id,path) WHERE retired=1;
    DELETE FROM sync_relay_migrations WHERE migration_id='service-host-enrollments-v3';
    COMMIT;`);
}

it("migrates v2 enrollments with released rows already drained", async () => {
  const f = await fixture(), enrolled = f.enroll();
  f.seed(scope.workspaceId, "paused-object", "docs/paused.md", "paused-share");
  f.seed(scope.workspaceId, "retired-object", "docs/retired.md", "retired-share");
  f.enroll({path: "docs/paused.md", shareId: "paused-share"});
  f.enroll({path: "docs/retired.md", shareId: "retired-share"});
  f.storage.setServiceHostEnrollmentEnabled({...f.input, path: "docs/paused.md", enabled: false, nowMs: 20});
  f.release("paused-object");
  f.stop({path: "docs/retired.md"});
  downgradeToV2(f);
  const reopened = openSyncRelayStorage(f.path, f.config);
  try {
    expect(reopened.readServiceHostEnrollment(scope.workspaceId, enrolled.path)).toMatchObject({enabled: true, hostDrainedAtMs: null});
    expect(reopened.readServiceHostEnrollment(scope.workspaceId, "docs/paused.md")).toMatchObject({enabled: false, retired: false, hostDrainedAtMs: 25});
    expect(reopened.readServiceHostEnrollment(scope.workspaceId, "docs/retired.md")).toMatchObject({enabled: false, retired: true, hostDrainedAtMs: 25});
    expect(f.raw.prepare("SELECT migration_id FROM sync_relay_migrations WHERE migration_id=?").get("service-host-enrollments-v3")).toBeTruthy();
  } finally {reopened.close();}
});

it("migrates v1 enrollments in place and keeps the enabled document hosted", async () => {
  const f = await fixture(), enabled = f.enroll();
  f.seed(scope.workspaceId, "paused-object", "docs/paused.md", "paused-share");
  f.seed(scope.workspaceId, "retired-object", "docs/retired.md", "retired-share");
  f.enroll({path: "docs/paused.md", shareId: "paused-share"});
  f.enroll({path: "docs/retired.md", shareId: "retired-share"});
  f.storage.setServiceHostEnrollmentEnabled({...f.input, path: "docs/paused.md", enabled: false, nowMs: 20});
  f.release("paused-object");
  f.stop({path: "docs/retired.md"});
  const usage = () => f.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id=?").get(scope.workspaceId)!.usage_bytes;
  const before = f.raw.prepare(`SELECT path,enabled,retired,accounted_bytes FROM ${SERVICE_HOST_ENROLLMENTS} ORDER BY path`).all(), charged = usage();
  downgradeToV1(f);
  for (let open = 0; open < 2; open++) {
    const reopened = openSyncRelayStorage(f.path, f.config);
    try {
      expect(f.raw.prepare(`SELECT path,enabled,retired,accounted_bytes FROM ${SERVICE_HOST_ENROLLMENTS} ORDER BY path`).all()).toEqual(before);
      expect(reopened.listServiceHostEnrollments(scope.workspaceId).map(row => [row.path, row.enabled, row.ownerStop, row.hostDrainedAtMs]))
        .toEqual([["docs/a.md", true, null, null], ["docs/paused.md", false, "pause", 25]]);
      expect(reopened.listRetiredServiceHostEnrollments(scope.workspaceId).documents.map(row => [row.path, row.ownerStop, row.hostDrainedAtMs])).toEqual([["docs/retired.md", "retire", 25]]);
      // A retired v1 document stays out of a new Edit share's reach, as it did before.
      expect(reopened.hasKeptServiceHostEnrollment(scope.workspaceId, "docs/retired.md")).toBe(true);
      expect(serviceHostDocumentEnabled(reopened as StorageContext, binding)).toBe(true);
      expect(authorizeServiceHostReplication(reopened, {...key, workspaceId: scope.workspaceId, bearer: deriveServiceHostBearer(enabled, key),
        method: "GET", pathname: `/sync/${scope.workspaceId}/hosted/log`})).toBe("owner-1");
      expect(usage()).toBe(charged);
    } finally {reopened.close();}
  }
  expect(f.raw.prepare("SELECT migration_id FROM sync_relay_migrations WHERE migration_id LIKE 'service-host-enrollments-%' ORDER BY migration_id").all()
    .map(row => row.migration_id)).toEqual(["service-host-enrollments-v1", "service-host-enrollments-v2", "service-host-enrollments-v3"]);
});

it("refuses an enrollment table it does not recognize", async () => {
  const unmarked = await fixture(); unmarked.enroll();
  downgradeToV1(unmarked, V1_SQL, null);
  expect(() => openSyncRelayStorage(unmarked.path, unmarked.config)).toThrow("Unmarked service host enrollment storage exists.");
  const altered = await fixture(); altered.enroll();
  downgradeToV1(altered, V1_SQL.replace("STRICT", ""));
  expect(() => openSyncRelayStorage(altered.path, altered.config)).toThrow("Service host enrollment storage is damaged.");
  for (const f of [unmarked, altered]) expect(f.raw.prepare(`SELECT count(*) AS count FROM ${SERVICE_HOST_ENROLLMENTS}`).get()!.count).toBe(1);
});

it("retirement frees capacity beyond 64 lifetime documents while preserving every canonical enrollment", async () => {
  const f = await fixture(), first = f.enroll();
  const retire = (path: string) => f.stop({path});
  for (let i = 1; i <= 63; i++) {
    const path = `docs/retirement-${i}.md`, shareId = `retirement-${i}`;
    f.seed(scope.workspaceId, `retirement-${i}`, path, shareId); f.enroll({path, shareId});
  }
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(64);
  expect(retire(first.path)).toMatchObject({retired: true, enabled: false, ownerStop: "retire"});
  expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding)).toBe(false);
  expect(f.storage.hasKeptServiceHostEnrollment(scope.workspaceId, first.path)).toBe(true);
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(63);
  f.seed(scope.workspaceId, "sixty-fifth", "docs/sixty-fifth.md", "sixty-fifth");
  f.enroll({path: "docs/sixty-fifth.md", shareId: "sixty-fifth"});
  expect(f.raw.prepare(`SELECT count(*) AS count FROM ${SERVICE_HOST_ENROLLMENTS}`).get()!.count).toBe(65);
  expect(() => f.enroll()).toThrow("capacity");
  expect(() => f.setEnabled(true)).toThrow("capacity");
  expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding)).toBe(false);
  retire("docs/sixty-fifth.md");
  expect(f.enroll()).toEqual({...first, updatedAtMs: 25});
  expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding)).toBe(true);
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(64);
});

it("retired rows stay hidden until an explicit reactivation and still reject foreign identities", async () => {
  const f = await fixture(), first = f.enroll();
  expect(f.storage.hasKeptServiceHostEnrollment(scope.workspaceId, first.path)).toBe(true);
  expect(f.storage.hasKeptServiceHostEnrollment(scope.workspaceId, "docs/absent.md")).toBe(false);
  expect(() => f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: true, retire: true})).toThrow("Invalid");
  expect(f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true, ownerUserId: "other"})).toBeNull();
  // Stop fences acceptance immediately.
  expect(f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true})).toMatchObject({enabled: false, retired: true, ownerStop: "retire"});
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(0);
  expect(f.release()).toMatchObject({hostDrainedAtMs: 25});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, first.path)).toMatchObject({shareId: first.shareId, retired: true, enabled: false});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/absent.md")).toBeNull();
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
  expect(f.storage.listServiceHostEnrollments(scope.workspaceId)).toEqual([]);
  expect(f.storage.currentServiceHostWorkspace(scope.workspaceId)).toBeNull();
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
  f.stop();
  f.enroll({workspaceId: "workspace-17", shareId: "share-17"});
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(16);
  expect(() => f.enroll()).toThrow("capacity");
  expect(f.raw.prepare(`SELECT count(*) AS count FROM ${SERVICE_HOST_ENROLLMENTS}`).get()!.count).toBe(17);
});

it("pages retired documents by path without mixing workspaces or active rows", async () => {
  const f = await fixture(); f.enroll();
  // Retirement has its own lifecycle tests, so one transaction seeds the retired rows.
  f.raw.exec("BEGIN");
  for (let i = 0; i < 65; i++) {
    f.raw.prepare(`INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,owner_stop,enabled,retired,created_at_ms,updated_at_ms,accounted_bytes)
      VALUES (?,?,?,'owner-1',?,'epoch','stream','retire',0,1,10,25,1)`).run(scope.workspaceId, `retired-page-${i}`, `docs/retired-${String(i).padStart(2, "0")}.md`, scope.shareId);
  }
  f.raw.exec("COMMIT");
  const first = f.storage.listRetiredServiceHostEnrollments(scope.workspaceId);
  expect(first.documents).toHaveLength(64); expect(first.nextCursor).toBe("docs/retired-63.md");
  expect(first.documents.every(row => row.retired && !row.enabled)).toBe(true);
  const second = f.storage.listRetiredServiceHostEnrollments(scope.workspaceId, first.nextCursor!);
  expect(second.documents.map(row => row.path)).toEqual(["docs/retired-64.md"]); expect(second.nextCursor).toBeNull();
  expect(f.storage.listRetiredServiceHostEnrollments("other")).toEqual({documents: [], nextCursor: null});
  expect(() => f.storage.listRetiredServiceHostEnrollments(scope.workspaceId, "docs/../bad.md")).toThrow();
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(1);
});

it("retires an enrollment only once no active Edit grant on the owner's shares covers it", async () => {
  const f = await fixture(), enrolled = f.enroll();
  const covered = () => f.storage.serviceHostEnrollmentHasEditGrant(enrolled);
  const retire = () => f.storage.releaseServiceHostEnrollment({workspaceId: scope.workspaceId, objectId: enrolled.objectId, nowMs: 40});
  const share = (shareId: string, paths: string[], granter = "owner-1") => {
    f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,?,?,0)")
      .run(shareId, scope.workspaceId, granter, JSON.stringify({paths, versionId: null}));
    f.raw.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
      VALUES (?,?,'user','reader',NULL,'edit',1,'active',0,NULL,NULL)`).run(`${shareId}-edit`, shareId);
  };
  share("overlap", ["docs"]); share("elsewhere", ["notes"]); share("foreign", ["docs"], "other");
  expect(f.storage.revokeShareGrant({shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 30}).ok).toBe(true);
  expect(covered()).toBe(true);
  expect(retire()).toBeNull();
  expect(f.storage.listServiceHostEnrollments()).toEqual([enrolled]);
  // A View grant, another path, or another person's share does not cover the document.
  f.raw.prepare("UPDATE sync_relay_share_grants SET access='view' WHERE grant_id='overlap-edit'").run();
  expect(covered()).toBe(false);
  expect(retire()).toMatchObject({path: binding.currentPath, enabled: false, retired: true, ownerStop: null, updatedAtMs: 40});
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
  expect(f.storage.listRetiredServiceHostEnrollments(scope.workspaceId).documents.map(row => row.path)).toEqual([binding.currentPath]);
  expect(retire()).toBeNull();
});

// Proves: live admission needs an Edit grant of the enrollment's owner that
// covers its path, as its departure does. Deleting the last one refuses the
// owner's binding at once, though the enrollment stays enabled until its
// release. Another covering Edit grant keeps it current, and Stop fences it either way.
it("refuses a document's live binding once no Edit grant of its owner covers it, and keeps Stop's fence", async () => {
  const f = await fixture(), enrolled = f.enroll();
  const owner = () => f.storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: "owner-1", shareId: scope.shareId}});
  const enabled = () => serviceHostDocumentEnabled(f.storage as StorageContext, binding);
  const refused = {kind: "refused", reason: "host-unavailable"};
  expect(owner().kind).toBe("current");
  expect(f.storage.revokeShare(scope.shareId, 30)).toBe(true);
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, enrolled.path)).toMatchObject({enabled: true, retired: false});
  expect(enabled()).toBe(false);
  expect(owner()).toEqual(refused);
  // A View grant, or an Edit grant on another person's share, does not cover it.
  f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES ('overlap',?,'owner-1',?,0),('foreign',?,'other',?,0)")
    .run(scope.workspaceId, JSON.stringify({paths: ["docs"], versionId: null}), scope.workspaceId, JSON.stringify({paths: ["docs"], versionId: null}));
  f.raw.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES ('overlap-grant','overlap','user','reader',NULL,'view',1,'active',0,NULL,NULL),('foreign-grant','foreign','user','reader',NULL,'edit',1,'active',0,NULL,NULL)`).run();
  expect(owner()).toEqual(refused);
  f.raw.prepare("UPDATE sync_relay_share_grants SET access='edit' WHERE grant_id='overlap-grant'").run();
  expect(enabled()).toBe(true);
  expect(owner().kind).toBe("current");
  f.stop();
  expect(enabled()).toBe(false);
  expect(owner()).toEqual(refused);
});

it("applies Pause after host release and fences Stop immediately", async () => {
  const f = await fixture(), enrolled = f.enroll();
  f.seed(scope.workspaceId, "stopped-object", "docs/stopped.md", "stopped-share");
  f.enroll({path: "docs/stopped.md", shareId: "stopped-share"});
  expect(f.release()).toBeNull();
  expect(f.setEnabled(false)).toMatchObject({enabled: true, retired: false, ownerStop: "pause"});
  expect(f.storage.setServiceHostEnrollmentEnabled({...f.input, path: "docs/stopped.md", enabled: false, retire: true, nowMs: 20}))
    .toMatchObject({enabled: false, retired: true, ownerStop: "retire"});
  // Resuming before the release cancels it.
  expect(f.setEnabled(true)).toMatchObject({enabled: true, ownerStop: null});
  expect(f.release()).toBeNull();
  f.setEnabled(false);
  expect(f.release()).toMatchObject({...enrolled, enabled: false, retired: false, ownerStop: "pause", hostDrainedAtMs: 25, updatedAtMs: 25});
  expect(f.release("stopped-object")).toMatchObject({hostDrainedAtMs: 25});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/stopped.md")).toMatchObject({enabled: false, retired: true, ownerStop: "retire"});
  // Revocation retires a paused document too, and it stays paused.
  f.raw.prepare("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=30 WHERE share_id=?").run(scope.shareId);
  expect(f.release()).toMatchObject({enabled: false, retired: true, ownerStop: "pause"});
  expect(f.storage.hasKeptServiceHostEnrollment(scope.workspaceId, enrolled.path)).toBe(true);
  expect(f.storage.hasKeptServiceHostEnrollment(scope.workspaceId, "docs/stopped.md")).toBe(true);
});

// The fixture document's adopted service activation. Stored metadata is enough here; native activation has its own suites.
async function activated() {
  const f = await fixture(); f.enroll();
  retainServiceActivation(f.raw, key.namespace, true);
  const owner = () => f.storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: "owner-1", shareId: scope.shareId}}).kind;
  const retirement = () => readServiceActivationRetirement(f.storage as StorageContext, binding);
  const retirements = () => f.raw.prepare("SELECT count(*) AS count FROM sync_relay_service_activations WHERE retire_requested_at_ms IS NOT NULL").get()!.count;
  const share = (shareId: string, grantId: string, access = "edit", userId = "reader-2") => {
    f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,'owner-1',?,0)")
      .run(shareId, scope.workspaceId, JSON.stringify({paths: ["docs"], versionId: null}));
    f.raw.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
      VALUES (?,?,'user',?,NULL,?,1,'active',0,NULL,NULL)`).run(grantId, shareId, userId, access);
  };
  return {...f, owner, retirement, retirements, share};
}
const recorded = (requestedAtMs: number) => ({relayDatabaseNamespace: key.namespace, activationId: `ordinary-activation-${"a".repeat(64)}`,
  workspaceId: scope.workspaceId, mainVersionId: "main", objectId: binding.objectId, lineageClaimId: binding.lineageClaimId, path: binding.currentPath,
  restoreFenceGeneration: 7, acceptedThrough: 0, requestedAtMs});

// Proves: Pause fences admission and records the exact activation's retirement
// in its own transaction. Repeating it keeps that one record. Resume records
// the return without clearing the retirement, so nothing revives the activation.
it("records one retirement when Pause fences the activation, and Resume leaves it pending", async () => {
  const f = await activated();
  expect(f.owner()).toBe("current");
  expect(f.retirement()).toBeNull();
  expect(f.setEnabled(false)).toMatchObject({enabled: true, ownerStop: "pause"});
  expect(f.owner()).toBe("refused");
  expect(f.retirement()).toEqual(recorded(20));
  f.setEnabled(false);
  expect(f.retirement()).toEqual(recorded(20)); expect(f.retirements()).toBe(1);
  // Another Edit share neither clears the Pause nor admits anything.
  f.share("another", "another-edit");
  expect(f.storage.hasKeptServiceHostEnrollment(scope.workspaceId, binding.currentPath)).toBe(true);
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)).toMatchObject({ownerStop: "pause"});
  expect(f.owner()).toBe("refused");
  expect(f.setEnabled(true)).toMatchObject({enabled: true, retired: false, ownerStop: null});
  expect(f.retirement()).toEqual(recorded(20));
  expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding)).toBe(false);
  expect(f.owner()).toBe("refused");
  const reopened = openSyncRelayStorage(f.path, f.config);
  try {expect(readServiceActivationRetirement(reopened as StorageContext, binding)).toEqual(recorded(20));} finally {reopened.close();}
});

// Proves: "last" is across every Edit share of the owner that covers the
// document. Removing one of two keeps the activation; downgrading the last
// Edit grant records its retirement in the same transaction, once.
it("retires the activation only when the last Edit grant covering the document ends", async () => {
  const f = await activated();
  f.share("overlap", "overlap-view", "view");
  expect(f.storage.createLinkGrant({grant: {grantId: "overlap-link", shareId: "overlap", principalKind: "link", principalUserId: null, principalEmail: null,
    access: "edit", generation: 1, status: "active", createdAtMs: 0, revokedAtMs: null, parentGrantId: null},
    credential: {credentialId: "overlap-credential", grantId: "overlap-link", secretHash: "d".repeat(64), generation: 1, mintedAtMs: 0, retiredAtMs: null}})).toBe(true);
  expect(f.storage.revokeShare(scope.shareId, 30)).toBe(true);
  expect(f.retirement()).toBeNull();
  expect(f.owner()).toBe("current");
  expect(f.storage.retuneShareGrant({shareId: "overlap", grantId: "overlap-link", access: "view", changedAtMs: 31, expectedDependentGrantIds: [], guard() {}}).ok).toBe(true);
  expect(f.retirement()).toEqual(recorded(31));
  expect(f.owner()).toBe("refused");
  expect(f.storage.revokeShareGrant({shareId: "overlap", grantId: "overlap-view", revokedAtMs: 32}).ok).toBe(true);
  expect(f.retirement()).toEqual(recorded(31)); expect(f.retirements()).toBe(1);
});

// Proves: revocation and whole-share removal record the retirement at zero
// coverage. Sharing again, or restoring the grant, before the host reconciles
// records the return but leaves the retirement pending and admission fenced.
it("keeps a revoked document's retirement pending when it is shared again before reconciliation", async () => {
  const f = await activated();
  expect(f.storage.revokeShareGrant({shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 30}).ok).toBe(true);
  expect(f.retirement()).toEqual(recorded(30));
  expect(f.owner()).toBe("refused");
  f.share("replacement", "replacement-edit");
  expect(f.enroll({shareId: "replacement", nowMs: 31})).toMatchObject({enabled: true, retired: false, ownerStop: null});
  f.raw.prepare("UPDATE sync_relay_share_grants SET status='active',revoked_at_ms=NULL WHERE grant_id=?").run(scope.grantId);
  expect(f.retirement()).toEqual(recorded(30));
  expect(f.owner()).toBe("refused");
  expect(f.storage.revokeShare("replacement", 32)).toBe(true);
  expect(f.storage.revokeShare(scope.shareId, 33)).toBe(true);
  expect(f.retirement()).toEqual(recorded(30)); expect(f.retirements()).toBe(1);
});

// Proves: deleting a collaborator's account records the retirement its
// revocations cause, in the same transaction. Another person's Edit grant
// keeps the activation; once the last one ends, sharing Edit with someone
// else leaves the retirement pending and admission fenced.
it("retires the activation when deleting a collaborator's account ends the last Edit grant", async () => {
  const f = await activated();
  initializeAccountDeletion(f.storage as StorageContext, "fence-key");
  const deleteAccount = (userId: string) => fenceAccount(f.storage as StorageContext, "fence-key", userId, `${userId}@dohc.test`);
  f.share("overlap", "overlap-edit");
  deleteAccount(scope.userId);
  expect(f.retirement()).toBeNull();
  expect(f.owner()).toBe("current");
  deleteAccount("reader-2");
  const deleted = recorded(f.retirement()!.requestedAtMs);
  expect(f.retirement()).toEqual(deleted);
  expect(f.owner()).toBe("refused");
  f.share("replacement", "replacement-edit", "edit", "reader-3");
  expect(f.retirement()).toEqual(deleted); expect(f.retirements()).toBe(1);
  expect(f.owner()).toBe("refused");
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
