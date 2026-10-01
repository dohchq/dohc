import { afterEach, expect, it } from "vitest";
import { claimWorkspace, closeTestStorage, closeTestStorages, inspectDatabase, reopenTestStorage, storagePath, testHandler, testStorage } from "../testing";

afterEach(closeTestStorages);

it("opens an older relay database and adds the Button columns and Notice index once", async () => {
  const storage = await testStorage();
  await claimWorkspace(testHandler(storage), "owner", "workspace");
  const path = storagePath(storage);
  closeTestStorage(storage);
  const db = inspectDatabase(path);
  db.exec(`DROP INDEX idx_sync_relay_notices_post;
    ALTER TABLE sync_relay_automation_presses DROP COLUMN confirmed_json;
    ALTER TABLE sync_relay_automation_presses DROP COLUMN accepted_generation;
    DELETE FROM sync_relay_migrations WHERE migration_id IN ('notice-post-index-v1', 'automation-press-confirmations-v1');
    INSERT INTO sync_relay_automation_presses (host_press_id, workspace_id, share_id, grant_id, grant_generation, press_id,
      user_id, automation_id, collection_path, definition_hash, record_id, state, created_at_ms, updated_at_ms)
    VALUES ('old-press', 'workspace', 'share', 'grant', 1, 'press', 'recipient', 'collection:packing#pack',
      'trip/packing', '0123456789abcdef', 'record', 'pending', 1, 1);`);
  db.close();

  const upgraded = reopenTestStorage(path);
  expect(upgraded.workspaceIsOwnedBy("workspace", "owner")).toBe(true);
  const check = inspectDatabase(path);
  expect(check.prepare("PRAGMA table_info(sync_relay_automation_presses)").all().map(row => row.name))
    .toEqual(expect.arrayContaining(["confirmed_json", "accepted_generation"]));
  expect(check.prepare("SELECT confirmed_json, accepted_generation, state FROM sync_relay_automation_presses WHERE host_press_id = 'old-press'").get())
    .toEqual({ confirmed_json: "[]", accepted_generation: null, state: "pending" });
  expect(check.prepare("SELECT name FROM sqlite_schema WHERE name = 'idx_sync_relay_notices_post'").get())
    .toEqual({ name: "idx_sync_relay_notices_post" });
  const markers = check.prepare("SELECT * FROM sync_relay_migrations WHERE migration_id IN ('notice-post-index-v1', 'automation-press-confirmations-v1') ORDER BY migration_id").all();
  expect(markers).toHaveLength(2);
  check.close();
  closeTestStorage(upgraded);
  expect(reopenTestStorage(path).workspaceIsOwnedBy("workspace", "owner")).toBe(true);
  const reopened = inspectDatabase(path);
  expect(reopened.prepare("SELECT * FROM sync_relay_migrations WHERE migration_id IN ('notice-post-index-v1', 'automation-press-confirmations-v1') ORDER BY migration_id").all())
    .toEqual(markers);
  reopened.close();
});
