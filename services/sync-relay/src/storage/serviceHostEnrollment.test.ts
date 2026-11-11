import {createHash} from "node:crypto";
import {afterEach, expect, it} from "vitest";
import {fixture as ticketFixture, binding, keptByOwnerRestore, retainServiceActivation, scope} from "../liveTickets.test-helper";
import {openSyncRelayStorage, type SyncRelayStorage} from "../storage";
import {authorizeServiceHostReplication, deriveServiceHostBearer, serviceHostReplicationRoute} from "../serviceHostCredential";
import {LATEST_RESTORE, serviceHostDocumentEnabled, SERVICE_HOST_ENROLLMENTS, SERVICE_HOST_MAX_WORKSPACES, ServiceHostRetirementConflict,
  type ServiceHostRetirementPreparation} from "./serviceHostEnrollment";
import {readServiceActivationRetirement} from "./serviceActivationRetirement";
import {fenceAccount, initializeAccountDeletion, purgeAccountRows} from "./accountDeletion";
import {attachLiveJournalHistory, createLiveJournalHistoryAuthority} from "./liveJournalHistory";
import {currentLiveDocumentMoment} from "./liveDocumentAuthority";
import {revokeShareGrantInTransaction} from "./shares";
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
  // Rows only, on one connection, so a test seeding many workspaces can commit them together.
  function seed(workspaceId: string, objectId: string, path: string, shareId: string) {
    f.raw.prepare(`INSERT OR IGNORE INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms,replication_epoch,stream_identity,epoch_log_floor)
      VALUES (?,'owner-1',0,'epoch','stream',0)`).run(workspaceId);
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
  expect(f.storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: "owner-1"}}).kind).toBe("current");
  expect(f.setEnabled(false)).toMatchObject({enabled: true, ownerStop: "pause"});
  // The host keeps its credential while applied work settles, but nothing new is admitted.
  expect(enabled()).toBe(false); expect(f.authorize(bearer)).toBe("owner-1");
  expect(f.storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: "owner-1"}})).toEqual({kind: "refused", reason: "host-unavailable"});
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
  // One transaction: a commit per row is hundreds of disk flushes, and the paging is what this proves.
  f.raw.exec("BEGIN");
  for (const workspaceId of workspaces) {f.seed(workspaceId, "object", "docs/a.md", `share-${workspaceId}`); stopped.run(workspaceId, "object", "docs/a.md", `share-${workspaceId}`);}
  for (const index of [1, 2]) stopped.run(workspaces[0], `object-${index}`, `docs/${index}.md`, `share-${workspaces[0]}`);
  f.raw.exec("COMMIT");
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
    DELETE FROM sync_relay_migrations WHERE migration_id='service-host-enrollments-v4';
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
    DELETE FROM sync_relay_migrations WHERE migration_id='service-host-enrollments-v4';
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
    expect(f.raw.prepare("SELECT migration_id FROM sync_relay_migrations WHERE migration_id=?").get("service-host-enrollments-v4")).toBeTruthy();
  } finally {reopened.close();}
});

// The v3 layout, which required the share whose Edit grant enrolled each document.
const V3_SQL = `CREATE TABLE ${SERVICE_HOST_ENROLLMENTS} (
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
  host_drained_at_ms INTEGER CHECK (host_drained_at_ms IS NULL OR host_drained_at_ms >= 0),
  accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND 9007199254740991),
  CHECK (enabled=1 OR retired=1 OR owner_stop='pause'),
  PRIMARY KEY (workspace_id, object_id),
  UNIQUE (workspace_id, path),
  FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (share_id) REFERENCES sync_relay_shares(share_id)
) STRICT`;
const V3_COLUMNS = "workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,owner_stop,enabled,retired,created_at_ms,updated_at_ms,host_drained_at_ms,accounted_bytes";
function downgradeToV3(f: Awaited<ReturnType<typeof fixture>>, sql = V3_SQL) {
  f.raw.exec(`BEGIN;
    ALTER TABLE ${SERVICE_HOST_ENROLLMENTS} RENAME TO enrollments_v4;
    ${sql};
    INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(${V3_COLUMNS}) SELECT ${V3_COLUMNS} FROM enrollments_v4;
    DROP TABLE enrollments_v4;
    CREATE INDEX idx_sync_relay_service_host_enrollments_active ON ${SERVICE_HOST_ENROLLMENTS}(workspace_id,path) WHERE retired=0;
    CREATE INDEX idx_sync_relay_service_host_enrollments_retired ON ${SERVICE_HOST_ENROLLMENTS}(workspace_id,path) WHERE retired=1;
    DELETE FROM sync_relay_migrations WHERE migration_id='service-host-enrollments-v4';
    COMMIT;`);
}

