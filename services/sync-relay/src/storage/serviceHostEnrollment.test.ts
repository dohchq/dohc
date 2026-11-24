import { LiveHostingRefusal } from "./serviceHostEnrollment";
import { SERVICE_HOST_MAX_WORKSPACES } from "../liveHostingLimits";
function refusal(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof LiveHostingRefusal) return error.reason;
    throw error;
  }
  return undefined;
}
import { afterEach, expect, it, vi } from "vitest";
import { observeDesktopReadiness } from "../desktopReadinessChanges";
import {
  fixture as ticketFixture,
  binding,
  retainServiceActivation,
  scope,
} from "../liveTickets.test-helper";
import { openSyncRelayStorage, type SyncRelayStorage } from "../storage";
import {
  authorizeServiceHostReplication,
  deriveServiceHostBearer,
  serviceHostReplicationRoute,
} from "../serviceHostCredential";
import { liveEditors } from "../liveEditors";
import { LIVE_NOTE_START_MAX_MS, RECLAIM_RETENTION_MS } from "../liveHostingLimits";
import {
  type LiveNoteMove,
  serviceHostDocumentEnabled,
  SERVICE_HOST_ENROLLMENTS,
  ServiceHostRetirementConflict,
  type ServiceHostRetirementPreparation,
} from "./serviceHostEnrollment";
import { readServiceActivationRetirement } from "./serviceActivationRetirement";
import { attachLiveJournalHistory, createLiveJournalHistoryAuthority } from "./liveJournalHistory";
import type { StorageContext } from "./context";
import {
  MEMBER_OPEN_DEMAND_MS,
  MEMBER_OPEN_MAX_DOCUMENTS,
  SERVICE_HOST_MAX_DOCUMENTS,
} from "../liveHostingLimits";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const key = { key: new Uint8Array(32).fill(17), namespace: "relay-enrollment-test" };
const document = {
  workspaceId: binding.workspaceId,
  mainVersionId: binding.mainVersionId,
  objectId: binding.objectId,
  lineageClaimId: binding.lineageClaimId,
};
async function fixture(quota?: number) {
  const f = await ticketFixture(quota === undefined ? undefined : { workspaceQuotaBytes: quota });
  cleanups.push(f.close);
  f.storage.claimWorkspaceIdentity({
    workspaceId: scope.workspaceId,
    replicationEpoch: "epoch",
    streamIdentity: "stream",
  });
  const input = {
    workspaceId: scope.workspaceId,
    path: binding.currentPath,
    shareId: scope.shareId,
    ownerUserId: "owner-1",
    nowMs: 10,
    guard() {},
  };
  const enroll = (changes = {}) =>
    f.storage.ensureOwnedLiveDocument({ intent: "share", ...input, ...changes });
  const setEnabled = (enabled: false) =>
    f.storage.setServiceHostEnrollmentEnabled({ ...input, enabled, nowMs: 20 });
  const resume = (changes = {}) =>
    f.storage.ensureOwnedLiveDocument({ intent: "owner-resume", ...input, nowMs: 20, ...changes });
  const release = (objectId = binding.objectId) =>
    f.storage.releaseServiceHostEnrollment({ workspaceId: scope.workspaceId, objectId, nowMs: 25 });
  const pause = () => {
    setEnabled(false);
    return release();
  };
  const stop = (changes = {}) => {
    const row = f.storage.setServiceHostEnrollmentEnabled({
      ...input,
      enabled: false,
      retire: true,
      nowMs: 20,
      ...changes,
    });
    if (row)
      f.storage.releaseServiceHostEnrollment({
        workspaceId: row.workspaceId,
        objectId: row.objectId,
        nowMs: 25,
      });
    return row && f.storage.readServiceHostEnrollment(row.workspaceId, row.path);
  };
  const authorize = (bearer: string, changes = {}) =>
    authorizeServiceHostReplication(f.storage, {
      ...key,
      workspaceId: scope.workspaceId,
      bearer,
      method: "GET",
      pathname: `/sync/${scope.workspaceId}/hosted/log`,
      ...changes,
    });
  // Rows only, on one connection, so a test seeding many workspaces can commit them together.
  // The share has an active Edit grant unless `edit` is false.
  function seed(workspaceId: string, objectId: string, path: string, shareId: string, edit = true) {
    f.raw
      .prepare(`INSERT OR IGNORE INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms,replication_epoch,stream_identity,epoch_log_floor)
      VALUES (?,'owner-1',0,'epoch','stream',0)`)
      .run(workspaceId);
    f.raw
      .prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
      VALUES (?,?,1,?,'main',?,?,'text',1,1)`)
      .run(workspaceId, objectId, `moment-${objectId}`, path, "b".repeat(64));
    f.raw
      .prepare(
        "INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,'owner-1',?,0)",
      )
      .run(shareId, workspaceId, JSON.stringify({ paths: ["docs"], versionId: null }));
    if (edit) grant(`${shareId}-edit`, shareId);
  }
  const grant = (grantId: string, shareId: string, access = "edit") =>
    f.raw
      .prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,
    principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id) VALUES (?,?,'user','seeded-reader',NULL,?,1,'active',0,NULL,NULL)`)
      .run(grantId, shareId, access);
  return { ...f, input, enroll, setEnabled, resume, release, pause, stop, authorize, seed, grant };
}

it("retains original document, share and credential across pause, new invitation and reopen", async () => {
  const f = await fixture(),
    first = f.enroll(),
    bearer = deriveServiceHostBearer(first, key);
  expect(first.objectId).toBe(binding.objectId);
  expect(f.authorize(bearer)).toBe("owner-1");
  expect(f.pause()?.enabled).toBe(false);
  expect(f.authorize(bearer)).toBeNull();
  f.raw
    .prepare(
      "UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=20 WHERE share_id=?",
    )
    .run(scope.shareId);
  f.raw
    .prepare(
      "INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) SELECT 'replacement',workspace_id,granter_user_id,selector_json,30 FROM sync_relay_shares WHERE share_id=?",
    )
    .run(scope.shareId);
  f.grant("replacement-edit", "replacement");
  expect(f.enroll({ shareId: "replacement", nowMs: 30 })).toMatchObject({
    enabled: false,
    ownerStop: "pause",
  });
  const resumed = f.resume({ nowMs: 30 });
  expect(resumed).toEqual({
    ...first,
    enabled: true,
    ownerStop: null,
    updatedAtMs: 30,
    ownerDemand: true,
    demandAtMs: 30,
    note: {
      generation: 2,
      state: "starting",
      reason: null,
      cause: null,
      sinceMs: 30,
      changedBy: "person:owner-1",
    },
  });
  expect(deriveServiceHostBearer(resumed, key)).toBe(bearer);
  const reopened = openSyncRelayStorage(f.path, f.config);
  try {
    expect(reopened.listServiceHostEnrollments()).toEqual([resumed]);
  } finally {
    reopened.close();
  }
});

it("refuses foreign owners, foreign or non-covering shares, side versions and noncanonical paths", async () => {
  const f = await fixture();
  expect(() => f.enroll({ ownerUserId: "attacker" })).toThrow("not found");
  for (const path of ["docs/../a.md", "other.md", "docs/data.csv", "docs/missing.md"])
    expect(() => f.enroll({ path })).toThrow();
  f.raw
    .prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id=?")
    .run(JSON.stringify({ paths: ["docs"], versionId: "branch" }), scope.shareId);
  expect(() => f.enroll()).toThrow("owner edit share");
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
});

it("fences a paused document's admission at once, keeps its credential until its release, and fences owner or epoch changes immediately", async () => {
  const f = await fixture(),
    first = f.enroll(),
    bearer = deriveServiceHostBearer(first, key);
  const enabled = () => serviceHostDocumentEnabled(f.storage as StorageContext, binding);
  expect(enabled()).toBe(true);
  expect(
    f.storage.resolveCurrentLiveDocumentBinding({
      document,
      actor: { kind: "owner", userId: "owner-1" },
    }).kind,
  ).toBe("current");
  expect(f.setEnabled(false)).toMatchObject({ enabled: true, ownerStop: "pause" });
  expect(enabled()).toBe(false);
  expect(f.authorize(bearer)).toBe("owner-1");
  expect(
    f.storage.resolveCurrentLiveDocumentBinding({
      document,
      actor: { kind: "owner", userId: "owner-1" },
    }),
  ).toEqual({ kind: "refused", reason: "host-unavailable" });
  expect(f.release()).toMatchObject({ enabled: false, retired: false, ownerStop: "pause" });
  expect(enabled()).toBe(false);
  expect(f.authorize(bearer)).toBeNull();
  f.resume();
  f.raw
    .prepare("UPDATE sync_relay_workspaces SET owner_user_id='other' WHERE workspace_id=?")
    .run(scope.workspaceId);
  expect(enabled()).toBe(false);
  expect(f.authorize(bearer)).toBeNull();
  f.raw
    .prepare(
      "UPDATE sync_relay_workspaces SET owner_user_id='owner-1',replication_epoch='new-epoch' WHERE workspace_id=?",
    )
    .run(scope.workspaceId);
  expect(enabled()).toBe(false);
  expect(f.authorize(bearer)).toBeNull();
  expect(() => f.enroll()).toThrow("obsolete");
  expect(() => f.resume()).toThrow("obsolete");
  expect(f.setEnabled(false)?.ownerStop).toBe("pause");
});

