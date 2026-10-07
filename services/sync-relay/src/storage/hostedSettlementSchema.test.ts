import { afterEach, expect, it } from "vitest";
import {
  testStorage,
  closeTestStorages,
  inspectDatabase,
  storagePath,
  closeTestStorage,
  reopenTestStorage,
} from "../testing";
import {
  initializeHostedSettlementSchema,
  SETTLEMENT_CUTS,
  SETTLEMENT_BINDINGS,
  SETTLEMENT_SCHEMA_MARKER,
} from "./hostedSettlementSchema";
import type { SqliteDb } from "./types";
afterEach(closeTestStorages);
it("retains the hosted schema across reopen", async () => {
  const storage = await testStorage(),
    path = storagePath(storage);
  closeTestStorage(storage);
  const next = reopenTestStorage(path);
  expect(
    inspectDatabase(path)
      .prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?")
      .get(SETTLEMENT_SCHEMA_MARKER),
  ).toBeDefined();
  closeTestStorage(next);
});
it.each([
  SETTLEMENT_CUTS,
  SETTLEMENT_BINDINGS,
  "settlement_cut_usage_insert",
  "settlement_cut_journal_delete",
  "settlement_binding_usage_insert",
  "settlement_admission_usage_insert",
])(
  "refuses missing proof retention object %s without repairing it",
  async (name) => {
    const storage = await testStorage(),
      path = storagePath(storage);
    closeTestStorage(storage);
    const db = inspectDatabase(path);
    db.exec(
      `DROP ${name.startsWith("sync_relay_") ? "TABLE" : "TRIGGER"} ${name}`,
    );
    expect(() => initializeHostedSettlementSchema(db as SqliteDb)).toThrow(
      "Hosted settlement schema is missing or damaged.",
    );
    db.close();
    expect(() => reopenTestStorage(path)).toThrow(
      /schema is missing or damaged/,
    );
  },
);
it("refuses unmarked hosted retention tables", async () => {
  const storage = await testStorage(),
    path = storagePath(storage);
  closeTestStorage(storage);
  const db = inspectDatabase(path);
  db.prepare("DELETE FROM sync_relay_migrations WHERE migration_id=?").run(
    SETTLEMENT_SCHEMA_MARKER,
  );
  expect(() => initializeHostedSettlementSchema(db as SqliteDb)).toThrow(
    "Hosted settlement schema is missing or damaged.",
  );
  db.close();
});

it("releases cut quota when its journal parent is deleted, without charging twice", async () => {
  const storage = await testStorage(),
    path = storagePath(storage);
  closeTestStorage(storage);
  const db = inspectDatabase(path, { foreignKeys: true });
  const usage = () =>
    Number(
      db
        .prepare(
          "SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'",
        )
        .get()!.usage_bytes,
    );
  db.prepare(
    "INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms) VALUES('workspace','owner',0)",
  ).run();
  const insertJournal =
    db.prepare(`INSERT INTO sync_relay_live_update_journal(delivery_id,update_digest,workspace_id,main_version_id,
    object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,principal_kind,principal_id,
    accepting_host_epoch,received_at_ms,update_bytes,relay_database_namespace,accepted_event_count,accepted_evidence_digest,accepted_metadata_bytes)
    VALUES(?,?,'workspace','main','object',?,'notes.md','["notes.md"]',1,'owner','owner',1,1,?,'namespace',1,?,1)`);
  const digest = "a".repeat(64);
  const first = Number(
    insertJournal.run("first", digest, digest, new Uint8Array([1]), digest)
      .lastInsertRowid,
  );
  const second = Number(
    insertJournal.run("second", digest, digest, new Uint8Array([1]), digest)
      .lastInsertRowid,
  );
  const insertCut = db.prepare(
    `INSERT INTO ${SETTLEMENT_CUTS}(journal_cursor,state_sha256,markdown_sha256,state_byte_length,markdown_byte_length) VALUES(?,?,?,?,?)`,
  );
  expect(usage()).toBe(0);
  insertCut.run(first, digest, digest, 1, 0);
  insertCut.run(second, digest, digest, 1, 0);
  expect(usage()).toBe(288);
  db.prepare(
    "DELETE FROM sync_relay_live_update_journal WHERE journal_cursor=?",
  ).run(first);
  expect(
    db
      .prepare(`SELECT 1 FROM ${SETTLEMENT_CUTS} WHERE journal_cursor=?`)
      .get(first),
  ).toBeUndefined();
  expect(usage()).toBe(144);
  db.prepare(`DELETE FROM ${SETTLEMENT_CUTS} WHERE journal_cursor=?`).run(
    second,
  );
  expect(usage()).toBe(0);
  db.prepare(
    "DELETE FROM sync_relay_live_update_journal WHERE journal_cursor=?",
  ).run(second);
  expect(usage()).toBe(0);
  const third = Number(
    insertJournal.run("third", digest, digest, new Uint8Array([1]), digest)
      .lastInsertRowid,
  );
  insertCut.run(third, digest, digest, 1, 0);
  db.prepare(
    "DELETE FROM sync_relay_workspaces WHERE workspace_id='workspace'",
  ).run();
  expect(db.prepare(`SELECT 1 FROM ${SETTLEMENT_CUTS}`).get()).toBeUndefined();
  expect(
    db
      .prepare(
        "SELECT 1 FROM sync_relay_workspace_usage WHERE workspace_id='workspace'",
      )
      .get(),
  ).toBeUndefined();
});