// Proves: v4 keeps every v3 enrollment as it was, its share included, lets
// later rows name no share, and records no hosting demand for any row. A v3
// table that is not the shipped layout is refused.
it("migrates v3 enrollments with their shares and no hosting demand, and refuses damaged v3 storage", async () => {
  const f = await fixture(), damaged = await fixture(); f.enroll(); damaged.enroll();
  f.seed(scope.workspaceId, "paused-object", "docs/paused.md", "paused-share");
  f.seed(scope.workspaceId, "retired-object", "docs/retired.md", "retired-share");
  f.enroll({path: "docs/paused.md", shareId: "paused-share"});
  f.enroll({path: "docs/retired.md", shareId: "retired-share"});
  f.storage.setServiceHostEnrollmentEnabled({...f.input, path: "docs/paused.md", enabled: false, nowMs: 20});
  f.release("paused-object");
  f.stop({path: "docs/retired.md"});
  const rows = (db: {prepare(sql: string): {all(): Array<Record<string, unknown>>}}) => db.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} ORDER BY path`).all();
  const usage = () => f.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id=?").get(scope.workspaceId)!.usage_bytes;
  const before = rows(f.raw), charged = usage();
  expect(before.map(row => [row.path, row.share_id, row.owner_demand, row.demand_at_ms]))
    .toEqual([["docs/a.md", scope.shareId, 0, null], ["docs/paused.md", "paused-share", 0, null], ["docs/retired.md", "retired-share", 0, null]]);
  downgradeToV3(f);
  for (let open = 0; open < 2; open++) {
    const reopened = openSyncRelayStorage(f.path, f.config);
    try {
      const db = (reopened as StorageContext).db;
      expect(rows(db)).toEqual(before);
      expect(db.prepare(`SELECT name,"notnull" AS required,dflt_value FROM pragma_table_info('${SERVICE_HOST_ENROLLMENTS}')
        WHERE name IN ('share_id','owner_demand','demand_at_ms') ORDER BY cid`).all())
        .toEqual([{name: "share_id", required: 0, dflt_value: null}, {name: "owner_demand", required: 1, dflt_value: "0"}, {name: "demand_at_ms", required: 0, dflt_value: null}]);
      expect(reopened.readServiceHostEnrollment(scope.workspaceId, "docs/a.md")).toMatchObject({enabled: true, shareId: scope.shareId});
      expect(usage()).toBe(charged);
    } finally {reopened.close();}
  }
  expect(f.raw.prepare("SELECT migration_id FROM sync_relay_migrations WHERE migration_id LIKE 'service-host-enrollments-%' ORDER BY migration_id").all()
    .map(row => row.migration_id)).toEqual(["service-host-enrollments-v2", "service-host-enrollments-v3", "service-host-enrollments-v4"]);
  downgradeToV3(damaged, V3_SQL.replace("STRICT", ""));
  expect(() => openSyncRelayStorage(damaged.path, damaged.config)).toThrow("Service host enrollment storage is damaged.");
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
    .map(row => row.migration_id)).toEqual(["service-host-enrollments-v1", "service-host-enrollments-v2", "service-host-enrollments-v3", "service-host-enrollments-v4"]);
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
  // Stop at 20 ended the first run.
  expect(f.enroll()).toEqual({...first, runToken: 20, updatedAtMs: 25});
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
  const covered = () => f.storage.serviceHostEnrollmentCovered(enrolled);
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
  const owner = () => f.storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: "owner-1"}});
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

// Proves: a Stop or an enrollment says it changed live editing only when its
// own transaction found the row in the other state, so of two calls exactly one does.
it("credits only the Stop or enrollment whose transaction changed the row", async () => {
  const f = await fixture(), enrolled = f.enroll();
  const retire = () => f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true, nowMs: 20});
  expect([retire()?.changed, retire()?.changed]).toEqual([true, false]);
  const heard: boolean[] = [];
  const resume = () => f.enroll({nowMs: 30, changed: (value: boolean) => heard.push(value)});
  resume(); resume();
  expect(heard).toEqual([true, false]);
  // A Pause still waiting for its release is live editing a Resume gives back.
  f.setEnabled(false);
  resume();
  expect(heard).toEqual([true, false, true]);
  expect(f.storage.listServiceHostEnrollments()).toEqual([expect.objectContaining({objectId: enrolled.objectId, enabled: true, retired: false, ownerStop: null})]);
});

// Proves: a page that access ending already retired credits no Stop, and a
// page a share already made live credits no Resume.
it("credits no Stop or Resume for a change another producer made first", async () => {
  const f = await fixture(), enrolled = f.enroll();
  const heard: boolean[] = [];
  f.enroll({nowMs: 30, changed: (value: boolean) => heard.push(value)});
  expect(heard).toEqual([false]);
  f.raw.prepare("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=30 WHERE share_id=?").run(scope.shareId);
  expect(f.storage.releaseServiceHostEnrollment({workspaceId: scope.workspaceId, objectId: enrolled.objectId, nowMs: 40}))
    .toMatchObject({retired: true, ownerStop: null});
  expect(f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true, nowMs: 50})?.changed).toBe(false);
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
  const owner = () => f.storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "owner", userId: "owner-1"}}).kind;
  const retirement = () => readServiceActivationRetirement(f.storage as StorageContext, binding);
  const retirements = () => f.raw.prepare("SELECT count(*) AS count FROM sync_relay_service_activations WHERE retire_requested_at_ms IS NOT NULL").get()!.count;
  const share = (shareId: string, grantId: string, access = "edit", userId = "reader-2", paths = ["docs"]) => {
    f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,'owner-1',?,0)")
      .run(shareId, scope.workspaceId, JSON.stringify({paths, versionId: null}));
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

// The relay's live-editing history, which the relay attaches as it starts.
const withHistory = <T extends SyncRelayStorage>(storage: T): T => {
  attachLiveJournalHistory(storage as unknown as StorageContext, createLiveJournalHistoryAuthority({namespace: key.namespace, reconciled: true}));
  return storage;
};
// The fixture document after the owner's restore that kept its live session through its own revocation.
async function kept() {
  const f = await activated(), restore = keptByOwnerRestore(f.raw, key.namespace);
  withHistory(f.storage);
  const enrolled = () => f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)!;
  const enabled = (owner?: {userId: string}, restoring = false) =>
    serviceHostDocumentEnabled(f.storage as StorageContext, binding, owner, restoring);
  const asOwner = {userId: "owner-1"};
  const covered = (storage: SyncRelayStorage = f.storage) =>
    storage.serviceHostEnrollmentCovered(storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)!);
  // The host retiring the kept activation once it released the document, no earlier than the retirement was requested.
  const retireKept = () => f.raw.prepare(`UPDATE sync_relay_service_activations SET retired_at_ms=retire_requested_at_ms,retired_boundary_json='{}',state_bytes=NULL
    WHERE activation_id=?`).run(restore.activationId);
  // The same answers from the same store after a restart.
  const afterRestart = () => {
    const reopened = withHistory(openSyncRelayStorage(f.path, f.config));
    try {return {covered: covered(reopened), owner: serviceHostDocumentEnabled(reopened as StorageContext, binding, asOwner)};} finally {reopened.close();}
  };
  return {...f, restore, enrolled, enabled, asOwner, covered, retireKept, afterRestart};
}
type Kept = Awaited<ReturnType<typeof kept>>;
// The owner's restore revoking the last Edit grant, as `beginStopRestore` does, keeping `activationId`.
function revokeKeeping(f: Awaited<ReturnType<typeof activated>>, activationId: string) {
  let keeps = 0;
  const revoked = (f.storage as StorageContext).tx(() => revokeShareGrantInTransaction(f.storage as StorageContext,
    {shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 30, expectedDependentGrantIds: []},
    {workspaceId: binding.workspaceId, objectId: binding.objectId, activationId, kept: () => { keeps++; }}));
  return {ok: revoked.ok, keeps};
}
// A synthetic later restore of the kept note, begun at fence 8 and not yet fenced, carrying the current run's marker. The test ends it before its fence.
function laterRestoreKeepingRun(f: Kept) {
  const atFence = {...binding, restoreFenceGeneration: 8};
  const basis = {binding: atFence, ownerBinding: atFence, baselineDigest: binding.lineageClaimId, baselineByteLength: 1, projectedDigest: binding.lineageClaimId,
    projectedLength: 0, baselineSequence: 1, registeredAtMs: 1, namespace: key.namespace, hostMode: "service", hostId: "host-1", ownerOrigin: null};
  f.raw.prepare(`INSERT INTO sync_relay_live_restore_operations(operation_id,relay_database_namespace,previous_operation_id,workspace_id,main_version_id,
    object_id,lineage_claim_id,intent_json,basis_json,phase,old_fence,revoked_generation,invalidated_at_ms,accounted_bytes)
    SELECT 'restore-2',relay_database_namespace,'restore',workspace_id,main_version_id,object_id,lineage_claim_id,
      json_set(intent_json,'$.operationId','restore-2','$.expectedFence',8),?,'authority-invalidated',8,6,40,1
    FROM sync_relay_live_restore_operations WHERE operation_id='restore'`).run(JSON.stringify(basis));
}

// Proves: the owner's restore that kept the note's live session keeps it live
// for that owner alone, through the host's release and a restart. The
// activation does not retire, and the grant stays revoked.
it("keeps a note live for its owner after their restore, and for no one else", async () => {
  const f = await kept();
  expect(f.retirement()).toBeNull();
  expect(f.covered()).toBe(true);
  expect(f.enabled(f.asOwner)).toBe(true);
  expect(f.enabled()).toBe(false);
  expect(f.enabled({userId: scope.userId})).toBe(false);
  expect(f.release()).toBeNull();
  expect(f.enrolled()).toMatchObject({enabled: true, retired: false, ownerStop: null, runToken: 10});
  expect(f.afterRestart()).toEqual({covered: true, owner: true});
  expect(f.storage.getShareGrant(scope.grantId)).toMatchObject({status: "revoked"});
  expect(f.storage.resolveCurrentLiveDocumentBinding({document, actor: {kind: "named", userId: scope.userId, grantId: scope.grantId}}).kind).toBe("refused");
});

// Proves: while the restore is unfinished the host keeps the note, but the
// owner's live editing waits for the restore to resume.
it("keeps a note with its host during the owner's unfinished restore and admits no edit until it resumes", async () => {
  const f = await kept();
  f.restore.update("phase='settled'");
  expect(f.covered()).toBe(true);
  expect(f.enabled(f.asOwner, true)).toBe(true);
  expect(f.enabled(f.asOwner)).toBe(false);
  expect(f.release()).toBeNull();
  f.restore.update("phase='resumed'");
  expect(f.enabled(f.asOwner)).toBe(true);
});

// Proves: nothing but the latest restore's record of the current run and
// owner, at the current fence, workspace and path, keeps the note live.
it.each([
  ["a declined restore", (f: Kept) => f.restore.update(`phase='declined',new_fence=NULL,cutover_cursor=NULL,fenced_at_ms=NULL,
    terminal_json=NULL,applied_json=NULL,native_receipt_json=NULL,declined_at_ms=35`)],
  ["a restore that kept nothing", (f: Kept) => f.restore.update("intent_json=json_remove(intent_json,'$.keptRun')")],
  ["a later restore the owner declined before its fence", (f: Kept) => {
    laterRestoreKeepingRun(f);
    expect(f.storage.declineStopRestore({operationId: "restore-2", workspaceId: scope.workspaceId, ownerUserId: "owner-1"}, 41).phase).toBe("declined");
  }],
  ["a restore that kept an earlier run", (f: Kept) => f.restore.update("intent_json=json_set(intent_json,'$.keptRun.runToken',9)")],
  ["a later restore generation", (f: Kept) => f.raw.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=9")],
  ["a replaced workspace identity", (f: Kept) => f.raw.exec("UPDATE sync_relay_workspaces SET replication_epoch='rotated'")],
  ["another workspace owner", (f: Kept) => f.raw.exec("UPDATE sync_relay_workspaces SET owner_user_id='owner-2'")],
  ["a note moved from its restored path", (f: Kept) => f.raw.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,
    relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms) VALUES (?,?,2,'moved','main','docs/b.md',?,'text',1,2)`)
    .run(scope.workspaceId, binding.objectId, "b".repeat(64))],
] as const)("does not keep a note live for its owner after %s", async (_case, change) => {
  const f = await kept();
  change(f);
  expect(f.covered()).toBe(false);
  expect(f.enabled(f.asOwner, true)).toBe(false);
  expect(f.enabled(f.asOwner)).toBe(false);
  expect(f.release()).toMatchObject({enabled: false, retired: true});
});