it("checks guards inside the transaction and charges quota exactly once", async () => {
  const f = await fixture();
  const usage = () =>
    Number(
      f.raw
        .prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id=?")
        .get(scope.workspaceId)!.usage_bytes,
    );
  const before = usage();
  expect(() =>
    f.enroll({
      guard() {
        throw new Error("retired");
      },
    }),
  ).toThrow("retired");
  expect(usage()).toBe(before);
  f.enroll();
  const charged = usage();
  expect(charged).toBeGreaterThan(before);
  f.enroll();
  f.setEnabled(false);
  f.resume();
  expect(usage()).toBe(charged);
  f.seed(scope.workspaceId, "quota-object", "docs/quota.md", "quota-share");
  (f.storage as StorageContext).options.workspaceQuotaBytes = usage();
  expect(() => f.enroll({ path: "docs/quota.md", shareId: "quota-share" })).toThrow("quota");
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(1);
});

it("service tokens are workspace, deployment and key bound and never authorize administration", async () => {
  const f = await fixture(),
    bearer = deriveServiceHostBearer(f.enroll(), key);
  expect(
    f.authorize(bearer, { workspaceId: "foreign", pathname: "/sync/foreign/hosted/log" }),
  ).toBeNull();
  expect(f.authorize(bearer, { namespace: "other" })).toBeNull();
  expect(f.authorize(bearer, { key: new Uint8Array(32).fill(18) })).toBeNull();
  expect(f.authorize(`${bearer.slice(0, -1)}!`)).toBeNull();
  for (const suffix of [
    "epoch",
    "shares",
    "presence",
    "key-envelope",
    "maintenance/gc",
    "live-host",
    "log/owner/0/admin",
    "hosted/live-host",
  ]) {
    expect(
      f.authorize(bearer, { pathname: `/sync/${scope.workspaceId}/${suffix}`, method: "POST" }),
    ).toBeNull();
  }
  expect(f.authorize(bearer, { pathname: "/sync/workspaces", method: "POST" })).toBeNull();
  const routes = [
    ["GET", "bootstrap"],
    ["GET", "log"],
    ["POST", "log"],
    ["GET", "log/owner/0"],
    ["GET", `blobs/${"a".repeat(64)}`],
    ["PUT", `blobs/${"a".repeat(64)}`],
    ["POST", "blobs/have"],
  ];
  for (const [method, suffix] of routes) {
    expect(
      f.authorize(bearer, { method, pathname: `/sync/${scope.workspaceId}/hosted/${suffix}` }),
    ).toBe("owner-1");
    expect(
      f.authorize(bearer, { method, pathname: `/sync/${scope.workspaceId}/${suffix}` }),
    ).toBeNull();
  }
  expect(
    serviceHostReplicationRoute({
      workspaceId: scope.workspaceId,
      pathname: `/sync/${scope.workspaceId}/blobs/have`,
      method: "PUT",
    }),
  ).toBe(false);
  expect(
    JSON.stringify(f.raw.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS}`).all()),
  ).not.toContain(bearer);
});

it("does not replace a retained object when its path is reused or follow its rename implicitly", async () => {
  const f = await fixture();
  f.enroll();
  f.raw
    .prepare(
      "UPDATE sync_relay_object_moments SET path='docs/moved.md' WHERE workspace_id=? AND object_id=?",
    )
    .run(scope.workspaceId, binding.objectId);
  expect(() => f.enroll({ path: "docs/moved.md" })).toThrow("moved");
  f.seed(scope.workspaceId, "replacement-object", binding.currentPath, "replacement-share");
  expect(() => f.enroll({ shareId: "replacement-share" })).toThrow("another document");
  expect(f.storage.listServiceHostEnrollments()[0]!.objectId).toBe(binding.objectId);
});

it("refuses altered enrollment schema on reopen", async () => {
  const f = await fixture();
  f.enroll();
  f.raw.exec(
    `CREATE TRIGGER unexpected_enrollment_trigger AFTER UPDATE ON ${SERVICE_HOST_ENROLLMENTS} BEGIN SELECT 1; END`,
  );
  expect(() => openSyncRelayStorage(f.path, f.config)).toThrow("constraints are damaged");
});

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
function downgradeToV1(
  f: Awaited<ReturnType<typeof fixture>>,
  sql = V1_SQL,
  marker: string | null = "service-host-enrollments-v1",
) {
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
    DELETE FROM sync_relay_migrations WHERE migration_id='service-host-enrollments-v5';
    COMMIT;`);
  if (marker)
    f.raw
      .prepare("INSERT INTO sync_relay_migrations (migration_id,completed_at_ms) VALUES (?,1)")
      .run(marker);
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
    DELETE FROM sync_relay_migrations WHERE migration_id='service-host-enrollments-v5';
    COMMIT;`);
}

it("migrates v2 enrollments with released rows already drained", async () => {
  const f = await fixture(),
    enrolled = f.enroll();
  f.seed(scope.workspaceId, "paused-object", "docs/paused.md", "paused-share");
  f.seed(scope.workspaceId, "retired-object", "docs/retired.md", "retired-share");
  f.enroll({ path: "docs/paused.md", shareId: "paused-share" });
  f.enroll({ path: "docs/retired.md", shareId: "retired-share" });
  f.storage.setServiceHostEnrollmentEnabled({
    ...f.input,
    path: "docs/paused.md",
    enabled: false,
    nowMs: 20,
  });
  f.release("paused-object");
  f.stop({ path: "docs/retired.md" });
  downgradeToV2(f);
  const reopened = openSyncRelayStorage(f.path, f.config);
  try {
    expect(reopened.readServiceHostEnrollment(scope.workspaceId, enrolled.path)).toMatchObject({
      enabled: true,
      hostDrainedAtMs: null,
    });
    expect(reopened.readServiceHostEnrollment(scope.workspaceId, "docs/paused.md")).toMatchObject({
      enabled: false,
      retired: false,
      hostDrainedAtMs: 25,
    });
    expect(reopened.readServiceHostEnrollment(scope.workspaceId, "docs/retired.md")).toMatchObject({
      enabled: false,
      retired: true,
      hostDrainedAtMs: 25,
    });
    expect(
      f.raw
        .prepare("SELECT migration_id FROM sync_relay_migrations WHERE migration_id=?")
        .get("service-host-enrollments-v3"),
    ).toBeTruthy();
    expect(
      f.raw
        .prepare("SELECT migration_id FROM sync_relay_migrations WHERE migration_id=?")
        .get("service-host-enrollments-v4"),
    ).toBeTruthy();
  } finally {
    reopened.close();
  }
});

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
const V3_COLUMNS =
  "workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,owner_stop,enabled,retired,created_at_ms,updated_at_ms,host_drained_at_ms,accounted_bytes";
const V4_COLUMNS =
  "workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,owner_stop,enabled,retired,created_at_ms,updated_at_ms,host_drained_at_ms,owner_demand,demand_at_ms,accounted_bytes";
function downgradeToV3(f: Awaited<ReturnType<typeof fixture>>, sql = V3_SQL) {
  f.raw.exec(`BEGIN;
    ALTER TABLE ${SERVICE_HOST_ENROLLMENTS} RENAME TO enrollments_v4;
    ${sql};
    INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(${V3_COLUMNS}) SELECT ${V3_COLUMNS} FROM enrollments_v4;
    DROP TABLE enrollments_v4;
    CREATE INDEX idx_sync_relay_service_host_enrollments_active ON ${SERVICE_HOST_ENROLLMENTS}(workspace_id,path) WHERE retired=0;
    CREATE INDEX idx_sync_relay_service_host_enrollments_retired ON ${SERVICE_HOST_ENROLLMENTS}(workspace_id,path) WHERE retired=1;
    DELETE FROM sync_relay_migrations WHERE migration_id='service-host-enrollments-v4';
    DELETE FROM sync_relay_migrations WHERE migration_id='service-host-enrollments-v5';
    COMMIT;`);
}

it("migrates v3 enrollments with their shares and no hosting demand, and refuses damaged v3 storage", async () => {
  const f = await fixture(),
    damaged = await fixture();
  f.enroll();
  damaged.enroll();
  f.seed(scope.workspaceId, "paused-object", "docs/paused.md", "paused-share");
  f.seed(scope.workspaceId, "retired-object", "docs/retired.md", "retired-share");
  f.enroll({ path: "docs/paused.md", shareId: "paused-share" });
  f.enroll({ path: "docs/retired.md", shareId: "retired-share" });
  f.storage.setServiceHostEnrollmentEnabled({
    ...f.input,
    path: "docs/paused.md",
    enabled: false,
    nowMs: 20,
  });
  f.release("paused-object");
  f.stop({ path: "docs/retired.md" });
  const rows = (db: { prepare(sql: string): { all(): Array<Record<string, unknown>> } }) =>
    db.prepare(`SELECT ${V4_COLUMNS} FROM ${SERVICE_HOST_ENROLLMENTS} ORDER BY path`).all();
  const usage = () =>
    f.raw
      .prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id=?")
      .get(scope.workspaceId)!.usage_bytes;
  const before = rows(f.raw),
    charged = usage();
  expect(before.map((row) => [row.path, row.share_id, row.owner_demand, row.demand_at_ms])).toEqual(
    [
      ["docs/a.md", scope.shareId, 0, null],
      ["docs/paused.md", "paused-share", 0, null],
      ["docs/retired.md", "retired-share", 0, null],
    ],
  );
  downgradeToV3(f);
  for (let open = 0; open < 2; open++) {
    const reopened = openSyncRelayStorage(f.path, f.config);
    try {
      const db = (reopened as StorageContext).db;
      expect(rows(db)).toEqual(before);
      expect(
        db
          .prepare(`SELECT name,"notnull" AS required,dflt_value FROM pragma_table_info('${SERVICE_HOST_ENROLLMENTS}')
        WHERE name IN ('share_id','owner_demand','demand_at_ms') ORDER BY cid`)
          .all(),
      ).toEqual([
        { name: "share_id", required: 0, dflt_value: null },
        { name: "owner_demand", required: 1, dflt_value: "0" },
        { name: "demand_at_ms", required: 0, dflt_value: null },
      ]);
      expect(reopened.readServiceHostEnrollment(scope.workspaceId, "docs/a.md")).toMatchObject({
        enabled: true,
        shareId: scope.shareId,
      });
      expect(usage()).toBe(charged);
    } finally {
      reopened.close();
    }
  }
  expect(
    f.raw
      .prepare(
        "SELECT migration_id FROM sync_relay_migrations WHERE migration_id LIKE 'service-host-enrollments-%' ORDER BY migration_id",
      )
      .all()
      .map((row) => row.migration_id),
  ).toEqual([
    "service-host-enrollments-v2",
    "service-host-enrollments-v3",
    "service-host-enrollments-v4",
    "service-host-enrollments-v5",
  ]);
  downgradeToV3(damaged, V3_SQL.replace("STRICT", ""));
  expect(() => openSyncRelayStorage(damaged.path, damaged.config)).toThrow(
    "Service host enrollment storage is damaged.",
  );
});

it("migrates v1 enrollments in place and keeps the enabled document hosted", async () => {
  const f = await fixture(),
    enabled = f.enroll();
  f.seed(scope.workspaceId, "paused-object", "docs/paused.md", "paused-share");
  f.seed(scope.workspaceId, "retired-object", "docs/retired.md", "retired-share");
  f.enroll({ path: "docs/paused.md", shareId: "paused-share" });
  f.enroll({ path: "docs/retired.md", shareId: "retired-share" });
  f.storage.setServiceHostEnrollmentEnabled({
    ...f.input,
    path: "docs/paused.md",
    enabled: false,
    nowMs: 20,
  });
  f.release("paused-object");
  f.stop({ path: "docs/retired.md" });
  const usage = () =>
    f.raw
      .prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id=?")
      .get(scope.workspaceId)!.usage_bytes;
  const before = f.raw
      .prepare(
        `SELECT path,enabled,retired,accounted_bytes FROM ${SERVICE_HOST_ENROLLMENTS} ORDER BY path`,
      )
      .all(),
    charged = usage();
  downgradeToV1(f);
  for (let open = 0; open < 2; open++) {
    const reopened = openSyncRelayStorage(f.path, f.config);
    try {
      expect(
        f.raw
          .prepare(
            `SELECT path,enabled,retired,accounted_bytes FROM ${SERVICE_HOST_ENROLLMENTS} ORDER BY path`,
          )
          .all(),
      ).toEqual(before);
      expect(
        reopened
          .listServiceHostEnrollments(scope.workspaceId)
          .map((row) => [row.path, row.enabled, row.ownerStop, row.hostDrainedAtMs]),
      ).toEqual([
        ["docs/a.md", true, null, null],
        ["docs/paused.md", false, "pause", 25],
      ]);
      expect(
        reopened
          .listRetiredServiceHostEnrollments(scope.workspaceId)
          .documents.map((row) => [row.path, row.ownerStop, row.hostDrainedAtMs]),
      ).toEqual([["docs/retired.md", "retire", 25]]);
      expect(reopened.hasKeptServiceHostEnrollment(scope.workspaceId, "docs/retired.md")).toBe(
        true,
      );
      expect(serviceHostDocumentEnabled(reopened as StorageContext, binding)).toBe(true);
      expect(
        authorizeServiceHostReplication(reopened, {
          ...key,
          workspaceId: scope.workspaceId,
          bearer: deriveServiceHostBearer(enabled, key),
          method: "GET",
          pathname: `/sync/${scope.workspaceId}/hosted/log`,
        }),
      ).toBe("owner-1");
      expect(usage()).toBe(charged);
    } finally {
      reopened.close();
    }
  }
  expect(
    f.raw
      .prepare(
        "SELECT migration_id FROM sync_relay_migrations WHERE migration_id LIKE 'service-host-enrollments-%' ORDER BY migration_id",
      )
      .all()
      .map((row) => row.migration_id),
  ).toEqual([
    "service-host-enrollments-v1",
    "service-host-enrollments-v2",
    "service-host-enrollments-v3",
    "service-host-enrollments-v4",
    "service-host-enrollments-v5",
  ]);
});

it("refuses an enrollment table it does not recognize", async () => {
  const unmarked = await fixture();
  unmarked.enroll();
  downgradeToV1(unmarked, V1_SQL, null);
  expect(() => openSyncRelayStorage(unmarked.path, unmarked.config)).toThrow(
    "Unmarked service host enrollment storage exists.",
  );
  const altered = await fixture();
  altered.enroll();
  downgradeToV1(altered, V1_SQL.replace("STRICT", ""));
  expect(() => openSyncRelayStorage(altered.path, altered.config)).toThrow(
    "Service host enrollment storage is damaged.",
  );
  for (const f of [unmarked, altered])
    expect(
      f.raw.prepare(`SELECT count(*) AS count FROM ${SERVICE_HOST_ENROLLMENTS}`).get()!.count,
    ).toBe(1);
});

it("retired rows stay hidden until an explicit reactivation and still reject foreign identities", async () => {
  const f = await fixture(),
    first = f.enroll();
  expect(f.storage.hasKeptServiceHostEnrollment(scope.workspaceId, first.path)).toBe(true);
  expect(f.storage.hasKeptServiceHostEnrollment(scope.workspaceId, "docs/absent.md")).toBe(false);
  expect(() =>
    f.storage.setServiceHostEnrollmentEnabled({
      ...f.input,
      enabled: true as unknown as false,
      retire: true,
    }),
  ).toThrow("Invalid");
  expect(
    f.storage.setServiceHostEnrollmentEnabled({
      ...f.input,
      enabled: false,
      retire: true,
      ownerUserId: "other",
    }),
  ).toBeNull();
  expect(
    f.storage.setServiceHostEnrollmentEnabled({ ...f.input, enabled: false, retire: true }),
  ).toMatchObject({ enabled: false, retired: true, ownerStop: "retire" });
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(0);
  expect(f.release()).toMatchObject({ hostDrainedAtMs: 25 });
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, first.path)).toMatchObject({
    shareId: first.shareId,
    retired: true,
    enabled: false,
  });
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/absent.md")).toBeNull();
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
  expect(f.storage.listServiceHostEnrollments(scope.workspaceId)).toEqual([]);
  expect(f.storage.currentServiceHostWorkspace(scope.workspaceId)).toBeNull();
  expect(f.setEnabled(false)).toMatchObject({ retired: true, enabled: false });
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
  expect(f.resume()).toMatchObject({ retired: false, enabled: true });
  expect(f.storage.listServiceHostEnrollments()).toHaveLength(1);
});

// Proves: live admission needs an Edit grant of the enrollment's owner that
// covers its path, as its departure does. Deleting the last one refuses the
// owner's binding at once, though the enrollment stays enabled until its
// release. Another covering Edit grant keeps it current, and Stop fences it either way.
it("refuses a document's live binding once no Edit grant of its owner covers it, and keeps Stop's fence", async () => {
  const f = await fixture(),
    enrolled = f.enroll();
  const owner = () =>
    f.storage.resolveCurrentLiveDocumentBinding({
      document,
      actor: { kind: "owner", userId: "owner-1" },
    });
  const enabled = () => serviceHostDocumentEnabled(f.storage as StorageContext, binding);
  const refused = { kind: "refused", reason: "host-unavailable" };
  expect(owner().kind).toBe("current");
  expect(f.storage.revokeShare(scope.shareId, 30)).toBe(true);
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, enrolled.path)).toMatchObject({
    enabled: true,
    retired: false,
  });
  expect(enabled()).toBe(false);
  expect(owner()).toEqual(refused);
  f.raw
    .prepare(
      "INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES ('overlap',?,'owner-1',?,0),('foreign',?,'other',?,0)",
    )
    .run(
      scope.workspaceId,
      JSON.stringify({ paths: ["docs"], versionId: null }),
      scope.workspaceId,
      JSON.stringify({ paths: ["docs"], versionId: null }),
    );
  f.raw
    .prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES ('overlap-grant','overlap','user','reader',NULL,'view',1,'active',0,NULL,NULL),('foreign-grant','foreign','user','reader',NULL,'edit',1,'active',0,NULL,NULL)`)
    .run();
  expect(owner()).toEqual(refused);
  f.raw
    .prepare("UPDATE sync_relay_share_grants SET access='edit' WHERE grant_id='overlap-grant'")
    .run();
  expect(enabled()).toBe(true);
  expect(owner().kind).toBe("current");
  f.stop();
  expect(enabled()).toBe(false);
  expect(owner()).toEqual(refused);
});

