import {afterEach, expect, it} from "vitest";
import {fixture as ticketFixture, binding, keptByOwnerRestore, retainServiceActivation, scope} from "../liveTickets.test-helper";
import {openSyncRelayStorage, type SyncRelayStorage} from "../storage";
import {authorizeServiceHostReplication, deriveServiceHostBearer, serviceHostReplicationRoute} from "../serviceHostCredential";
import {liveEditors} from "../liveEditors";
import { RECLAIM_RETENTION_MS} from "../liveHostingLimits";
import { serviceHostDocumentEnabled, SERVICE_HOST_ENROLLMENTS,
  ServiceHostRetirementConflict, type ServiceHostRetirementPreparation} from "./serviceHostEnrollment";
import {readServiceActivationRetirement} from "./serviceActivationRetirement";
import {attachLiveJournalHistory, createLiveJournalHistoryAuthority} from "./liveJournalHistory";
import type {StorageContext} from "./context";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanups.splice(0).reverse()) await close();});
const key = {key: new Uint8Array(32).fill(17), namespace: "relay-enrollment-test"};
const document = {workspaceId: binding.workspaceId, mainVersionId: binding.mainVersionId, objectId: binding.objectId, lineageClaimId: binding.lineageClaimId};
async function fixture(quota?: number) {
  const f = await ticketFixture(quota === undefined ? undefined : {workspaceQuotaBytes: quota}); cleanups.push(f.close);
  f.storage.claimWorkspaceIdentity({workspaceId: scope.workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
  const input = {workspaceId: scope.workspaceId, path: binding.currentPath, shareId: scope.shareId, ownerUserId: "owner-1", nowMs: 10, guard() {}};
  const enroll = (changes = {}) => f.storage.ensureOwnedLiveDocument({intent: "share", ...input, ...changes});
  const setEnabled = (enabled: false) => f.storage.setServiceHostEnrollmentEnabled({...input, enabled, nowMs: 20});
  const resume = (changes = {}) => f.storage.ensureOwnedLiveDocument({intent: "owner-resume", ...input, nowMs: 20, ...changes});
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
  // The share has an active Edit grant unless `edit` is false.
  function seed(workspaceId: string, objectId: string, path: string, shareId: string, edit = true) {
    f.raw.prepare(`INSERT OR IGNORE INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms,replication_epoch,stream_identity,epoch_log_floor)
      VALUES (?,'owner-1',0,'epoch','stream',0)`).run(workspaceId);
    f.raw.prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
      VALUES (?,?,1,?,'main',?,?,'text',1,1)`).run(workspaceId, objectId, `moment-${objectId}`, path, "b".repeat(64));
    f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,'owner-1',?,0)")
      .run(shareId, workspaceId, JSON.stringify({paths: ["docs"], versionId: null}));
    if (edit) grant(`${shareId}-edit`, shareId);
  }
  // An active grant on the share, Edit unless `access` says otherwise.
  const grant = (grantId: string, shareId: string, access = "edit") => f.raw.prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,
    principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id) VALUES (?,?,'user','seeded-reader',NULL,?,1,'active',0,NULL,NULL)`).run(grantId, shareId, access);
  return {...f, input, enroll, setEnabled, resume, release, pause, stop, authorize, seed, grant};
}

it("retains original document, share and credential across pause, new invitation and reopen", async () => {
  const f = await fixture(), first = f.enroll(), bearer = deriveServiceHostBearer(first, key);
  expect(first.objectId).toBe(binding.objectId);
  expect(f.authorize(bearer)).toBe("owner-1");
  expect(f.pause()?.enabled).toBe(false);
  expect(f.authorize(bearer)).toBeNull();
  f.raw.prepare("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=20 WHERE share_id=?").run(scope.shareId);
  f.raw.prepare("INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) SELECT 'replacement',workspace_id,granter_user_id,selector_json,30 FROM sync_relay_shares WHERE share_id=?").run(scope.shareId);
  f.grant("replacement-edit", "replacement");
  // The new share leaves the Pause. Only Resume clears it.
  expect(f.enroll({shareId: "replacement", nowMs: 30})).toMatchObject({enabled: false, ownerStop: "pause"});
  const resumed = f.resume({nowMs: 30});
  expect(resumed).toEqual({...first, enabled: true, ownerStop: null, updatedAtMs: 30, ownerDemand: true, demandAtMs: 30});
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
  f.resume();
  f.raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id='other' WHERE workspace_id=?").run(scope.workspaceId);
  expect(enabled()).toBe(false); expect(f.authorize(bearer)).toBeNull();
  f.raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id='owner-1',replication_epoch='new-epoch' WHERE workspace_id=?").run(scope.workspaceId);
  expect(enabled()).toBe(false); expect(f.authorize(bearer)).toBeNull();
  expect(() => f.enroll()).toThrow("obsolete");
  expect(() => f.resume()).toThrow("obsolete");
  expect(f.setEnabled(false)?.ownerStop).toBe("pause");
});

it("checks guards inside the transaction and charges quota exactly once", async () => {
  const f = await fixture();
  const usage = () => Number(f.raw.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id=?").get(scope.workspaceId)!.usage_bytes);
  const before = usage();
  expect(() => f.enroll({guard() {throw new Error("retired");}})).toThrow("retired");
  expect(usage()).toBe(before);
  f.enroll(); const charged = usage(); expect(charged).toBeGreaterThan(before);
  f.enroll(); f.setEnabled(false); f.resume(); expect(usage()).toBe(charged);
  f.seed(scope.workspaceId, "quota-object", "docs/quota.md", "quota-share");
  (f.storage as StorageContext).options.workspaceQuotaBytes = usage();
  expect(() => f.enroll({path: "docs/quota.md", shareId: "quota-share"})).toThrow("quota");
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(1);
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

it("does not replace a retained object when its path is reused or follow its rename implicitly", async () => {
  const f = await fixture(); f.enroll();
  f.raw.prepare("UPDATE sync_relay_object_moments SET path='docs/moved.md' WHERE workspace_id=? AND object_id=?").run(scope.workspaceId, binding.objectId);
  expect(() => f.enroll({path: "docs/moved.md"})).toThrow("moved");
  f.seed(scope.workspaceId, "replacement-object", binding.currentPath, "replacement-share");
  expect(() => f.enroll({shareId: "replacement-share"})).toThrow("another document");
  expect(f.storage.listServiceHostEnrollments()[0]!.objectId).toBe(binding.objectId);

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
  expect(f.resume()).toMatchObject({enabled: true, retired: false, ownerStop: null});
  expect(f.retirement()).toEqual(recorded(20));
  expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding)).toBe(false);
  expect(f.owner()).toBe("refused");
  const reopened = openSyncRelayStorage(f.path, f.config);
  try {expect(readServiceActivationRetirement(reopened as StorageContext, binding)).toEqual(recorded(20));} finally {reopened.close();}
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

// The owner's restore revoking the last Edit grant, as `beginStopRestore` does, keeping `activationId`.

// A synthetic later restore of the kept note, begun at fence 8 and not yet fenced, carrying the current run's marker. The test ends it before its fence.

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

// A live sibling note under the same folder share, enrolled and with its own
// activation, as the fixture's note has.

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

// The owner's open of the fixture's document, as their desktop sends it, and the refusal it answers.
const ownerOpen = (f: Awaited<ReturnType<typeof fixture>>, nowMs = 30) => f.storage.ensureOwnedLiveDocument({intent: "owner-open", ...f.input, nowMs});

type Fixture = Awaited<ReturnType<typeof fixture>>;
// What a reclaim leaves: retired without a Stop and with no demand, so the next open of any intent enrolls it again.
const reclaimed = {enabled: false, retired: true, ownerStop: null, ownerDemand: false, demandAtMs: null};
/**
 * The fixture's note, which only demand recorded at 10 keeps: the owner's
 * open when `owner`, otherwise an agent's session. Its only Edit grant ended.
 */
async function demandedOnly(owner = false) {
  const f = await fixture(); f.enroll();
  if (owner) ownerOpen(f, 10);
  else expect(f.storage.renewPersonalSessionDemand({workspaceId: scope.workspaceId, objectId: binding.objectId, nowMs: 10})).toBe(true);
  expect(f.storage.revokeShareGrant({shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 10}).ok).toBe(true);
  const read = () => f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)!;
  expect(read()).toMatchObject({enabled: true, retired: false, ownerDemand: owner, demandAtMs: 10});
  // A live connection to the note, counted as every live route counts one, until the returned release runs.
  const connect = () => liveEditors(f.storage).acquire(binding);
  return {...f, read, connect, sweep: (nowMs: number) => f.storage.reclaimIdleLiveDocuments(nowMs)};
}

/** Every enrollment row as stored. */
const stored = (f: Fixture) => f.raw.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} ORDER BY workspace_id,object_id`).all();

// Proves: the sweep reclaims a note only agents' demand keeps once nothing
// used it for the retention period, and writes nothing before. An open live
// connection keeps it past the period; once it closes, the same sweep
// reclaims it. The row stays.
it("reclaims an agent-only note idle past retention, and keeps it while a live connection is open", async () => {
  const f = await demandedOnly(), past = 10 + RECLAIM_RETENTION_MS + 1, before = stored(f);
  // Idle for exactly the retention period is not past it.
  expect(f.sweep(past - 1)).toEqual([]);
  const release = f.connect();
  expect(f.sweep(past)).toEqual([]);
  expect(stored(f)).toEqual(before);
  release();
  expect(f.sweep(past)).toMatchObject([{objectId: binding.objectId, ...reclaimed}]);
  expect(f.read()).toMatchObject(reclaimed);
  expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding)).toBe(false);
  expect(f.sweep(past + 1)).toEqual([]);
  expect(stored(f)).toHaveLength(before.length);
});

// Proves: a note the owner's restore kept live is never reclaimed, though
// only demand otherwise keeps it. Once the restore keeps nothing, the same
// note is reclaimed and its activation's retirement opens.
it("never reclaims a note the owner's restore kept live, and reclaims it once the restore keeps nothing", async () => {
  const f = await kept(), past = 10 + RECLAIM_RETENTION_MS + 1;
  expect(f.storage.renewPersonalSessionDemand({workspaceId: scope.workspaceId, objectId: binding.objectId, nowMs: 10})).toBe(true);
  expect(f.storage.reclaimIdleLiveDocuments(past)).toEqual([]);
  expect(f.enrolled()).toMatchObject({enabled: true, retired: false, demandAtMs: 10});
  expect(f.retirement()).toBeNull();
  f.restore.update("intent_json=json_remove(intent_json,'$.keptRun')");
  expect(f.storage.reclaimIdleLiveDocuments(past)).toMatchObject([{objectId: binding.objectId, ...reclaimed}]);
  expect(f.retirement()).toMatchObject({activationId: f.restore.activationId, requestedAtMs: past});
});