// Proves: while the note is away from the path where its live editing began,
// no restore of it can start, even with an Edit share that covers where it is
// now. The attempt changes nothing, and the owner's kept session stays off.
it("can't start a restore of a note while it's away from where live editing began", async () => {
  const f = await kept(), runToken = f.enrolled().runToken;
  expect(f.enabled(f.asOwner)).toBe(true);
  expect(currentLiveDocumentMoment(f.storage as StorageContext, document, binding.currentPath)).toBeDefined();
  // The owner's device logs the note's content at docs/a.md, then renames it to notes/a.md.
  const content = Buffer.from("a"), sha256 = createHash("sha256").update(content).digest("hex");
  f.storage.putBlob({workspaceId: scope.workspaceId, sha256, content, createdAtMs: 40});
  const moment = (originSeq: number, momentId: string, change: object) => ({originSeq, opKind: "moment.append", recordedAtMs: 40,
    payloadJson: JSON.stringify({objectId: binding.objectId, versionId: "main", momentId, recordedAtMs: 40, payloadAfterBlobSha256: sha256,
      payloadAfterContentKind: "text", payloadAfterByteLength: 1, ...change})});
  f.storage.appendLogBatch({workspaceId: scope.workspaceId, originId: "desktop", ops: [
    moment(0, "written", {operation: "write", payloadAfterPath: binding.currentPath}),
    moment(1, "renamed", {operation: "rename", payloadBeforePath: binding.currentPath, payloadBeforeBlobSha256: sha256, payloadAfterPath: "notes/a.md"}),
  ]});
  // An Edit share of notes only, so it can't keep docs/a.md live by itself.
  f.share("away", "away-edit", "edit", "reader-2", ["notes"]);
  expect(f.storage.objectIdAtPathInVersion({workspaceId: scope.workspaceId, versionId: "main", path: "notes/a.md"})).toBe(binding.objectId);
  expect(currentLiveDocumentMoment(f.storage as StorageContext, document, binding.currentPath)).toBeUndefined();
  expect(f.raw.prepare("SELECT current_path FROM sync_relay_live_documents WHERE workspace_id=? AND object_id=?")
    .get(scope.workspaceId, binding.objectId)?.current_path).toBe(binding.currentPath);
  expect(() => f.storage.beginStopRestore({deliveryKind: "owner", operationId: "restore-away", ownerUserId: "owner-1", document, shareId: "away",
    grantId: "away-edit", expectedGrantGeneration: 1, expectedDependentGrantIds: [], expectedFence: 8, restorePointCursor: 0,
    restorePointReceiptDigest: binding.lineageClaimId}, 41)).toThrow("Live restore operation conflicts with current authority.");
  expect(f.raw.prepare("SELECT operation_id FROM sync_relay_live_restore_operations").all().map(row => row.operation_id)).toEqual(["restore"]);
  expect(f.storage.getShareGrant("away-edit")).toMatchObject({status: "active"});
  expect(f.enrolled().runToken).toBe(runToken);
  expect(f.enabled(f.asOwner, true)).toBe(false);
  expect(f.enabled(f.asOwner)).toBe(false);
});