// The fixture document's adopted service activation. Stored metadata is enough here; native activation has its own suites.
async function activated() {
  const f = await fixture();
  f.enroll();
  retainServiceActivation(f.raw, key.namespace, true);
  const owner = () =>
    f.storage.resolveCurrentLiveDocumentBinding({
      document,
      actor: { kind: "owner", userId: "owner-1" },
    }).kind;
  const retirement = () => readServiceActivationRetirement(f.storage as StorageContext, binding);
  const retirements = () =>
    f.raw
      .prepare(
        "SELECT count(*) AS count FROM sync_relay_service_activations WHERE retire_requested_at_ms IS NOT NULL",
      )
      .get()!.count;
  const share = (
    shareId: string,
    grantId: string,
    access = "edit",
    userId = "reader-2",
    paths = ["docs"],
  ) => {
    f.raw
      .prepare(
        "INSERT INTO sync_relay_shares(share_id,workspace_id,granter_user_id,selector_json,created_at_ms) VALUES (?,?,'owner-1',?,0)",
      )
      .run(shareId, scope.workspaceId, JSON.stringify({ paths, versionId: null }));
    f.raw
      .prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
      VALUES (?,?,'user',?,NULL,?,1,'active',0,NULL,NULL)`)
      .run(grantId, shareId, userId, access);
  };
  return { ...f, owner, retirement, retirements, share };
}
const recorded = (requestedAtMs: number) => ({
  relayDatabaseNamespace: key.namespace,
  activationId: `ordinary-activation-${"a".repeat(64)}`,
  workspaceId: scope.workspaceId,
  mainVersionId: "main",
  objectId: binding.objectId,
  lineageClaimId: binding.lineageClaimId,
  path: binding.currentPath,
  restoreFenceGeneration: 7,
  acceptedThrough: 0,
  requestedAtMs,
});

it("records one retirement when Pause fences the activation, and Resume leaves it pending", async () => {
  const f = await activated();
  expect(f.owner()).toBe("current");
  expect(f.retirement()).toBeNull();
  expect(f.setEnabled(false)).toMatchObject({ enabled: true, ownerStop: "pause" });
  expect(f.owner()).toBe("refused");
  expect(f.retirement()).toEqual(recorded(20));
  f.setEnabled(false);
  expect(f.retirement()).toEqual(recorded(20));
  expect(f.retirements()).toBe(1);
  f.share("another", "another-edit");
  expect(f.storage.hasKeptServiceHostEnrollment(scope.workspaceId, binding.currentPath)).toBe(true);
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)).toMatchObject(
    { ownerStop: "pause" },
  );
  expect(f.owner()).toBe("refused");
  expect(f.resume()).toMatchObject({ enabled: true, retired: false, ownerStop: null });
  expect(f.retirement()).toEqual(recorded(20));
  expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding)).toBe(false);
  expect(f.owner()).toBe("refused");
  const reopened = openSyncRelayStorage(f.path, f.config);
  try {
    expect(readServiceActivationRetirement(reopened as StorageContext, binding)).toEqual(
      recorded(20),
    );
  } finally {
    reopened.close();
  }
});

// The relay's live-editing history, which the relay attaches as it starts.
const withHistory = <T extends SyncRelayStorage>(storage: T): T => {
  attachLiveJournalHistory(
    storage as unknown as StorageContext,
    createLiveJournalHistoryAuthority({ namespace: key.namespace, reconciled: true }),
  );
  return storage;
};
// Proves: Stop opens a new retirement only with the host's preparation of
// exactly that activation and restore generation, checked while the
// connection that prepared it still stands. A refused Stop fences nothing.
// Replaying the open retirement needs no preparation and keeps its fence.
it("retires a prepared activation only with its host's preparation and replays that retirement", async () => {
  const f = await fixture(),
    enrolled = f.enroll();
  const activationId = retainServiceActivation(f.raw, key.namespace, true);
  const candidate = f.storage.retirableServiceActivation(enrolled)!;
  expect(candidate).toEqual({
    activationId,
    lineageClaimId: binding.lineageClaimId,
    restoreFenceGeneration: binding.restoreFenceGeneration,
  });
  const retire = (prepared?: ServiceHostRetirementPreparation) =>
    f.storage.setServiceHostEnrollmentEnabled({
      ...f.input,
      enabled: false,
      retire: true,
      nowMs: 20,
      ...(prepared ? { prepared } : {}),
    });
  const unchanged = () => {
    expect(f.storage.serviceActivationRetirement(enrolled)).toBeNull();
    expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding)).toBe(true);
    expect(f.storage.readServiceHostEnrollment(scope.workspaceId, enrolled.path)).toMatchObject({
      enabled: true,
      retired: false,
      ownerStop: null,
    });
  };
  expect(() => retire()).toThrow(expect.objectContaining({ code: "host-not-loaded" }));
  unchanged();
  expect(() =>
    retire({ ...candidate, activationId: "another-activation", assertCurrent() {} }),
  ).toThrow(expect.objectContaining({ code: "conflict" }));
  expect(() =>
    retire({ ...candidate, lineageClaimId: "c".repeat(64), assertCurrent() {} }),
  ).toThrow(expect.objectContaining({ code: "conflict" }));
  expect(() => retire({ ...candidate, restoreFenceGeneration: 6, assertCurrent() {} })).toThrow(
    ServiceHostRetirementConflict,
  );
  expect(() =>
    retire({
      ...candidate,
      assertCurrent() {
        throw new Error("Service host registration was retired.");
      },
    }),
  ).toThrow("registration was retired");
  unchanged();
  let checked = 0;
  expect(
    retire({
      ...candidate,
      assertCurrent() {
        checked++;
      },
    }),
  ).toMatchObject({ enabled: false, retired: true, ownerStop: "retire" });
  expect(checked).toBe(1);
  const fence = f.storage.serviceActivationRetirement(enrolled)!;
  expect(fence).toMatchObject({
    activationId,
    restoreFenceGeneration: binding.restoreFenceGeneration,
  });
  expect(f.storage.retirableServiceActivation(enrolled)).toBeNull();
  expect(retire()).toMatchObject({ retired: true, acceptedCursor: fence.acceptedThrough });
  expect(f.storage.serviceActivationRetirement(enrolled)).toEqual(fence);
});

// The owner's open of the fixture's document, as their desktop sends it, and the refusal it answers.
const ownerOpen = (f: Awaited<ReturnType<typeof fixture>>, nowMs = 30) =>
  f.storage.ensureOwnedLiveDocument({ intent: "owner-open", ...f.input, nowMs });

type Fixture = Awaited<ReturnType<typeof fixture>>;
// What a reclaim leaves: retired without a Stop and with no demand, so the next open of any intent enrolls it again.
const reclaimed = {
  enabled: false,
  retired: true,
  ownerStop: null,
  ownerDemand: false,
  demandAtMs: null,
};
async function demandedOnly(owner = false, started = true) {
  const f = await fixture();
  f.enroll();
  if (started)
    expect(
      f.storage.moveLiveNote({
        workspaceId: scope.workspaceId,
        objectId: binding.objectId,
        generation: noteOf(f.storage).generation,
        nowMs: 10,
        move: "started",
      }).moved,
    ).toBe(true);
  if (owner) ownerOpen(f, 10);
  else
    expect(
      f.storage.renewPersonalSessionDemand({
        workspaceId: scope.workspaceId,
        objectId: binding.objectId,
        nowMs: 10,
      }),
    ).toBe(true);
  expect(
    f.storage.revokeShareGrant({ shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 10 })
      .ok,
  ).toBe(true);
  const read = () => f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)!;
  expect(read()).toMatchObject({
    enabled: true,
    retired: false,
    ownerDemand: owner,
    demandAtMs: 10,
  });
  // A live connection to the note, counted as every live route counts one, until the returned release runs.
  const connect = () => liveEditors(f.storage).acquire(binding);
  return {
    ...f,
    read,
    connect,
    sweep: (nowMs: number) => f.storage.reclaimIdleLiveDocuments(nowMs),
  };
}

const stored = (f: Fixture) =>
  f.raw.prepare(`SELECT * FROM ${SERVICE_HOST_ENROLLMENTS} ORDER BY workspace_id,object_id`).all();

it("reclaims an agent-only note idle past retention, and keeps it while a live connection is open", async () => {
  const f = await demandedOnly(),
    past = 10 + RECLAIM_RETENTION_MS + 1,
    before = stored(f);
  expect(f.sweep(past - 1)).toEqual([]);
  const release = f.connect();
  expect(f.sweep(past)).toEqual([]);
  expect(stored(f)).toEqual(before);
  release();
  expect(f.sweep(past)).toMatchObject([{ objectId: binding.objectId, ...reclaimed }]);
  expect(f.read()).toMatchObject(reclaimed);
  expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding)).toBe(false);
  expect(f.sweep(past + 1)).toEqual([]);
  expect(stored(f)).toHaveLength(before.length);
});

it("leaves a note that never started to its start clock, not to idle reclaim", async () => {
  const f = await demandedOnly(false, false),
    past = 10 + RECLAIM_RETENTION_MS + 1;
  expect(f.sweep(past)).toEqual([]);
  expect(
    f.storage.failLapsedLiveNoteStarts(past, () => "failing").map((row) => row.note),
  ).toMatchObject([{ state: "off", reason: "start-failed", cause: "failing" }]);
  expect(f.sweep(past + 1)).toEqual([]);
});

const V4_SQL = `CREATE TABLE ${SERVICE_HOST_ENROLLMENTS} (
  workspace_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  path TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  share_id TEXT,
  replication_epoch TEXT NOT NULL,
  stream_identity TEXT NOT NULL,
  owner_stop TEXT CHECK (owner_stop IN ('pause','retire')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0,1) AND (retired=0 OR enabled=0)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  host_drained_at_ms INTEGER CHECK (host_drained_at_ms IS NULL OR host_drained_at_ms >= 0),
  owner_demand INTEGER NOT NULL DEFAULT 0 CHECK (owner_demand IN (0,1)),
  demand_at_ms INTEGER CHECK (demand_at_ms IS NULL OR demand_at_ms >= 0),
  accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND 9007199254740991),
  CHECK (enabled=1 OR retired=1 OR owner_stop='pause'),
  PRIMARY KEY (workspace_id, object_id),
  UNIQUE (workspace_id, path),
  FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (share_id) REFERENCES sync_relay_shares(share_id)
) STRICT`;
function downgradeToV4(f: Fixture) {
  f.raw.exec(`BEGIN;
    ALTER TABLE ${SERVICE_HOST_ENROLLMENTS} RENAME TO enrollments_v5;
    ${V4_SQL};
    INSERT INTO ${SERVICE_HOST_ENROLLMENTS}(${V4_COLUMNS}) SELECT ${V4_COLUMNS} FROM enrollments_v5;
    DROP TABLE enrollments_v5;
    CREATE INDEX idx_sync_relay_service_host_enrollments_active ON ${SERVICE_HOST_ENROLLMENTS}(workspace_id,path) WHERE retired=0;
    CREATE INDEX idx_sync_relay_service_host_enrollments_retired ON ${SERVICE_HOST_ENROLLMENTS}(workspace_id,path) WHERE retired=1;
    DELETE FROM sync_relay_migrations WHERE migration_id='service-host-enrollments-v5';
    COMMIT;`);
}
const noteOf = (storage: SyncRelayStorage, path = binding.currentPath) =>
  storage.readServiceHostEnrollment(scope.workspaceId, path)!.note;
const move = (
  f: Fixture,
  change: LiveNoteMove,
  generation = noteOf(f.storage).generation,
  nowMs = 40,
) =>
  f.storage.moveLiveNote({
    workspaceId: scope.workspaceId,
    objectId: binding.objectId,
    generation,
    nowMs,
    ...change,
  });

it("fills the live note record from v4 enrollments, and keeps a live note live and served", async () => {
  const f = await fixture(),
    pending = await fixture(),
    live = f.enroll();
  retainServiceActivation(f.raw, key.namespace, true);
  for (const name of ["paused", "pausing", "stopped", "uncovered"]) {
    f.seed(scope.workspaceId, `${name}-object`, `docs/${name}.md`, `${name}-share`);
    f.enroll({ path: `docs/${name}.md`, shareId: `${name}-share` });
  }
  for (const path of ["docs/paused.md", "docs/pausing.md"])
    f.storage.setServiceHostEnrollmentEnabled({ ...f.input, path, enabled: false, nowMs: 20 });
  f.release("paused-object");
  f.stop({ path: "docs/stopped.md" });
  f.raw.exec("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=20");
  expect(f.release("uncovered-object")).toMatchObject({ retired: true, ownerStop: null });
  f.raw
    .prepare(
      "UPDATE sync_relay_share_grants SET status='active',revoked_at_ms=NULL WHERE share_id=?",
    )
    .run(scope.shareId);
  pending.enroll();
  retainServiceActivation(pending.raw, key.namespace);
  downgradeToV4(f);
  downgradeToV4(pending);
  const before = Date.now(),
    reopened = withHistory(openSyncRelayStorage(f.path, f.config)),
    reopenedPending = openSyncRelayStorage(pending.path, pending.config);
  try {
    const filled = (path: string) => {
      const enrollment = reopened.readServiceHostEnrollment(scope.workspaceId, path)!;
      const { sinceMs, ...note } = enrollment.note;
      return { ...note, since: sinceMs === enrollment.updatedAtMs ? "updated" : sinceMs };
    };
    const off = (reason: string, changedBy = "person:owner-1") => ({
      generation: 1,
      state: "off",
      reason,
      cause: null,
      since: "updated",
      changedBy,
    });
    expect(
      Object.fromEntries(
        ["a", "paused", "pausing", "stopped", "uncovered"].map((name) => [
          name,
          filled(`docs/${name}.md`),
        ]),
      ),
    ).toEqual({
      a: {
        generation: 1,
        state: "live",
        reason: null,
        cause: null,
        since: "updated",
        changedBy: "server",
      },
      paused: off("paused"),
      pausing: off("paused"),
      stopped: off("stopped"),
      uncovered: off("access-ended", "server"),
    });
    expect(reopened.readServiceHostEnrollment(scope.workspaceId, "docs/pausing.md")).toMatchObject({
      enabled: true,
      ownerStop: "pause",
    });
    const starting = noteOf(reopenedPending);
    expect(starting).toMatchObject({
      generation: 1,
      state: "starting",
      reason: null,
      changedBy: "server",
    });
    expect(starting.sinceMs).toBeGreaterThanOrEqual(before);
    expect(serviceHostDocumentEnabled(reopened as StorageContext, binding)).toBe(true);
    expect(
      authorizeServiceHostReplication(reopened, {
        ...key,
        workspaceId: scope.workspaceId,
        bearer: deriveServiceHostBearer(live, key),
        method: "GET",
        pathname: `/sync/${scope.workspaceId}/hosted/log`,
      }),
    ).toBe("owner-1");
    expect(reopened.hasKeptServiceHostEnrollment(scope.workspaceId, "docs/uncovered.md")).toBe(
      false,
    );
  } finally {
    reopened.close();
    reopenedPending.close();
  }
  const again = openSyncRelayStorage(f.path, f.config);
  try {
    expect(noteOf(again)).toMatchObject({ generation: 1, state: "live" });
  } finally {
    again.close();
  }
});

it("moves a note only from the state and generation each move leaves, and answers a refusal with the record", async () => {
  const f = await fixture(),
    runToken = f.enroll().runToken;
  retainServiceActivation(f.raw, key.namespace);
  const start = { move: "start", by: "person:owner-1" } as const,
    started = { move: "started" } as const,
    failed = { move: "start-failed", cause: "no-lineage" } as const;
  const refuses = (...changes: LiveNoteMove[]) => {
    const before = f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)!;
    for (const change of changes) {
      expect(move(f, change)).toEqual({ moved: false, record: before.note });
      expect(move(f, change, before.note.generation - 1)).toEqual({
        moved: false,
        record: before.note,
      });
    }
    expect(f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)).toEqual(
      before,
    );
  };
  expect(noteOf(f.storage)).toEqual({
    generation: 1,
    state: "starting",
    reason: null,
    cause: null,
    sinceMs: 10,
    changedBy: "person:owner-1",
  });
  refuses(start);
  expect(move(f, failed, 0)).toMatchObject({ moved: false, record: { generation: 1 } });
  expect(move(f, failed)).toEqual({
    moved: true,
    record: {
      generation: 1,
      state: "off",
      reason: "start-failed",
      cause: "no-lineage",
      sinceMs: 40,
      changedBy: "server",
    },
  });
  const ended = f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)!;
  expect(ended).toMatchObject({ enabled: false, retired: true, ownerStop: null });
  expect(ended.runToken).toBeGreaterThan(runToken);
  expect(readServiceActivationRetirement(f.storage as StorageContext, binding)).toMatchObject({
    requestedAtMs: 40,
  });
  refuses(started, failed);
  expect(move(f, start, 0)).toMatchObject({ moved: false });
  expect(move(f, start, 1, 50)).toEqual({
    moved: true,
    record: {
      generation: 2,
      state: "starting",
      reason: null,
      cause: null,
      sinceMs: 50,
      changedBy: "person:owner-1",
    },
  });
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)).toMatchObject(
    { enabled: true, retired: false, ownerStop: null, hostDrainedAtMs: null },
  );
  refuses(start);
  expect(move(f, started, 2, 60)).toEqual({
    moved: true,
    record: {
      generation: 2,
      state: "live",
      reason: null,
      cause: null,
      sinceMs: 60,
      changedBy: "server",
    },
  });
  refuses(start, started, failed);
  f.raw.prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET state='stopping'`).run();
  refuses(start, started, failed);
  f.raw.prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET state='live'`).run();
  f.setEnabled(false);
  expect(noteOf(f.storage)).toEqual({
    generation: 2,
    state: "off",
    reason: "paused",
    cause: null,
    sinceMs: 60,
    changedBy: "person:owner-1",
  });
  refuses(started, failed);
  expect(move(f, start, 2, 70)).toMatchObject({
    moved: true,
    record: { generation: 3, state: "starting", sinceMs: 70 },
  });
  expect(
    f.storage.moveLiveNote({
      workspaceId: scope.workspaceId,
      objectId: "missing-object",
      generation: 0,
      nowMs: 40,
      ...started,
    }),
  ).toEqual({ moved: false, record: null });
});

it("starts a note once per start on every way in, and leaves one whose start failed off until Resume", async () => {
  const f = await fixture();
  expect(f.enroll().note).toEqual({
    generation: 1,
    state: "starting",
    reason: null,
    cause: null,
    sinceMs: 10,
    changedBy: "person:owner-1",
  });
  f.enroll({ nowMs: 15 });
  ownerOpen(f);
  f.resume({ nowMs: 30 });
  expect(noteOf(f.storage)).toMatchObject({ generation: 1, state: "starting", sinceMs: 10 });
  f.pause();
  f.enroll({ nowMs: 40 });
  expect(() => ownerOpen(f, 40)).toThrow();
  expect(noteOf(f.storage)).toMatchObject({ generation: 1, state: "off", reason: "paused" });
  f.resume({ nowMs: 50 });
  f.resume({ nowMs: 55 });
  expect(noteOf(f.storage)).toMatchObject({
    generation: 2,
    state: "starting",
    sinceMs: 50,
    changedBy: "person:owner-1",
  });
  f.stop();
  expect(noteOf(f.storage)).toMatchObject({ generation: 2, state: "off", reason: "stopped" });
  f.enroll({ nowMs: 60 });
  f.resume({ nowMs: 70 });
  f.enroll({ nowMs: 75 });
  expect(noteOf(f.storage)).toMatchObject({ generation: 3, state: "starting", sinceMs: 70 });
  for (const cause of ["failing", "refused"] as const) {
    move(f, { move: "start-failed", cause });
    expect(f.enroll({ nowMs: 80 }).note).toMatchObject({ state: "off", reason: "start-failed" });
    expect(ownerOpen(f, 85).note).toMatchObject({ state: "off", reason: "start-failed", cause });
    expect(f.storage.hasKeptServiceHostEnrollment(scope.workspaceId, binding.currentPath)).toBe(
      true,
    );
    const generation = noteOf(f.storage).generation;
    f.resume({ nowMs: 90 });
    f.resume({ nowMs: 95 });
    expect(noteOf(f.storage)).toMatchObject({
      generation: generation + 1,
      state: "starting",
      sinceMs: 90,
    });
  }
  move(f, { move: "start-failed", cause: "no-lineage" });
  expect(f.enroll({ nowMs: 100 }).note).toMatchObject({ generation: 5, state: "off" });
  ownerOpen(f, 110);
  ownerOpen(f, 115);
  expect(noteOf(f.storage)).toMatchObject({ generation: 6, state: "starting", sinceMs: 110 });
});

it("starts a reclaimed note again on its next open, once", async () => {
  const f = await demandedOnly(),
    past = 10 + RECLAIM_RETENTION_MS + 1;
  expect(f.sweep(past)).toHaveLength(1);
  expect(f.read().note).toEqual({
    generation: 1,
    state: "off",
    reason: "access-ended",
    cause: null,
    sinceMs: past,
    changedBy: "server",
  });
  ownerOpen(f, past + 1);
  ownerOpen(f, past + 2);
  expect(f.read().note).toMatchObject({
    generation: 2,
    state: "starting",
    sinceMs: past + 1,
    changedBy: "person:owner-1",
  });
});

// A workspace member's open. `member-1` joins the fixture's workspace at
// once, and the owner sets members to `level`.

const MEMBER = "member-1";
function setMemberLevel(f: Fixture, level: "view" | "comment" | "edit") {
  expect(
    f.storage.setWorkspaceMemberLevel({
      workspaceId: scope.workspaceId,
      actorUserId: "owner-1",
      level,
      workspaceName: undefined,
      newShareId: () => "unused-share",
      nowMs: 6,
    }),
  ).toEqual({ ok: true });
}
function addMember(f: Fixture, level: "view" | "comment" | "edit" = "edit") {
  expect(
    f.storage.inviteWorkspaceMember({
      workspaceId: scope.workspaceId,
      actorUserId: "owner-1",
      workspaceName: "Plans",
      email: "sam@example.test",
      recipientUserId: MEMBER,
      newMemberId: () => "member-entry",
      newGrantId: () => "member-grant",
      newShareId: () => "members-share",
      nowMs: 5,
    }),
  ).toMatchObject({ ok: true });
  setMemberLevel(f, level);
}
const memberOpen = (
  f: Fixture,
  changes: {
    userId?: string;
    path?: string;
    nowMs?: number;
    changed?(changed: boolean): void;
  } = {},
) =>
  f.storage.ensureOwnedLiveDocument({
    intent: "member-open",
    userId: MEMBER,
    workspaceId: scope.workspaceId,
    path: binding.currentPath,
    nowMs: 30,
    guard() {},
    ...changes,
  });
const enrolled = (f: Fixture, path = binding.currentPath) =>
  f.storage.readServiceHostEnrollment(scope.workspaceId, path);

// Proves: a member at Edit hosts the document they open, under the owner,
// with demand recorded as an agent's open records it.
it("hosts a document a member at Edit opens and records the open as demand", async () => {
  const f = await fixture();
  addMember(f);
  const heard: boolean[] = [];
  expect(
    memberOpen(f, {
      changed: (value) => {
        heard.push(value);
      },
    }),
  ).toMatchObject({
    objectId: binding.objectId,
    ownerUserId: "owner-1",
    shareId: "members-share",
    enabled: true,
    retired: false,
    ownerStop: null,
    ownerDemand: false,
    demandAtMs: 30,
  });
  expect(heard).toEqual([true]);
  expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding, 30)).toBe(true);
  // A second open renews the demand and changes nothing else.
  expect(
    memberOpen(f, {
      nowMs: 40,
      changed: (value) => {
        heard.push(value);
      },
    }),
  ).toMatchObject({ enabled: true, demandAtMs: 40 });
  expect(heard).toEqual([true, false]);
});

// Proves: the account, its grant and its level come from storage. Comment,
// View, a path outside the workspace reach, an account outside the
// workspace, the owner and a path share's recipient all write nothing.
it.each([
  [
    "a member at Comment",
    (f: Fixture) => {
      addMember(f, "comment");
      return memberOpen(f);
    },
  ],
  [
    "a member at View",
    (f: Fixture) => {
      addMember(f, "view");
      return memberOpen(f);
    },
  ],
  [
    "a path outside the workspace reach",
    (f: Fixture) => {
      addMember(f);
      return memberOpen(f, { path: ".env/notes.md" });
    },
  ],
  [
    "an account outside the workspace",
    (f: Fixture) => {
      addMember(f);
      return memberOpen(f, { userId: "stranger" });
    },
  ],
  [
    "the owner",
    (f: Fixture) => {
      addMember(f);
      return memberOpen(f, { userId: "owner-1" });
    },
  ],
  [
    "a path share's recipient at Edit",
    (f: Fixture) => {
      addMember(f);
      return memberOpen(f, { userId: scope.userId });
    },
  ],
] as const)("refuses a member open by %s", async (_, open) => {
  const f = await fixture();
  expect(() => open(f)).toThrow("not found");
  expect(enrolled(f)).toBeNull();
  expect(f.storage.listServiceHostEnrollments()).toEqual([]);
});

// Proves: the open reads the membership again inside its transaction, so a
// removal or a level drop after the route checked the grant refuses it.
it.each(["removed", "dropped to Comment"] as const)(
  "refuses a member open when the member is %s after the route's check",
  async (change) => {
    const f = await fixture();
    addMember(f);
    const checked = f.storage.listActiveShareGrantsForRecipient("members-share", MEMBER);
    expect(checked.map((grant) => grant.grantId)).toEqual(["member-grant"]);
    if (change === "removed") {
      expect(
        f.storage.removeWorkspaceMember({
          workspaceId: scope.workspaceId,
          actorUserId: "owner-1",
          memberId: "member-entry",
          nowMs: 20,
        }),
      ).toEqual({ ok: true });
    } else setMemberLevel(f, "comment");
    expect(() => memberOpen(f)).toThrow("not found");
    expect(enrolled(f)).toBeNull();
  },
);

// Proves: a full host answers a member's open with the refusal an agent's
// open hears, at once and without a row.
it("answers a member open on a full host with live_host_full", async () => {
  const f = await fixture();
  addMember(f);
  for (let i = 2; i <= SERVICE_HOST_MAX_WORKSPACES + 1; i++) {
    const workspaceId = `workspace-${i}`,
      shareId = `share-${i}`;
    f.seed(workspaceId, `object-${i}`, binding.currentPath, shareId);
    f.enroll({ workspaceId, shareId });
  }
  expect(refusal(() => memberOpen(f))).toBe("live_host_full");
  expect(enrolled(f)).toBeNull();
});

// Proves: one workspace's member opens stop at that workspace's cap, well
// short of the host's, so another workspace still enrolls a document.
it("keeps one workspace's member opens from filling the host for other workspaces", async () => {
  const f = await fixture();
  addMember(f);
  let opened = 0;
  for (let i = 1; i <= SERVICE_HOST_MAX_DOCUMENTS; i++) {
    const path = `docs/member-${i}.md`;
    f.seed(scope.workspaceId, `member-object-${i}`, path, `member-share-${i}`, false);
    if (refusal(() => memberOpen(f, { path })) === "live_host_full") {
      expect(enrolled(f, path)).toBeNull();
      break;
    }
    opened++;
  }
  expect(opened).toBe(MEMBER_OPEN_MAX_DOCUMENTS);
  f.seed("workspace-2", "object-2", binding.currentPath, "share-2");
  expect(f.enroll({ workspaceId: "workspace-2", shareId: "share-2" })).toMatchObject({
    workspaceId: "workspace-2",
    enabled: true,
    retired: false,
  });
});

// Proves: the member cap counts only recent opens. Once the earlier opens
// are older than the window, another page opens, and the host's release
// retires a stale page but keeps a recent one until the member leaves.
it("opens a 17th page once the earlier member opens go stale, and retires the stale ones", async () => {
  const f = await fixture();
  addMember(f);
  // No path share covers the pages, so only the member's opens keep them.
  expect(
    f.storage.revokeShareGrant({ shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 20 })
      .ok,
  ).toBe(true);
  const path = (i: number) => `docs/member-${i}.md`;
  const release = (i: number, nowMs: number) =>
    f.storage.releaseServiceHostEnrollment({
      workspaceId: scope.workspaceId,
      objectId: `member-object-${i}`,
      nowMs,
    });
  for (let i = 1; i <= MEMBER_OPEN_MAX_DOCUMENTS + 1; i++)
    f.seed(scope.workspaceId, `member-object-${i}`, path(i), `member-share-${i}`, false);
  for (let i = 1; i <= MEMBER_OPEN_MAX_DOCUMENTS; i++) memberOpen(f, { path: path(i) });
  const next = MEMBER_OPEN_MAX_DOCUMENTS + 1,
    stale = 30 + MEMBER_OPEN_DEMAND_MS;
  expect(refusal(() => memberOpen(f, { path: path(next), nowMs: stale - 1 }))).toBe(
    "live_host_full",
  );
  expect(memberOpen(f, { path: path(next), nowMs: stale })).toMatchObject({
    enabled: true,
    retired: false,
    demandAtMs: stale,
  });
  expect(release(1, stale)).toMatchObject({ enabled: false, retired: true });
  expect(release(next, stale)).toBeNull();
  // Recent demand keeps a page only while a member at Edit can reach it.
  expect(
    f.storage.removeWorkspaceMember({
      workspaceId: scope.workspaceId,
      actorUserId: "owner-1",
      memberId: "member-entry",
      nowMs: stale,
    }),
  ).toEqual({ ok: true });
  expect(release(next, stale)).toMatchObject({ enabled: false, retired: true });
});

// Proves: ending the membership deletes its row, yet a page a member opened
// still reads as member-opened, so it stops counting at once and retires.
it("retires a member-opened page once the owner ends the membership", async () => {
  const f = await fixture();
  addMember(f);
  expect(
    f.storage.revokeShareGrant({ shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 20 })
      .ok,
  ).toBe(true);
  memberOpen(f);
  expect(
    f.storage.endWorkspaceMembership({
      workspaceId: scope.workspaceId,
      actorUserId: "owner-1",
      nowMs: 40,
    }),
  ).toEqual({ ok: true });
  expect(f.storage.serviceHostEnrollmentCovered(enrolled(f)!, 40)).toBe(false);
  expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding, 40)).toBe(false);
  expect(
    f.storage.releaseServiceHostEnrollment({
      workspaceId: scope.workspaceId,
      objectId: binding.objectId,
      nowMs: 40,
    }),
  ).toMatchObject({ enabled: false, retired: true });
});

// Proves: a member's open that revives a retired page, or takes over a live
// page whose path share's Edit grant ended, counts toward the member cap and
// lapses as a new member open does.
it("counts and lapses a member open that revives a retired page or takes over one a revoked share left", async () => {
  const f = await fixture();
  expect(
    f.storage.revokeShareGrant({ shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 20 })
      .ok,
  ).toBe(true);
  const path = (name: string) => `docs/${name}.md`;
  const release = (objectId: string, nowMs: number) =>
    f.storage.releaseServiceHostEnrollment({ workspaceId: scope.workspaceId, objectId, nowMs });
  const revoke = (shareId: string) =>
    expect(
      f.storage.revokeShareGrant({ shareId, grantId: `${shareId}-edit`, revokedAtMs: 20 }).ok,
    ).toBe(true);
  // Its path share enrolled it, and its Edit grant ended before anyone joined.
  f.seed(scope.workspaceId, "retired-object", path("retired"), "retired-share");
  f.enroll({ path: path("retired"), shareId: "retired-share" });
  revoke("retired-share");
  expect(release("retired-object", 25)).toMatchObject({ retired: true });
  // Its path share's Edit grant ends once a member reaches it, so the member's grant keeps it.
  f.seed(scope.workspaceId, "held-object", path("held"), "held-share");
  f.enroll({ path: path("held"), shareId: "held-share" });
  addMember(f);
  revoke("held-share");
  expect(release("held-object", 25)).toBeNull();
  for (const name of ["retired", "held"])
    expect(memberOpen(f, { path: path(name) })).toMatchObject({
      enabled: true,
      retired: false,
      shareId: "members-share",
    });
  let opened = 0;
  for (let i = 1; i <= MEMBER_OPEN_MAX_DOCUMENTS; i++) {
    f.seed(
      scope.workspaceId,
      `member-object-${i}`,
      path(`member-${i}`),
      `member-share-${i}`,
      false,
    );
    if (refusal(() => memberOpen(f, { path: path(`member-${i}`) })) === "live_host_full") break;
    opened++;
  }
  expect(opened).toBe(MEMBER_OPEN_MAX_DOCUMENTS - 2);
  const stale = 30 + MEMBER_OPEN_DEMAND_MS;
  for (const objectId of ["retired-object", "held-object"]) {
    expect(
      serviceHostDocumentEnabled(
        f.storage as StorageContext,
        { workspaceId: scope.workspaceId, objectId },
        stale,
      ),
    ).toBe(false);
    expect(release(objectId, stale)).toMatchObject({ enabled: false, retired: true });
  }
});

// Proves: a member's open leaves the path share and its grant as they were.
it("leaves a path share and its grant unchanged when a member opens a document it covers", async () => {
  const f = await fixture();
  addMember(f);
  const grants = () =>
    f.raw
      .prepare("SELECT * FROM sync_relay_share_grants WHERE share_id=? ORDER BY grant_id")
      .all(scope.shareId);
  const shares = () =>
    f.raw.prepare("SELECT * FROM sync_relay_shares WHERE share_id=?").all(scope.shareId);
  const before = { grants: grants(), shares: shares() };
  memberOpen(f);
  expect({ grants: grants(), shares: shares() }).toEqual(before);
  // The path share still asks for hosting as before, and finds the document hosted.
  expect(f.enroll({ nowMs: 40 })).toMatchObject({
    enabled: true,
    shareId: "members-share",
    demandAtMs: 30,
  });
});

// Proves: an active membership grant at Edit whose workspace reach includes
// the path covers the document, and stops covering it at a lower level.
it("counts a member's Edit grant as covering an enrolled document", async () => {
  const f = await fixture();
  f.enroll();
  addMember(f);
  expect(
    f.storage.revokeShareGrant({ shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 20 })
      .ok,
  ).toBe(true);
  expect(f.storage.serviceHostEnrollmentCovered(enrolled(f)!)).toBe(true);
  expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding)).toBe(true);
  setMemberLevel(f, "comment");
  expect(f.storage.serviceHostEnrollmentCovered(enrolled(f)!)).toBe(false);
  expect(serviceHostDocumentEnabled(f.storage as StorageContext, binding)).toBe(false);
});

it("enrolls at a folder's Edit above the member default and ends coverage when that folder narrows", async () => {
  const f = await fixture();
  addMember(f, "comment");
  f.raw
    .prepare(
      "UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=25 WHERE grant_id=?",
    )
    .run(scope.grantId);
  const context = f.storage as StorageContext;
  context.tx(() =>
    context.db
      .prepare(
        `INSERT INTO sync_relay_access_rules (workspace_id,folder,rule_text,from_seq,to_seq) VALUES (?,'docs','members: edit',100,NULL)`,
      )
      .run(scope.workspaceId),
  );
  expect(memberOpen(f)).toMatchObject({ enabled: true, shareId: "members-share" });
  expect(serviceHostDocumentEnabled(context, binding, 30)).toBe(true);
  context.tx(() =>
    context.db
      .prepare("UPDATE sync_relay_access_rules SET rule_text='members: view' WHERE workspace_id=?")
      .run(scope.workspaceId),
  );
  expect(serviceHostDocumentEnabled(context, binding, 30)).toBe(false);
  expect(() => memberOpen(f, { nowMs: 31 })).toThrow("not found");
});

it("leaves a starting note whose Edit access ended to its release, which records why", async () => {
  const f = await fixture();
  f.enroll();
  expect(
    f.storage.revokeShareGrant({ shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 20 })
      .ok,
  ).toBe(true);
  expect(f.storage.failLapsedLiveNoteStarts(10 + LIVE_NOTE_START_MAX_MS, () => "failing")).toEqual(
    [],
  );
  expect(noteOf(f.storage).state).toBe("starting");
  f.release(binding.objectId);
  expect(noteOf(f.storage)).toMatchObject({ state: "off", reason: "access-ended", cause: null });
});

it("tells the waits of a note its start clock turned off, even when a later note's turn fails", async () => {
  const f = await fixture();
  f.enroll();
  f.seed(scope.workspaceId, "b-object", "docs/b.md", "b-share");
  f.enroll({ path: "docs/b.md", shareId: "b-share" });
  const changed = vi.fn();
  const stops = [binding.currentPath, "docs/b.md"].map((path) =>
    observeDesktopReadiness(
      f.storage,
      { shareId: `wait:${path}`, workspaceId: scope.workspaceId, path },
      changed,
    ),
  );
  try {
    let calls = 0;
    expect(() =>
      f.storage.failLapsedLiveNoteStarts(10 + LIVE_NOTE_START_MAX_MS, () => {
        if (calls++ > 0) throw new Error("No cause.");
        return "failing";
      }),
    ).toThrow("No cause.");
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(1);
  } finally {
    for (const stop of stops) stop();
  }
});

it.each([
  ["retiring", "retire_requested_at_ms=5,retire_restore_generation=0,retire_accepted_cursor=1"],
  [
    "retired",
    "retire_requested_at_ms=5,retire_restore_generation=0,retire_accepted_cursor=1,retired_at_ms=6,retired_boundary_json='{}',state_bytes=NULL",
  ],
])("fills a note whose completed activation is %s as starting, not live", async (_, retire) => {
  const f = await fixture();
  f.enroll();
  retainServiceActivation(f.raw, key.namespace, true);
  f.raw.exec(`UPDATE sync_relay_service_activations SET ${retire}`);
  downgradeToV4(f);
  const reopened = openSyncRelayStorage(f.path, f.config);
  try {
    expect(noteOf(reopened)).toMatchObject({ generation: 1, state: "starting" });
  } finally {
    reopened.close();
  }
});

it("fails a start 10 minutes after the start the record holds, also across a relay restart", async () => {
  const f = await fixture();
  f.enroll();
  retainServiceActivation(f.raw, key.namespace);
  const cause = () => "failing" as const;
  expect(f.storage.failLapsedLiveNoteStarts(10 + LIVE_NOTE_START_MAX_MS - 1, cause)).toEqual([]);
  expect(noteOf(f.storage).state).toBe("starting");
  const restarted = withHistory(openSyncRelayStorage(f.path, f.config));
  try {
    expect(restarted.failLapsedLiveNoteStarts(10 + LIVE_NOTE_START_MAX_MS - 1, cause)).toEqual([]);
    expect(
      restarted.failLapsedLiveNoteStarts(10 + LIVE_NOTE_START_MAX_MS, cause).map((row) => row.note),
    ).toEqual([
      {
        generation: 1,
        state: "off",
        reason: "start-failed",
        cause: "failing",
        sinceMs: 10 + LIVE_NOTE_START_MAX_MS,
        changedBy: "server",
      },
    ]);
    expect(
      restarted.readServiceHostEnrollment(scope.workspaceId, binding.currentPath),
    ).toMatchObject({ enabled: false, retired: true });
    expect(readServiceActivationRetirement(restarted as StorageContext, binding)).not.toBeNull();
    expect(restarted.failLapsedLiveNoteStarts(10 + 2 * LIVE_NOTE_START_MAX_MS, cause)).toEqual([]);
  } finally {
    restarted.close();
  }
});
