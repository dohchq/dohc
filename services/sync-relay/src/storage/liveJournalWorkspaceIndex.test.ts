import { afterEach, expect, it } from "vitest";
import {
  closeTestStorage,
  closeTestStorages,
  inspectDatabase,
  storagePath,
  testStorage,
} from "../testing";
import { initializeSyncRelaySchema } from "./schema";
import type { SqliteDb } from "./types";

afterEach(closeTestStorages);

it("migrates an existing journal to the workspace cursor index and validates it on reopen", async () => {
  const storage = await testStorage(),
    path = storagePath(storage);
  closeTestStorage(storage);
  const db = inspectDatabase(path);
  db.exec("DROP INDEX IF EXISTS idx_sync_relay_live_update_journal_workspace");
  db.prepare("DELETE FROM sync_relay_migrations WHERE migration_id=?").run(
    "live-update-journal-workspace-index-v1",
  );
  initializeSyncRelaySchema(db as SqliteDb);
  initializeSyncRelaySchema(db as SqliteDb);
  expect(
    db
      .prepare("PRAGMA index_info(idx_sync_relay_live_update_journal_workspace)")
      .all()
      .map((row) => row.name),
  ).toEqual(["workspace_id", "journal_cursor"]);
  db.exec("DROP INDEX idx_sync_relay_live_update_journal_workspace");
  expect(() => initializeSyncRelaySchema(db as SqliteDb)).toThrow(
    "live journal workspace index is missing or damaged",
  );
});