// Proves: finding a note's latest restore reads only that note's restores,
// each step through an index of the restore table and in its order. No step
// reads the restores that ended before their fence, even for a note with no
// fenced restore.
it("finds a note's latest restore through an index", async () => {
  const f = await fixture();
  expect(Object.keys(LATEST_RESTORE)).toEqual(["unfinished", "fenced"]);
  const plan = (sql: string) =>
    f.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array.from(sql.matchAll(/\?/g), () => "x")).map(row => String(row.detail));
  expect(plan(LATEST_RESTORE.unfinished)).toEqual([expect.stringMatching(/^SEARCH sync_relay_live_restore_operations USING (COVERING )?INDEX \S+ \(.*object_id=\?/)]);
  expect(plan(LATEST_RESTORE.fenced)).toEqual([expect.stringMatching(/^SEARCH sync_relay_live_restore_operations USING (COVERING )?INDEX \S+ \(relay_database_namespace=\? AND workspace_id=\? AND main_version_id=\? AND object_id=\? AND new_fence>\?\)$/)]);
});

// Proves: no other document inherits the continuation: not another object
// at the restored path, and not a sibling the same share covered.
it("keeps only the restored note live, not a replacement or sibling", async () => {
  const f = await kept();
  for (const other of [{objectId: "replacement", path: binding.currentPath}, {objectId: "sibling", path: "docs/b.md"}]) {
    expect(f.storage.serviceHostEnrollmentCovered({...f.enrolled(), ...other})).toBe(false);
  }
});

