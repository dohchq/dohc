import { afterEach, expect, it } from "vitest";
import {
  closeTestStorage,
  closeTestStorages,
  inspectDatabase,
  reopenTestStorage,
  storagePath,
  testStorage,
} from "../testing";

afterEach(closeTestStorages);

const replicaObjects = (path: string) =>
  inspectDatabase(path, { readOnly: true })
    .prepare(
      "SELECT type, name FROM sqlite_schema WHERE name LIKE '%replica%' OR name LIKE 'sync_relay_history_%' ORDER BY name",
    )
    .all();

it("creates no read replica tables, triggers or indexes", async () => {
  const storage = await testStorage();
  expect(replicaObjects(storagePath(storage))).toEqual([]);
});

it("stops the read replica's triggers on an existing store and keeps its rows", async () => {
  const first = await testStorage(),
    path = storagePath(first);
  first.claimWorkspace({ workspaceId: "w", ownerUserId: "owner", createdAtMs: 1 });
  closeTestStorage(first);
  const db = inspectDatabase(path);
  db.exec(`
    DELETE FROM sync_relay_migrations WHERE migration_id = 'read-replica-triggers-retired-v1';
    CREATE TABLE sync_relay_history_grant_floors (grant_id TEXT PRIMARY KEY) STRICT;
    INSERT INTO sync_relay_history_grant_floors VALUES ('kept');
    CREATE TRIGGER replica_history_grant_floor AFTER INSERT ON sync_relay_share_grants BEGIN
      INSERT INTO sync_relay_history_grant_floors VALUES (NEW.grant_id);
    END;
    CREATE INDEX replica_history_journal_position
      ON sync_relay_live_update_journal(workspace_id, main_version_id, object_id, journal_cursor);
  `);
  db.close();

  const storage = reopenTestStorage(path);
  storage.createShare({
    share: {
      shareId: "s",
      workspaceId: "w",
      granterUserId: "owner",
      selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }),
      createdAtMs: 2,
    },
    grant: {
      grantId: "g",
      shareId: "s",
      principalKind: "user",
      principalUserId: "reader",
      principalEmail: null,
      access: "view",
      generation: 1,
      status: "active",
      createdAtMs: 2,
      revokedAtMs: null,
      parentGrantId: null,
    },
  });
  expect(replicaObjects(path)).toEqual([
    { type: "table", name: "sync_relay_history_grant_floors" },
  ]);
  expect(
    inspectDatabase(path, { readOnly: true })
      .prepare("SELECT grant_id FROM sync_relay_history_grant_floors")
      .all(),
  ).toEqual([{ grant_id: "kept" }]);
});