// A live sibling note under the same folder share, enrolled and with its own
// activation, as the fixture's note has.
function activatedSibling(f: Awaited<ReturnType<typeof activated>>) {
  const lineageClaimId = "c".repeat(64), activationId = `ordinary-activation-${"c".repeat(64)}`, path = "docs/b.md";
  f.seed(scope.workspaceId, "sibling", path, "sibling-share");
  const copy = (table: string, where: string, from: string, changes: Record<string, string>) => {
    const columns = f.raw.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all().map(row => String(row.name));
    f.raw.prepare(`INSERT INTO ${table}(${columns}) SELECT ${columns.map(column => column in changes ? "?" : column)} FROM ${table} WHERE ${where}=?`)
      .run(...columns.filter(column => column in changes).map(column => changes[column]!), from);
  };
  copy("sync_relay_live_documents", "object_id", binding.objectId,
    {object_id: "sibling", lineage_claim_id: lineageClaimId, baseline_digest: lineageClaimId, current_path: path});
  copy("sync_relay_service_activations", "activation_id", `ordinary-activation-${"a".repeat(64)}`, {activation_id: activationId, object_id: "sibling",
    lineage_claim_id: lineageClaimId, binding_json: JSON.stringify({...binding, objectId: "sibling", lineageClaimId, currentPath: path, selectorPaths: [path]})});
  f.enroll({path});
  return {relayDatabaseNamespace: key.namespace, activationId, workspaceId: scope.workspaceId, mainVersionId: "main", objectId: "sibling", lineageClaimId, path,
    restoreFenceGeneration: 7, acceptedThrough: 0};
}

// Proves: the restore's revocation keeps only the exact activation it names.
// Every other note it leaves without Edit access ends its run and retires at
// its recorded boundary, here a live sibling under the same folder share, and
// naming another activation keeps nothing: that note retires as on any
// revocation.
it.each([["its own activation", true], ["another activation", false]] as const)("keeps a note through the restore's revocation only when it names %s",
  async (_case, own) => {
    const f = await activated(), sibling = activatedSibling(f);
    const run = (path: string) => f.storage.readServiceHostEnrollment(scope.workspaceId, path)!.runToken;
    expect(revokeKeeping(f, own ? `ordinary-activation-${"a".repeat(64)}` : "another-activation")).toEqual({ok: true, keeps: own ? 1 : 0});
    expect(f.retirement()).toEqual(own ? null : recorded(30));
    expect(run(binding.currentPath)).toBe(own ? 10 : 30);
    expect(readServiceActivationRetirement(f.storage as StorageContext, {workspaceId: scope.workspaceId, objectId: "sibling"}))
      .toEqual({...sibling, requestedAtMs: 30});
    expect(run(sibling.path)).toBe(30);
  });

// Proves the hard rule: when a retirement is already open, the restore's
// revocation neither clears, skips nor replaces it, keeps nothing, and ends
// the run, so no record of a kept session can follow.
it("leaves an open retirement in place when the owner's restore revokes the last Edit grant", async () => {
  const f = await activated();
  expect(f.setEnabled(false)).toMatchObject({ownerStop: "pause"});
  expect(f.retirement()).toEqual(recorded(20));
  expect(revokeKeeping(f, `ordinary-activation-${"a".repeat(64)}`)).toEqual({ok: true, keeps: 0});
  expect(f.retirement()).toEqual(recorded(20)); expect(f.retirements()).toBe(1);
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)).toMatchObject({runToken: 30});
});

// Proves: Pause only fences a restored note, and Resume brings the owner's
// live editing back once the paused activation retired.
it("brings live editing back when the owner resumes a paused restored note", async () => {
  const f = await kept();
  expect(f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, nowMs: 40})).toMatchObject({ownerStop: "pause"});
  expect(f.retirement()).toMatchObject({activationId: f.restore.activationId, requestedAtMs: 40});
  expect(f.enabled(f.asOwner)).toBe(false);
  expect(f.covered()).toBe(true);
  expect(f.release()).toMatchObject({enabled: false, retired: false, ownerStop: "pause"});
  f.retireKept();
  expect(f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: true, nowMs: 50}))
    .toMatchObject({enabled: true, retired: false, ownerStop: null, runToken: 10});
  expect(f.covered()).toBe(true);
  expect(f.enabled(f.asOwner)).toBe(true);
  expect(f.enabled({userId: scope.userId})).toBe(false);
  expect(f.afterRestart()).toEqual({covered: true, owner: true});
});

// Proves: Stop ends live editing the restore kept, for good. Neither Resume
// nor enrolling the note again brings it back.
it.each([10, 5] as const)("ends live editing for good when the owner stops a restored note (%s)",
  async nowMs => {
    const f = await kept();
    const prepared = {...f.storage.retirableServiceActivation(binding)!, assertCurrent() {}};
    expect(f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true, nowMs, prepared}))
      .toMatchObject({enabled: false, retired: true, ownerStop: "retire", runToken: 11});
    expect(f.covered()).toBe(false);
    expect(f.release()).toMatchObject({retired: true});
    f.retireKept();
    expect(f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: true, nowMs})).toMatchObject({enabled: true, retired: false, ownerStop: null});
    expect(f.covered()).toBe(false);
    expect(f.enabled(f.asOwner)).toBe(false);
    expect(f.release()).toMatchObject({enabled: false, retired: true});
    expect(f.enroll({nowMs})).toMatchObject({enabled: true, retired: false, ownerStop: null, runToken: 11});
    expect(f.covered()).toBe(false);
    expect(f.enabled(f.asOwner)).toBe(false);
    expect(f.afterRestart()).toEqual({covered: false, owner: false});
  });

// Proves: every ordinary end of Edit access after the restore ends the
// owner's continuation for good: lowering a new Edit link to View, revoking a
// new Edit grant, and that person's account deletion before the host releases
// the note. The kept activation retires as on any such revocation.
it.each([
  ["the owner lowers a new Edit link to View", 50, (f: Kept) => {
    f.share("again", "again-view", "view");
    expect(f.storage.createLinkGrant({grant: {grantId: "again-link", shareId: "again", principalKind: "link", principalUserId: null, principalEmail: null,
      access: "edit", generation: 1, status: "active", createdAtMs: 0, revokedAtMs: null, parentGrantId: null},
      credential: {credentialId: "again-credential", grantId: "again-link", secretHash: "d".repeat(64), generation: 1, mintedAtMs: 0, retiredAtMs: null}})).toBe(true);
    expect(f.covered()).toBe(true);
    expect(f.storage.retuneShareGrant({shareId: "again", grantId: "again-link", access: "view", changedAtMs: 50, expectedDependentGrantIds: [], guard() {}}).ok).toBe(true);
  }],
  ...([10, 5, 50] as const).map(nowMs => [`the owner revokes a new Edit grant (${nowMs})`, nowMs, (f: Kept) => {
    f.share("again", "again-edit");
    expect(f.storage.revokeShareGrant({shareId: "again", grantId: "again-edit", revokedAtMs: nowMs}).ok).toBe(true);
  }] as const),
  ["the owner revokes a new Edit grant and that person's account is deleted", 50, (f: Kept) => {
    initializeAccountDeletion(f.storage as StorageContext, "fence-key");
    f.share("again", "again-edit");
    expect(f.storage.revokeShareGrant({shareId: "again", grantId: "again-edit", revokedAtMs: 50}).ok).toBe(true);
    const {manifest} = fenceAccount(f.storage as StorageContext, "fence-key", "reader-2", "reader-2@dohc.test");
    purgeAccountRows(f.storage as StorageContext, "reader-2", "reader-2@dohc.test", manifest!);
    expect(f.storage.getShareGrant("again-edit")).toBeNull();
  }],
] as const)("ends the owner's continuation when %s", async (_case, endedAtMs, end) => {
  const f = await kept();
  end(f);
  expect(f.enrolled().runToken).toBe(Math.max(endedAtMs, 11));
  expect(f.retirement()).toMatchObject({activationId: f.restore.activationId, restoreFenceGeneration: 8});
  expect(f.covered()).toBe(false);
  expect(f.release()).toMatchObject({enabled: false, retired: true});
  f.retireKept();
  expect(f.enabled(f.asOwner)).toBe(false);
  expect(f.afterRestart()).toEqual({covered: false, owner: false});
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

// Proves: Stop opens a new retirement only with the host's preparation of
// exactly that activation and restore generation, checked while the
// connection that prepared it still stands. A refused Stop fences nothing.
// Replaying the open retirement needs no preparation and keeps its fence.
it("retires a prepared activation only with its host's preparation and replays that retirement", async () => {
  const f = await fixture(), enrolled = f.enroll();
  const activationId = retainServiceActivation(f.raw, key.namespace, true);
  const candidate = f.storage.retirableServiceActivation(enrolled)!;
  expect(candidate).toEqual({activationId, lineageClaimId: binding.lineageClaimId, restoreFenceGeneration: binding.restoreFenceGeneration});
  const retire = (prepared?: ServiceHostRetirementPreparation) =>
    f.storage.setServiceHostEnrollmentEnabled({...f.input, enabled: false, retire: true, nowMs: 20, ...(prepared ? {prepared} : {})});
  const unchanged = () => {
    expect(f.storage.serviceActivationRetirement(enrolled)).toBeNull();
    expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding)).toBe(true);
    expect(f.storage.readServiceHostEnrollment(scope.workspaceId, enrolled.path)).toMatchObject({enabled: true, retired: false, ownerStop: null});
  };
  expect(() => retire()).toThrow(expect.objectContaining({code: "host-not-loaded"}));
  unchanged();
  expect(() => retire({...candidate, activationId: "another-activation", assertCurrent() {}})).toThrow(expect.objectContaining({code: "conflict"}));
  expect(() => retire({...candidate, lineageClaimId: "c".repeat(64), assertCurrent() {}})).toThrow(expect.objectContaining({code: "conflict"}));
  // The generation changed after the host prepared.
  expect(() => retire({...candidate, restoreFenceGeneration: 6, assertCurrent() {}})).toThrow(ServiceHostRetirementConflict);
  // The connection that prepared it was replaced.
  expect(() => retire({...candidate, assertCurrent() {throw new Error("Service host registration was retired.");}})).toThrow("registration was retired");
  unchanged();
  let checked = 0;
  expect(retire({...candidate, assertCurrent() {checked++;}})).toMatchObject({enabled: false, retired: true, ownerStop: "retire"});
  expect(checked).toBe(1);
  const fence = f.storage.serviceActivationRetirement(enrolled)!;
  expect(fence).toMatchObject({activationId, restoreFenceGeneration: binding.restoreFenceGeneration});
  expect(f.storage.retirableServiceActivation(enrolled)).toBeNull();
  // A repeated Stop, as after a lost reply, replays the open retirement without a preparation.
  expect(retire()).toMatchObject({retired: true, acceptedCursor: fence.acceptedThrough});
  expect(f.storage.serviceActivationRetirement(enrolled)).toEqual(fence);
});
